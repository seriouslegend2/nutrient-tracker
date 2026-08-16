from __future__ import annotations

from typing import Any

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
