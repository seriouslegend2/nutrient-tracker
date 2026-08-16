"""Build, validate, trace, and apply one manual meal resolution."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Literal

from app.agents.manual_meal_resolver.agent import (
    MANUAL_MEAL_RESOLVER_AGENT_NAME,
    resolve_manual_meal,
)
from app.agents.manual_meal_resolver.models import (
    GlobalCategoryContext,
    GlobalDishContext,
    HouseholdPortionContext,
    ManualResolverInput,
    ResolvedManualDish,
)
from app.config.settings import settings
from app.domain.dishes import repository as dish_repo
from app.domain.meals import repository as meal_repo
from app.domain.messages import repository as message_repo
from app.services.prompts import trace_agent
from app.tools.manual_meal_resolver_tools import update_meal_resolution
from app.utils.logger import logger


async def _record_run(row: dict[str, Any]) -> None:
    try:
        await message_repo.create_agent_run(row)
    except Exception as exc:
        logger.warning("agent_run_persist_failed agent=manual_meal_resolver error={}", str(exc))


def _usage(responses: list[Any]) -> tuple[int | None, int | None, float | None]:
    def value(usage: Any, key: str) -> Any:
        return usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)

    usages: list[Any] = []
    for response in responses:
        if isinstance(response, dict):
            usages.extend(
                usage
                for message in (response.get("messages") or [])
                if (usage := getattr(message, "usage_metadata", None))
            )
        elif usage := getattr(response, "usage", None):
            usages.append(usage)
    input_tokens = [amount for usage in usages if (amount := value(usage, "input_tokens"))]
    output_tokens = [amount for usage in usages if (amount := value(usage, "output_tokens"))]
    costs = [amount for usage in usages if (amount := value(usage, "cost_usd"))]
    return (
        sum(input_tokens) if input_tokens else None,
        sum(output_tokens) if output_tokens else None,
        sum(costs) if costs else None,
    )


def _tool_output(response: Any, tool_name: str) -> dict[str, Any] | None:
    if not isinstance(response, dict):
        return None
    for message in reversed(response.get("messages") or []):
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


async def run_manual_meal_resolver(
    *, user_id: str, meal_id: str, dish_name: str, servings: float
) -> ResolvedManualDish | None:
    """Resolve manual text and atomically map the already-created meal row."""
    if not settings.ai_enabled:
        return None
    started = time.perf_counter()
    prompt_name = prompt_version = prompt_source = None
    try:
        dishes, categories, household = await asyncio.gather(
            dish_repo.list_active_dishes(),
            dish_repo.list_active_categories(),
            dish_repo.list_category_portions(user_id),
        )
        resolver_input = ManualResolverInput(
            meal_id=meal_id,
            dish_name=dish_name.strip(),
            servings=servings,
            global_dishes=[
                GlobalDishContext(
                    food_id=str(row["dish_id"]),
                    name=str(row["name"]),
                    name_normalized=str(row["name_normalized"]),
                    aliases=list(row.get("aliases") or []),
                    category=str(row["category"]),
                    nutrients_per_unit=row.get("nutrients_per_unit") or {},
                    source=str(row.get("source") or "unknown"),
                )
                for row in dishes
            ],
            global_categories=[
                GlobalCategoryContext(
                    category=str(row["category"]),
                    portion_unit=str(row["portion_unit"]),
                    portion_grams=row["portion_grams"],
                    portion_count=row.get("portion_count") or 1,
                )
                for row in categories
            ],
            household_portions=[
                HouseholdPortionContext(
                    category=str(row["category"]),
                    portion_unit=str(row["portion_unit"]),
                    portion_count=row.get("portion_count") or 1,
                    effective_portion_grams=row["effective_portion_grams"],
                    is_custom=bool(row.get("is_custom", False)),
                )
                for row in household
            ],
        )
        with trace_agent(
            MANUAL_MEAL_RESOLVER_AGENT_NAME,
            {"dish_count": len(dishes)},
        ):
            resolution, prompt, response = await resolve_manual_meal(
                resolver_input, user_id=user_id
            )
            responses = [response]
        prompt_name, prompt_version, prompt_source = prompt.name, prompt.version, prompt.source

        dish_by_id = {str(row["dish_id"]): row for row in dishes}
        category_names = {str(row["category"]) for row in categories}
        created_tool_output = _tool_output(response, "create_global_dish")
        updated_tool_output = _tool_output(response, "update_meal_resolution")
        selected: dict[str, Any] | None = None
        action: Literal["match_existing", "create_new"] | None = None
        if created_tool_output:
            selected = await dish_repo.get_dish(str(created_tool_output["food_id"]))
            if not selected:
                raise ValueError("Created tool food_id is not an active global dish")
            action = "create_new"
        elif resolution.action == "match_existing":
            selected = dish_by_id.get(resolution.selected_food_id or "")
            if not selected:
                raise ValueError("Selected food_id is not in the supplied global universe")
            action = "match_existing"
        elif resolution.action == "create_new":
            if resolution.category not in category_names:
                raise ValueError("Selected category is not in the supplied category universe")
            selected = await dish_repo.get_dish(resolution.selected_food_id or "")
            if not selected or str(selected["category"]) != resolution.category:
                raise ValueError(
                    "create_new must use the food_id returned by create_global_dish"
                )
            action = "create_new"

        result = None
        if selected and action:
            food_id = str(selected["dish_id"])
            updated_meal = (updated_tool_output or {}).get("meal")
            if not updated_meal and resolution.updated_meal_id:
                updated_meal = await meal_repo.get_meal(user_id, resolution.updated_meal_id)
            if (
                not updated_meal
                or not updated_meal.get("is_active")
                or str(updated_meal.get("food_id") or "") != food_id
            ):
                updated = await update_meal_resolution.ainvoke(
                    {"meal_id": meal_id, "food_id": food_id},
                    config={"configurable": {"user_id": user_id, "meal_id": meal_id}},
                )
                if updated.get("status") != "OK":
                    raise ValueError(updated.get("message") or "Meal mapping failed")
                updated_meal = updated["meal"]
            result = ResolvedManualDish(
                food_id=food_id,
                name=str(selected["name"]),
                category=str(selected["category"]),
                confidence=resolution.confidence,
                action=action,
                updated_meal_id=str(updated_meal["id"]),
            )

        input_tokens, output_tokens, cost_usd = _usage(responses)
        await _record_run(
            {
                "user_id": user_id,
                "agent_name": MANUAL_MEAL_RESOLVER_AGENT_NAME,
                "model": settings.MANUAL_RESOLVER_MODEL,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": cost_usd,
                "status": "ok",
                "output": {
                    "action": resolution.action,
                    "confidence": resolution.confidence,
                    "prompt_name": prompt_name,
                    "prompt_version": prompt_version,
                    "prompt_source": prompt_source,
                },
            }
        )
        return result
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "agent_name": MANUAL_MEAL_RESOLVER_AGENT_NAME,
                "model": settings.MANUAL_RESOLVER_MODEL,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "status": "failed",
                "error_message": str(exc),
                "output": {
                    "prompt_name": prompt_name,
                    "prompt_version": prompt_version,
                    "prompt_source": prompt_source,
                },
            }
        )
        logger.exception("manual_meal_resolution_failed user_id={} dish={}", user_id, dish_name)
        return None
