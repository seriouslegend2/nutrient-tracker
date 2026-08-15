"""Goals. Thin: the formulas and the safety ladder live in Postgres.

This layer marshals and validates. It does NOT compute BMR, TDEE or targets -
that lives in ``fn_resolve_goal_targets`` so a trigger, a backfill and the API
all evaluate the same arithmetic. See the migrations.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.core.exceptions import (
    ConflictError,
    IncompleteProfileError,
    NotFoundError,
    VLCDRefusedError,
)
from app.services.supabase import call_rpc, get_supabase
from app.utils.logger import logger

_ACTIVE = "is_active"


def _translate_pg_error(exc: Exception) -> Exception:
    """Map the safety ladder's PT409 hints onto typed domain errors.

    The ladder raises PT409 rather than 40001/40P01: PostgREST retries those
    retryable codes server-side in an infinite loop even after the client
    disconnects, which once pinned KookarCore's production DB at ~95% CPU.
    """
    text = str(exc)
    if "vlcd_refused" in text:
        return VLCDRefusedError(0)
    if "under_18" in text:
        return ConflictError(
            "Goal targets are not available for users under 18.",
            code="UNDER_18",
            suggested_action="Speak to a doctor or dietitian about a suitable plan.",
        )
    if "pregnant_or_nursing" in text:
        return ConflictError(
            "Weight goals require clinical supervision during pregnancy or nursing.",
            code="PREGNANCY_GUARD",
            suggested_action="Please speak to your doctor before setting a weight goal.",
        )
    if "medical_condition" in text:
        return ConflictError(
            "Weight goals require clinical review for your disclosed medical condition.",
            code="MEDICAL_CONDITION_GUARD",
            suggested_action="Ask your doctor or dietitian for an appropriate target.",
        )
    if "target_bmi" in text:
        return ConflictError(
            "The requested target weight would produce a BMI below 18.5.",
            code="TARGET_BMI_GUARD",
            suggested_action="Choose a target weight within the healthy BMI range.",
        )
    if "incomplete_profile" in text:
        return IncompleteProfileError(["height_cm", "weight_kg", "date_of_birth"])
    return exc


async def preview(
    *, user_id: str, kind: str, spec: dict[str, Any], starts_on: date, ends_on: date
) -> dict[str, Any]:
    """Dry-run a goal. Returns requested vs clamped, writes nothing.

    This is what turns a clamp into guidance: the UI can show "you asked for
    this, here is what is safe, here is the realistic date" BEFORE anything
    is stored.
    """
    try:
        rows = await call_rpc(
            "fn_resolve_goal_targets",
            {
                "p_user_id": user_id,
                "p_kind": kind,
                "p_spec": spec,
                "p_starts_on": starts_on,
                "p_ends_on": ends_on,
            },
        )
    except Exception as exc:
        raise _translate_pg_error(exc) from exc

    row = rows[0] if isinstance(rows, list) and rows else (rows or {})
    derivation = row.get("derivation") or {}

    if derivation.get("floor_applied"):
        logger.info(
            "goal_floor_applied user_id={} requested={} applied={}",
            user_id,
            derivation.get("requested_intake_kcal"),
            derivation.get("applied_intake_kcal"),
        )

    return {
        "daily_targets": row.get("daily_targets") or {"targets": []},
        "derivation": derivation,
        "clamp_fired": bool(derivation.get("clamp_fired") or derivation.get("floor_applied")),
    }


async def create_goal(
    *, user_id: str, kind: str, spec: dict[str, Any], starts_on: date, ends_on: date
) -> dict[str, Any]:
    """Resolve, validate, and activate a goal in one database transaction."""
    try:
        rows = await call_rpc(
            "fn_create_goal",
            {
                "p_user_id": user_id,
                "p_kind": kind,
                "p_spec": spec,
                "p_starts_on": starts_on,
                "p_ends_on": ends_on,
            },
        )
    except Exception as exc:
        raise _translate_pg_error(exc) from exc
    goal = rows[0] if isinstance(rows, list) and rows else (rows or {})

    logger.info(
        "goal_created user_id={} kind={} clamped={}",
        user_id,
        kind,
        bool((goal.get("derivation") or {}).get("clamp_fired")),
    )
    return goal


async def get_active_goal(user_id: str) -> dict[str, Any] | None:
    """The homepage goal. Exactly one row, guaranteed by a partial unique index."""
    sb = await get_supabase()
    res = (
        await sb.table("goals")
        .select("*")
        .eq("user_id", user_id)
        .eq(_ACTIVE, True)
        .limit(1)
        .execute()
    )
    return (res.data or [None])[0]


async def list_goals(
    user_id: str, *, limit: int = 50, offset: int = 0, status: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    sb = await get_supabase()
    q = sb.table("goals").select("*", count="exact").eq("user_id", user_id)
    if status:
        q = q.eq("status", status)
    res = await q.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    return res.data or [], res.count or 0


async def progress(user_id: str, goal_id: str, date_from: date, date_to: date) -> dict[str, Any]:
    """Goal vs actual. A SUM over meals compared to daily_targets - pure maths."""
    goal = await get_active_goal(user_id)
    if not goal or goal["goal_id"] != goal_id:
        sb = await get_supabase()
        check = (
            await sb.table("goals")
            .select("goal_id")
            .eq("user_id", user_id)
            .eq("goal_id", goal_id)
            .limit(1)
            .execute()
        )
        if not check.data:
            raise NotFoundError("Goal not found", code="GOAL_NOT_FOUND")

    return await call_rpc(
        "fn_goal_progress",
        {"p_goal_id": goal_id, "p_from": date_from, "p_to": date_to},
    )


async def set_active(user_id: str, goal_id: str, active: bool) -> dict[str, Any]:
    try:
        rows = await call_rpc(
            "fn_set_goal_active",
            {"p_user_id": user_id, "p_goal_id": goal_id, "p_active": active},
        )
    except Exception as exc:
        if "goal_not_found" in str(exc):
            raise NotFoundError("Goal not found", code="GOAL_NOT_FOUND") from exc
        raise _translate_pg_error(exc) from exc
    return rows[0] if isinstance(rows, list) and rows else rows
