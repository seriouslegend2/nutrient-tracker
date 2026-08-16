"""Data access for the dish universe and the two override tables.

The ONLY place SQL for dishes is written. Routers call the service; the service
calls this.

Versioning: an edit INSERTs a new row and deactivates the old one, so `id` is
the version's row and `dish_id` is the stable logical identity that
``meals.food_id`` references. That split is what stops a March meal from
dangling when a dish is corrected in August.
"""

from __future__ import annotations

import re
from typing import Any

from app.services.supabase import call_rpc, get_supabase
from app.utils.logger import logger

_ACTIVE = "is_active"


def normalize(name: str) -> str:
    """'Dal  Tadka!' -> 'dal tadka'. Used for search and free-text matching."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", name.lower())).strip()


async def search_dishes(
    query: str, *, limit: int = 50, offset: int = 0, category: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    """Hybrid search: trigram similarity on the normalised name plus aliases.

    Pure embedding search confuses 'dal fry' with 'dal makhani' - roughly a 2x
    calorie difference - so lexical matching stays in the loop.
    """
    sb = await get_supabase()
    q = sb.table("dish_global").select("*", count="exact").eq(_ACTIVE, True)
    if category:
        q = q.eq("category", category)
    if query:
        needle = normalize(query)
        q = q.or_(f"name_normalized.ilike.%{needle}%,name.ilike.%{query}%")
    res = await q.order("name").range(offset, offset + limit - 1).execute()
    return res.data or [], res.count or 0


async def get_dish(dish_id: str) -> dict[str, Any] | None:
    sb = await get_supabase()
    res = (
        await sb.table("dish_global")
        .select("*")
        .eq("dish_id", dish_id)
        .eq(_ACTIVE, True)
        .limit(1)
        .execute()
    )
    return (res.data or [None])[0]


async def find_by_name(name: str) -> dict[str, Any] | None:
    """Exact normalised-name match. Used to attach food_id to free text."""
    sb = await get_supabase()
    res = (
        await sb.table("dish_global")
        .select("*")
        .eq("name_normalized", normalize(name))
        .eq(_ACTIVE, True)
        .limit(1)
        .execute()
    )
    return (res.data or [None])[0]


# ---------------------------------------------------------------------------
# Overrides. Both are versioned: deactivate the live row, insert version + 1.
# ---------------------------------------------------------------------------


async def set_dish_household(
    user_id: str,
    dish_id: str,
    portion_unit: str,
    portion_grams: float,
    per_100g: dict[str, Any] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Level ②: this user's version of THIS dish."""
    rows = await call_rpc(
        "fn_set_dish_household",
        {
            "p_user_id": user_id,
            "p_dish_id": dish_id,
            "p_portion_unit": portion_unit,
            "p_portion_grams": portion_grams,
            "p_per_100g": per_100g,
            "p_note": note,
        },
    )
    created = rows[0] if isinstance(rows, list) and rows else rows
    logger.info(
        "dish_household_set user_id={} dish_id={} version={}",
        user_id,
        dish_id,
        created["version"],
    )
    return created


async def set_category_household(
    user_id: str,
    category: str,
    portion_count: float = 1.0,
    source: str = "questionnaire",
) -> dict[str, Any]:
    """Set the usual count; unit and grams always come from the fixed catalog."""
    rows = await call_rpc(
        "fn_set_category_household_count",
        {
            "p_user_id": user_id,
            "p_category": category,
            "p_portion_count": portion_count,
            "p_source": source,
        },
    )
    return rows[0] if isinstance(rows, list) and rows else rows


async def list_category_portions(user_id: str) -> list[dict[str, Any]]:
    """Global defaults merged with this user's overrides, mine flagged."""
    sb = await get_supabase()
    globals_ = await sb.table("category_global").select("*").eq(_ACTIVE, True).execute()
    mine = (
        await sb.table("category_household")
        .select("*")
        .eq("user_id", user_id)
        .eq(_ACTIVE, True)
        .execute()
    )
    by_cat = {r["category"]: r for r in (mine.data or [])}
    out: list[dict[str, Any]] = []
    for g in globals_.data or []:
        override = by_cat.get(g["category"])
        count = override["portion_count"] if override else g["portion_count"]
        out.append(
            {
                "category": g["category"],
                "portion_unit": g["portion_unit"],
                "portion_grams": g["portion_grams"],
                "portion_count": count,
                "effective_portion_grams": round(float(g["portion_grams"]) * float(count), 2),
                "is_custom": override is not None,
                "global_portion_grams": g["portion_grams"],
                "global_portion_count": g["portion_count"],
                "source": (override or g).get("source"),
            }
        )
    return sorted(out, key=lambda r: r["category"])
