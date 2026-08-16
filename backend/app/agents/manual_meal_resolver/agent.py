"""Build and invoke the middleware-driven manual meal resolver."""

from __future__ import annotations

import json
from typing import Any

from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy

from app.agents.manual_meal_resolver.middleware import (
    ManualResolverPromptMiddleware,
    resolve_manual_resolver_model,
)
from app.agents.manual_meal_resolver.models import ManualResolution, ManualResolverInput
from app.agents.manual_meal_resolver.state import ManualMealResolverState
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.services.prompts import ResolvedPrompt
from app.tools.manual_meal_resolver_tools import manual_meal_resolver_tools

MANUAL_MEAL_RESOLVER_AGENT_NAME = "manual_meal_resolver"


def _tool_payload(result: dict[str, Any], tool_name: str) -> dict[str, Any] | None:
    for message in reversed(result.get("messages") or []):
        if getattr(message, "name", None) != tool_name:
            continue
        content = getattr(message, "content", None)
        if isinstance(content, dict):
            payload = content
        elif isinstance(content, str):
            try:
                payload = json.loads(content)
            except json.JSONDecodeError:
                continue
        else:
            continue
        if payload.get("status") == "OK":
            return payload
    return None


def _resolution_from_tools(result: dict[str, Any]) -> ManualResolution | None:
    created = _tool_payload(result, "create_global_dish")
    updated = _tool_payload(result, "update_meal_resolution")
    meal = (updated or {}).get("meal") or {}
    updated_meal_id = str(meal["id"]) if meal.get("id") else None
    if created:
        return ManualResolution(
            action="create_new",
            selected_food_id=str(created["food_id"]),
            category=str(created["category"]),
            canonical_name=str(created["name"]),
            per_100g=created["per_100g"],
            updated_meal_id=updated_meal_id,
            confidence="medium",
            reason="Recovered the successful global-dish tool result.",
        )
    if updated and meal.get("food_id"):
        return ManualResolution(
            action="match_existing",
            selected_food_id=str(meal["food_id"]),
            updated_meal_id=updated_meal_id,
            confidence="medium",
            reason="Recovered the successful meal-update tool result.",
        )
    return None


def _resolver_state(resolver_input: ManualResolverInput) -> dict[str, Any]:
    values = resolver_input.model_dump(mode="json")
    return {
        "messages": [{"role": "user", "content": "Resolve the supplied manual meal."}],
        "meal_id": json.dumps(values["meal_id"]),
        "dish_name": json.dumps(values["dish_name"], ensure_ascii=False),
        "servings": json.dumps(values["servings"]),
        "global_dishes": json.dumps(values["global_dishes"], separators=(",", ":"), sort_keys=True),
        "global_categories": json.dumps(
            values["global_categories"], separators=(",", ":"), sort_keys=True
        ),
        "household_portions": json.dumps(
            values["household_portions"], separators=(",", ":"), sort_keys=True
        ),
    }


async def build_manual_meal_resolver_agent(
    _config: dict[str, Any] | None = None,
) -> tuple[Any, ManualResolverPromptMiddleware]:
    middleware = ManualResolverPromptMiddleware()
    agent = create_agent(
        model=resolve_manual_resolver_model(),
        tools=manual_meal_resolver_tools,
        name=MANUAL_MEAL_RESOLVER_AGENT_NAME,
        state_schema=ManualMealResolverState,
        context_schema=NutrientTrackerRuntimeContext,
        response_format=ToolStrategy(ManualResolution),
        middleware=[middleware],
    )
    return agent, middleware


async def resolve_manual_meal(
    resolver_input: ManualResolverInput, *, user_id: str
) -> tuple[ManualResolution, ResolvedPrompt, Any]:
    config = {
        "configurable": {
            "user_id": user_id,
            "meal_id": resolver_input.meal_id,
        }
    }
    context = NutrientTrackerRuntimeContext(user_id=user_id)
    agent, middleware = await build_manual_meal_resolver_agent(config)
    result = await agent.ainvoke(
        _resolver_state(resolver_input),
        config=config,
        context=context,
    )
    response = result.get("structured_response")
    if response is None:
        response = _resolution_from_tools(result)
    if response is None:
        raise ValueError("OpenAI returned no manual meal resolution or successful tool result")
    resolution = (
        response
        if isinstance(response, ManualResolution)
        else ManualResolution.model_validate(response)
    )
    if middleware.resolved_prompt is None:
        raise RuntimeError("Manual resolver middleware did not resolve a prompt")
    return resolution, middleware.resolved_prompt, result
