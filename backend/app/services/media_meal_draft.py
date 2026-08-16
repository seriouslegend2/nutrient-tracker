"""Turn factual media evidence into fully cataloged, serving-based meal drafts."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from app.agents.media_facts.models import MediaFacts, MediaQuantity
from app.agents.media_meal_resolver.runner import run_media_meal_resolver_agent
from app.domain.dishes import repository as dish_repo
from app.domain.dishes.resolve import resolve_portion, scale_unit_nutrients

_MEAL_SLOTS = {"breakfast", "brunch", "lunch", "snacks", "dinner", "misc"}


def _normalise_unit(value: str | None) -> str:
    unit = (value or "").strip().lower().rstrip("s")
    aliases = {
        "gram": "g",
        "kilogram": "kg",
        "piece": "piece",
        "serving": "serving",
        "portion": "serving",
    }
    return aliases.get(unit, unit)


def _positive(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _quantity_as_grams(
    quantity: MediaQuantity,
    *,
    portion_unit: str,
    portion_grams: float,
) -> float | None:
    if grams := _positive(quantity.total_grams):
        return round(grams, 2)
    value = _positive(quantity.value)
    unit = _normalise_unit(quantity.unit)
    if value is None:
        return None
    if unit == "g":
        return round(value, 2)
    if unit == "kg":
        return round(value * 1000, 2)
    if unit == _normalise_unit(portion_unit):
        return round(value * portion_grams, 2)
    return None


def _default_meal_slot(now: datetime) -> str:
    if now.hour < 11:
        return "breakfast"
    if now.hour < 15:
        return "lunch"
    if now.hour < 18:
        return "snacks"
    return "dinner"


def _draft_date_and_slot(facts: MediaFacts, now: datetime) -> tuple[str, str]:
    extracted_date = next((item.row_date for item in facts.items if item.row_date), None)
    extracted_slot = next(
        (
            slot
            for item in facts.items
            if (slot := (item.meal_slot or "").strip().lower()) in _MEAL_SLOTS
        ),
        None,
    )
    return (
        (extracted_date or now.date()).isoformat(),
        extracted_slot or _default_meal_slot(now),
    )


def _fixed_portion(
    *,
    category_row: dict[str, Any] | None,
) -> tuple[str, float, str, str, float, float]:
    if not category_row:
        raise ValueError("Resolved dish category has no fixed serving definition")
    base_unit = str(category_row["portion_unit"])
    base_grams = _positive(category_row.get("portion_grams"))
    portion_count = _positive(category_row.get("portion_count"))
    if base_grams is None or portion_count is None:
        raise ValueError("Resolved dish category has no fixed unit definition")
    return base_unit, base_grams, "category_global", base_unit, base_grams, portion_count


def _resolve_quantity(
    quantity: MediaQuantity,
    *,
    portion_unit: str,
    portion_grams: float,
) -> tuple[float, float, str]:
    grams = _quantity_as_grams(
        quantity,
        portion_unit=portion_unit,
        portion_grams=portion_grams,
    )
    if grams is None:
        raise ValueError(
            f"Agent 1 quantity {quantity.value} {quantity.unit} cannot be converted "
            f"to fixed unit {portion_unit}"
        )
    return round(grams / portion_grams, 3), grams, f"agent1_{quantity.source}"


async def build_media_meal_draft(
    *,
    user_id: str,
    thread_id: str,
    facts: MediaFacts,
    correlation_id: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Resolve every fact to a global dish before producing a reviewable draft."""
    if not facts.items:
        raise ValueError("Media facts contain no meal items")
    resolution, category_rows = await asyncio.gather(
        run_media_meal_resolver_agent(
            user_id=user_id,
            thread_id=thread_id,
            facts=facts,
            correlation_id=correlation_id,
        ),
        dish_repo.list_category_portions(user_id),
    )
    categories = {str(row["category"]): row for row in category_rows}
    resolved_by_evidence = {dish.evidence_id: dish for dish in resolution.dishes}
    items: list[dict[str, Any]] = []

    for fact in facts.items:
        resolved = resolved_by_evidence[fact.evidence_id]
        chain = await resolve_portion(user_id, resolved.food_id, resolved.category)
        (
            portion_unit,
            portion_grams,
            resolved_from,
            base_portion_unit,
            base_portion_grams,
            portion_count,
        ) = _fixed_portion(
            category_row=categories.get(resolved.category),
        )
        servings, grams, amount_source = _resolve_quantity(
            fact.quantity,
            portion_unit=portion_unit,
            portion_grams=portion_grams,
        )
        mass_range = fact.quantity.range_g.model_dump(mode="json") if fact.quantity.range_g else None
        items.append(
            {
                "evidence_id": fact.evidence_id,
                "name": fact.observed_item_name,
                "resolved_name": resolved.name,
                "food_id": resolved.food_id,
                "category": resolved.category,
                "servings": servings,
                "portions": servings,
                "portion_unit": portion_unit,
                "total_grams": grams,
                "nutrients": scale_unit_nutrients(
                    chain.get("nutrients_per_unit") or {}, servings
                ),
                "amount_source": amount_source,
                "resolution_action": resolved.action,
                "matching_confidence": resolved.confidence,
                "mass_range_g": mass_range,
                "confidence": fact.confidence,
                "observed_quantity": fact.quantity.model_dump(mode="json"),
                "portion_metadata": {
                    "portion_unit": portion_unit,
                    "portion_grams": portion_grams,
                    "resolved_from": resolved_from,
                    "base_portion_unit": base_portion_unit,
                    "base_portion_grams": base_portion_grams,
                    "portion_count": portion_count,
                    "fixed": True,
                },
                "meal_date": fact.row_date.isoformat() if fact.row_date else None,
                "meal_type": fact.meal_slot,
                "source_metadata": {
                    "document_row": fact.document_row,
                    "source_locator": fact.source_locator,
                    "content_kind": facts.content_kind,
                },
            }
        )

    current = now or datetime.now().astimezone()
    meal_date, meal_type = _draft_date_and_slot(facts, current)
    source_kind = {
        "food_photo": "food_photo",
        "nutrition_label": "nutrition_label",
        "food_diary": "food_diary_pdf",
    }.get(facts.content_kind, "food_photo" if facts.media_kind == "image" else "food_diary_pdf")
    return {
        "items": items,
        "evidence": facts.model_dump(mode="json"),
        "meal_date": meal_date,
        "meal_type": meal_type,
        "source_metadata": {
            "kind": source_kind,
            "media_kind": facts.media_kind,
            "content_kind": facts.content_kind,
        },
        "confidence": facts.confidence,
    }
