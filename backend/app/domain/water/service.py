"""Hydration persistence operations."""

from __future__ import annotations

from datetime import date

from postgrest.types import CountMethod

from app.services.db_results import Row, as_rows
from app.services.supabase import get_supabase


async def log_water(user_id: str, volume_ml: float, logged_on: date) -> Row:
    sb = await get_supabase()
    result = (
        await sb.table("water_logs")
        .insert(
            {
                "user_id": user_id,
                "volume_ml": volume_ml,
                "logged_on": logged_on.isoformat(),
            }
        )
        .execute()
    )
    rows = as_rows(result.data)
    if not rows:
        raise RuntimeError("Water log insert returned no row")
    return rows[0]


async def list_water(user_id: str, *, limit: int, offset: int) -> tuple[list[Row], int]:
    sb = await get_supabase()
    result = (
        await sb.table("water_logs")
        .select("*", count=CountMethod.exact)
        .eq("user_id", user_id)
        .order("logged_on", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return as_rows(result.data), result.count or 0
