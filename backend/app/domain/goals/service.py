"""Goals. Thin: the formulas and the safety ladder live in Postgres.

This layer marshals and validates. It does NOT compute BMR, TDEE or targets -
that lives in ``fn_resolve_goal_targets_v2`` so a trigger, a backfill and the API
all evaluate the same arithmetic. See the migrations.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.core.exceptions import (
    ConflictError,
    IncompleteProfileError,
    NotFoundError,
    ValidationError,
    VLCDRefusedError,
)
from app.domain.goals.progress import evaluate_goal_progress, evaluate_metric_progress
from app.services.supabase import call_rpc, get_supabase
from app.utils.logger import logger

_ACTIVE = "is_active"
_MAX_GOAL_DAYS = 1830


def _missing_multi_goal_schema(exc: Exception) -> bool:
    text = str(exc)
    return any(
        marker in text
        for marker in (
            "goals.cadence",
            "goals.is_primary",
            "activity_logs",
            "fn_resolve_goal_targets_v2",
            "fn_create_goal_v2",
            "fn_set_goal_active_v2",
            "fn_set_goal_primary",
        )
    )


def _goal_defaults(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **row,
        "cadence": row.get("cadence")
        or ("period" if row.get("kind") == "body_weight" else "daily"),
        "is_primary": row.get("is_primary", bool(row.get("is_active"))),
    }


def _normalise_cadence(
    kind: str, cadence: str, spec: dict[str, Any], starts_on: date, ends_on: date
) -> str:
    period_days = (ends_on - starts_on).days + 1
    if period_days <= 0:
        raise ValidationError(
            "ends_on must be on or after starts_on", code="INVALID_GOAL_DATE_RANGE"
        )
    if period_days > _MAX_GOAL_DAYS:
        raise ValidationError(
            f"Goal periods cannot exceed {_MAX_GOAL_DAYS} days.",
            code="GOAL_PERIOD_TOO_LONG",
        )
    if kind == "nutrient":
        nutrients = spec.get("nutrients")
        if not isinstance(nutrients, dict) or len(nutrients) != 1:
            raise ValidationError(
                "A nutrient goal must contain exactly one target.", code="INVALID_GOAL_SPEC"
            )
        nutrient, nutrient_value = next(iter(nutrients.items()))
        if nutrient not in {"calories_kcal", "protein_g", "carbs_g", "fat_g"}:
            raise ValidationError("Unsupported daily nutrient target.", code="INVALID_GOAL_SPEC")
        if (
            not isinstance(nutrient_value, (int, float))
            or isinstance(nutrient_value, bool)
            or nutrient_value <= 0
        ):
            raise ValidationError("Nutrient target must be positive.", code="INVALID_GOAL_TARGET")
    if kind == "hydration":
        hydration = spec.get("target_ml")
        if hydration is not None and (
            not isinstance(hydration, (int, float)) or isinstance(hydration, bool) or hydration <= 0
        ):
            raise ValidationError("Hydration target must be positive.", code="INVALID_GOAL_TARGET")
    if kind == "body_weight":
        amount = spec.get("amount_kg")
        if spec.get("direction") not in {"lose", "gain"} or (
            not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount <= 0
        ):
            raise ValidationError(
                "Weight goals need a lose/gain direction and positive amount.",
                code="INVALID_GOAL_SPEC",
            )
    if kind in {"nutrient", "hydration", "item"}:
        return "daily"
    if kind == "body_weight":
        return "period"
    if kind != "behaviour":
        return cadence
    if cadence not in {"weekly", "monthly", "period"}:
        raise ValidationError(
            "Training cadence must be weekly, monthly, or period.",
            code="INVALID_GOAL_CADENCE",
        )
    target = spec.get("target")
    if (
        not isinstance(target, (int, float))
        or isinstance(target, bool)
        or target <= 0
        or target % 1
    ):
        raise ValidationError(
            "Training target must be a positive whole number of days.",
            code="INVALID_GOAL_TARGET",
        )
    maximum = 7 if cadence == "weekly" else 31 if cadence == "monthly" else period_days
    if target > maximum:
        raise ValidationError(
            f"Training target cannot exceed {maximum} days for this cadence.",
            code="INVALID_GOAL_TARGET",
        )
    return cadence


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
    if "hydration_extreme" in text:
        return ConflictError(
            "The requested hydration minimum is potentially unsafe.",
            code="HYDRATION_EXTREME",
            suggested_action="Choose a target closer to your profile-based estimate.",
        )
    if any(
        hint in text
        for hint in (
            "invalid_goal_spec",
            "unsupported_behaviour",
            "invalid_goal_dates",
            "primary_requires_calories",
        )
    ):
        return ValidationError("The goal configuration is invalid.", code="INVALID_GOAL_SPEC")
    return exc


async def preview(
    *,
    user_id: str,
    kind: str,
    spec: dict[str, Any],
    starts_on: date,
    ends_on: date,
    cadence: str = "daily",
    make_primary: bool = False,
) -> dict[str, Any]:
    """Dry-run a goal. Returns requested vs clamped, writes nothing.

    This is what turns a clamp into guidance: the UI can show "you asked for
    this, here is what is safe, here is the realistic date" BEFORE anything
    is stored.
    """
    cadence = _normalise_cadence(kind, cadence, spec, starts_on, ends_on)
    try:
        rows = await call_rpc(
            "fn_resolve_goal_targets_v2",
            {
                "p_user_id": user_id,
                "p_kind": kind,
                "p_spec": spec,
                "p_starts_on": starts_on,
                "p_ends_on": ends_on,
            },
        )
    except Exception as exc:
        if _missing_multi_goal_schema(exc):
            raise ConflictError(
                "Goal preview is temporarily unavailable while the database is upgraded.",
                code="GOAL_MIGRATION_REQUIRED",
                suggested_action="Apply the pending multi-goal migration before creating goals.",
            ) from exc
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
        "cadence": cadence,
    }


async def create_goal(
    *,
    user_id: str,
    kind: str,
    spec: dict[str, Any],
    starts_on: date,
    ends_on: date,
    cadence: str = "daily",
    make_primary: bool = False,
) -> dict[str, Any]:
    """Resolve, validate, and activate a goal in one database transaction."""
    cadence = _normalise_cadence(kind, cadence, spec, starts_on, ends_on)
    try:
        rows = await call_rpc(
            "fn_create_goal_v2",
            {
                "p_user_id": user_id,
                "p_kind": kind,
                "p_spec": spec,
                "p_starts_on": starts_on,
                "p_ends_on": ends_on,
                "p_cadence": cadence,
                "p_make_primary": make_primary,
            },
        )
    except Exception as exc:
        if _missing_multi_goal_schema(exc):
            raise ConflictError(
                "Goal updates are temporarily unavailable while the database is upgraded.",
                code="GOAL_MIGRATION_REQUIRED",
                suggested_action="Try again after the pending goal migration is deployed.",
            ) from exc
        raise _translate_pg_error(exc) from exc
    goal = _goal_defaults(rows[0] if isinstance(rows, list) and rows else (rows or {}))

    logger.info(
        "goal_created user_id={} kind={} clamped={}",
        user_id,
        kind,
        bool((goal.get("derivation") or {}).get("clamp_fired")),
    )
    return goal


async def get_active_goal(user_id: str) -> dict[str, Any] | None:
    """Return the active primary goal used by compatibility clients."""
    sb = await get_supabase()
    try:
        res = (
            await sb.table("goals")
            .select("*")
            .eq("user_id", user_id)
            .eq(_ACTIVE, True)
            .eq("is_primary", True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        if not _missing_multi_goal_schema(exc):
            raise
        res = (
            await sb.table("goals")
            .select("*")
            .eq("user_id", user_id)
            .eq(_ACTIVE, True)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
    row = (res.data or [None])[0]
    return _goal_defaults(row) if row else None


async def list_goals(
    user_id: str, *, limit: int = 50, offset: int = 0, status: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    sb = await get_supabase()
    res = await sb.table("goals").select("*").eq("user_id", user_id).execute()
    latest: dict[str, dict[str, Any]] = {}
    for raw_row in res.data or []:
        row = _goal_defaults(raw_row)
        logical_id = str(row["goal_id"])
        if logical_id not in latest or int(row["version"]) > int(latest[logical_id]["version"]):
            latest[logical_id] = row
    rows = [row for row in latest.values() if status is None or row.get("status") == status]
    rows.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return rows[offset : offset + limit], len(rows)


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
            "fn_set_goal_active_v2",
            {"p_user_id": user_id, "p_goal_id": goal_id, "p_active": active},
        )
    except Exception as exc:
        if _missing_multi_goal_schema(exc):
            raise ConflictError(
                "Goal updates are temporarily unavailable while the database is upgraded.",
                code="GOAL_MIGRATION_REQUIRED",
                suggested_action="Try again after the pending goal migration is deployed.",
            ) from exc
        if "goal_not_found" in str(exc):
            raise NotFoundError("Goal not found", code="GOAL_NOT_FOUND") from exc
        raise _translate_pg_error(exc) from exc
    return _goal_defaults(rows[0] if isinstance(rows, list) and rows else rows)


async def set_primary(user_id: str, goal_id: str) -> dict[str, Any]:
    try:
        rows = await call_rpc("fn_set_goal_primary", {"p_user_id": user_id, "p_goal_id": goal_id})
    except Exception as exc:
        if _missing_multi_goal_schema(exc):
            raise ConflictError(
                "Primary goal selection is unavailable while the database is upgraded.",
                code="GOAL_MIGRATION_REQUIRED",
            ) from exc
        if "goal_not_found" in str(exc):
            raise NotFoundError("Goal not found", code="GOAL_NOT_FOUND") from exc
        raise _translate_pg_error(exc) from exc
    return _goal_defaults(rows[0] if isinstance(rows, list) and rows else rows)


async def check_in_activity(
    user_id: str, activity_date: date, activity_type: str = "training"
) -> dict[str, Any]:
    sb = await get_supabase()
    result = (
        await sb.table("activity_logs")
        .upsert(
            {
                "user_id": user_id,
                "activity_date": activity_date.isoformat(),
                "activity_type": activity_type,
            },
            on_conflict="user_id,activity_date,activity_type",
        )
        .execute()
    )
    return result.data[0]


async def list_activity(
    user_id: str,
    date_from: date,
    date_to: date,
    *,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    if date_from > date_to:
        raise ValidationError("date_from must be on or before date_to", code="INVALID_DATE_RANGE")
    sb = await get_supabase()
    result = (
        await sb.table("activity_logs")
        .select("*", count="exact")
        .eq("user_id", user_id)
        .gte("activity_date", date_from.isoformat())
        .lte("activity_date", date_to.isoformat())
        .order("activity_date", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return result.data or [], result.count or 0


def _as_date(value: Any) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value))


async def progress_summary(user_id: str, as_of: date) -> dict[str, Any]:
    """Load source facts once, then evaluate every active goal without hidden proxies."""
    sb = await get_supabase()
    goals_result = (
        await sb.table("goals")
        .select("*")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .order("created_at")
        .execute()
    )
    goals = [_goal_defaults(goal) for goal in goals_result.data or []]
    if not goals:
        return {"as_of": as_of.isoformat(), "goals": []}

    range_start = min(_as_date(goal["starts_on"]) for goal in goals)
    range_end = min(as_of, max(_as_date(goal["ends_on"]) for goal in goals))
    meals: list[dict[str, Any]] = []
    water: list[dict[str, Any]] = []
    activities: list[dict[str, Any]] = []
    metrics: list[dict[str, Any]] = []

    if range_start <= range_end:
        needs_meals = any(
            goal["kind"] in {"nutrient", "body_weight", "item", "behaviour"} for goal in goals
        )
        if needs_meals:
            meals_result = (
                await sb.table("meals")
                .select("meal_date,nutrients,grams,food_id")
                .eq("user_id", user_id)
                .eq("is_active", True)
                .gte("meal_date", range_start.isoformat())
                .lte("meal_date", range_end.isoformat())
                .execute()
            )
            meals = meals_result.data or []
        if any(
            any(
                target.get("metric") == "water_ml"
                for target in (goal.get("daily_targets") or {}).get("targets") or []
            )
            for goal in goals
        ):
            water_result = (
                await sb.table("water_logs")
                .select("logged_on,volume_ml")
                .eq("user_id", user_id)
                .gte("logged_on", range_start.isoformat())
                .lte("logged_on", range_end.isoformat())
                .execute()
            )
            water = water_result.data or []
        if any(
            goal["kind"] == "behaviour"
            and (goal.get("spec") or {}).get("metric") == "training_days"
            for goal in goals
        ):
            try:
                activity_result = (
                    await sb.table("activity_logs")
                    .select("activity_date,activity_type")
                    .eq("user_id", user_id)
                    .eq("activity_type", "training")
                    .gte("activity_date", range_start.isoformat())
                    .lte("activity_date", range_end.isoformat())
                    .execute()
                )
                activities = activity_result.data or []
            except Exception as exc:
                if not _missing_multi_goal_schema(exc):
                    raise

    metrics_result = (
        await sb.table("body_metrics")
        .select("measured_on,weight_kg")
        .eq("user_id", user_id)
        .lte("measured_on", as_of.isoformat())
        .order("measured_on")
        .execute()
    )
    metrics = metrics_result.data or []

    summaries = []
    for goal in goals:
        starts_on = _as_date(goal["starts_on"])
        ends_on = _as_date(goal["ends_on"])
        actuals: dict[date, float | None] = {}
        kind = goal["kind"]
        target_rows = (goal.get("daily_targets") or {}).get("targets") or []
        target = target_rows[0] if target_rows else {}
        metric_summaries: list[dict[str, Any]] = []

        for target_row in target_rows:
            metric_actuals: dict[date, float | None] = {}
            metric = target_row.get("metric")
            scope = target_row.get("scope") or "total"
            if metric == "water_ml":
                for row in water:
                    logged_on = _as_date(row["logged_on"])
                    metric_actuals[logged_on] = (metric_actuals.get(logged_on) or 0) + float(
                        row["volume_ml"]
                    )
            elif scope == "activity":
                metric_actuals = {_as_date(row["activity_date"]): 1.0 for row in activities}
            elif scope == "dish":
                food_id = str(target_row.get("food_id") or "")
                for row in meals:
                    if str(row.get("food_id") or "") == food_id and row.get("grams") is not None:
                        logged_on = _as_date(row["meal_date"])
                        metric_actuals[logged_on] = (metric_actuals.get(logged_on) or 0) + float(
                            row["grams"]
                        )
            elif scope == "count":
                metric_actuals = {_as_date(row["meal_date"]): 1.0 for row in meals}
            else:
                for row in meals:
                    value = (row.get("nutrients") or {}).get(metric)
                    if value is not None:
                        logged_on = _as_date(row["meal_date"])
                        metric_actuals[logged_on] = (metric_actuals.get(logged_on) or 0) + float(
                            value
                        )
            metric_summaries.append(
                evaluate_metric_progress(goal, target_row, metric_actuals, as_of)
            )

        if kind == "nutrient":
            metric = target.get("metric")
            for row in meals:
                logged_on = _as_date(row["meal_date"])
                value = (row.get("nutrients") or {}).get(metric)
                if value is not None:
                    actuals[logged_on] = (actuals.get(logged_on) or 0) + float(value)
        elif kind == "item":
            food_id = str(target.get("food_id") or "")
            for row in meals:
                if str(row.get("food_id") or "") == food_id and row.get("grams") is not None:
                    logged_on = _as_date(row["meal_date"])
                    actuals[logged_on] = (actuals.get(logged_on) or 0) + float(row["grams"])
        elif kind == "hydration":
            for row in water:
                logged_on = _as_date(row["logged_on"])
                actuals[logged_on] = (actuals.get(logged_on) or 0) + float(row["volume_ml"])
        elif kind == "behaviour":
            if (goal.get("spec") or {}).get("metric") == "training_days":
                actuals = {_as_date(row["activity_date"]): 1.0 for row in activities}
            else:
                actuals = {_as_date(row["meal_date"]): 1.0 for row in meals}
        elif kind == "body_weight":
            ordered_metrics = [
                (_as_date(row["measured_on"]), float(row["weight_kg"])) for row in metrics
            ]
            latest: float | None = None
            metric_index = 0
            cursor = starts_on
            while cursor <= min(ends_on, as_of):
                while (
                    metric_index < len(ordered_metrics)
                    and ordered_metrics[metric_index][0] <= cursor
                ):
                    latest = ordered_metrics[metric_index][1]
                    metric_index += 1
                actuals[cursor] = latest
                cursor += timedelta(days=1)

        summary = evaluate_goal_progress(goal, actuals, as_of)
        summary["metrics"] = metric_summaries
        summaries.append(summary)

    return {"as_of": as_of.isoformat(), "goals": summaries}
