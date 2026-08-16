from __future__ import annotations

from typing import Any

import pytest

from app.domain.dishes import service
from app.domain.dishes.models import CatalogActor, CatalogAuditIdentity, NutrientsPerUnit


async def test_unknown_dish_accepts_declared_micronutrients_without_invented_macros(
    monkeypatch,
) -> None:
    captured: dict[str, Any] = {}

    async def categories() -> list[dict[str, Any]]:
        return [{"category": "unknown"}]

    async def create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"dish_id": "dish-1"}

    monkeypatch.setattr(service.dish_repo, "list_active_categories", categories)
    monkeypatch.setattr(service.dish_repo, "create_global_dish", create)

    await service.create_global_dish(
        audit=CatalogAuditIdentity("user-1", CatalogActor.MEDIA_MEAL_RESOLVER),
        canonical_name="Unknown dish 2026-08-16 14:30:00 UTC #1",
        category="unknown",
        nutrients_per_unit=NutrientsPerUnit(vitamin_b12_ug=2.4),
    )

    assert captured["nutrients_per_unit"] == {"vitamin_b12_ug": 2.4}


async def test_named_dish_requires_all_macros(monkeypatch) -> None:
    async def categories() -> list[dict[str, Any]]:
        return [{"category": "fruit"}]

    monkeypatch.setattr(service.dish_repo, "list_active_categories", categories)

    with pytest.raises(ValueError, match="Protein, carbs, and fat"):
        await service.create_global_dish(
            audit=CatalogAuditIdentity("user-1", CatalogActor.MANUAL_MEAL_RESOLVER),
            canonical_name="Amla",
            category="fruit",
            nutrients_per_unit=NutrientsPerUnit(protein_g=1),
        )
