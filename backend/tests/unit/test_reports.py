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
    assert [point["bucket"] for point in report["series"]] == ["2026-08-10", "2026-08-12"]


async def test_micro_report_keeps_calendar_denominator_and_reports_coverage(monkeypatch) -> None:
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
    assert iron["actual_per_day"] == round(19 / 7, 2)


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

    first, second = report["series"]
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
        "bucket": "2026-08-10", "volume_ml": 1750.0, "log_count": 3,
        "logged_days": 2, "daily_average_ml": 875.0,
    }]
