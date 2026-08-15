"""Meal orchestration. No SQL here, and no FastAPI import either."""

from __future__ import annotations

from datetime import date
from typing import Any

from app.core.exceptions import NotFoundError
from app.domain.dishes import repository as dish_repo
from app.domain.dishes.resolve import resolve_item
from app.domain.meals import repository as repo
from app.utils.logger import logger


async def _prepare_item(
    *,
    user_id: str,
    meal_type: str,
    dish_name: str,
    food_id: str | None = None,
    portions: float = 1.0,
    grams: float | None = None,
    portion_unit: str | None = None,
    slot_time: str | None = None,
    source: str = "manual",
    note: str | None = None,
    confidence: str | None = None,
    nutrients: dict[str, Any] | None = None,
) -> dict[str, Any]:
    category: str | None = None

    # If no dish was chosen, try to attach one by name - but never block on it.
    if food_id is None:
        match = await dish_repo.find_by_name(dish_name)
        if match:
            food_id = match["dish_id"]
            category = match["category"]
    else:
        dish = await dish_repo.get_dish(food_id)
        category = dish["category"] if dish else None

    if nutrients is not None:
        # Caller supplied nutrition (photo estimate, label scan, user override).
        # Level ① - use it and do not re-resolve behind them.
        resolution_unit = portion_unit or "g"
        row_grams = grams
        row_nutrients = nutrients
        resolved_from = "meals"
    else:
        res = await resolve_item(
            user_id=user_id,
            dish_name=dish_name,
            food_id=food_id,
            category=category,
            portions=portions,
            grams_override=grams,
            portion_unit_override=portion_unit,
        )
        resolution_unit = res.portion_unit
        row_grams = res.grams
        row_nutrients = res.nutrients
        resolved_from = res.resolved_from

    return {
        "meal_type": meal_type,
        "slot_time": slot_time,
        "dish_name": dish_name,
        "food_id": food_id,
        "category": category,
        "portions": portions,
        "portion_unit": resolution_unit,
        "grams": row_grams,
        "nutrients": row_nutrients,
        "resolved_from": resolved_from,
        "confidence": confidence,
        "source": source,
        "note": note,
    }


async def add_item(
    *,
    user_id: str,
    meal_date: date,
    meal_type: str,
    dish_name: str,
    food_id: str | None = None,
    portions: float = 1.0,
    grams: float | None = None,
    portion_unit: str | None = None,
    slot_time: str | None = None,
    source: str = "manual",
    note: str | None = None,
    confidence: str | None = None,
    nutrients: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Log one item; unmatched free text remains a first-class row."""
    item = await _prepare_item(
        user_id=user_id,
        meal_type=meal_type,
        dish_name=dish_name,
        food_id=food_id,
        portions=portions,
        grams=grams,
        portion_unit=portion_unit,
        slot_time=slot_time,
        source=source,
        note=note,
        confidence=confidence,
        nutrients=nutrients,
    )
    version = await repo.next_day_version(user_id, meal_date)
    existing = await repo.get_day(user_id, meal_date)
    if existing:
        version = existing[0]["version"]
    row = await repo.insert_meal(
        {
            **item,
            "user_id": user_id,
            "meal_date": meal_date.isoformat(),
            "version": version,
            "is_active": True,
        }
    )
    logger.info(
        "meal_logged user_id={} date={} slot={} resolved_from={}",
        user_id,
        meal_date,
        meal_type,
        item["resolved_from"],
    )
    return row


async def replace_day(
    *, user_id: str, meal_date: date, items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Replace a whole day: mint version+1 and deactivate the previous set.

    The old rows stay readable, so "what did my Tuesday look like before I
    changed it" is answerable.
    """
    prepared: list[dict[str, Any]] = []
    for item in items:
        row = await _prepare_item(
            user_id=user_id,
            meal_type=item["meal_type"],
            dish_name=item["dish_name"],
            food_id=item.get("food_id"),
            portions=item.get("portions", 1.0),
            grams=item.get("grams"),
            portion_unit=item.get("portion_unit"),
            slot_time=item.get("slot_time"),
            source=item.get("source", "manual"),
            note=item.get("note"),
        )
        prepared.append(row)

    out = await repo.replace_day(user_id, meal_date, prepared)
    version = out[0]["version"] if out else None

    logger.info(
        "day_replaced user_id={} date={} version={} items={}",
        user_id,
        meal_date,
        version,
        len(out),
    )
    return out


async def adjust_item(
    *,
    user_id: str,
    meal_id: str,
    portions: float | None = None,
    portion_unit: str | None = None,
    grams: float | None = None,
) -> dict[str, Any]:
    """Change a portion or quantity and recompute nutrients."""
    current = await repo.get_meal(user_id, meal_id)
    if not current:
        raise NotFoundError("Meal item not found", code="MEAL_NOT_FOUND")

    res = await resolve_item(
        user_id=user_id,
        dish_name=current["dish_name"],
        food_id=current.get("food_id"),
        category=current.get("category"),
        portions=portions if portions is not None else current["portions"],
        grams_override=grams,
        portion_unit_override=portion_unit or current["portion_unit"],
    )
    patch = {
        "portions": portions if portions is not None else current["portions"],
        "portion_unit": res.portion_unit,
        "grams": res.grams,
        "nutrients": res.nutrients,
        "resolved_from": res.resolved_from,
    }
    updated = await repo.update_meal(user_id, meal_id, patch)
    if not updated:
        raise NotFoundError("Meal item not found", code="MEAL_NOT_FOUND")
    return updated


async def day_totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum a day, reporting unknown-nutrition rows as a GAP rather than zero."""
    totals: dict[str, float] = {}
    unaccounted = 0
    for row in rows:
        nutrients = row.get("nutrients") or {}
        if not nutrients:
            unaccounted += 1
            continue
        for key, value in nutrients.items():
            try:
                totals[key] = round(totals.get(key, 0.0) + float(value), 2)
            except (TypeError, ValueError):
                continue
    return {"totals": totals, "unaccounted_items": unaccounted}
