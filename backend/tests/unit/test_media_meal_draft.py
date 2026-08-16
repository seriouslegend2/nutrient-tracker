from __future__ import annotations

from datetime import date, datetime

import pytest

from app.agents.media_facts.models import (
    DocumentDeclaredNutrient,
    MassRange,
    MediaFactItem,
    MediaFacts,
    MediaQuantity,
)
from app.agents.media_meal_resolver.models import MediaMealResolverRunResult, MediaResolutionPlan
from app.services import media_meal_draft


def _facts(*, quantity: bool = True, media_kind: str = "image") -> MediaFacts:
    return MediaFacts(
        usable=True,
        media_kind=media_kind,
        content_kind="food_photo" if media_kind == "image" else "food_diary",
        items=[
            MediaFactItem(
                evidence_id="evidence-1",
                observed_item_name="Dal",
                normalized_name="dal",
                quantity=MediaQuantity(
                    value=200 if quantity else 550,
                    unit="g",
                    total_grams=200 if quantity else 550,
                    range_g=(
                        MassRange(low=170, high=230)
                        if quantity
                        else MassRange(low=480, high=620)
                    ),
                    source="estimated",
                    confidence="medium",
                    basis="visible bowl" if quantity else "large visible plate",
                ),
                row_date=date(2026, 8, 15) if media_kind == "pdf" else None,
                meal_slot="Dinner" if media_kind == "pdf" else None,
                confidence="high",
            )
        ],
        confidence="high",
    )


async def _resolved(**_kwargs) -> MediaMealResolverRunResult:
    from app.agents.media_meal_resolver.models import ResolvedMediaDish

    return MediaMealResolverRunResult(
        dishes=[
            ResolvedMediaDish(
                evidence_id="evidence-1",
                food_id="dish-1",
                name="Dal Tadka",
                category="dal_gravy",
                confidence="high",
                action="match_existing",
            )
        ],
        plan=MediaResolutionPlan(decisions=[]),
        prompt_name="media-meal-resolver-v1",
        prompt_source="code",
    )


async def _categories(_user_id: str):
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


async def _portion(*_args):
    return {
        "portion_unit": "katori",
        "portion_grams": 160,
        "nutrients_per_unit": {"protein_g": 16, "carbs_g": 32, "fat_g": 8},
        "resolved_from": "dish_global",
    }


def _setup(monkeypatch) -> None:
    monkeypatch.setattr(media_meal_draft, "run_media_meal_resolver_agent", _resolved)
    monkeypatch.setattr(media_meal_draft.dish_repo, "list_category_portions", _categories)
    monkeypatch.setattr(media_meal_draft, "resolve_portion", _portion)


async def test_media_quantity_becomes_count_of_the_fixed_global_unit(monkeypatch) -> None:
    _setup(monkeypatch)

    payload = await media_meal_draft.build_media_meal_draft(
        user_id="user-1",
        thread_id="thread-1",
        facts=_facts(),
        now=datetime(2026, 8, 16, 12, 0),
    )

    item = payload["items"][0]
    assert item["resolved_name"] == "Dal Tadka"
    assert item["food_id"] == "dish-1"
    assert item["servings"] == 1.5
    assert item["total_grams"] == 240
    assert item["amount_source"] == "agent1_estimated"
    assert item["observed_quantity"]["total_grams"] == 200
    assert item["portion_metadata"] == {
        "portion_unit": "katori",
        "portion_grams": 160.0,
        "resolved_from": "category_global",
        "base_portion_unit": "katori",
        "base_portion_grams": 160.0,
        "portion_count": 1.5,
        "fixed": True,
    }
    assert item["nutrients"] == {
        "protein_g": 24,
        "carbs_g": 48,
        "fat_g": 12,
        "calories_kcal": 396,
    }
    assert payload["meal_date"] == "2026-08-16"
    assert payload["meal_type"] == "lunch"


async def test_agent_one_grams_are_not_replaced_by_household_usual(
    monkeypatch,
) -> None:
    _setup(monkeypatch)

    payload = await media_meal_draft.build_media_meal_draft(
        user_id="user-1",
        thread_id="thread-1",
        facts=_facts(quantity=False),
        now=datetime(2026, 8, 16, 20, 0),
    )

    item = payload["items"][0]
    assert item["total_grams"] == 560
    assert item["servings"] == 3.5
    assert item["servings"] != 1.5
    assert item["observed_quantity"]["total_grams"] == 550


async def test_pdf_date_and_slot_override_upload_defaults(monkeypatch) -> None:
    _setup(monkeypatch)

    payload = await media_meal_draft.build_media_meal_draft(
        user_id="user-1",
        thread_id="thread-1",
        facts=_facts(media_kind="pdf"),
        now=datetime(2026, 8, 16, 8, 0),
    )

    assert payload["meal_date"] == "2026-08-15"
    assert payload["meal_type"] == "dinner"


async def test_unnamed_nutrition_label_becomes_an_unknown_dish_draft(monkeypatch) -> None:
    from app.agents.media_meal_resolver.models import ResolvedMediaDish

    facts = MediaFacts(
        usable=True,
        media_kind="image",
        content_kind="nutrition_label",
        items=[
            MediaFactItem(
                evidence_id="label-1",
                observed_item_name="Unknown packaged item",
                normalized_name="unknown packaged item",
                quantity=MediaQuantity(
                    value=30,
                    unit="g",
                    total_grams=30,
                    source="document_declared",
                    confidence="high",
                    basis="one declared serving",
                ),
                document_declared_nutrients=[
                    DocumentDeclaredNutrient(
                        name="protein_g",
                        value=4,
                        unit="g",
                        basis="per_serving",
                        serving_size_g=30,
                        source_locator="nutrition panel",
                    ),
                    DocumentDeclaredNutrient(
                        name="sodium_mg",
                        value=180,
                        unit="mg",
                        basis="per_serving",
                        serving_size_g=30,
                        source_locator="nutrition panel",
                    ),
                ],
                confidence="high",
            )
        ],
        confidence="high",
    )

    async def resolved(**_kwargs) -> MediaMealResolverRunResult:
        return MediaMealResolverRunResult(
            dishes=[
                ResolvedMediaDish(
                    evidence_id="label-1",
                    food_id="unknown-dish-1",
                    name="Unknown dish 2026-08-16 12:00:00 UTC #1",
                    category="unknown",
                    confidence="high",
                    action="create_new",
                )
            ],
            plan=MediaResolutionPlan(decisions=[]),
            prompt_name="media-meal-resolver-v1",
            prompt_source="code",
        )

    async def categories(_user_id: str):
        return [
            {
                "category": "unknown",
                "portion_unit": "g",
                "portion_grams": 1,
                "portion_count": 1,
            }
        ]

    async def portion(*_args):
        return {
            "portion_unit": "g",
            "portion_grams": 1,
            "nutrients_per_unit": {"protein_g": 4 / 30, "sodium_mg": 6},
            "resolved_from": "dish_global",
        }

    monkeypatch.setattr(media_meal_draft, "run_media_meal_resolver_agent", resolved)
    monkeypatch.setattr(media_meal_draft.dish_repo, "list_category_portions", categories)
    monkeypatch.setattr(media_meal_draft, "resolve_portion", portion)

    payload = await media_meal_draft.build_media_meal_draft(
        user_id="user-1",
        thread_id="thread-1",
        facts=facts,
        now=datetime(2026, 8, 16, 12, 0),
    )

    item = payload["items"][0]
    assert item["resolved_name"] == "Unknown dish 2026-08-16 12:00:00 UTC #1"
    assert item["servings"] == 30
    assert item["portion_unit"] == "g"
    assert item["total_grams"] == 30
    assert item["nutrients"] == {
        "protein_g": 4,
        "sodium_mg": 180,
        "calories_kcal": 16,
    }


async def test_unresolved_catalog_identity_does_not_produce_a_completed_draft(
    monkeypatch,
) -> None:
    _setup(monkeypatch)

    async def unresolved(**_kwargs):
        raise ValueError("unresolved")

    monkeypatch.setattr(media_meal_draft, "run_media_meal_resolver_agent", unresolved)

    with pytest.raises(ValueError, match="unresolved"):
        await media_meal_draft.build_media_meal_draft(
            user_id="user-1",
            thread_id="thread-1",
            facts=_facts(),
        )
