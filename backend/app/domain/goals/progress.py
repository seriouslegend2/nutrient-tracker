"""Pure cadence-aware goal progress evaluation."""

from __future__ import annotations

import calendar as month_calendar
import math
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

_MAX_GOAL_DAYS = 1830


def _target(goal: Mapping[str, Any]) -> tuple[float, str, str]:
    if goal["kind"] == "body_weight":
        target = (goal.get("derivation") or {}).get("target_weight_kg")
        if target is None:
            target = (goal.get("spec") or {}).get("target_weight_kg")
        direction = "at_most" if (goal.get("spec") or {}).get("direction") == "lose" else "at_least"
        return float(target or 0), "kg", direction

    targets = (goal.get("daily_targets") or {}).get("targets") or []
    target = targets[0] if targets else {}
    return (
        float(target.get("value") or 0),
        str(target.get("unit") or ""),
        str(target.get("direction") or "at_least"),
    )


def _status(
    actual: float | None,
    target: float,
    direction: str,
    *,
    future: bool = False,
    open_bucket: bool = False,
) -> str:
    if future:
        return "future"
    if actual is None:
        return "no_data"
    if direction == "at_most":
        if actual > target:
            return "above"
        return "in_progress" if open_bucket else "met"
    if direction == "around":
        if actual == target:
            return "met"
        if open_bucket:
            return "in_progress"
        return "above" if actual > target else "below"
    if actual >= target:
        return "met"
    return "in_progress" if open_bucket else "below"


def _buckets(starts_on: date, ends_on: date, cadence: str) -> list[tuple[date, date]]:
    if cadence == "period":
        return [(starts_on, ends_on)]

    buckets: list[tuple[date, date]] = []
    cursor = starts_on
    while cursor <= ends_on:
        if cadence == "weekly":
            bucket_end = cursor + timedelta(days=6 - cursor.weekday())
        elif cadence == "monthly":
            next_month = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
            bucket_end = next_month - timedelta(days=1)
        else:
            bucket_end = cursor
        bucket_end = min(bucket_end, ends_on)
        buckets.append((cursor, bucket_end))
        cursor = bucket_end + timedelta(days=1)
    return buckets


def _progress_pct(actual: float | None, target: float, direction: str) -> float | None:
    if actual is None or target <= 0:
        return None
    if direction == "at_most":
        return 100.0 if actual <= target else round(100 * target / actual, 1)
    return round(min(100 * actual / target, 100), 1)


def _behaviour_bucket_target(target: float, cadence: str, bucket_start: date, days: int) -> float:
    if cadence == "weekly":
        full_days = 7
    elif cadence == "monthly":
        full_days = month_calendar.monthrange(bucket_start.year, bucket_start.month)[1]
    else:
        return target
    return float(min(days, math.ceil(target * days / full_days)))


def evaluate_goal_progress(
    goal: Mapping[str, Any],
    actual_by_date: Mapping[date, float | None],
    as_of: date,
) -> dict[str, Any]:
    """Evaluate one goal over its inclusive, clipped calendar range."""
    starts_on = date.fromisoformat(str(goal["starts_on"]))
    ends_on = date.fromisoformat(str(goal["ends_on"]))
    ends_on = min(ends_on, starts_on + timedelta(days=_MAX_GOAL_DAYS - 1))
    cadence = str(goal.get("cadence") or "daily")
    kind = str(goal["kind"])
    spec = goal.get("spec") or {}
    targets = (goal.get("daily_targets") or {}).get("targets") or []
    metric = spec.get("metric") or (targets[0].get("metric") if targets else None)
    target, unit, direction = _target(goal)

    calendar: list[dict[str, Any]] = []
    cursor = starts_on
    while cursor <= ends_on:
        actual = actual_by_date.get(cursor)
        if kind == "behaviour" and cursor <= as_of:
            actual = actual or 0.0
        calendar.append(
            {
                "date": cursor.isoformat(),
                "status": _status(
                    actual,
                    1.0 if kind == "behaviour" else target,
                    direction,
                    future=cursor > as_of,
                    open_bucket=cursor == as_of,
                ),
                "actual": actual,
                "target": 1.0 if kind == "behaviour" else target,
            }
        )
        cursor += timedelta(days=1)

    evaluated_buckets: list[dict[str, Any]] = []
    for bucket_start, bucket_end in _buckets(starts_on, ends_on, cadence):
        days = (bucket_end - bucket_start).days + 1
        values = [
            actual_by_date.get(bucket_start + timedelta(days=offset)) for offset in range(days)
        ]
        if kind == "behaviour":
            actual = sum(value or 0 for value in values) if bucket_start <= as_of else None
            bucket_target = _behaviour_bucket_target(target, cadence, bucket_start, days)
        elif kind == "body_weight":
            present = [value for value in values if value is not None]
            actual = present[-1] if present else None
            bucket_target = target
        else:
            present = [value for value in values if value is not None]
            actual = sum(present) if present else None
            bucket_target = target * days
        evaluated_buckets.append(
            {
                "start": bucket_start,
                "end": bucket_end,
                "actual": actual,
                "target": bucket_target,
                "status": _status(
                    actual,
                    bucket_target,
                    direction,
                    future=bucket_start > as_of,
                    open_bucket=bucket_start <= as_of <= bucket_end,
                ),
            }
        )

    relevant = [bucket for bucket in evaluated_buckets if bucket["start"] <= as_of]
    actual_values = [bucket["actual"] for bucket in relevant if bucket["actual"] is not None]
    if kind == "body_weight":
        period_actual = actual_values[-1] if actual_values else None
        period_target = target
    else:
        period_actual = sum(actual_values) if actual_values else None
        period_target = sum(float(bucket["target"]) for bucket in evaluated_buckets)

    if not relevant:
        period_status = "future"
    elif as_of <= ends_on:
        period_status = "in_progress"
    elif all(bucket["status"] == "met" for bucket in evaluated_buckets):
        period_status = "met"
    elif period_actual is None or any(
        bucket["status"] == "no_data" for bucket in evaluated_buckets
    ):
        period_status = "no_data"
    else:
        period_status = _status(period_actual, period_target, direction)

    streak_current = 0
    streak_longest = 0
    if kind == "behaviour":
        streak_buckets = [bucket for bucket in relevant if bucket["end"] < as_of]
        current_bucket = next(
            (bucket for bucket in relevant if bucket["start"] <= as_of <= bucket["end"]), None
        )
        if current_bucket and current_bucket["status"] == "met":
            streak_buckets.append(current_bucket)
        run = 0
        for bucket in streak_buckets:
            if bucket["status"] == "met":
                run += 1
                streak_longest = max(streak_longest, run)
            else:
                run = 0
        for bucket in reversed(streak_buckets):
            if bucket["status"] != "met":
                break
            streak_current += 1

    today_actual = actual_by_date.get(as_of) if starts_on <= as_of <= ends_on else None
    if kind == "behaviour" and starts_on <= as_of <= ends_on:
        today_actual = today_actual or 0.0
    today_target = 1.0 if kind == "behaviour" else target
    today_status = _status(
        today_actual,
        today_target,
        direction,
        future=as_of < starts_on,
        open_bucket=starts_on <= as_of <= ends_on,
    )

    label = (goal.get("spec") or {}).get("label")
    if not label:
        label = {
            "nutrient": "Nutrition",
            "hydration": "Hydration",
            "behaviour": "Training",
            "body_weight": "Body weight",
            "item": "Food item",
        }.get(kind, kind.replace("_", " ").title())

    return {
        "goal_id": str(goal["goal_id"]),
        "kind": kind,
        "metric": metric,
        "cadence": cadence,
        "is_primary": bool(goal.get("is_primary")),
        "label": label,
        "starts_on": starts_on.isoformat(),
        "ends_on": ends_on.isoformat(),
        "today": {
            "status": today_status,
            "actual": today_actual,
            "target": today_target,
            "unit": unit,
            "direction": direction,
        },
        "period": {
            "status": period_status,
            "actual": period_actual,
            "target": period_target,
            "unit": unit,
            "progress_pct": _progress_pct(period_actual, period_target, direction),
            "completed_buckets": sum(bucket["status"] == "met" for bucket in evaluated_buckets),
            "total_buckets": len(evaluated_buckets),
        },
        "streak": {
            "current": streak_current,
            "longest": streak_longest,
            "unit": {
                "daily": "days",
                "weekly": "weeks",
                "monthly": "months",
                "period": "periods",
            }[cadence],
        },
        "calendar": calendar,
    }
