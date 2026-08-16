"""Build and invoke the tool-enabled media meal resolver."""

from __future__ import annotations

import json
from typing import Any

from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy

from app.agents.media_meal_resolver.middleware import (
    MediaResolverPromptMiddleware,
    resolve_media_resolver_model,
)
from app.agents.media_meal_resolver.models import MediaResolutionPlan, MediaResolverInput
from app.agents.media_meal_resolver.state import MediaMealResolverState
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.services.prompts import ResolvedPrompt
from app.tools.media_meal_resolver_tools import media_meal_resolver_tools

MEDIA_MEAL_RESOLVER_AGENT_NAME = "media_meal_resolver"


def _json_content(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _structured_plan(result: dict[str, Any]) -> MediaResolutionPlan | None:
    response = result.get("structured_response")
    if response is not None:
        return (
            response
            if isinstance(response, MediaResolutionPlan)
            else MediaResolutionPlan.model_validate(response)
        )
    for message in reversed(result.get("messages") or []):
        for call in reversed(getattr(message, "tool_calls", None) or []):
            if call.get("name") == "MediaResolutionPlan":
                return MediaResolutionPlan.model_validate(call.get("args") or {})
    return None


def _bind_creation_results(
    plan: MediaResolutionPlan,
    result: dict[str, Any],
    supplied_food_ids: set[str] | None = None,
) -> MediaResolutionPlan:
    supplied_food_ids = supplied_food_ids or set()
    created: dict[str, dict[str, Any]] = {}
    for message in result.get("messages") or []:
        if getattr(message, "name", None) != "create_global_dish":
            continue
        payload = _json_content(getattr(message, "content", None))
        if not payload or payload.get("status") != "OK" or not payload.get("evidence_id"):
            continue
        evidence_id = str(payload["evidence_id"])
        if evidence_id in created and created[evidence_id].get("food_id") != payload.get("food_id"):
            raise ValueError(f"Multiple global dishes were created for evidence {evidence_id}")
        created[evidence_id] = payload

    decisions = []
    for decision in plan.decisions:
        tool_result = created.get(decision.evidence_id)
        if tool_result:
            food_id = str(tool_result["food_id"])
            if food_id in supplied_food_ids:
                decisions.append(
                    decision.model_copy(
                        update={
                            "action": "match_existing",
                            "selected_food_id": food_id,
                            "canonical_name": None,
                            "category": None,
                        }
                    )
                )
                continue
            decisions.append(
                decision.model_copy(
                    update={
                        "action": "create_new",
                        "selected_food_id": food_id,
                        "canonical_name": str(tool_result["name"]),
                        "category": str(tool_result["category"]),
                    }
                )
            )
            continue
        decisions.append(decision)
    return MediaResolutionPlan(decisions=decisions)


def _resolver_state(resolver_input: MediaResolverInput) -> dict[str, Any]:
    return {
        "messages": [{"role": "user", "content": "Resolve the supplied media facts."}],
        "resolver_input": json.dumps(
            resolver_input.model_dump(mode="json"),
            separators=(",", ":"),
            sort_keys=True,
        ),
    }


async def build_media_meal_resolver_agent() -> tuple[Any, MediaResolverPromptMiddleware]:
    middleware = MediaResolverPromptMiddleware()
    agent = create_agent(
        model=resolve_media_resolver_model(),
        tools=media_meal_resolver_tools,
        name=MEDIA_MEAL_RESOLVER_AGENT_NAME,
        state_schema=MediaMealResolverState,
        context_schema=NutrientTrackerRuntimeContext,
        response_format=ToolStrategy(MediaResolutionPlan),
        middleware=[middleware],
    )
    return agent, middleware


async def resolve_media_meals(
    resolver_input: MediaResolverInput, *, user_id: str, thread_id: str
) -> tuple[MediaResolutionPlan, ResolvedPrompt, Any]:
    config = {
        "configurable": {
            "user_id": user_id,
            "thread_id": thread_id,
            "fallback_names": resolver_input.fallback_names,
        }
    }
    context = NutrientTrackerRuntimeContext(user_id=user_id, thread_id=thread_id)
    agent, middleware = await build_media_meal_resolver_agent()
    result = await agent.ainvoke(
        _resolver_state(resolver_input),
        config=config,
        context=context,
    )
    plan = _structured_plan(result)
    if plan is None:
        raise ValueError("OpenAI returned no media meal resolution")
    plan = _bind_creation_results(
        plan,
        result,
        {dish.food_id for dish in resolver_input.global_dishes},
    )
    if middleware.resolved_prompt is None:
        raise RuntimeError("Media resolver middleware did not resolve a prompt")
    return plan, middleware.resolved_prompt, result
