from datetime import date

import pytest

from app.core.exceptions import ValidationError
from app.domain.goals.service import _normalise_cadence


@pytest.mark.unit
@pytest.mark.parametrize(
    ("kind", "requested", "expected", "spec"),
    [
        ("nutrient", "monthly", "daily", {"nutrients": {"protein_g": 60}}),
        ("hydration", "period", "daily", {"target_ml": 2000}),
        ("body_weight", "daily", "period", {"direction": "lose", "amount_kg": 5}),
    ],
)
def test_goal_kinds_use_their_supported_cadence(
    kind: str, requested: str, expected: str, spec: dict
) -> None:
    assert (
        _normalise_cadence(
            kind,
            requested,
            spec,
            date(2026, 1, 1),
            date(2026, 2, 1),
        )
        == expected
    )


@pytest.mark.unit
def test_training_target_cannot_exceed_period_days() -> None:
    with pytest.raises(ValidationError, match="cannot exceed 3 days"):
        _normalise_cadence(
            "behaviour",
            "period",
            {"target": 4},
            date(2026, 1, 1),
            date(2026, 1, 3),
        )


@pytest.mark.unit
def test_goal_date_range_must_be_ordered() -> None:
    with pytest.raises(ValidationError, match="ends_on"):
        _normalise_cadence(
            "hydration",
            "daily",
            {"target_ml": 2000},
            date(2026, 1, 2),
            date(2026, 1, 1),
        )


@pytest.mark.unit
def test_goal_period_is_bounded() -> None:
    with pytest.raises(ValidationError, match="cannot exceed 1830 days"):
        _normalise_cadence(
            "hydration",
            "daily",
            {"target_ml": 2000},
            date(2026, 1, 1),
            date(2032, 1, 1),
        )


@pytest.mark.unit
def test_nutrient_goal_requires_one_positive_target() -> None:
    with pytest.raises(ValidationError, match="exactly one target"):
        _normalise_cadence(
            "nutrient",
            "daily",
            {"nutrients": {"protein_g": 60, "carbs_g": 200}},
            date(2026, 1, 1),
            date(2026, 2, 1),
        )
