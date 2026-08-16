"""Nutrient scaling. The arithmetic every logged meal depends on."""

import pytest

from app.domain.dishes import repository, resolve
from app.domain.dishes.resolve import scale_unit_nutrients


@pytest.mark.unit
def test_scales_linearly_by_fixed_units():
    nutrients_per_unit = {"protein_g": 10.0, "carbs_g": 20.0, "fat_g": 5.0}
    out = scale_unit_nutrients(nutrients_per_unit, 2)
    assert out["protein_g"] == 20.0
    assert out["carbs_g"] == 40.0
    assert out["fat_g"] == 10.0


@pytest.mark.unit
def test_energy_is_recomputed_from_macros_not_carried_through():
    """EuroFIR Step 10: never borrow energy values, always calculate them.

    A stored calorie figure that disagrees with the macros beside it is the
    thing users notice first.
    """
    nutrients_per_unit = {
        "protein_g": 10.0,
        "carbs_g": 20.0,
        "fat_g": 5.0,
        "calories_kcal": 99999,
    }  # deliberately wrong
    out = scale_unit_nutrients(nutrients_per_unit, 1)
    # 10*4 + 20*4 + 5*9 = 165
    assert out["calories_kcal"] == 165
    assert out["calories_kcal"] != 99999


@pytest.mark.unit
def test_empty_input_stays_empty_rather_than_becoming_zero():
    """'{}' means UNKNOWN nutrition. Zero would silently under-count a day."""
    assert scale_unit_nutrients({}, 2) == {}


@pytest.mark.unit
async def test_exact_grams_preserve_the_dish_serving_unit(monkeypatch):
    async def fake_resolve_portion(*_args):
        return {
            "portion_unit": "serving",
            "portion_grams": 100,
            "nutrients_per_unit": {"protein_g": 10},
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


@pytest.mark.unit
async def test_explicit_serving_uses_fixed_unit_not_household_usual_count(monkeypatch):
    async def fake_resolve_portion(*_args):
        return {
            "portion_unit": "bowl",
            "portion_grams": 150,
            "nutrients_per_unit": {
                "protein_g": 13.5,
                "carbs_g": 37.5,
                "fat_g": 10.5,
            },
            "resolved_from": "dish_global",
        }

    monkeypatch.setattr(resolve, "resolve_portion", fake_resolve_portion)

    result = await resolve.resolve_item(
        user_id="user-1",
        dish_name="Fish biryani",
        food_id="dish-1",
        portions=1,
    )

    assert result.portion_unit == "bowl"
    assert result.grams == 150
    assert result.nutrients == {
        "protein_g": 13.5,
        "carbs_g": 37.5,
        "fat_g": 10.5,
        "calories_kcal": 299,
    }


@pytest.mark.unit
async def test_household_portion_write_sends_only_the_usual_count(monkeypatch):
    call: dict = {}

    async def fake_call_rpc(name, payload):
        call.update(name=name, payload=payload)
        return [{"portion_count": payload["p_portion_count"]}]

    monkeypatch.setattr(repository, "call_rpc", fake_call_rpc)

    result = await repository.set_category_household("user-1", "dal_gravy", 1.5)

    assert result["portion_count"] == 1.5
    assert call == {
        "name": "fn_set_category_household_count",
        "payload": {
            "p_user_id": "user-1",
            "p_category": "dal_gravy",
            "p_portion_count": 1.5,
            "p_source": "questionnaire",
        },
    }
