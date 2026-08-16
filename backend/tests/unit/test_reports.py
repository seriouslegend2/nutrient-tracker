from datetime import date

from app.domain.reports import service


async def test_macro_report_discloses_logged_days_and_unknown_items(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {
                "meal_date": "2026-08-10",
                "nutrients": {"protein_g": 20, "carbs_g": 40, "fat_g": 10},
            },
            {"meal_date": "2026-08-10", "nutrients": {}},
            {
                "meal_date": "2026-08-12",
                "nutrients": {"protein_g": 30, "carbs_g": 50, "fat_g": 12},
            },
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.macros("user", date(2026, 8, 10), date(2026, 8, 16))

    assert report["logged_days"] == 2
    assert report["unaccounted_items"] == 1
    assert [point["bucket"] for point in report["series"]] == [
        "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
        "2026-08-14", "2026-08-15", "2026-08-16",
    ]
    assert report["coverage_days"]["protein_g"] == 2
    assert report["series"][1]["protein_g"] is None


async def test_trend_does_not_turn_missing_calories_into_zero(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {"meal_date": "2026-08-10", "nutrients": {"protein_g": 20}},
            {"meal_date": "2026-08-11", "nutrients": {"calories_kcal": 450}},
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.trend("user", date(2026, 8, 10), date(2026, 8, 16))

    assert report["unaccounted_items"] == 1
    assert len(report["series"]) == 7
    assert report["series"][0]["calories_kcal"] is None
    assert report["series"][0]["coverage_status"] == "missing"
    assert report["series"][1]["calories_kcal"] == 450.0
    assert report["series"][1]["daily_average_kcal"] == 450.0
    assert report["series"][1]["rolling_mean"] is None
    assert report["series"][2]["calories_kcal"] is None


async def test_weekly_trend_averages_only_days_with_calorie_data(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {"meal_date": "2026-07-21", "nutrients": {"calories_kcal": 100}},
            {"meal_date": "2026-07-27", "nutrients": {"calories_kcal": 300}},
            {"meal_date": "2026-07-28", "nutrients": {"calories_kcal": 500}},
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.trend(
        "user", date(2026, 7, 21), date(2026, 8, 17), group_by="week"
    )

    assert len(report["series"]) == 4
    assert report["series"][0]["calories_kcal"] == 400.0
    assert report["series"][0]["daily_average_kcal"] == 200.0
    assert report["series"][0]["recorded_days"] == 2
    assert report["series"][2]["daily_average_kcal"] is None


async def test_macro_report_preserves_individually_missing_values(monkeypatch) -> None:
    async def rows(*_args):
        return [{"meal_date": "2026-08-10", "nutrients": {"protein_g": 20}}]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.macros("user", date(2026, 8, 10), date(2026, 8, 16))
    point = report["series"][0]

    assert point["protein_g"] == 20.0
    assert point["carbs_g"] is None
    assert point["fat_g"] is None
    assert point["pct_of_energy"] == {"protein": None, "carbs": None, "fat": None}


async def test_micro_report_uses_nutrient_coverage_denominator(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {"meal_date": "2026-08-10", "nutrients": {"iron_mg": 19}},
            {"meal_date": "2026-08-10", "nutrients": {}},
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.micros("user", date(2026, 8, 10), date(2026, 8, 16), sex="male")
    iron = next(row for row in report["panel"] if row["nutrient"] == "iron_mg")

    assert report["days"] == 7
    assert report["logged_days"] == 1
    assert report["unaccounted_items"] == 1
    assert iron["actual_per_day"] == 19.0
    assert iron["coverage_days"] == 1
    assert iron["on_track"] is None
    missing = next(row for row in report["panel"] if row["nutrient"] == "vitamin_b1_mg")
    assert missing["actual_per_day"] is None
    assert missing["pct_of_rda"] is None
    assert missing["on_track"] is None


async def test_meal_patterns_count_slots_not_dish_rows_as_occurrences(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {
                "meal_date": "2026-08-10", "meal_type": "lunch", "slot_time": "13:15:00",
                "nutrients": {"calories_kcal": 300, "fiber_g": 5}, "source": "manual",
                "resolved_from": "dish_global",
            },
            {
                "meal_date": "2026-08-10", "meal_type": "lunch", "slot_time": "13:15:00",
                "nutrients": {"calories_kcal": 200}, "source": "manual",
                "resolved_from": "category_household",
            },
            {
                "meal_date": "2026-08-11", "meal_type": "dinner", "slot_time": None,
                "nutrients": {}, "source": "agent", "resolved_from": "unknown",
            },
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.meal_patterns("user", date(2026, 8, 10), date(2026, 8, 16))
    lunch = next(row for row in report["slots"] if row["meal_type"] == "lunch")
    dinner = next(row for row in report["slots"] if row["meal_type"] == "dinner")

    assert report["logged_days"] == 2
    assert report["timed_occurrences"] == 1
    assert lunch["days_present"] == 1
    assert lunch["item_count"] == 2
    assert lunch["median_slot_time"] == "13:15"
    assert dinner["unknown_energy_items"] == 1
    assert next(row for row in report["nutrient_coverage"] if row["nutrient"] == "fiber_g")["items_with_value"] == 1


async def test_nutrient_series_preserves_missing_keys_and_explicit_zero(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {"meal_date": "2026-08-10", "nutrients": {"fiber_g": 5, "sodium_mg": 0}},
            {"meal_date": "2026-08-10", "nutrients": {"fiber_g": 3}},
            {"meal_date": "2026-08-11", "nutrients": {"sodium_mg": 700}},
            {"meal_date": "2026-08-11", "nutrients": {}},
        ]

    monkeypatch.setattr(service, "_rows", rows)
    report = await service.nutrient_series(
        "user", date(2026, 8, 10), date(2026, 8, 16), ["fiber_g", "sodium_mg"]
    )

    first, second = report["series"][:2]
    assert first["totals"] == {"fiber_g": 8.0, "sodium_mg": 0.0}
    assert first["coverage_items"] == {"fiber_g": 2, "sodium_mg": 1}
    assert "fiber_g" not in second["totals"]
    assert report["unaccounted_items"] == 1


async def test_hydration_aggregates_all_logs_and_recorded_days(monkeypatch) -> None:
    async def rows(*_args):
        return [
            {"logged_on": "2026-08-10", "volume_ml": 250},
            {"logged_on": "2026-08-10", "volume_ml": 500},
            {"logged_on": "2026-08-12", "volume_ml": 1000},
        ]

    monkeypatch.setattr(service, "_water_rows", rows)
    report = await service.hydration(
        "user", date(2026, 8, 10), date(2026, 8, 16), group_by="week"
    )

    assert report["logged_days"] == 2
    assert report["series"] == [{
        "bucket": "2026-08-10", "period_start": "2026-08-10",
        "period_end": "2026-08-16", "calendar_days": 7, "is_partial": False,
        "volume_ml": 1750.0, "log_count": 3, "logged_days": 2,
        "daily_average_ml": 875.0,
    }]


def test_rolling_four_week_periods_are_anchored_to_requested_start() -> None:
    periods = service._periods(date(2026, 7, 21), date(2026, 8, 17), "week")

    assert [(period["period_start"], period["period_end"]) for period in periods] == [
        ("2026-07-21", "2026-07-27"),
        ("2026-07-28", "2026-08-03"),
        ("2026-08-04", "2026-08-10"),
        ("2026-08-11", "2026-08-17"),
    ]
    assert all(period["calendar_days"] == 7 for period in periods)
    assert not any(period["is_partial"] for period in periods)


def test_partial_rolling_week_keeps_every_day_exactly_once() -> None:
    periods = service._periods(date(2026, 8, 1), date(2026, 8, 10), "week")
    lookup = service._period_lookup(periods)

    assert len(lookup) == 10
    assert periods[-1] == {
        "bucket": "2026-08-08", "period_start": "2026-08-08",
        "period_end": "2026-08-10", "calendar_days": 3, "is_partial": True,
    }


def test_rolling_year_has_twelve_anchored_months_and_365_unique_days() -> None:
    periods = service._periods(date(2025, 8, 18), date(2026, 8, 17), "month")
    lookup = service._period_lookup(periods)

    assert len(periods) == 12
    assert len(lookup) == 365
    assert periods[0]["period_start"] == "2025-08-18"
    assert periods[0]["period_end"] == "2025-09-17"
    assert periods[-1]["period_start"] == "2026-07-18"
    assert periods[-1]["period_end"] == "2026-08-17"
    assert not any(period["is_partial"] for period in periods)
