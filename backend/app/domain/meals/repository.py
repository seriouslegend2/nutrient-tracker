"""Data access for meals. The ONLY place SQL for meals is written.

A day is versioned in place: all rows of a day share a version, and replacing a
day inserts version+1 then deactivates the old set. Reading a day is one query -
no joins, no aggregate assembly.

Every query here is scoped by ``user_id`` taken from the verified token. There
is no code path that accepts a user id from a request.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.services.supabase import call_rpc, get_supabase

_ACTIVE = "is_active"
_COLS = "*"


async def confirm_media_draft(
    *,
    user_id: str,
    message_id: str,
    meal_date: date,
    meal_type: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    result = await call_rpc(
        "fn_confirm_media_meal_draft",
        {
            "p_user_id": user_id,
            "p_message_id": message_id,
            "p_meal_date": meal_date,
            "p_meal_type": meal_type,
            "p_items": items,
        },
    )
    if not isinstance(result, dict):
        raise RuntimeError("Media confirmation returned no result")
    return result


async def discard_media_draft(*, user_id: str, message_id: str) -> None:
    await call_rpc(
        "fn_discard_media_meal_draft",
        {"p_user_id": user_id, "p_message_id": message_id},
    )


async def list_meals(
    *,
    user_id: str,
    date_from: date | None = None,
    date_to: date | None = None,
    meal_types: list[str] | None = None,
    limit: int = 50,
    offset: int = 0,
    cursor: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Time-range listing, filterable by date and meal type.

    Supports keyset pagination for the infinite-scroll timeline: offset paging
    drifts when a row is inserted mid-scroll.
    """
    sb = await get_supabase()
    q = sb.table("meals").select(_COLS, count="exact").eq("user_id", user_id).eq(_ACTIVE, True)

    if date_from:
        q = q.gte("meal_date", date_from.isoformat())
    if date_to:
        q = q.lte("meal_date", date_to.isoformat())
    if meal_types:
        q = q.in_("meal_type", meal_types)

    if cursor and cursor.get("meal_date") and cursor.get("id"):
        # Descending tuple keyset: date first, UUID as the deterministic tie-breaker.
        q = q.or_(
            f"meal_date.lt.{cursor['meal_date']},"
            f"and(meal_date.eq.{cursor['meal_date']},id.lt.{cursor['id']})"
        )

    q = q.order("meal_date", desc=True).order("id", desc=True)
    res = await q.range(offset, offset + limit - 1).execute()
    return res.data or [], res.count or 0


async def get_day(user_id: str, day: date, version: int | None = None) -> list[dict[str, Any]]:
    """One day, all slots. `version` reads a superseded version."""
    sb = await get_supabase()
    q = sb.table("meals").select(_COLS).eq("user_id", user_id).eq("meal_date", day.isoformat())
    q = q.eq("version", version) if version is not None else q.eq(_ACTIVE, True)
    res = await q.order("meal_type").order("created_at").execute()
    return res.data or []


async def list_day_versions(user_id: str, day: date) -> list[dict[str, Any]]:
    sb = await get_supabase()
    res = (
        await sb.table("meals")
        .select("version,is_active,created_at")
        .eq("user_id", user_id)
        .eq("meal_date", day.isoformat())
        .order("version", desc=True)
        .execute()
    )
    seen: dict[int, dict[str, Any]] = {}
    for row in res.data or []:
        v = row["version"]
        if v not in seen:
            seen[v] = {
                "version": v,
                "is_active": row["is_active"],
                "created_at": row["created_at"],
                "item_count": 0,
            }
        seen[v]["item_count"] += 1
    return sorted(seen.values(), key=lambda r: r["version"], reverse=True)


async def next_day_version(user_id: str, day: date) -> int:
    sb = await get_supabase()
    res = (
        await sb.table("meals")
        .select("version")
        .eq("user_id", user_id)
        .eq("meal_date", day.isoformat())
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    return (res.data[0]["version"] + 1) if res.data else 1


async def insert_meal(row: dict[str, Any]) -> dict[str, Any]:
    item = {
        key: value
        for key, value in row.items()
        if key not in {"user_id", "meal_date", "version", "is_active"}
    }
    result = await call_rpc(
        "fn_append_meal_item",
        {
            "p_user_id": row["user_id"],
            "p_meal_date": row["meal_date"],
            "p_item": item,
        },
    )
    if not isinstance(result, dict):
        raise RuntimeError("Meal append returned no row")
    return result


async def get_meal(user_id: str, meal_id: str) -> dict[str, Any] | None:
    sb = await get_supabase()
    res = (
        await sb.table("meals")
        .select(_COLS)
        .eq("id", meal_id)
        .eq("user_id", user_id)  # scoped by the token's user, always
        .limit(1)
        .execute()
    )
    return (res.data or [None])[0]


async def update_meal(user_id: str, meal_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    try:
        result = await call_rpc(
            "fn_version_meal_item",
            {
                "p_user_id": user_id,
                "p_meal_id": meal_id,
                "p_patch": patch,
                "p_delete": False,
            },
        )
    except Exception as exc:
        if "meal_not_found" in str(exc):
            return None
        raise
    return result if isinstance(result, dict) else None


async def replace_day(user_id: str, day: date, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = await call_rpc(
        "fn_replace_meal_day",
        {"p_user_id": user_id, "p_meal_date": day, "p_items": items},
    )
    return result if isinstance(result, list) else []


async def delete_meal(user_id: str, meal_id: str) -> bool:
    """Version the complete day without the deleted item."""
    try:
        result = await call_rpc(
            "fn_version_meal_item",
            {
                "p_user_id": user_id,
                "p_meal_id": meal_id,
                "p_patch": {},
                "p_delete": True,
            },
        )
    except Exception as exc:
        if "meal_not_found" in str(exc):
            return False
        raise
    return isinstance(result, dict) and result.get("deleted") is True
