"""Validated application services for the global dish catalog."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from app.domain.dishes import repository as dish_repo
from app.domain.dishes.models import CatalogAuditIdentity, NutrientsPerUnit


async def create_global_dish(
    *,
    audit: CatalogAuditIdentity,
    canonical_name: str,
    category: str,
    nutrients_per_unit: NutrientsPerUnit,
    aliases: Sequence[str] = (),
) -> dict[str, Any]:
    """Create one audited dish whose nutrition is for one fixed category unit."""
    if not audit.actor_user_id:
        raise ValueError("Catalog writes require an authenticated actor")
    categories = {str(row["category"]) for row in await dish_repo.list_active_categories()}
    if category not in categories:
        raise ValueError("Category is not in the active static catalog")
    if category != "unknown" and any(
        value is None
        for value in (
            nutrients_per_unit.protein_g,
            nutrients_per_unit.carbs_g,
            nutrients_per_unit.fat_g,
        )
    ):
        raise ValueError("Protein, carbs, and fat are required for named dishes")
    return await dish_repo.create_global_dish(
        actor_user_id=audit.actor_user_id,
        actor=audit.actor.value,
        name=canonical_name,
        category=category,
        nutrients_per_unit=nutrients_per_unit.model_dump(exclude_none=True),
        source=audit.actor.value,
        aliases=list(aliases),
    )
