from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.domain.meals import drafts


def _dish() -> dict[str, Any]:
    return {
        "dish_id": "dish-1",
        "name": "Dal Tadka",
        "name_normalized": "dal tadka",
        "category": "dal_gravy",
    }


async def _portion_rows(_user_id: str) -> list[dict[str, Any]]:
    return [
        {
            "category": "dal_gravy",
            "portion_unit": "katori",
            "portion_grams": 160,
            "portion_count": 1.5,
            "effective_portion_grams": 240,
            "is_custom": True,
        }
    ]


async def _resolved_portion(*_args: Any) -> dict[str, Any]:
    return {
        "portion_unit": "katori",
        "portion_grams": 240,
        "per_100g": {"protein_g": 10, "carbs_g": 20, "fat_g": 5},
        "resolved_from": "category_household",
    }


async def test_explicit_mass_exact_match_scales_nutrition(monkeypatch) -> None:
    lookups: list[str] = []

    async def find_by_name(name: str) -> dict[str, Any]:
        lookups.append(name)
        return _dish()

    monkeypatch.setattr(drafts.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(drafts.dish_repo, "list_category_portions", _portion_rows)
    monkeypatch.setattr(drafts, "resolve_portion", _resolved_portion)
    payload = {
        "items": [
            {
                "name": "model display name",
                "name_normalized": "dal tadka",
                "estimated_mass_g": 180,
                "mass_range_g": {"low": 150, "high": 210},
            }
        ]
    }

    enriched = await drafts.enrich_media_payload(user_id="user-1", payload=payload)
    item = enriched["items"][0]

    assert lookups == ["dal tadka"]
    assert item["food_id"] == "dish-1"
    assert item["resolved_name"] == "Dal Tadka"
    assert item["category"] == "dal_gravy"
    assert item["total_grams"] == 180
    assert item["amount_source"] == "extracted_mass"
    assert item["nutrients"] == {
        "protein_g": 18,
        "carbs_g": 36,
        "fat_g": 9,
        "calories_kcal": 297,
    }
    assert item["matching_confidence"] == "exact"
    assert payload["items"][0].keys() == {
        "name",
        "name_normalized",
        "estimated_mass_g",
        "mass_range_g",
    }


async def test_missing_mass_uses_household_effective_portion(monkeypatch) -> None:
    async def find_by_name(_name: str) -> dict[str, Any]:
        return _dish()

    monkeypatch.setattr(drafts.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(drafts.dish_repo, "list_category_portions", _portion_rows)
    monkeypatch.setattr(drafts, "resolve_portion", _resolved_portion)

    enriched = await drafts.enrich_media_payload(
        user_id="user-1", payload={"items": [{"name": "Dal Tadka"}]}
    )
    item = enriched["items"][0]

    assert item["total_grams"] == 240
    assert item["amount_source"] == "household_usual_portion"
    assert item["portion_metadata"] == {
        "portion_unit": "katori",
        "portion_grams": 160,
        "portion_count": 1.5,
        "effective_portion_grams": 240,
        "is_custom": True,
        "resolved_portion_unit": "katori",
        "resolved_portion_grams": 240,
        "resolved_from": "category_household",
    }
    assert item["nutrients"]["protein_g"] == 24


async def test_unknown_dish_keeps_recognised_amount_without_nutrition(monkeypatch) -> None:
    async def find_by_name(_name: str) -> None:
        return None

    monkeypatch.setattr(drafts.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(drafts.dish_repo, "list_category_portions", _portion_rows)

    enriched = await drafts.enrich_media_payload(
        user_id="user-1",
        payload={"items": [{"name": "Family curry", "quantity": 0.2, "unit": "kg"}]},
    )
    item = enriched["items"][0]

    assert item["quantity"] == 0.2
    assert item["unit"] == "kg"
    assert item["total_grams"] == 200
    assert item["food_id"] is None
    assert item["nutrients"] == {}
    assert item["matching_confidence"] == "none"


async def test_pdf_rows_and_source_metadata_are_preserved_exactly(monkeypatch) -> None:
    async def find_by_name(_name: str) -> None:
        return None

    monkeypatch.setattr(drafts.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(drafts.dish_repo, "list_category_portions", _portion_rows)
    row = {
        "date": "2026-08-10",
        "meal_type": "lunch",
        "item": "family curry",
        "quantity": 120,
        "unit": "g",
        "calories_kcal": 310,
    }
    payload = {
        "rows": [row],
        "row_count": 1,
        "source_metadata": {"kind": "food_diary_pdf", "filename": "diary.pdf"},
        "items": [
            {
                "name": "family curry",
                "estimated_mass_g": 120,
                "source_metadata": {"kind": "pdf_row", "row_index": 0, "row": row},
            }
        ],
    }
    original = deepcopy(payload)

    enriched = await drafts.enrich_media_payload(user_id="user-1", payload=payload)

    assert payload == original
    assert enriched["rows"] == original["rows"]
    assert enriched["source_metadata"] == original["source_metadata"]
    assert enriched["items"][0]["source_metadata"] == original["items"][0]["source_metadata"]
