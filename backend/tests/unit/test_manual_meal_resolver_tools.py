from __future__ import annotations

from typing import Any

from app.domain.dishes.resolve import Resolution
from app.tools import manual_meal_resolver_tools as tools


async def test_create_tool_uses_agent_estimate_and_static_category(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    async def categories() -> list[dict[str, Any]]:
        return [{"category": "fruit"}]

    async def create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"dish_id": "dish-new", "name": "Amla", "category": "fruit"}

    monkeypatch.setattr(tools.dish_repo, "list_active_categories", categories)
    monkeypatch.setattr(tools.dish_repo, "create_global_dish", create)

    result = await tools.create_global_dish.ainvoke(
        {
            "canonical_name": "Amla",
            "category": "fruit",
            "nutrients_per_unit": {"protein_g": 1.2, "carbs_g": 12, "fat_g": 0.6},
            "alias": "amla",
        },
        config={"configurable": {"user_id": "user-1"}},
    )

    assert result["food_id"] == "dish-new"
    assert captured["actor"] == "manual_meal_resolver"
    assert captured["nutrients_per_unit"] == {
        "protein_g": 1.2,
        "carbs_g": 12,
        "fat_g": 0.6,
    }


async def test_create_tool_rejects_generic_meal_descriptions() -> None:
    result = await tools.create_global_dish.ainvoke(
        {
            "canonical_name": "Special mixed plate",
            "category": "protein_main",
            "nutrients_per_unit": {"protein_g": 22.5, "carbs_g": 15, "fat_g": 12},
            "alias": "restaurant meal",
        },
        config={"configurable": {"user_id": "user-1"}},
    )

    assert result["status"] == "ERROR"
    assert "Generic" in result["message"]


async def test_create_tool_rejects_category_outside_static_catalog(monkeypatch) -> None:
    async def categories() -> list[dict[str, Any]]:
        return [{"category": "fruit"}]

    monkeypatch.setattr(tools.dish_repo, "list_active_categories", categories)

    result = await tools.create_global_dish.ainvoke(
        {
            "canonical_name": "Amla",
            "category": "invented_category",
            "nutrients_per_unit": {"protein_g": 1.2, "carbs_g": 12, "fat_g": 0.6},
        },
        config={"configurable": {"user_id": "user-1"}},
    )

    assert result["status"] == "ERROR"
    assert "static catalog" in result["message"]


async def test_update_tool_maps_only_expected_meal_and_freezes_nutrition(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    async def meal(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {
            "id": "meal-1",
            "is_active": True,
            "food_id": None,
            "dish_name": "home chicken curry",
            "portions": 2,
        }

    async def dish(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-1", "category": "protein_main"}

    async def resolve(**kwargs: Any) -> Resolution:
        assert kwargs["portions"] == 2
        return Resolution(
            "serving", 150, 300, {"protein_g": 54}, "category_household"
        )

    async def update(_user_id: str, _meal_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        captured.update(patch)
        return {"id": "meal-2", "is_active": True, **patch}

    monkeypatch.setattr(tools.meal_repo, "get_meal", meal)
    monkeypatch.setattr(tools.dish_repo, "get_dish", dish)
    monkeypatch.setattr(tools, "resolve_item", resolve)
    monkeypatch.setattr(tools.meal_repo, "update_meal", update)

    result = await tools.update_meal_resolution.ainvoke(
        {"meal_id": "meal-1", "food_id": "dish-1"},
        config={"configurable": {"user_id": "user-1", "meal_id": "meal-1"}},
    )

    assert result["status"] == "OK"
    assert result["meal"]["id"] == "meal-2"
    assert captured["grams"] == 300
    assert captured["nutrients"] == {"protein_g": 54}


async def test_update_tool_rejects_a_different_meal_id() -> None:
    result = await tools.update_meal_resolution.ainvoke(
        {"meal_id": "meal-other", "food_id": "dish-1"},
        config={"configurable": {"user_id": "user-1", "meal_id": "meal-1"}},
    )

    assert result["status"] == "ERROR"
    assert "outside" in result["message"]


async def test_update_tool_rejects_an_already_resolved_meal(monkeypatch) -> None:
    async def meal(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {"id": "meal-1", "is_active": True, "food_id": "dish-existing"}

    monkeypatch.setattr(tools.meal_repo, "get_meal", meal)

    result = await tools.update_meal_resolution.ainvoke(
        {"meal_id": "meal-1", "food_id": "dish-1"},
        config={"configurable": {"user_id": "user-1", "meal_id": "meal-1"}},
    )

    assert result == {"status": "ERROR", "message": "Meal is already resolved"}
