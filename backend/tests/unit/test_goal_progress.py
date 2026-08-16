from datetime import date

import pytest

from app.domain.goals.progress import evaluate_goal_progress


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
    return {
        "goal_id": "11111111-1111-1111-1111-111111111111",
        "kind": kind,
        "is_primary": False,
        "cadence": cadence,
        "starts_on": starts_on,
        "ends_on": ends_on,
        "spec": {"metric": metric, "target": value},
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
        "derivation": {},
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
