"""The two constrained tools owned by manual_meal_resolver."""

from __future__ import annotations

import re
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agents.manual_meal_resolver.models import Per100GNutrients
from app.domain.dishes import repository as dish_repo
from app.domain.dishes.resolve import resolve_item
from app.domain.meals import repository as meal_repo

_GENERIC_MEAL_WORDS = {
    "bowl",
    "combo",
    "dish",
    "food",
    "meal",
    "plate",
    "platter",
    "portion",
    "thali",
}


def _is_generic_meal_name(value: str) -> bool:
    words = set(re.findall(r"[a-z0-9]+", value.lower()))
    return not words or bool(words & _GENERIC_MEAL_WORDS)


def _context(config: RunnableConfig) -> tuple[str | None, str | None]:
    configurable = (config or {}).get("configurable", {})
    return configurable.get("user_id"), configurable.get("meal_id")


class CreateGlobalDishInput(BaseModel):
    canonical_name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    per_100g: Per100GNutrients
    alias: str | None = None


@tool(args_schema=CreateGlobalDishInput)
async def create_global_dish(
    canonical_name: str,
    category: str,
    per_100g: dict[str, float],
    alias: str | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Create an idempotent global dish from a validated per-100g nutrient estimate."""
    user_id, _ = _context(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    if _is_generic_meal_name(canonical_name) or (alias and _is_generic_meal_name(alias)):
        return {
            "status": "ERROR",
            "message": "Generic or mixed meal descriptions cannot be added to the global catalog",
        }
    categories = {str(row["category"]) for row in await dish_repo.list_active_categories()}
    if category not in categories:
        return {"status": "ERROR", "message": "Category is not in the active static catalog"}
    nutrients = Per100GNutrients.model_validate(per_100g).model_dump(exclude_none=True)
    created = await dish_repo.create_global_dish(
        actor_user_id=user_id,
        actor="manual_meal_resolver",
        name=canonical_name,
        category=category,
        per_100g=nutrients,
        source="manual_meal_resolver",
        aliases=[alias] if alias else [],
    )
    return {
        "status": "OK",
        "food_id": str(created["dish_id"]),
        "name": str(created["name"]),
        "category": str(created["category"]),
    }


class UpdateMealResolutionInput(BaseModel):
    meal_id: str = Field(min_length=1)
    food_id: str = Field(min_length=1)


@tool(args_schema=UpdateMealResolutionInput)
async def update_meal_resolution(
    meal_id: str,
    food_id: str,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Atomically map the expected unresolved meal and freeze calculated nutrition."""
    user_id, expected_meal_id = _context(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    if not expected_meal_id or meal_id != expected_meal_id:
        return {"status": "ERROR", "message": "meal_id is outside this resolver invocation"}
    current = await meal_repo.get_meal(user_id, meal_id)
    if not current or not current.get("is_active"):
        return {"status": "ERROR", "message": "Active meal was not found"}
    if current.get("food_id"):
        return {"status": "ERROR", "message": "Meal is already resolved"}
    dish = await dish_repo.get_dish(food_id)
    if not dish:
        return {"status": "ERROR", "message": "Global dish was not found"}
    resolution = await resolve_item(
        user_id=user_id,
        dish_name=current["dish_name"],
        food_id=food_id,
        category=dish["category"],
        portions=float(current["portions"]),
    )
    updated = await meal_repo.update_meal(
        user_id,
        meal_id,
        {
            "food_id": food_id,
            "category": dish["category"],
            "portion_unit": resolution.portion_unit,
            "grams": resolution.grams,
            "nutrients": resolution.nutrients,
            "resolved_from": resolution.resolved_from,
        },
    )
    if not updated:
        return {"status": "ERROR", "message": "Meal update failed"}
    if (
        str(updated.get("food_id") or "") != food_id
        or str(updated.get("category") or "") != str(dish["category"])
    ):
        return {
            "status": "ERROR",
            "message": "Meal versioning did not preserve food_id and category; deploy the manual resolution migration",
        }
    return {"status": "OK", "meal": updated}


manual_meal_resolver_tools = [
    create_global_dish,
    update_meal_resolution,
]
