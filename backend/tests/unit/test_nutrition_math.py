"""Nutrient scaling. The arithmetic every logged meal depends on."""

import pytest

from app.domain.dishes import resolve
from app.domain.dishes.resolve import scale_nutrients


@pytest.mark.unit
def test_scales_linearly_by_grams():
    per_100g = {"protein_g": 10.0, "carbs_g": 20.0, "fat_g": 5.0}
    out = scale_nutrients(per_100g, 200)
    assert out["protein_g"] == 20.0
    assert out["carbs_g"] == 40.0
    assert out["fat_g"] == 10.0


@pytest.mark.unit
def test_energy_is_recomputed_from_macros_not_carried_through():
    """EuroFIR Step 10: never borrow energy values, always calculate them.

    A stored calorie figure that disagrees with the macros beside it is the
    thing users notice first.
    """
    per_100g = {
        "protein_g": 10.0,
        "carbs_g": 20.0,
        "fat_g": 5.0,
        "calories_kcal": 99999,
    }  # deliberately wrong
    out = scale_nutrients(per_100g, 100)
    # 10*4 + 20*4 + 5*9 = 165
    assert out["calories_kcal"] == 165
    assert out["calories_kcal"] != 99999


@pytest.mark.unit
def test_empty_input_stays_empty_rather_than_becoming_zero():
    """'{}' means UNKNOWN nutrition. Zero would silently under-count a day."""
    assert scale_nutrients({}, 200) == {}


@pytest.mark.unit
async def test_exact_grams_preserve_the_dish_serving_unit(monkeypatch):
    async def fake_resolve_portion(*_args):
        return {
            "portion_unit": "serving",
            "portion_grams": 100,
            "per_100g": {"protein_g": 10},
            "resolved_from": "dish_global",
        }

    monkeypatch.setattr(resolve, "resolve_portion", fake_resolve_portion)

    result = await resolve.resolve_item(
        user_id="user-1",
        dish_name="Paneer butter masala",
        food_id="dish-1",
        portions=1,
        grams_override=180,
    )

    assert result.portion_unit == "serving"
    assert result.grams == 180
    assert result.nutrients["protein_g"] == 18
