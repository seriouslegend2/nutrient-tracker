"""Bounded catalog search for the nutrition chat orchestrator."""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

from app.domain.dishes import repository as dish_repo


class SearchFoodCatalogInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1, max_length=120, description="Food-name search text")
    limit: int = Field(..., ge=1, le=10, description="Maximum candidates to return")


@tool("search_food_catalog", args_schema=SearchFoodCatalogInput)
async def search_food_catalog(
    query: str, limit: int = 5, config: RunnableConfig = None
) -> dict[str, Any]:
    """Search active foods before selecting an identity for a meal.

    Use this when a food name could map to multiple catalog foods. Unmatched
    free text remains loggable through manage_meal_entry with a null food_id.
    """
    items, total = await dish_repo.search_dishes(query, limit=limit)
    return {
        "status": "OK",
        "candidates": [
            {
                "food_id": row.get("dish_id"),
                "name": row.get("name"),
                "aliases": row.get("aliases") or [],
                "category": row.get("category"),
                "portion_unit": row.get("portion_unit"),
                "portion_grams": row.get("portion_grams"),
            }
            for row in items
        ],
        "total": total,
    }


# Internal compatibility alias; its model-visible name remains search_food_catalog.
search_dishes = search_food_catalog

__all__ = ["SearchFoodCatalogInput", "search_dishes", "search_food_catalog"]
