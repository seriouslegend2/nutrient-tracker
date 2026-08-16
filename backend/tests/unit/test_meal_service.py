from __future__ import annotations

import math
from datetime import date
from typing import Any

import pytest

from app.agents.manual_meal_resolver.models import ResolvedManualDish
from app.api.v1.meals_router import MealCreateRequest
from app.core.exceptions import ValidationError
from app.domain.dishes.resolve import Resolution
from app.domain.meals import service
from app.domain.meals.servings import normalize_meal_servings


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


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.1, 0.5), (1.24, 1.0), (1.25, 1.5), (1.74, 1.5), (1.75, 2.0), (3, 3.0)],
)
def test_meal_servings_round_half_up_to_half_units(value: float, expected: float) -> None:
    assert normalize_meal_servings(value) == expected


async def test_prepare_item_normalizes_before_resolution(monkeypatch) -> None:
    async def find_by_name(_name: str) -> None:
        return None

    captured: dict[str, Any] = {}

    async def resolve(**kwargs: Any) -> Resolution:
        captured.update(kwargs)
        return Resolution("katori", 160, 240, {"protein_g": 24}, "category_global")

    monkeypatch.setattr(service.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(service, "resolve_item", resolve)

    item = await service._prepare_item(
        user_id="user-1",
        meal_type="lunch",
        dish_name="Dal",
        grams=200,
        portions=1.25,
    )

    assert captured["portions"] == 1.5
    assert item["portions"] == 1.5


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
        meal_date=date(2026, 8, 16),
        meal_type="dinner",
        nutrients={"calories_kcal": 500},
    )

    assert by_id.dish_name is None
    assert generic.nutrients == {"calories_kcal": 500}


def test_meal_request_normalizes_servings() -> None:
    request = MealCreateRequest(
        meal_date="2026-08-16", meal_type="lunch", dish_name="Dal", portions=1.25
    )

    assert request.portions == 1.5


async def test_unmatched_servings_remain_loggable_without_grams(monkeypatch) -> None:
    async def no_match(_name: str) -> None:
        return None

    async def unresolved(**_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(service.dish_repo, "find_by_name", no_match)
    monkeypatch.setattr(service, "run_manual_meal_resolver", unresolved)

    item = await service._prepare_item(
        user_id="user-1",
        meal_type="snacks",
        dish_name="Restaurant tasting portion",
        portions=1.5,
    )

    assert item["food_id"] is None
    assert item["portions"] == 1.5
    assert item["portion_unit"] == "serving"
    assert item["grams"] is None
    assert item["nutrients"] == {}
    assert item["resolved_from"] == "unknown"


async def test_unmatched_meal_is_inserted_then_resolved_by_meal_id(monkeypatch) -> None:
    async def no_match(_name: str) -> None:
        return None

    captured: dict[str, Any] = {}

    async def match(**kwargs: Any) -> ResolvedManualDish:
        captured.update(kwargs)
        return ResolvedManualDish(
            food_id="dish-1",
            name="Chicken curry",
            category="protein_main",
            confidence="high",
            action="match_existing",
            updated_meal_id="meal-2",
        )

    async def insert(row: dict[str, Any]) -> dict[str, Any]:
        return {"id": "meal-1", **row}

    async def get_meal(_user_id: str, meal_id: str) -> dict[str, Any]:
        assert meal_id == "meal-2"
        return {
            "id": "meal-2",
            "food_id": "dish-1",
            "category": "protein_main",
            "portions": 2,
            "portion_unit": "serving",
            "grams": 300,
            "nutrients": {"protein_g": 54},
            "resolved_from": "category_household",
        }

    monkeypatch.setattr(service.dish_repo, "find_by_name", no_match)
    monkeypatch.setattr(service, "run_manual_meal_resolver", match)
    monkeypatch.setattr(service.repo, "insert_meal", insert)
    monkeypatch.setattr(service.repo, "get_meal", get_meal)

    item = await service.add_item(
        user_id="user-1",
        meal_date=date(2026, 8, 16),
        meal_type="dinner",
        dish_name="home chicken curry",
        portions=2,
    )

    assert captured["meal_id"] == "meal-1"
    assert captured["servings"] == 2
    assert item["food_id"] == "dish-1"
    assert item["category"] == "protein_main"
    assert item["grams"] == 300
    assert item["nutrients"] == {"protein_g": 54}


def test_exact_user_nutrition_does_not_add_unstated_calories() -> None:
    assert service._normalise_supplied_nutrients(
        {"protein_g": 50, "carbs_g": 330}, derive_calories=False
    ) == {"protein_g": 50.0, "carbs_g": 330.0}
