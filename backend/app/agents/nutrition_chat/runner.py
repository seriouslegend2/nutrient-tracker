"""Runtime entry point for the nutrition chat agent."""

from __future__ import annotations

import re
import time
from typing import Any

from app.agents.nutrition_chat.models import ChatTurn
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.config.settings import settings
from app.domain.messages import repository as message_repo
from app.utils.logger import logger

_EXPLICIT_MUTATION = re.compile(
    r"^\s*(?:please\s+)?(?:log|add|record|remove|delete|set|change|update|correct)\b",
    re.IGNORECASE,
)
_EXPLICIT_CONFIRMATIONS = {
    "yes",
    "yes please",
    "confirm",
    "confirmed",
    "go ahead",
    "do it",
    "please do",
}


def _allow_mutations(messages: list[dict[str, str]], payload: dict[str, Any]) -> bool:
    """Ambiguous meal text is read-only until the user gives an explicit instruction."""
    if payload:
        return False
    latest = next(
        (
            message.get("content", "")
            for message in reversed(messages)
            if message.get("role") == "user"
        ),
        "",
    )
    normalized = latest.strip().lower().rstrip(".!?")
    if _EXPLICIT_MUTATION.search(latest):
        return True
    has_prior_assistant = any(message.get("role") == "assistant" for message in messages[:-1])
    return has_prior_assistant and normalized in _EXPLICIT_CONFIRMATIONS


def _usage(result: dict[str, Any]) -> tuple[int | None, int | None, float | None]:
    input_tokens = 0
    output_tokens = 0
    cost_usd = 0.0
    has_input = has_output = has_cost = False
    for message in result.get("messages") or []:
        usage = getattr(message, "usage_metadata", None) or {}
        metadata = getattr(message, "response_metadata", None) or {}
        if usage.get("input_tokens") is not None:
            input_tokens += int(usage["input_tokens"])
            has_input = True
        if usage.get("output_tokens") is not None:
            output_tokens += int(usage["output_tokens"])
            has_output = True
        cost = usage.get("cost_usd") or metadata.get("cost_usd")
        if cost is not None:
            cost_usd += float(cost)
            has_cost = True
    return (
        input_tokens if has_input else None,
        output_tokens if has_output else None,
        cost_usd if has_cost else None,
    )


async def _record_run(row: dict[str, Any]) -> None:
    try:
        await message_repo.create_agent_run(row)
    except Exception as exc:
        logger.warning("agent_run_persist_failed agent=nutrition_chat error={}", str(exc))


async def run_nutrition_chat_agent(
    *,
    user_id: str,
    thread_id: str,
    messages: list[dict[str, str]],
    extraction_payload: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> ChatTurn:
    """Run one authenticated chat turn and normalize its structured response."""
    started = time.perf_counter()
    payload = extraction_payload or {}
    config = {"configurable": {"user_id": user_id, "thread_id": thread_id}}
    context = NutrientTrackerRuntimeContext(user_id=user_id, thread_id=thread_id)
    allow_mutations = _allow_mutations(messages, payload)
    try:
        from app.agents.nutrition_chat.agent import build_nutrition_chat_agent

        agent = await build_nutrition_chat_agent(allow_mutations=allow_mutations)
        result = await agent.ainvoke(
            {
                "messages": messages,
                "user_id": user_id,
                "user_profile": "",
                "active_goal": "",
                "preferences": "",
                "extraction_payload": payload,
            },
            config=config,
            context=context,
        )
        response = result.get("structured_response")
        if response is None:
            raise RuntimeError("Nutrition agent returned no structured response")
        turn = response if isinstance(response, ChatTurn) else ChatTurn.model_validate(response)
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "correlation_id": correlation_id,
                "agent_name": "nutrition_chat",
                "model": settings.CHAT_MODEL,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "status": "failed",
                "error_message": str(exc),
            }
        )
        raise

    input_tokens, output_tokens, cost_usd = _usage(result)
    await _record_run(
        {
            "user_id": user_id,
            "correlation_id": correlation_id,
            "agent_name": "nutrition_chat",
            "model": settings.CHAT_MODEL,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_usd,
            "status": "ok",
            "output": turn.model_dump(mode="json"),
        }
    )
    return turn
