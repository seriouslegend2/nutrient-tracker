"""Public invocation entry point for the media extraction LangGraph."""

from __future__ import annotations

import time
from typing import Any

from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.config.settings import settings
from app.domain.messages import repository as message_repo
from app.services.media_extraction import ExtractionResult
from app.utils.logger import logger


async def _record_run(row: dict[str, Any]) -> None:
    try:
        await message_repo.create_agent_run(row)
    except Exception as exc:
        logger.warning("agent_run_persist_failed agent=media_extraction error={}", str(exc))


async def run_media_extraction_agent(
    *,
    user_id: str,
    thread_id: str,
    mime_type: str,
    data_b64: str,
    user_text: str | None = None,
    filename: str | None = None,
    samples: int = 1,
    correlation_id: str | None = None,
) -> ExtractionResult:
    started = time.perf_counter()
    config = {"configurable": {"user_id": user_id, "thread_id": thread_id}}
    context = NutrientTrackerRuntimeContext(user_id=user_id, thread_id=thread_id)
    try:
        from app.agents.media_extraction.agent import build_media_extraction_agent

        agent = await build_media_extraction_agent(config)
        result = await agent.ainvoke(
            {
                "messages": [{"role": "user", "content": "Extract the attached media."}],
                "mime_type": mime_type,
                "data_b64": data_b64,
                "user_text": user_text or "",
                "filename": filename or "",
                "samples": samples,
            },
            config=config,
            context=context,
        )
        response = result.get("structured_response")
        if not isinstance(response, dict):
            raise RuntimeError("Media extraction agent returned no structured response")
        extraction = ExtractionResult(**response)
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "correlation_id": correlation_id,
                "agent_name": "media_extraction",
                "model": (
                    settings.AUDIO_MODEL
                    if mime_type.startswith("audio/")
                    else settings.VISION_MODEL
                ),
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
            "agent_name": "media_extraction",
            "model": extraction.model
            or (settings.AUDIO_MODEL if mime_type.startswith("audio/") else settings.VISION_MODEL),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "input_tokens": extraction.input_tokens,
            "output_tokens": extraction.output_tokens,
            "cost_usd": extraction.cost_usd,
            "status": "ok" if extraction.ok else "failed",
            "error_message": extraction.detail if not extraction.ok else None,
            "output": {
                "ok": extraction.ok,
                "detail": extraction.detail,
                "item_count": len(extraction.payload.get("items") or []),
            },
        }
    )
    return extraction
