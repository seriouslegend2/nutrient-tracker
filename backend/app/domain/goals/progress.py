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
        if open_bucket:
            return "in_progress"
        tolerance = target * 0.1
        if target - tolerance <= actual <= target + tolerance:
            return "met"
        return "above" if actual > target + tolerance else "below"
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


def _completion_pct(actual: float | None, target: float) -> float | None:
    if actual is None or target <= 0:
        return None
    return round(min(100 * actual / target, 100), 1)


def _weight_progress_pct(start: float | None, actual: float | None, target: float) -> float | None:
    if start is None or actual is None or start == target:
        return None
    return round(max(0.0, min(100.0, 100 * (actual - start) / (target - start))), 1)


def _latest_value(
    actual_by_date: Mapping[date, float | None], starts_on: date, ends_on: date
) -> float | None:
    values = [
        actual_by_date.get(starts_on + timedelta(days=offset))
        for offset in range((ends_on - starts_on).days + 1)
    ]
    present = [value for value in values if value is not None]
    return float(present[-1]) if present else None


def _weight_target_on(
    starts_on: date, ends_on: date, start_weight: float | None, target: float, on_date: date
) -> float:
    if start_weight is None or ends_on <= starts_on:
        return target
    elapsed = max(0, min((on_date - starts_on).days, (ends_on - starts_on).days))
    ratio = elapsed / (ends_on - starts_on).days
    return round(start_weight + (target - start_weight) * ratio, 2)


def _behaviour_bucket_target(target: float, cadence: str, bucket_start: date, days: int) -> float:
    if cadence == "weekly":
        full_days = 7
    elif cadence == "monthly":
        full_days = month_calendar.monthrange(bucket_start.year, bucket_start.month)[1]
    else:
        return target
    return float(min(days, math.ceil(target * days / full_days)))


def evaluate_metric_progress(
    goal: Mapping[str, Any],
    target_row: Mapping[str, Any],
    actual_by_date: Mapping[date, float | None],
    as_of: date,
) -> dict[str, Any]:
    """Evaluate one resolved target as a daily bar and a full-period bar."""
    starts_on = date.fromisoformat(str(goal["starts_on"]))
    ends_on = min(
        date.fromisoformat(str(goal["ends_on"])),
        starts_on + timedelta(days=_MAX_GOAL_DAYS - 1),
    )
    cadence = str(goal.get("cadence") or "daily")
    metric = str(target_row.get("metric") or "value")
    unit = str(target_row.get("unit") or "")
    direction = str(target_row.get("direction") or "at_least")
    target = float(target_row.get("value") or 0)
    scope = str(target_row.get("scope") or "total")

    daily_targets: dict[date, float] = {}
    if scope == "activity":
        for bucket_start, bucket_end in _buckets(starts_on, ends_on, cadence):
            days = (bucket_end - bucket_start).days + 1
            bucket_target = _behaviour_bucket_target(target, cadence, bucket_start, days)
            for offset in range(days):
                daily_targets[bucket_start + timedelta(days=offset)] = bucket_target / days
    else:
        cursor = starts_on
        while cursor <= ends_on:
            daily_targets[cursor] = target
            cursor += timedelta(days=1)

    total_days = (ends_on - starts_on).days + 1
    effective_as_of = min(max(as_of, starts_on), ends_on)
    days_elapsed = 0 if as_of < starts_on else (effective_as_of - starts_on).days + 1
    today_actual = actual_by_date.get(as_of) if starts_on <= as_of <= ends_on else None
    if scope == "activity" and starts_on <= as_of <= ends_on:
        today_actual = today_actual or 0.0
    today_target = 1.0 if scope == "activity" else daily_targets.get(as_of, target)

    elapsed_values = [
        value
        for day, value in actual_by_date.items()
        if starts_on <= day <= effective_as_of and value is not None
    ]
    period_actual = sum(float(value) for value in elapsed_values) if elapsed_values else None
    if scope == "activity" and days_elapsed > 0 and period_actual is None:
        period_actual = 0.0
    period_target = sum(daily_targets.values())
    target_to_date = (
        sum(value for day, value in daily_targets.items() if day <= effective_as_of)
        if as_of >= starts_on
        else 0.0
    )

    labels = {
        "calories_kcal": "Calories",
        "protein_g": "Protein",
        "carbs_g": "Carbs",
        "fat_g": "Fat",
        "fiber_g": "Fibre",
        "water_ml": "Hydration",
        "training_days": "Training",
    }
    return {
        "metric": metric,
        "label": labels.get(metric, metric.replace("_", " ").title()),
        "unit": unit,
        "direction": direction,
        "today": {
            "status": _status(
                today_actual,
                today_target,
                direction,
                future=as_of < starts_on,
                open_bucket=starts_on <= as_of <= ends_on,
            ),
            "actual": today_actual,
            "target": today_target,
            "unit": unit,
            "direction": direction,
            "progress_pct": _completion_pct(today_actual, today_target),
        },
        "period": {
            "status": "future"
            if as_of < starts_on
            else "in_progress"
            if as_of <= ends_on
            else _status(period_actual, period_target, direction),
            "actual": period_actual,
            "target": period_target,
            "target_to_date": target_to_date,
            "unit": unit,
            "direction": direction,
            "progress_pct": _completion_pct(period_actual, period_target),
            "days_elapsed": days_elapsed,
            "total_days": total_days,
        },
    }


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
    body_baseline = actual_by_date.get(starts_on) if kind == "body_weight" else None

    daily_expected: dict[date, float] = {}
    if kind != "body_weight":
        for bucket_start, bucket_end in _buckets(starts_on, ends_on, cadence):
            days = (bucket_end - bucket_start).days + 1
            bucket_target = (
                _behaviour_bucket_target(target, cadence, bucket_start, days)
                if kind == "behaviour"
                else target * days
            )
            for offset in range(days):
                daily_expected[bucket_start + timedelta(days=offset)] = bucket_target / days

    calendar: list[dict[str, Any]] = []
    cursor = starts_on
    while cursor <= ends_on:
        actual = actual_by_date.get(cursor)
        if kind == "behaviour" and cursor <= as_of:
            actual = actual or 0.0
        day_target = (
            _weight_target_on(starts_on, ends_on, body_baseline, target, cursor)
            if kind == "body_weight"
            else 1.0
            if kind == "behaviour"
            else target
        )
        calendar.append(
            {
                "date": cursor.isoformat(),
                "status": _status(
                    actual,
                    day_target,
                    direction,
                    future=cursor > as_of,
                    open_bucket=cursor == as_of,
                ),
                "actual": actual,
                "target": day_target,
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
    effective_as_of = min(max(as_of, starts_on), ends_on)
    total_days = (ends_on - starts_on).days + 1
    days_elapsed = 0 if as_of < starts_on else (effective_as_of - starts_on).days + 1
    calendar_week_start = effective_as_of - timedelta(days=effective_as_of.weekday())
    week_start = max(starts_on, calendar_week_start)
    week_end = min(ends_on, calendar_week_start + timedelta(days=6))
    week_elapsed_end = min(effective_as_of, week_end)
    if kind == "body_weight":
        period_actual = actual_values[-1] if actual_values else None
        period_target = target
        period_baseline = body_baseline
        period_target_to_date = _weight_target_on(
            starts_on, ends_on, period_baseline, target, effective_as_of
        )
        period_progress = _weight_progress_pct(
            period_baseline, period_actual, period_target_to_date
        )
        overall_progress = _weight_progress_pct(period_baseline, period_actual, target)
    else:
        period_actual = sum(actual_values) if actual_values else None
        period_target = sum(daily_expected.values())
        period_target_to_date = (
            sum(value for day, value in daily_expected.items() if day <= effective_as_of)
            if as_of >= starts_on
            else 0.0
        )
        period_baseline = None
        period_progress = _completion_pct(period_actual, period_target_to_date)
        overall_progress = _completion_pct(period_actual, period_target)

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
    if kind == "body_weight":
        today_target = _weight_target_on(starts_on, ends_on, period_baseline, target, as_of)
    else:
        today_target = daily_expected.get(as_of, target)
    today_status = _status(
        today_actual,
        today_target,
        direction,
        future=as_of < starts_on,
        open_bucket=starts_on <= as_of <= ends_on,
    )

    if kind == "body_weight":
        week_baseline = actual_by_date.get(week_start)
        week_actual = _latest_value(actual_by_date, week_start, week_elapsed_end)
        week_target = _weight_target_on(starts_on, ends_on, period_baseline, target, week_end)
        week_target_to_date = _weight_target_on(
            starts_on, ends_on, period_baseline, target, week_elapsed_end
        )
        week_progress = _weight_progress_pct(week_baseline, week_actual, week_target_to_date)
    else:
        week_values = [
            actual_by_date.get(week_start + timedelta(days=offset))
            for offset in range((week_elapsed_end - week_start).days + 1)
        ]
        if kind == "behaviour":
            week_actual = sum(value or 0 for value in week_values)
        else:
            present = [value for value in week_values if value is not None]
            week_actual = sum(present) if present else None
        week_target = sum(
            value for day, value in daily_expected.items() if week_start <= day <= week_end
        )
        week_target_to_date = sum(
            value for day, value in daily_expected.items() if week_start <= day <= week_elapsed_end
        )
        week_progress = _completion_pct(week_actual, week_target_to_date)
    week_status = _status(
        week_actual,
        week_target_to_date,
        direction,
        future=as_of < starts_on,
        open_bucket=as_of <= week_end,
    )

    label = (goal.get("spec") or {}).get("label")
    if not label:
        if kind == "body_weight":
            amount = (goal.get("spec") or {}).get("amount_kg")
            action = "Gain" if (goal.get("spec") or {}).get("direction") == "gain" else "Lose"
            label = f"{action} {amount:g} kg" if isinstance(amount, (int, float)) else "Body weight"
        else:
            label = {
                "nutrient": "Nutrition",
                "hydration": "Hydration",
                "behaviour": "Training",
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
            "progress_pct": (
                _weight_progress_pct(period_baseline, today_actual, today_target)
                if kind == "body_weight"
                else _completion_pct(today_actual, today_target)
            ),
        },
        "current_week": {
            "starts_on": week_start.isoformat(),
            "ends_on": week_end.isoformat(),
            "status": week_status,
            "actual": week_actual,
            "target": week_target,
            "target_to_date": week_target_to_date,
            "unit": unit,
            "direction": direction,
            "progress_pct": week_progress,
        },
        "period": {
            "status": period_status,
            "actual": period_actual,
            "target": period_target,
            "target_to_date": period_target_to_date,
            "unit": unit,
            "progress_pct": period_progress,
            "overall_progress_pct": overall_progress,
            "baseline": period_baseline,
            "days_elapsed": days_elapsed,
            "total_days": total_days,
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
