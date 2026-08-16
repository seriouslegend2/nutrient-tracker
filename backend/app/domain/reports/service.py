"""Reports: the four chart families the assignment asks for.

All four are aggregates over ``meals``, which is a single-table scan because
nutrients are denormalised onto the row.

Unknown-nutrition rows are reported as a GAP, never counted as zero - "3 items
unaccounted" is honest, silently under-counting is not.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, timedelta
from statistics import median
from typing import Any

from app.domain.goals import service as goals_service
from app.services.supabase import get_supabase

# The 18 micronutrients we ship, with ICMR-NIN 2020 adult RDAs (M/F).
# ICMR reference adults: man 65 kg, woman 55 kg. US values in the comment.
# ICMR publishes both EAR and RDA and recommends EAR for assessing adequacy,
# so RDA is the on-screen individual goal and EAR would drive cohort analytics.
RDA: dict[str, dict[str, float]] = {
    "iron_mg": {"male": 19, "female": 29},  # US 8 / 18
    "vitamin_b12_ug": {"male": 2.2, "female": 2.2},  # US 2.4
    "vitamin_d_iu": {"male": 600, "female": 600},
    "calcium_mg": {"male": 1000, "female": 1000},
    "folate_ug": {"male": 300, "female": 220},  # US 400
    "zinc_mg": {"male": 17, "female": 13},
    "vitamin_a_ug": {"male": 1000, "female": 840},
    "vitamin_c_mg": {"male": 80, "female": 65},  # the iron-absorption enhancer
    "iodine_ug": {"male": 150, "female": 150},
    "magnesium_mg": {"male": 440, "female": 370},
    "potassium_mg": {"male": 3510, "female": 3510},
    "sodium_mg": {"male": 2000, "female": 2000},  # a CEILING, not a target
    "vitamin_b1_mg": {"male": 1.8, "female": 1.7},
    "vitamin_b2_mg": {"male": 2.5, "female": 2.4},
    "vitamin_b6_mg": {"male": 2.4, "female": 1.9},
    "selenium_ug": {"male": 40, "female": 40},
    "vitamin_e_mg": {"male": 10, "female": 10},
}

# The only inverted nutrient on the panel: less is better.
CEILING_NUTRIENTS = {"sodium_mg"}

MACROS = ["calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"]


async def _rows(user_id: str, date_from: date, date_to: date) -> list[dict[str, Any]]:
    sb = await get_supabase()
    res = (
        await sb.table("meals")
        .select("meal_date,meal_type,slot_time,nutrients,dish_name,source,resolved_from")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .gte("meal_date", date_from.isoformat())
        .lte("meal_date", date_to.isoformat())
        .execute()
    )
    return res.data or []


async def _water_rows(user_id: str, date_from: date, date_to: date) -> list[dict[str, Any]]:
    sb = await get_supabase()
    res = (
        await sb.table("water_logs")
        .select("logged_on,volume_ml")
        .eq("user_id", user_id)
        .gte("logged_on", date_from.isoformat())
        .lte("logged_on", date_to.isoformat())
        .execute()
    )
    return res.data or []


def _add_months(value: date, months: int) -> date:
    index = value.year * 12 + value.month - 1 + months
    year, month_index = divmod(index, 12)
    month = month_index + 1
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def _periods(date_from: date, date_to: date, group_by: str) -> list[dict[str, Any]]:
    """Materialize every rolling period in the inclusive requested range."""
    periods: list[dict[str, Any]] = []
    cursor = date_from
    index = 0
    while cursor <= date_to:
        if group_by == "day":
            end = cursor
        elif group_by == "week":
            end = min(cursor + timedelta(days=6), date_to)
        else:
            next_start = _add_months(date_from, index + 1)
            end = min(next_start - timedelta(days=1), date_to)
        periods.append(
            {
                "bucket": cursor.isoformat(),
                "period_start": cursor.isoformat(),
                "period_end": end.isoformat(),
                "calendar_days": (end - cursor).days + 1,
                "is_partial": (
                    group_by == "week" and (end - cursor).days < 6
                )
                or (
                    group_by == "month" and end < _add_months(date_from, index + 1) - timedelta(days=1)
                ),
            }
        )
        cursor = end + timedelta(days=1)
        index += 1
    return periods


def _period_lookup(periods: list[dict[str, Any]]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for period in periods:
        cursor = date.fromisoformat(period["period_start"])
        end = date.fromisoformat(period["period_end"])
        while cursor <= end:
            lookup[cursor.isoformat()] = str(period["bucket"])
            cursor += timedelta(days=1)
    return lookup


def _range_meta(date_from: date, date_to: date, group_by: str) -> dict[str, Any]:
    return {
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "calendar_days": (date_to - date_from).days + 1,
        "group_by": group_by,
    }


async def trend(
    user_id: str, date_from: date, date_to: date, group_by: str = "day"
) -> dict[str, Any]:
    """Calorie intake over time, with a 7-point rolling mean."""
    rows = await _rows(user_id, date_from, date_to)
    periods = _periods(date_from, date_to, group_by)
    lookup = _period_lookup(periods)
    buckets: dict[str, float] = defaultdict(float)
    recorded_days: dict[str, set[str]] = defaultdict(set)
    total_items: dict[str, int] = defaultdict(int)
    items_with_value: dict[str, int] = defaultdict(int)
    unaccounted = 0
    for row in rows:
        meal_date = str(row["meal_date"])
        bucket = lookup[meal_date]
        total_items[bucket] += 1
        nutrients = row.get("nutrients") or {}
        if "calories_kcal" not in nutrients:
            unaccounted += 1
            continue
        buckets[bucket] += float(nutrients["calories_kcal"])
        recorded_days[bucket].add(meal_date)
        items_with_value[bucket] += 1

    series = []
    for period in periods:
        bucket = str(period["bucket"])
        covered = len(recorded_days[bucket])
        value = round(buckets[bucket], 1) if items_with_value[bucket] else None
        series.append(
            {
                **period,
                "calories_kcal": value,
                "daily_average_kcal": round(buckets[bucket] / covered, 1) if covered else None,
                "recorded_days": covered,
                "items_with_value": items_with_value[bucket],
                "total_items": total_items[bucket],
                "coverage_status": "missing"
                if not items_with_value[bucket]
                else "complete"
                if covered == period["calendar_days"]
                and items_with_value[bucket] == total_items[bucket]
                else "partial",
            }
        )

    window = 7
    for i, point in enumerate(series):
        lo = max(0, i - window + 1)
        chunk = [p["daily_average_kcal"] for p in series[lo : i + 1]]
        point["rolling_mean"] = (
            round(sum(chunk) / window, 1)
            if len(chunk) == window and all(value is not None for value in chunk)
            else None
        )

    return {
        **_range_meta(date_from, date_to, group_by),
        "series": series,
        "unaccounted_items": unaccounted,
    }


async def macros(
    user_id: str, date_from: date, date_to: date, group_by: str = "day"
) -> dict[str, Any]:
    """Macro breakdown, in grams AND as a percentage of energy.

    Both, because the AMDR reference ranges are expressed in percent
    (carb 45-65%, fat 20-35%, protein 10-35%) while a user thinks in grams.
    """
    rows = await _rows(user_id, date_from, date_to)
    periods = _periods(date_from, date_to, group_by)
    lookup = _period_lookup(periods)
    buckets: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    coverage: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    coverage_days: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    logged_days: set[str] = set()
    unaccounted = 0
    for row in rows:
        nutrients = row.get("nutrients") or {}
        present = [macro for macro in MACROS if macro in nutrients]
        if not present:
            unaccounted += 1
            continue
        logged_days.add(row["meal_date"])
        key = lookup[str(row["meal_date"])]
        for macro in present:
            buckets[key][macro] += float(nutrients[macro])
            coverage[key][macro] += 1
            coverage_days[key][macro].add(str(row["meal_date"]))

    series = []
    overall_coverage_days: dict[str, set[str]] = defaultdict(set)
    for period in periods:
        key = str(period["bucket"])
        vals = {
            macro: round(buckets[key][macro], 1) if coverage[key][macro] else None
            for macro in MACROS
        }
        means = {
            macro: round(buckets[key][macro] / len(coverage_days[key][macro]), 1)
            if coverage_days[key][macro]
            else None
            for macro in MACROS
        }
        for macro in MACROS:
            overall_coverage_days[macro].update(coverage_days[key][macro])
        complete = all(vals[macro] is not None for macro in ("protein_g", "carbs_g", "fat_g"))
        energy = (
            float(vals["protein_g"]) * 4
            + float(vals["carbs_g"]) * 4
            + float(vals["fat_g"]) * 9
            if complete
            else 0
        )
        vals["pct_of_energy"] = (
            {
                "protein": round(float(vals["protein_g"]) * 4 / energy * 100, 1),
                "carbs": round(float(vals["carbs_g"]) * 4 / energy * 100, 1),
                "fat": round(float(vals["fat_g"]) * 9 / energy * 100, 1),
            }
            if energy
            else {"protein": None, "carbs": None, "fat": None}
        )
        series.append(
            {
                **period,
                **vals,
                "mean_per_covered_day": means,
                "coverage_items": dict(coverage[key]),
                "coverage_days": {
                    macro: len(days) for macro, days in coverage_days[key].items()
                },
            }
        )

    return {
        **_range_meta(date_from, date_to, group_by),
        "series": series,
        "logged_days": len(logged_days),
        "coverage_days": {
            macro: len(overall_coverage_days[macro]) for macro in MACROS
        },
        "unaccounted_items": unaccounted,
        "amdr_reference": {"carbs": [45, 65], "fat": [20, 35], "protein": [10, 35]},
    }


async def micros(
    user_id: str, date_from: date, date_to: date, sex: str = "female"
) -> dict[str, Any]:
    """Micronutrient summary vs RDA, with a personalised top-5 watchlist.

    Eighteen is already too many to show at once, so the panel leads with the
    five furthest from target and keeps the rest behind a tab.
    """
    rows = await _rows(user_id, date_from, date_to)
    days = max((date_to - date_from).days + 1, 1)
    totals: dict[str, float] = defaultdict(float)
    coverage_days: dict[str, set[str]] = defaultdict(set)
    coverage_items: dict[str, int] = defaultdict(int)
    logged_days: set[str] = set()
    unaccounted = 0
    for row in rows:
        nutrients = row.get("nutrients") or {}
        if not nutrients:
            unaccounted += 1
            continue
        logged_days.add(row["meal_date"])
        for key, value in nutrients.items():
            if key in RDA:
                try:
                    totals[key] += float(value)
                    coverage_days[key].add(str(row["meal_date"]))
                    coverage_items[key] += 1
                except (TypeError, ValueError):
                    continue

    panel = []
    for nutrient, targets in RDA.items():
        target_per_day = targets.get(sex, targets["female"])
        has_values = bool(coverage_items[nutrient])
        covered_days = len(coverage_days[nutrient])
        actual_per_day = totals[nutrient] / covered_days if has_values else None
        pct = (
            actual_per_day / target_per_day * 100
            if actual_per_day is not None and target_per_day
            else None
        )
        is_ceiling = nutrient in CEILING_NUTRIENTS
        panel.append(
            {
                "nutrient": nutrient,
                "actual_per_day": round(actual_per_day, 2) if actual_per_day is not None else None,
                "rda_per_day": target_per_day,
                "pct_of_rda": round(pct, 1) if pct is not None else None,
                "direction": "at_most" if is_ceiling else "at_least",
                "on_track": ((pct <= 100) if is_ceiling else (pct >= 100))
                if pct is not None and covered_days == days
                else None,
                "coverage_days": covered_days,
                "items_with_value": coverage_items[nutrient],
            }
        )

    # watchlist: furthest from target first, ceilings that are exceeded included
    watchlist = sorted(
        [row for row in panel if row["pct_of_rda"] is not None],
        key=lambda p: (p["pct_of_rda"] - 100) if p["direction"] == "at_most" else -p["pct_of_rda"],
        reverse=True,
    )[:5]

    return {
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "basis": "ICMR-NIN 2020",
        "sex": sex,
        "days": days,
        "logged_days": len(logged_days),
        "unaccounted_items": unaccounted,
        "watchlist": watchlist,
        "panel": sorted(panel, key=lambda p: p["nutrient"]),
    }


async def goal_vs_actual(user_id: str, date_from: date, date_to: date) -> dict[str, Any]:
    """The explicit requirement: target band with actual plotted through it."""
    goal = await goals_service.get_active_goal(user_id)
    if not goal:
        return {"has_goal": False, "series": [], "targets": []}

    prog = await goals_service.progress(user_id, goal["goal_id"], date_from, date_to)
    rows = await _rows(user_id, date_from, date_to)

    by_day: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        nutrients = row.get("nutrients") or {}
        for macro in MACROS:
            if macro in nutrients:
                by_day[row["meal_date"]][macro] += float(nutrients[macro])

    targets = {t["metric"]: t for t in (goal.get("daily_targets") or {}).get("targets", [])}
    series = []
    for day in sorted(by_day):
        point: dict[str, Any] = {"date": day}
        for metric, target in targets.items():
            actual = by_day[day].get(metric)
            if actual is None:
                continue
            target_value = float(target["value"])
            point[metric] = {
                "actual": round(actual, 1),
                "target": target_value,
                "deviation": round(actual - target_value, 1),
                "direction": target.get("direction"),
            }
        series.append(point)

    return {
        "has_goal": True,
        "goal_kind": goal["kind"],
        "clamp_fired": bool((goal.get("derivation") or {}).get("clamp_fired")),
        "targets": list(targets.values()),
        "series": series,
        "summary": prog,
    }


async def meal_patterns(user_id: str, date_from: date, date_to: date) -> dict[str, Any]:
    """Recorded meal-slot, timing, and provenance evidence.

    Rows are food items, so frequency is reported as distinct date/slot
    occurrences rather than pretending every dish row is a separate meal.
    """
    rows = await _rows(user_id, date_from, date_to)
    total_days = max((date_to - date_from).days + 1, 1)
    logged_days = {str(row["meal_date"]) for row in rows}
    slot_days: dict[str, set[str]] = defaultdict(set)
    slot_items: dict[str, int] = defaultdict(int)
    slot_calories: dict[str, float] = defaultdict(float)
    slot_unknown: dict[str, int] = defaultdict(int)
    timed_slots: dict[tuple[str, str], list[int]] = defaultdict(list)
    capture_sources: dict[str, int] = defaultdict(int)
    portion_sources: dict[str, int] = defaultdict(int)
    coverage = dict.fromkeys(
        ["calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sodium_mg"], 0
    )

    for row in rows:
        meal_type = str(row.get("meal_type") or "misc")
        meal_date = str(row["meal_date"])
        nutrients = row.get("nutrients") or {}
        slot_days[meal_type].add(meal_date)
        slot_items[meal_type] += 1
        capture_sources[str(row.get("source") or "unknown")] += 1
        portion_sources[str(row.get("resolved_from") or "unknown")] += 1
        if nutrients and "calories_kcal" in nutrients:
            slot_calories[meal_type] += float(nutrients["calories_kcal"] or 0)
        else:
            slot_unknown[meal_type] += 1
        for nutrient in coverage:
            if nutrient in nutrients:
                coverage[nutrient] += 1
        minutes = _time_minutes(row.get("slot_time"))
        if minutes is not None:
            timed_slots[(meal_date, meal_type)].append(minutes)

    occurrence_times = [int(median(times)) for times in timed_slots.values()]
    hourly: dict[int, int] = defaultdict(int)
    for minutes in occurrence_times:
        hourly[minutes // 60] += 1
    total_known_calories = sum(slot_calories.values())
    slots = []
    for meal_type in ["breakfast", "brunch", "lunch", "snacks", "dinner", "misc"]:
        occurrences = len(slot_days[meal_type])
        times = [int(median(values)) for (day, slot), values in timed_slots.items() if slot == meal_type]
        slots.append(
            {
                "meal_type": meal_type,
                "days_present": occurrences,
                "item_count": slot_items[meal_type],
                "timed_occurrences": len(times),
                "median_slot_time": _format_minutes(int(median(times))) if times else None,
                "calories_kcal": round(slot_calories[meal_type], 1),
                "energy_share_pct": round(slot_calories[meal_type] / total_known_calories * 100, 1)
                if total_known_calories
                else 0.0,
                "unknown_energy_items": slot_unknown[meal_type],
            }
        )

    item_count = len(rows)
    return {
        "days": total_days,
        "logged_days": len(logged_days),
        "item_count": item_count,
        "timed_occurrences": len(occurrence_times),
        "slots": slots,
        "hourly": [{"hour": hour, "occurrences": hourly.get(hour, 0)} for hour in range(24)],
        "capture_sources": _count_rows(capture_sources, item_count),
        "portion_sources": _count_rows(portion_sources, item_count),
        "nutrient_coverage": [
            {
                "nutrient": nutrient,
                "items_with_value": count,
                "total_items": item_count,
                "coverage_pct": round(count / item_count * 100, 1) if item_count else 0.0,
            }
            for nutrient, count in coverage.items()
        ],
    }


async def nutrient_series(
    user_id: str,
    date_from: date,
    date_to: date,
    nutrients: list[str],
    group_by: str = "day",
) -> dict[str, Any]:
    """Nutrient totals and daily equivalents with item/day coverage."""
    rows = await _rows(user_id, date_from, date_to)
    periods = _periods(date_from, date_to, group_by)
    lookup = _period_lookup(periods)
    totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    coverage_items: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    coverage_days: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    logged_days: set[str] = set()
    unaccounted = 0

    for row in rows:
        values = row.get("nutrients") or {}
        if not values:
            unaccounted += 1
            continue
        meal_date = str(row["meal_date"])
        logged_days.add(meal_date)
        bucket = lookup[meal_date]
        for nutrient in nutrients:
            if nutrient not in values:
                continue
            try:
                value = float(values[nutrient])
            except (TypeError, ValueError):
                continue
            totals[bucket][nutrient] += value
            coverage_items[bucket][nutrient] += 1
            coverage_days[bucket][nutrient].add(meal_date)

    series = []
    for period in periods:
        bucket = str(period["bucket"])
        bucket_totals = {key: round(value, 2) for key, value in totals[bucket].items()}
        series.append(
            {
                **period,
                "totals": bucket_totals,
                "daily_averages": {
                    key: round(value / len(coverage_days[bucket][key]), 2)
                    for key, value in totals[bucket].items()
                    if coverage_days[bucket][key]
                },
                "coverage_items": dict(coverage_items[bucket]),
                "coverage_days": {key: len(value) for key, value in coverage_days[bucket].items()},
            }
        )
    return {
        **_range_meta(date_from, date_to, group_by),
        "nutrients": nutrients,
        "logged_days": len(logged_days),
        "unaccounted_items": unaccounted,
        "series": series,
    }


async def hydration(
    user_id: str, date_from: date, date_to: date, group_by: str = "day"
) -> dict[str, Any]:
    """Aggregate every water log in the requested range server-side."""
    rows = await _water_rows(user_id, date_from, date_to)
    periods = _periods(date_from, date_to, group_by)
    lookup = _period_lookup(periods)
    totals: dict[str, float] = defaultdict(float)
    counts: dict[str, int] = defaultdict(int)
    days: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        logged_on = str(row["logged_on"])
        bucket = lookup[logged_on]
        totals[bucket] += float(row.get("volume_ml") or 0)
        counts[bucket] += 1
        days[bucket].add(logged_on)
    return {
        **_range_meta(date_from, date_to, group_by),
        "logged_days": len({str(row["logged_on"]) for row in rows}),
        "series": [
            {
                **period,
                "volume_ml": round(totals[str(period["bucket"])], 1)
                if counts[str(period["bucket"])]
                else None,
                "log_count": counts[str(period["bucket"])],
                "logged_days": len(days[str(period["bucket"])]),
                "daily_average_ml": round(
                    totals[str(period["bucket"])] / len(days[str(period["bucket"])]), 1
                )
                if days[str(period["bucket"])]
                else None,
            }
            for period in periods
        ],
    }


def _time_minutes(value: Any) -> int | None:
    if value is None:
        return None
    parts = str(value).split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    return hour * 60 + minute if 0 <= hour <= 23 and 0 <= minute <= 59 else None


def _format_minutes(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _count_rows(values: dict[str, int], total: int) -> list[dict[str, Any]]:
    return [
        {
            "source": source,
            "item_count": count,
            "share_pct": round(count / total * 100, 1) if total else 0.0,
        }
        for source, count in sorted(values.items(), key=lambda item: (-item[1], item[0]))
    ]
