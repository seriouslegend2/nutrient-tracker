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
