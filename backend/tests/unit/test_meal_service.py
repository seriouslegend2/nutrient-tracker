from __future__ import annotations

import math
from typing import Any

import pytest

from app.api.v1.meals_router import MealCreateRequest
from app.core.exceptions import ValidationError
from app.domain.dishes.resolve import Resolution
from app.domain.meals import service


async def test_portion_edit_re_resolves_the_current_household_serving(monkeypatch) -> None:
    resolution_calls: list[dict[str, Any]] = []

    async def get_meal(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {
            "dish_name": "Paneer bhurji",
            "food_id": "dish-1",
            "category": "paneer_tofu",
            "portions": 1,
            "portion_unit": "g",
        }

    async def resolve_item(**kwargs: Any) -> Resolution:
        resolution_calls.append(kwargs)
        return Resolution("serving", 100, 200, {"calories_kcal": 424}, "category_household")

    async def update_meal(_user_id: str, _meal_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return {"id": "meal-2", **patch}

    monkeypatch.setattr(service.repo, "get_meal", get_meal)
    monkeypatch.setattr(service, "resolve_item", resolve_item)
    monkeypatch.setattr(service.repo, "update_meal", update_meal)

    updated = await service.adjust_item(user_id="user-1", meal_id="meal-1", portions=2)

    assert resolution_calls[0]["grams_override"] is None
    assert resolution_calls[0]["portion_unit_override"] is None
    assert resolution_calls[0]["portions"] == 2
    assert updated["portion_unit"] == "serving"
    assert updated["grams"] == 200


async def test_generic_nutrition_entry_uses_slot_label_and_stated_values(monkeypatch) -> None:
    async def find_by_name(_name: str) -> None:
        return None

    monkeypatch.setattr(service.dish_repo, "find_by_name", find_by_name)

    item = await service._prepare_item(
        user_id="user-1",
        meal_type="dinner",
        dish_name=None,
        nutrients={"protein_g": 20, "carbs_g": 30, "fat_g": 10},
    )

    assert item["dish_name"] == "Dinner item"
    assert item["portion_unit"] == "serving"
    assert item["grams"] is None
    assert item["nutrients"] == {
        "protein_g": 20,
        "carbs_g": 30,
        "fat_g": 10,
        "calories_kcal": 290,
    }
    assert item["resolved_from"] == "meals"


async def test_editing_generic_nutrition_scales_stated_values_without_lookup(monkeypatch) -> None:
    async def get_meal(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {
            "dish_name": "Dinner item",
            "food_id": None,
            "category": None,
            "portions": 1,
            "portion_unit": "serving",
            "grams": None,
            "nutrients": {"calories_kcal": 500, "protein_g": 25},
            "resolved_from": "meals",
        }

    async def update_meal(_user_id: str, _meal_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return {"id": "meal-1", **patch}

    async def unexpected_resolve(**_kwargs: Any) -> Resolution:
        raise AssertionError("A stated nutrient entry must not be re-resolved")

    monkeypatch.setattr(service.repo, "get_meal", get_meal)
    monkeypatch.setattr(service.repo, "update_meal", update_meal)
    monkeypatch.setattr(service, "resolve_item", unexpected_resolve)

    updated = await service.adjust_item(user_id="user-1", meal_id="meal-1", portions=1.5)

    assert updated["portions"] == 1.5
    assert updated["nutrients"] == {"calories_kcal": 750, "protein_g": 37.5}
    assert updated["resolved_from"] == "meals"


@pytest.mark.parametrize("value", [-1, math.nan, math.inf])
def test_stated_nutrients_must_be_finite_and_nonnegative(value: float) -> None:
    with pytest.raises(ValidationError, match="finite and nonnegative"):
        service._normalise_supplied_nutrients({"protein_g": value})


def test_meal_request_accepts_food_id_or_stated_nutrients_without_a_name() -> None:
    by_id = MealCreateRequest(meal_date="2026-08-16", meal_type="lunch", food_id="dish-1")
    generic = MealCreateRequest(
        meal_date="2026-08-16",
        meal_type="dinner",
        nutrients={"calories_kcal": 500},
    )

    assert by_id.dish_name is None
    assert generic.nutrients == {"calories_kcal": 500}
