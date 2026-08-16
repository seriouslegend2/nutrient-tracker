from datetime import date

import pytest

from app.domain.goals.progress import evaluate_goal_progress, evaluate_metric_progress


def goal(
    *,
    kind: str,
    cadence: str,
    starts_on: str,
    ends_on: str,
    value: float,
    metric: str,
    unit: str,
    direction: str = "at_least",
) -> dict:
    spec = {"metric": metric, "target": value}
    derivation = {}
    if kind == "body_weight":
        spec = {"direction": "lose", "target_weight_kg": value}
        derivation = {"target_weight_kg": value}
    return {
        "goal_id": "11111111-1111-1111-1111-111111111111",
        "kind": kind,
        "is_primary": False,
        "cadence": cadence,
        "starts_on": starts_on,
        "ends_on": ends_on,
        "spec": spec,
        "daily_targets": {
            "targets": [
                {
                    "metric": metric,
                    "value": value,
                    "unit": unit,
                    "direction": direction,
                }
            ]
        },
        "derivation": derivation,
    }


@pytest.mark.unit
def test_daily_protein_includes_each_day_and_marks_today_in_progress() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="nutrient",
            cadence="daily",
            starts_on="2026-01-01",
            ends_on="2026-01-03",
            value=60,
            metric="protein_g",
            unit="g",
        ),
        {date(2026, 1, 1): 65, date(2026, 1, 2): 50},
        date(2026, 1, 2),
    )

    assert [day["status"] for day in result["calendar"]] == ["met", "in_progress", "future"]
    assert result["metric"] == "protein_g"
    assert result["is_primary"] is False
    assert result["today"]["actual"] == 50
    assert result["period"]["target"] == 180
    assert result["period"]["target_to_date"] == 120
    assert result["current_week"]["target"] == 180
    assert result["current_week"]["target_to_date"] == 120
    assert result["period"]["status"] == "in_progress"


@pytest.mark.unit
def test_weekly_training_streak_ignores_an_unclosed_current_week() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="behaviour",
            cadence="weekly",
            starts_on="2026-01-05",
            ends_on="2026-01-18",
            value=2,
            metric="training_days",
            unit="days",
        ),
        {
            date(2026, 1, 6): 1,
            date(2026, 1, 8): 1,
            date(2026, 1, 13): 1,
        },
        date(2026, 1, 14),
    )

    assert result["period"]["completed_buckets"] == 1
    assert result["current_week"]["actual"] == 1
    assert result["current_week"]["target"] == 2
    assert result["period"]["target_to_date"] == pytest.approx(20 / 7)
    assert result["streak"] == {"current": 1, "longest": 1, "unit": "weeks"}
    assert result["period"]["status"] == "in_progress"


@pytest.mark.unit
def test_training_target_is_prorated_for_a_partial_calendar_week() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="behaviour",
            cadence="weekly",
            starts_on="2026-01-11",
            ends_on="2026-01-18",
            value=3,
            metric="training_days",
            unit="days",
        ),
        {date(2026, 1, 11): 1},
        date(2026, 1, 12),
    )

    assert result["period"]["target"] == 4
    assert result["period"]["completed_buckets"] == 1
    assert result["current_week"]["starts_on"] == "2026-01-12"
    assert result["current_week"]["ends_on"] == "2026-01-18"
    assert result["current_week"]["target"] == 3
    assert result["current_week"]["target_to_date"] == pytest.approx(3 / 7)


@pytest.mark.unit
def test_hydration_missing_day_is_no_data_and_cannot_bank_water() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="hydration",
            cadence="daily",
            starts_on="2026-02-01",
            ends_on="2026-02-02",
            value=2000,
            metric="water_ml",
            unit="ml",
        ),
        {date(2026, 2, 1): 4000},
        date(2026, 2, 3),
    )

    assert [day["status"] for day in result["calendar"]] == ["met", "no_data"]
    assert result["period"]["completed_buckets"] == 1
    assert result["period"]["status"] == "no_data"


@pytest.mark.unit
def test_missing_at_most_observation_is_not_success() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="nutrient",
            cadence="daily",
            starts_on="2026-02-01",
            ends_on="2026-02-01",
            value=2000,
            metric="calories_kcal",
            unit="kcal",
            direction="at_most",
        ),
        {},
        date(2026, 2, 2),
    )

    assert result["calendar"][0]["status"] == "no_data"
    assert result["period"]["status"] == "no_data"


@pytest.mark.unit
def test_open_at_most_day_is_not_complete_before_day_closes() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="nutrient",
            cadence="daily",
            starts_on="2026-02-01",
            ends_on="2026-02-01",
            value=2000,
            metric="calories_kcal",
            unit="kcal",
            direction="at_most",
        ),
        {date(2026, 2, 1): 1200},
        date(2026, 2, 1),
    )

    assert result["today"]["status"] == "in_progress"
    assert result["calendar"][0]["status"] == "in_progress"


@pytest.mark.unit
def test_around_target_uses_ten_percent_band_after_day_closes() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="nutrient",
            cadence="daily",
            starts_on="2026-02-01",
            ends_on="2026-02-04",
            value=200,
            metric="carbs_g",
            unit="g",
            direction="around",
        ),
        {
            date(2026, 2, 1): 185,
            date(2026, 2, 2): 170,
            date(2026, 2, 3): 225,
            date(2026, 2, 4): 200,
        },
        date(2026, 2, 4),
    )

    assert [day["status"] for day in result["calendar"]] == [
        "met",
        "below",
        "above",
        "in_progress",
    ]


@pytest.mark.unit
def test_period_cadence_clips_actuals_and_calendar_to_goal_dates() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="nutrient",
            cadence="period",
            starts_on="2026-03-10",
            ends_on="2026-03-12",
            value=50,
            metric="protein_g",
            unit="g",
        ),
        {
            date(2026, 3, 9): 500,
            date(2026, 3, 10): 50,
            date(2026, 3, 11): 50,
            date(2026, 3, 12): 50,
            date(2026, 3, 13): 500,
        },
        date(2026, 3, 13),
    )

    assert [day["date"] for day in result["calendar"]] == [
        "2026-03-10",
        "2026-03-11",
        "2026-03-12",
    ]
    assert result["period"]["actual"] == 150
    assert result["period"]["target"] == 150
    assert result["period"]["status"] == "met"


@pytest.mark.unit
def test_weight_goal_reports_today_trajectory_and_overall_change() -> None:
    result = evaluate_goal_progress(
        goal(
            kind="body_weight",
            cadence="period",
            starts_on="2026-01-01",
            ends_on="2026-02-18",
            value=75,
            metric="weight_kg",
            unit="kg",
            direction="at_most",
        ),
        {
            date(2026, 1, 1): 80,
            date(2026, 1, 14): 79,
            date(2026, 1, 15): 78,
        },
        date(2026, 1, 15),
    )

    assert result["today"]["actual"] == 78
    assert result["today"]["target"] == pytest.approx(78.54, abs=0.01)
    assert result["period"]["baseline"] == 80
    assert result["period"]["target"] == 75
    assert result["period"]["target_to_date"] == pytest.approx(78.54, abs=0.01)
    assert result["period"]["overall_progress_pct"] == 40
    assert result["period"]["days_elapsed"] == 15
    assert result["period"]["total_days"] == 49


@pytest.mark.unit
def test_body_weight_calorie_target_has_daily_and_full_period_bars() -> None:
    body_goal = goal(
        kind="body_weight",
        cadence="period",
        starts_on="2026-01-01",
        ends_on="2026-01-03",
        value=75,
        metric="weight_kg",
        unit="kg",
        direction="at_most",
    )
    result = evaluate_metric_progress(
        body_goal,
        {
            "metric": "calories_kcal",
            "value": 2000,
            "unit": "kcal",
            "direction": "at_most",
            "scope": "total",
        },
        {date(2026, 1, 1): 1800, date(2026, 1, 2): 1900},
        date(2026, 1, 2),
    )

    assert result["label"] == "Calories"
    assert result["today"]["actual"] == 1900
    assert result["today"]["target"] == 2000
    assert result["period"]["actual"] == 3700
    assert result["period"]["target_to_date"] == 4000
    assert result["period"]["target"] == 6000
    assert result["period"]["progress_pct"] == pytest.approx(61.7, abs=0.1)
    assert result["calendar"] == [
        {
            "date": "2026-01-01",
            "status": "met",
            "actual": 1800,
            "target": 2000.0,
        },
        {
            "date": "2026-01-02",
            "status": "in_progress",
            "actual": 1900,
            "target": 2000.0,
        },
        {
            "date": "2026-01-03",
            "status": "future",
            "actual": None,
            "target": 2000.0,
        },
    ]


@pytest.mark.unit
def test_weekly_training_metric_distributes_target_across_period() -> None:
    training_goal = goal(
        kind="behaviour",
        cadence="weekly",
        starts_on="2026-01-05",
        ends_on="2026-01-11",
        value=3,
        metric="training_days",
        unit="days",
    )
    result = evaluate_metric_progress(
        training_goal,
        {
            "metric": "training_days",
            "value": 3,
            "unit": "days",
            "direction": "at_least",
            "scope": "activity",
        },
        {date(2026, 1, 6): 1},
        date(2026, 1, 7),
    )

    assert result["today"]["target"] == 1
    assert result["period"]["actual"] == 1
    assert result["period"]["target"] == 3
