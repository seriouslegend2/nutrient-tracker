"""Database operations for administrative API endpoints."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from typing import Any

from postgrest.types import CountMethod

from app.core.exceptions import NotFoundError
from app.services.db_results import Row, as_rows
from app.services.supabase import get_supabase


async def list_users(*, limit: int, offset: int) -> tuple[list[Row], int]:
    sb = await get_supabase()
    result = (
        await sb.table("app_users")
        .select("*, user_profiles(*)", count=CountMethod.exact)
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return as_rows(result.data), result.count or 0


async def get_user(user_id: str) -> Row:
    sb = await get_supabase()
    user_result = await sb.table("app_users").select("*").eq("id", user_id).limit(1).execute()
    users = as_rows(user_result.data)
    if not users:
        raise NotFoundError("User not found", code="USER_NOT_FOUND")

    profile_result = await sb.table("user_profiles").select("*").eq("user_id", user_id).execute()
    goal_result = (
        await sb.table("goals")
        .select("*")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )
    meal_result = (
        await sb.table("meals")
        .select("id", count=CountMethod.exact)
        .eq("user_id", user_id)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )
    profiles = as_rows(profile_result.data)
    goals = as_rows(goal_result.data)
    return {
        "user": users[0],
        "profile": profiles[0] if profiles else None,
        "active_goal": goals[0] if goals else None,
        "meal_count": meal_result.count or 0,
    }


async def list_panel(
    table: str,
    user_id: str,
    *,
    order: str,
    limit: int,
    offset: int,
) -> tuple[list[Row], int]:
    sb = await get_supabase()
    result = (
        await sb.table(table)
        .select("*", count=CountMethod.exact)
        .eq("user_id", user_id)
        .order(order, desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return as_rows(result.data), result.count or 0


async def resolution_mix() -> dict[str, Any]:
    sb = await get_supabase()
    since = (date.today() - timedelta(days=30)).isoformat()
    result = (
        await sb.table("meals")
        .select("resolved_from")
        .gte("meal_date", since)
        .eq("is_active", True)
        .execute()
    )
    levels = [
        level for row in as_rows(result.data) if isinstance(level := row.get("resolved_from"), str)
    ]
    counts = Counter(levels)
    total = sum(counts.values())
    denominator = total or 1
    return {
        "window_days": 30,
        "total": total,
        "levels": [
            {"level": level, "count": count, "pct": round(count / denominator * 100, 1)}
            for level, count in counts.most_common()
        ],
    }


async def metrics() -> dict[str, Any]:
    sb = await get_supabase()
    since = (date.today() - timedelta(days=7)).isoformat()
    users = await sb.table("app_users").select("id", count=CountMethod.exact).limit(1).execute()
    meals = (
        await sb.table("meals")
        .select("id", count=CountMethod.exact)
        .gte("meal_date", since)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )
    run_result = await sb.table("agent_runs").select("status,duration_ms,cost_usd").execute()
    runs = as_rows(run_result.data)
    successful = sum(row.get("status") == "ok" for row in runs)
    durations = sorted(
        value for row in runs if isinstance(value := row.get("duration_ms"), (int, float))
    )
    costs = [value for row in runs if isinstance(value := row.get("cost_usd"), (int, float))]
    return {
        "total_users": users.count or 0,
        "meals_last_7d": meals.count or 0,
        "agent_runs": len(runs),
        "agent_success_rate": round(successful / len(runs) * 100, 1) if runs else None,
        "p50_latency_ms": durations[len(durations) // 2] if durations else None,
        "p95_latency_ms": durations[int(len(durations) * 0.95)] if durations else None,
        "total_cost_usd": round(sum(costs), 4),
    }
