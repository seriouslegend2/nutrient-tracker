"""Resolve media extraction evidence into reviewable meal drafts."""

from __future__ import annotations

import math
from copy import deepcopy
from typing import Any

from app.domain.dishes import repository as dish_repo
from app.domain.dishes.resolve import resolve_portion, scale_nutrients_for_grams


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _normalise_unit(value: Any) -> str:
    unit = str(value or "").strip().lower().replace(".", "")
    aliases = {
        "gram": "g",
        "grams": "g",
        "kilogram": "kg",
        "kilograms": "kg",
        "servings": "serving",
        "pieces": "piece",
        "katoris": "katori",
        "bowls": "bowl",
        "cups": "cup",
    }
    return aliases.get(unit, unit)


def _recognised_mass(item: dict[str, Any]) -> tuple[float | None, str | None]:
    mass = _positive_number(item.get("estimated_mass_g"))
    if mass is not None:
        return round(mass, 2), "extracted_mass"

    quantity = _positive_number(item.get("quantity"))
    unit = _normalise_unit(item.get("unit"))
    if quantity is not None and unit in {"g", "kg"}:
        factor = 1000 if unit == "kg" else 1
        return round(quantity * factor, 2), "extracted_mass"

    count = _positive_number(item.get("count"))
    unit_mass = _positive_number(item.get("unit_mass_g"))
    if count is not None and unit_mass is not None:
        return round(count * unit_mass, 2), "extracted_count_unit"

    return None, None


def _count_unit_mass(
    item: dict[str, Any],
    *,
    category_portion: dict[str, Any] | None,
    resolved_portion: dict[str, Any],
) -> float | None:
    count = _positive_number(item.get("count"))
    quantity = _positive_number(item.get("quantity"))
    amount = count if count is not None else quantity
    extracted_unit = _normalise_unit(item.get("unit"))
    if amount is None or not extracted_unit:
        return None

    if resolved_portion.get("resolved_from") == "dish_household" and extracted_unit == (
        _normalise_unit(resolved_portion.get("portion_unit"))
    ):
        base_grams = _positive_number(resolved_portion.get("portion_grams"))
    elif category_portion and extracted_unit == _normalise_unit(
        category_portion.get("portion_unit")
    ):
        base_grams = _positive_number(category_portion.get("portion_grams"))
    elif extracted_unit == _normalise_unit(resolved_portion.get("portion_unit")):
        base_grams = _positive_number(resolved_portion.get("portion_grams"))
    else:
        base_grams = None
    return round(amount * base_grams, 2) if base_grams is not None else None


async def enrich_media_payload(*, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Add exact dish resolution while retaining all extraction evidence."""
    enriched = deepcopy(payload)
    items = enriched.get("items")
    if not isinstance(items, list) or not items:
        return enriched

    category_portions = {
        row["category"]: row for row in await dish_repo.list_category_portions(user_id)
    }
    for item in items:
        if not isinstance(item, dict):
            continue

        recognised_grams, recognised_source = _recognised_mass(item)
        lookup_name = str(
            item.get("name_normalized")
            or item.get("normalized_name")
            or item.get("normalized")
            or item.get("name")
            or ""
        ).strip()
        match = await dish_repo.find_by_name(lookup_name) if lookup_name else None
        if not match:
            item.update(
                {
                    "food_id": None,
                    "total_grams": recognised_grams,
                    "amount_source": recognised_source or "unresolved",
                    "nutrients": {},
                    "matching_confidence": "none",
                }
            )
            continue

        category = match.get("category")
        food_id = match["dish_id"]
        chain = await resolve_portion(user_id, food_id, category)
        category_portion = category_portions.get(category)
        grams = recognised_grams
        amount_source = recognised_source

        if grams is None:
            grams = _count_unit_mass(
                item,
                category_portion=category_portion,
                resolved_portion=chain,
            )
            if grams is not None:
                amount_source = "extracted_count_unit"

        if grams is None:
            usual_grams = _positive_number(chain.get("portion_grams"))
            if chain.get("resolved_from") != "dish_household":
                usual_grams = (
                    _positive_number(category_portion.get("effective_portion_grams"))
                    if category_portion
                    else usual_grams
                )
            grams = usual_grams
            grams = round(grams, 2) if grams is not None else None
            amount_source = "household_usual_portion" if grams is not None else "unresolved"

        portion_metadata = {
            "portion_unit": (
                category_portion.get("portion_unit")
                if category_portion
                else chain.get("portion_unit")
            ),
            "portion_grams": (
                category_portion.get("portion_grams")
                if category_portion
                else chain.get("portion_grams")
            ),
            "portion_count": category_portion.get("portion_count") if category_portion else 1.0,
            "effective_portion_grams": (
                category_portion.get("effective_portion_grams")
                if category_portion
                else chain.get("portion_grams")
            ),
            "is_custom": category_portion.get("is_custom", False) if category_portion else False,
            "resolved_portion_unit": chain.get("portion_unit"),
            "resolved_portion_grams": chain.get("portion_grams"),
            "resolved_from": chain.get("resolved_from") or "unknown",
        }
        item.update(
            {
                "food_id": food_id,
                "resolved_name": match["name"],
                "category": category,
                "portion_metadata": portion_metadata,
                "total_grams": grams,
                "amount_source": amount_source,
                "nutrients": scale_nutrients_for_grams(
                    chain.get("nutrients_per_unit") or {},
                    grams,
                    float(chain.get("portion_grams") or grams),
                )
                if grams is not None
                else {},
                "matching_confidence": "exact",
            }
        )

    return enriched
