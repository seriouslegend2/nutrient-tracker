"""Runtime entry point for the nutrition chat agent."""

from __future__ import annotations

import json
import time
from typing import Any

from langchain_core.messages import ToolMessage

from app.agents.nutrition_chat.models import ChatResponse, ChatTurn, ToolCallSummary
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.config.settings import settings
from app.domain.messages import repository as message_repo
from app.services.prompts import trace_agent
from app.utils.logger import logger


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


def _action_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return None
    if not isinstance(value, dict):
        return None
    candidate = value.get("agent_action")
    if not isinstance(candidate, dict):
        return None
    if not all(candidate.get(key) for key in ("id", "action_type", "summary", "status")):
        return None
    return {
        key: candidate.get(key)
        for key in (
            "id",
            "user_id",
            "action_type",
            "summary",
            "status",
            "expires_at",
            "confirmed_at",
            "execution_started_at",
            "completed_at",
            "result",
            "error",
            "created_at",
            "updated_at",
        )
    }


def _executed_actions(result: dict[str, Any]) -> list[dict[str, Any]]:
    actions: dict[str, dict[str, Any]] = {}
    for message in result.get("messages") or []:
        if not isinstance(message, ToolMessage):
            continue
        candidates: list[Any] = [message.content, getattr(message, "artifact", None)]
        if isinstance(message.content, list):
            candidates.extend(
                block.get("text") if isinstance(block, dict) else block for block in message.content
            )
        for value in candidates:
            action = _action_payload(value)
            if action:
                actions[str(action["id"])] = action
    return list(actions.values())


def _executed_tool_calls(result: dict[str, Any]) -> list[ToolCallSummary]:
    calls: list[ToolCallSummary] = []
    for message in result.get("messages") or []:
        if not isinstance(message, ToolMessage):
            continue
        action = _action_payload(message.content)
        detail = (
            {
                "action_id": action["id"],
                "action_type": action["action_type"],
                "action_status": action["status"],
            }
            if action
            else {}
        )
        calls.append(
            ToolCallSummary(
                tool=message.name or "unknown",
                status="ERROR" if getattr(message, "status", "success") == "error" else "OK",
                detail=detail,
            )
        )
    return calls


async def run_nutrition_chat_agent(
    *,
    user_id: str,
    thread_id: str,
    messages: list[dict[str, str]],
    pending_media_draft: dict[str, Any] | None = None,
    correlation_id: str | None = None,
    timezone: str = "UTC",
    source_message_id: str | None = None,
    auto_execute_actions: bool = True,
) -> ChatTurn:
    """Run one authenticated chat turn and normalize its structured response."""
    started = time.perf_counter()
    payload = pending_media_draft or {}
    config = {
        "configurable": {
            "user_id": user_id,
            "thread_id": thread_id,
            "timezone": timezone,
            "source_message_id": source_message_id,
            "auto_execute_actions": auto_execute_actions,
        }
    }
    context = NutrientTrackerRuntimeContext(
        user_id=user_id,
        thread_id=thread_id,
        timezone=timezone,
    )
    try:
        from app.agents.nutrition_chat.agent import build_nutrition_chat_agent

        agent = await build_nutrition_chat_agent()
        trace_inputs = {
            "user_id": user_id,
            "thread_id": thread_id,
            "correlation_id": correlation_id,
            "source_message_id": source_message_id,
            "timezone": timezone,
            "messages": messages,
            "pending_media_draft": payload or None,
        }
        with trace_agent(
            "nutrition_chat",
            {
                "correlation_id": correlation_id,
                "model": settings.ORCHESTRATION_MODEL,
                "thread_id": thread_id,
                "user_id": user_id,
            },
            inputs=trace_inputs,
        ) as trace_run:
            result = await agent.ainvoke(
                {
                    "messages": messages,
                    "user_id": user_id,
                    "pending_media_draft": json.dumps(
                        payload or None,
                        ensure_ascii=True,
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                },
                config=config,
                context=context,
            )
            response = result.get("structured_response")
            if response is None:
                raise RuntimeError("Nutrition agent returned no structured response")
            model_response = (
                response
                if isinstance(response, ChatResponse)
                else ChatResponse.model_validate(response)
            )
            actions = _executed_actions(result)
            reply = model_response.reply
            completed_actions = [action for action in actions if action.get("status") == "completed"]
            failed_actions = [action for action in actions if action.get("status") == "failed"]
            if auto_execute_actions and failed_actions:
                reply = "I couldn't apply that change, so your tracker was not updated."
            pending_actions = [action for action in actions if action.get("status") == "proposed"]
            if auto_execute_actions and actions and len(completed_actions) != len(actions):
                logger.warning(
                    "nutrition_chat_action_not_completed user_id={} correlation_id={}",
                    user_id,
                    correlation_id,
                )
            turn = ChatTurn(
                reply=reply,
                tool_calls=_executed_tool_calls(result),
                needs_confirmation=bool(pending_actions),
                agent_actions=actions,
            )
            if trace_run is not None:
                trace_run.add_outputs(turn.model_dump(mode="json"))
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "correlation_id": correlation_id,
                "agent_name": "nutrition_chat",
                "model": settings.ORCHESTRATION_MODEL,
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
            "model": settings.ORCHESTRATION_MODEL,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_usd,
            "status": "ok",
            "output": turn.model_dump(mode="json"),
        }
    )
    return turn
