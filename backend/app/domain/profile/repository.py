"""Profile, roles, body metrics and preferences."""

from __future__ import annotations

from datetime import date
from typing import Any

from app.services.supabase import call_rpc, get_supabase, serialise
from app.utils.logger import logger

_ACTIVE = "is_active"


async def ensure_user(user_id: str, email: str | None = None) -> dict[str, Any]:
    """Create the app identity and default role for a Supabase auth user."""
    sb = await get_supabase()
    user = {"id": user_id}
    if email:
        user["email"] = email
    result = await sb.table("app_users").upsert(user, on_conflict="id").execute()
    await (
        sb.table("user_roles")
        .upsert(
            {"user_id": user_id, "role": "customer"},
            on_conflict="user_id,role",
            ignore_duplicates=True,
        )
        .execute()
    )
    return result.data[0]


async def get_user_roles(user_id: str) -> list[Any]:
    """Roles from OUR table, never from the JWT.

    Supabase lets a user update their own ``user_metadata``, so a role stored
    there would be self-assignable - a straight privilege-escalation hole.
    """
    from app.core.deps import Role  # local import: core must not depend on domain

    sb = await get_supabase()
    res = await sb.table("user_roles").select("role").eq("user_id", user_id).execute()
    out: list[Role] = []
    for row in res.data or []:
        try:
            out.append(Role(row["role"]))
        except ValueError:
            continue
    return out


async def get_profile(user_id: str) -> dict[str, Any] | None:
    sb = await get_supabase()
    res = await sb.table("user_profiles").select("*").eq("user_id", user_id).limit(1).execute()
    return (res.data or [None])[0]


async def upsert_profile(user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    sb = await get_supabase()
    payload = serialise({k: v for k, v in patch.items() if v is not None})
    payload["user_id"] = user_id
    res = await sb.table("user_profiles").upsert(payload, on_conflict="user_id").execute()
    # A database trigger refreshes derived columns without exposing them for
    # authenticated direct writes.
    return (await get_profile(user_id)) or res.data[0]


async def add_body_metric(
    user_id: str,
    weight_kg: float,
    waist_cm: float | None = None,
    measured_on: date | None = None,
) -> dict[str, Any]:
    """Append-only. The INSERT trigger refreshes the profile and may version the goal."""
    sb = await get_supabase()
    res = (
        await sb.table("body_metrics")
        .insert(
            {
                "user_id": user_id,
                "weight_kg": weight_kg,
                "waist_cm": waist_cm,
                "measured_on": (measured_on or date.today()).isoformat(),
            }
        )
        .execute()
    )
    logger.info("body_metric_added user_id={} weight={}", user_id, weight_kg)
    return res.data[0]


async def list_body_metrics(
    user_id: str, *, limit: int = 50, offset: int = 0
) -> tuple[list[dict[str, Any]], int]:
    sb = await get_supabase()
    res = (
        await sb.table("body_metrics")
        .select("*", count="exact")
        .eq("user_id", user_id)
        .order("measured_on", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return res.data or [], res.count or 0


# ---------------------------------------------------------------------------
# Preferences: ONE table holding everything we know about the user.
# Versioned in place; the previous state goes to audit_log.
# ---------------------------------------------------------------------------


async def list_preferences(
    user_id: str, *, limit: int = 50, offset: int = 0, active_only: bool = True
) -> tuple[list[dict[str, Any]], int]:
    sb = await get_supabase()
    q = (
        sb.table("user_preferences")
        .select("*", count="exact")
        .eq("user_id", user_id)
        .eq(_ACTIVE, True)
    )
    if active_only:
        q = q.eq("status", "Active")
    res = await q.order("topic_title").range(offset, offset + limit - 1).execute()
    return res.data or [], res.count or 0


async def upsert_preference(
    user_id: str,
    topic_title: str,
    content: str,
    *,
    pref_type: str = "Permanent",
    source: str = "questionnaire",
    expires_on: date | None = None,
) -> dict[str, Any]:
    """Create or version a preference cluster.

    An UPDATE re-emits the COMPLETE rewritten content, never a diff - which
    removes an entire class of merge bug.
    """
    rows = await call_rpc(
        "fn_upsert_preference",
        {
            "p_user_id": user_id,
            "p_topic_title": topic_title,
            "p_content": content,
            "p_type": pref_type,
            "p_source": source,
            "p_expires_on": expires_on,
        },
    )
    return rows[0] if isinstance(rows, list) and rows else rows
