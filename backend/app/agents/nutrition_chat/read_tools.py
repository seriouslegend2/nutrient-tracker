"""Bounded, user-scoped read tools for nutrition chat.

The tools in this module only shape results from deterministic domain services.
They never accept identity from model input and never load the full dish catalog.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.domain.dishes import repository as dish_repo
from app.domain.goals import service as goals_service
from app.domain.meals import repository as meals_repo
from app.domain.meals import service as meals_service
from app.domain.profile import repository as profile_repo
from app.domain.reports import service as reports_service

MAX_RANGE_DAYS = 366
MAX_TODAY_ITEMS = 40
MAX_UNKNOWN_NAMES = 20
MAX_GOALS = 20
MAX_PORTIONS = 50
MAX_BODY_METRICS = 50

SUPPORTED_NUTRIENTS = frozenset(reports_service.MACROS) | frozenset(reports_service.RDA)


class StrictToolInput(BaseModel):
    """Reject model-invented arguments and non-finite numeric values."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class DateRangeInput(StrictToolInput):
    date_from: date = Field(..., description="Inclusive first date, YYYY-MM-DD")
    date_to: date = Field(..., description="Inclusive last date, YYYY-MM-DD")

    @model_validator(mode="after")
    def validate_range(self) -> DateRangeInput:
        days = (self.date_to - self.date_from).days + 1
        if days < 1:
            raise ValueError("date_from must be on or before date_to")
        if days > MAX_RANGE_DAYS:
            raise ValueError(f"Date range cannot exceed {MAX_RANGE_DAYS} days")
        return self


class GetTodaySnapshotInput(StrictToolInput):
    pass


class GetGoalProgressInput(StrictToolInput):
    goal_id: str | None = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Optional goal ID; omit to return every active goal",
    )
    as_of: date | None = Field(..., description="Progress date; use null for today")


class GetHouseholdPortionsInput(StrictToolInput):
    customized_only: bool = Field(..., description="Return only user-customized counts")
    limit: int = Field(..., ge=1, le=MAX_PORTIONS)


class GetHydrationInput(DateRangeInput):
    group_by: Literal["day", "week", "month"]


class GetBodyMetricsInput(StrictToolInput):
    mode: Literal["latest", "history"] = Field(
        ..., description="Use latest for one measurement or history for a bounded list"
    )
    limit: int = Field(..., ge=1, le=MAX_BODY_METRICS)


class GetNutritionReportInput(DateRangeInput):
    report_type: Literal["macros", "micros", "nutrients"]
    group_by: Literal["day", "week", "month"]
    nutrients: list[str] = Field(
        ...,
        min_length=1,
        max_length=8,
        description="One to eight nutrient keys, used by the nutrients report",
    )

    @model_validator(mode="after")
    def validate_nutrients(self) -> GetNutritionReportInput:
        invalid = sorted(set(self.nutrients) - SUPPORTED_NUTRIENTS)
        if invalid:
            raise ValueError(f"Unsupported nutrients: {', '.join(invalid)}")
        if len(set(self.nutrients)) != len(self.nutrients):
            raise ValueError("Nutrients must be unique")
        return self


class QueryTrackerHistoryInput(StrictToolInput):
    resource: Literal["meals", "nutrition", "hydration", "body_metrics"]
    date_from: date | None = Field(...)
    date_to: date | None = Field(...)
    group_by: Literal["day", "week", "month"] | None = Field(...)
    report_type: Literal["macros", "micros", "nutrients"] | None = Field(...)
    nutrients: list[str] | None = Field(..., max_length=8)
    meal_types: list[str] | None = Field(..., max_length=6)
    limit: int = Field(..., ge=1, le=50)

    @model_validator(mode="after")
    def validate_query(self) -> QueryTrackerHistoryInput:
        if self.resource == "body_metrics":
            if any(
                value is not None
                for value in (
                    self.date_from,
                    self.date_to,
                    self.group_by,
                    self.report_type,
                    self.nutrients,
                    self.meal_types,
                )
            ):
                raise ValueError("Body history accepts only resource and limit")
            return self
        if self.date_from is None or self.date_to is None:
            raise ValueError(f"{self.resource} history requires date_from and date_to")
        DateRangeInput(date_from=self.date_from, date_to=self.date_to)
        if self.resource == "meals":
            if any(
                value is not None for value in (self.group_by, self.report_type, self.nutrients)
            ):
                raise ValueError("Meal history accepts only dates, meal_types, and limit")
        elif self.resource == "hydration":
            if self.group_by is None or any(
                value is not None for value in (self.report_type, self.nutrients, self.meal_types)
            ):
                raise ValueError("Hydration history requires group_by only")
        else:
            if self.group_by is None or self.report_type is None or self.meal_types is not None:
                raise ValueError("Nutrition history requires group_by and report_type")
            if self.report_type == "nutrients" and not self.nutrients:
                raise ValueError("Selected-nutrient history requires nutrients")
            if self.nutrients:
                invalid = sorted(set(self.nutrients) - SUPPORTED_NUTRIENTS)
                if invalid:
                    raise ValueError(f"Unsupported nutrients: {', '.join(invalid)}")
        return self


def _user_id(config: RunnableConfig) -> str | None:
    value = (config or {}).get("configurable", {}).get("user_id")
    return str(value) if value else None


def _today(config: RunnableConfig) -> date:
    timezone = str((config or {}).get("configurable", {}).get("timezone") or "UTC")
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    return datetime.now(UTC).astimezone(zone).date()


def _auth_error() -> dict[str, Any]:
    return {"status": "ERROR", "message": "No authenticated user in context"}


def _range_metadata(date_from: date, date_to: date) -> dict[str, Any]:
    return {
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "calendar_days": (date_to - date_from).days + 1,
    }


def _compact_nutrients(values: Any) -> dict[str, float]:
    if not isinstance(values, dict):
        return {}
    compact: dict[str, float] = {}
    for key in sorted(SUPPORTED_NUTRIENTS):
        if key not in values:
            continue
        try:
            compact[key] = round(float(values[key]), 2)
        except (TypeError, ValueError):
            continue
    return compact


def _compact_meal(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "meal_type": row.get("meal_type") or "misc",
        "slot_time": row.get("slot_time"),
        "dish_name": row.get("dish_name"),
        "portions": row.get("portions"),
        "portion_unit": row.get("portion_unit"),
        "grams": row.get("grams"),
        "nutrients": _compact_nutrients(row.get("nutrients")),
        "resolved_from": row.get("resolved_from"),
    }


def _measurement(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row.get("id"),
        "measured_on": row.get("measured_on"),
        "weight_kg": row.get("weight_kg"),
        "waist_cm": row.get("waist_cm"),
    }


def _coverage(logged_days: int, calendar_days: int, unaccounted_items: int = 0) -> dict[str, Any]:
    return {
        "calendar_days": calendar_days,
        "logged_days": logged_days,
        "logged_day_pct": round(logged_days / calendar_days * 100, 1),
        "unaccounted_items": unaccounted_items,
    }


def _progress_value(value: Any) -> Any:
    """Add direction-aware distance while preserving the service result."""
    if not isinstance(value, dict):
        return value
    compact = dict(value)
    actual = value.get("actual")
    target = value.get("target")
    direction = value.get("direction")
    if actual is None or not isinstance(target, (int, float)):
        return compact
    actual_number = float(actual)
    target_number = float(target)
    if direction == "around":
        lower = target_number * 0.9
        upper = target_number * 1.1
        compact["target_band"] = {"lower": round(lower, 2), "upper": round(upper, 2)}
        compact["distance_to_band"] = round(
            lower - actual_number
            if actual_number < lower
            else actual_number - upper
            if actual_number > upper
            else 0.0,
            2,
        )
    elif direction == "at_most":
        compact["remaining_allowance"] = round(max(target_number - actual_number, 0.0), 2)
    else:
        compact["remaining"] = round(max(target_number - actual_number, 0.0), 2)
    return compact


def _compact_goal(goal: dict[str, Any], as_of: date) -> dict[str, Any]:
    compact = {key: value for key, value in goal.items() if key != "calendar"}
    compact["today"] = _progress_value(goal.get("today"))
    compact["current_week"] = _progress_value(goal.get("current_week"))
    compact["period"] = _progress_value(goal.get("period"))
    compact["metrics"] = [
        {
            **metric,
            "today": _progress_value(metric.get("today")),
            "period": _progress_value(metric.get("period")),
        }
        for metric in goal.get("metrics") or []
    ]
    ends_on = date.fromisoformat(str(goal["ends_on"]))
    compact["days_remaining"] = max((ends_on - as_of).days, 0)
    return compact


@tool(args_schema=GetTodaySnapshotInput)
async def get_today_snapshot(config: RunnableConfig = None) -> dict[str, Any]:
    """Get authoritative totals and compact source facts for the current local day.

    Totals are computed by application code across every meal row. Model-visible
    meal rows and unknown-item names are capped with explicit truncation metadata.
    """
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    today = _today(config)
    rows = await meals_repo.get_day(user_id, today)
    totals = await meals_service.day_totals(rows)
    water = await reports_service.hydration(user_id, today, today)
    activities, activity_total = await goals_service.list_activity(
        user_id, today, today, limit=1, offset=0
    )
    body_rows, body_total = await profile_repo.list_body_metrics(user_id, limit=1, offset=0)

    visible_rows = rows[:MAX_TODAY_ITEMS]
    slots: dict[str, list[dict[str, Any]]] = {}
    for row in visible_rows:
        meal_type = str(row.get("meal_type") or "misc")
        slots.setdefault(meal_type, []).append(_compact_meal(row))

    unknown_names = [
        str(row.get("dish_name") or "Unnamed item")
        for row in rows
        if not (row.get("nutrients") or {})
    ]
    nutrient_coverage = {
        nutrient: sum(nutrient in (row.get("nutrients") or {}) for row in rows)
        for nutrient in sorted(SUPPORTED_NUTRIENTS)
    }
    water_total = sum(float(point.get("volume_ml") or 0) for point in water.get("series") or [])

    return {
        "status": "OK",
        "date": today.isoformat(),
        "meals_by_slot": slots,
        "totals": _compact_nutrients(totals.get("totals")),
        "water_ml": round(water_total, 1),
        "training_checked_in": bool(activities),
        "latest_body_metric": _measurement(body_rows[0] if body_rows else None),
        "coverage": {
            "meal_items": len(rows),
            "items_with_nutrition": len(rows) - int(totals["unaccounted_items"]),
            "unaccounted_items": int(totals["unaccounted_items"]),
            "unknown_item_names": unknown_names[:MAX_UNKNOWN_NAMES],
            "nutrient_items": nutrient_coverage,
            "water_logged": bool(water.get("logged_days")),
            "training_records": activity_total,
            "body_metric_records": body_total,
        },
        "truncation": {
            "truncated": len(rows) > MAX_TODAY_ITEMS or len(unknown_names) > MAX_UNKNOWN_NAMES,
            "meal_items_returned": len(visible_rows),
            "meal_items_available": len(rows),
            "unknown_names_returned": min(len(unknown_names), MAX_UNKNOWN_NAMES),
            "unknown_names_available": len(unknown_names),
        },
    }


@tool(args_schema=GetGoalProgressInput)
async def get_goal_progress(
    goal_id: str | None = None,
    as_of: date | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Get compact deterministic progress for all active goals or one goal.

    Complete date calendars are deliberately omitted. The result retains Today,
    current-week, period, streak, and resolved metric progress only.
    """
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    effective_date = as_of or _today(config)
    summary = await goals_service.progress_summary(user_id, effective_date)
    available = summary.get("goals") or []
    selected = [goal for goal in available if not goal_id or str(goal.get("goal_id")) == goal_id]
    if goal_id and not selected:
        return {"status": "ERROR", "message": "Active goal not found", "goal_id": goal_id}

    visible = selected[:MAX_GOALS]
    return {
        "status": "OK",
        "as_of": effective_date.isoformat(),
        "goals": [_compact_goal(goal, effective_date) for goal in visible],
        "coverage": {
            "active_goals_available": len(available),
            "matching_goals": len(selected),
            "goals_returned": len(visible),
            "calendars_included": False,
        },
        "truncation": {
            "truncated": len(selected) > len(visible),
            "limit": MAX_GOALS,
            "omitted_goal_calendars": True,
        },
    }


@tool(args_schema=GetHouseholdPortionsInput)
async def get_household_portions(
    customized_only: bool = False,
    limit: int = MAX_PORTIONS,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Get fixed category units and the user's usual counts, never dish nutrition."""
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    rows = await dish_repo.list_category_portions(user_id)
    filtered = [row for row in rows if not customized_only or row.get("is_custom")]
    visible = filtered[:limit]
    portions = [
        {
            "category": row.get("category"),
            "portion_unit": row.get("portion_unit"),
            "fixed_unit_grams": row.get("portion_grams"),
            "usual_count": row.get("portion_count"),
            "effective_usual_grams": row.get("effective_portion_grams"),
            "is_custom": bool(row.get("is_custom")),
            "source": row.get("source"),
        }
        for row in visible
    ]
    return {
        "status": "OK",
        "portions": portions,
        "coverage": {
            "categories_available": len(rows),
            "categories_matching": len(filtered),
            "categories_returned": len(portions),
        },
        "truncation": {"truncated": len(filtered) > len(visible), "limit": limit},
    }


@tool(args_schema=GetHydrationInput)
async def get_hydration(
    date_from: date,
    date_to: date,
    group_by: Literal["day", "week", "month"] = "day",
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Get deterministic water totals for an inclusive range of at most 366 days."""
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    report = await reports_service.hydration(user_id, date_from, date_to, group_by)
    calendar_days = (date_to - date_from).days + 1
    return {
        "status": "OK",
        "range": _range_metadata(date_from, date_to),
        "hydration": report,
        "coverage": _coverage(int(report.get("logged_days") or 0), calendar_days),
        "truncation": {"truncated": False, "range_limit_days": MAX_RANGE_DAYS},
    }


@tool(args_schema=GetBodyMetricsInput)
async def get_body_metrics(
    mode: Literal["latest", "history"] = "latest",
    limit: int = 10,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Get the latest body measurement or a bounded recent weight/waist history."""
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    effective_limit = 1 if mode == "latest" else limit
    rows, total = await profile_repo.list_body_metrics(user_id, limit=effective_limit, offset=0)
    metrics = [_measurement(row) for row in rows]
    return {
        "status": "OK",
        "mode": mode,
        "metrics": metrics,
        "coverage": {
            "records_available": total,
            "records_returned": len(metrics),
            "weight_values": sum(row.get("weight_kg") is not None for row in rows),
            "waist_values": sum(row.get("waist_cm") is not None for row in rows),
        },
        "truncation": {
            "truncated": total > len(metrics),
            "limit": effective_limit,
            "order": "measured_on_desc",
        },
    }


@tool(args_schema=GetNutritionReportInput)
async def get_nutrition_report(
    date_from: date,
    date_to: date,
    report_type: Literal["macros", "micros", "nutrients"] = "macros",
    group_by: Literal["day", "week", "month"] = "day",
    nutrients: list[str] | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Get a deterministic macro, micronutrient, or selected-nutrient report.

    The range is capped at 366 days and selected nutrients are capped at eight.
    Missing nutrition remains explicit rather than being treated as zero.
    """
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()

    selected_nutrients = nutrients or ["fiber_g", "sodium_mg"]
    if report_type == "macros":
        report = await reports_service.macros(user_id, date_from, date_to, group_by)
    elif report_type == "micros":
        profile = await profile_repo.get_profile(user_id)
        sex = str((profile or {}).get("sex") or "")
        if sex not in {"male", "female"}:
            return {
                "status": "ERROR",
                "message": "Micronutrient reference percentages require profile sex.",
                "suggested_action": "Complete the profile before requesting this comparison.",
            }
        report = await reports_service.micros(user_id, date_from, date_to, sex=sex)
    else:
        report = await reports_service.nutrient_series(
            user_id, date_from, date_to, selected_nutrients, group_by
        )

    calendar_days = (date_to - date_from).days + 1
    logged_days = int(report.get("logged_days") or 0)
    unaccounted = int(report.get("unaccounted_items") or 0)
    return {
        "status": "OK",
        "report_type": report_type,
        "range": _range_metadata(date_from, date_to),
        "report": report,
        "coverage": _coverage(logged_days, calendar_days, unaccounted),
        "truncation": {
            "truncated": False,
            "range_limit_days": MAX_RANGE_DAYS,
            "nutrient_limit": 8,
        },
    }


@tool("query_tracker_history", args_schema=QueryTrackerHistoryInput)
async def query_tracker_history(
    resource: str,
    date_from: date | None = None,
    date_to: date | None = None,
    group_by: str | None = None,
    report_type: str | None = None,
    nutrients: list[str] | None = None,
    meal_types: list[str] | None = None,
    limit: int = 20,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Query bounded historical meals, nutrition, hydration, or body metrics."""
    model = QueryTrackerHistoryInput(
        resource=resource,
        date_from=date_from,
        date_to=date_to,
        group_by=group_by,
        report_type=report_type,
        nutrients=nutrients,
        meal_types=meal_types,
        limit=limit,
    )
    user_id = _user_id(config)
    if not user_id:
        return _auth_error()
    if model.resource == "body_metrics":
        return await get_body_metrics.ainvoke(
            {"mode": "history", "limit": model.limit}, config=config
        )
    if model.resource == "meals":
        rows, total = await meals_repo.list_meals(
            user_id=user_id,
            date_from=model.date_from,
            date_to=model.date_to,
            meal_types=model.meal_types,
            limit=model.limit,
        )
        return {
            "status": "OK",
            "resource": "meals",
            "items": [{"meal_date": row.get("meal_date"), **_compact_meal(row)} for row in rows],
            "coverage": {"available": total, "returned": len(rows)},
            "truncation": {"truncated": total > len(rows), "limit": model.limit},
        }
    if model.resource == "hydration":
        return await get_hydration.ainvoke(
            {
                "date_from": model.date_from,
                "date_to": model.date_to,
                "group_by": model.group_by,
            },
            config=config,
        )
    return await get_nutrition_report.ainvoke(
        {
            "date_from": model.date_from,
            "date_to": model.date_to,
            "report_type": model.report_type,
            "group_by": model.group_by,
            "nutrients": model.nutrients or [],
        },
        config=config,
    )


read_tools = [query_tracker_history]

tools = read_tools

__all__ = [
    "GetBodyMetricsInput",
    "GetGoalProgressInput",
    "GetHouseholdPortionsInput",
    "GetHydrationInput",
    "GetNutritionReportInput",
    "GetTodaySnapshotInput",
    "QueryTrackerHistoryInput",
    "get_body_metrics",
    "get_goal_progress",
    "get_household_portions",
    "get_hydration",
    "get_nutrition_report",
    "get_today_snapshot",
    "query_tracker_history",
    "read_tools",
    "tools",
]
