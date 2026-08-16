"""Persisted and traced runtime entry point for media_facts."""

from __future__ import annotations

import base64
import time
from typing import Any

from app.agents.media_facts.agent import (
    MEDIA_FACTS_AGENT_NAME,
    SUPPORTED_MEDIA_MIME_TYPES,
    build_media_facts_agent,
    media_kind_for_mime,
)
from app.agents.media_facts.models import MediaFactsAgentOutput, MediaFactsRunResult
from app.agents.media_facts.state import MediaFactsRuntimeContext
from app.config.settings import settings
from app.domain.messages import repository as message_repo
from app.services.prompts import trace_agent
from app.utils.logger import logger

MEDIA_SIZE_LIMITS = {
    "image/jpeg": 10 * 1024 * 1024,
    "image/png": 10 * 1024 * 1024,
    "image/webp": 10 * 1024 * 1024,
    "application/pdf": 20 * 1024 * 1024,
}


def validate_media_upload(mime_type: str, size_bytes: int) -> str | None:
    if mime_type not in SUPPORTED_MEDIA_MIME_TYPES:
        return f"Unsupported file type: {mime_type}"
    limit = MEDIA_SIZE_LIMITS[mime_type]
    if size_bytes > limit:
        return (
            f"That {media_kind_for_mime(mime_type)} is too large. "
            f"The limit is {limit // (1024 * 1024)} MB."
        )
    return None


async def _record_run(row: dict[str, Any]) -> None:
    try:
        await message_repo.create_agent_run(row)
    except Exception as exc:
        logger.warning("agent_run_persist_failed agent=media_facts error={}", str(exc))


async def run_media_facts_agent(
    *,
    user_id: str,
    thread_id: str,
    mime_type: str,
    data: bytes,
    filename: str | None = None,
    user_note: str | None = None,
    correlation_id: str | None = None,
) -> MediaFactsRunResult:
    validation_error = validate_media_upload(mime_type, len(data))
    if validation_error:
        return MediaFactsRunResult(ok=False, detail=validation_error)
    if not settings.ai_enabled:
        return MediaFactsRunResult(
            ok=False,
            detail="AI features are disabled - no OPENAI_API_KEY is configured.",
        )

    started = time.perf_counter()
    context = MediaFactsRuntimeContext(user_id=user_id, thread_id=thread_id)
    try:
        agent = build_media_facts_agent()
        with trace_agent(
            MEDIA_FACTS_AGENT_NAME,
            {"mime_type": mime_type},
            {
                "mime_type": mime_type,
                "filename": filename,
                "byte_count": len(data),
                "user_note": user_note,
                "thread_id": thread_id,
                "correlation_id": correlation_id,
            },
        ) as trace_run:
            result = await agent.ainvoke(
                {
                    "mime_type": mime_type,
                    "data_b64": base64.b64encode(data).decode("ascii"),
                    "filename": filename or "",
                    "user_note": user_note or "",
                },
                context=context,
            )
            raw_output = result.get("structured_response")
            output = (
                raw_output
                if isinstance(raw_output, MediaFactsAgentOutput)
                else MediaFactsAgentOutput.model_validate(raw_output)
            )
            if trace_run is not None:
                trace_run.add_outputs(
                    {
                        "facts": output.facts.model_dump(mode="json"),
                        "model": output.model,
                        "prompt_name": output.prompt_name,
                        "prompt_version": output.prompt_version,
                        "prompt_source": output.prompt_source,
                    }
                )
        detail = None
        if not output.facts.usable:
            detail = output.facts.warnings[0] if output.facts.warnings else "The media is unusable."
        run_result = MediaFactsRunResult(
            ok=output.facts.usable,
            facts=output.facts,
            detail=detail,
            model=output.model,
            input_tokens=output.input_tokens,
            output_tokens=output.output_tokens,
            cost_usd=output.cost_usd,
            prompt_name=output.prompt_name,
            prompt_version=output.prompt_version,
            prompt_source=output.prompt_source,
        )
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "correlation_id": correlation_id,
                "agent_name": MEDIA_FACTS_AGENT_NAME,
                "model": settings.VISION_MODEL,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "status": "failed",
                "error_message": str(exc),
            }
        )
        raise

    await _record_run(
        {
            "user_id": user_id,
            "correlation_id": correlation_id,
            "agent_name": MEDIA_FACTS_AGENT_NAME,
            "model": run_result.model or settings.VISION_MODEL,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "input_tokens": run_result.input_tokens,
            "output_tokens": run_result.output_tokens,
            "cost_usd": run_result.cost_usd,
            "status": "ok" if run_result.ok else "failed",
            "error_message": run_result.detail if not run_result.ok else None,
            "output": {
                "usable": bool(run_result.facts and run_result.facts.usable),
                "item_count": len(run_result.facts.items) if run_result.facts else 0,
                "prompt_name": run_result.prompt_name,
                "prompt_version": run_result.prompt_version,
                "prompt_source": run_result.prompt_source,
            },
        }
    )
    return run_result
