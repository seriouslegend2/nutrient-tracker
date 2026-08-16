"""Catalog mutation tool owned by media_meal_resolver."""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.domain.dishes import service as dish_service
from app.domain.dishes.models import CatalogActor, CatalogAuditIdentity, NutrientsPerUnit


class CreateGlobalDishInput(BaseModel):
    evidence_id: str = Field(min_length=1)
    canonical_name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    nutrients_per_unit: NutrientsPerUnit
    alias: str | None = None


@tool(args_schema=CreateGlobalDishInput)
async def create_global_dish(
    evidence_id: str,
    canonical_name: str,
    category: str,
    nutrients_per_unit: dict[str, float],
    alias: str | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Create an idempotent global dish when no supplied catalog dish matches."""
    configurable = (config or {}).get("configurable", {})
    user_id = configurable.get("user_id")
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    if category == "unknown":
        fallback_names = configurable.get("fallback_names") or {}
        expected_name = str(fallback_names.get(evidence_id) or "")
        if not expected_name or canonical_name != expected_name:
            return {
                "status": "ERROR",
                "message": "Unknown items must use the application-provided timestamped name",
            }
    nutrients = NutrientsPerUnit.model_validate(nutrients_per_unit)
    try:
        created = await dish_service.create_global_dish(
            audit=CatalogAuditIdentity(
                actor_user_id=user_id,
                actor=CatalogActor.MEDIA_MEAL_RESOLVER,
            ),
            canonical_name=canonical_name,
            category=category,
            nutrients_per_unit=nutrients,
            aliases=[alias] if alias else [],
        )
    except ValueError as exc:
        return {"status": "ERROR", "message": str(exc)}
    return {
        "status": "OK",
        "evidence_id": evidence_id,
        "food_id": str(created["dish_id"]),
        "name": str(created["name"]),
        "category": str(created["category"]),
    }


media_meal_resolver_tools = [create_global_dish]
