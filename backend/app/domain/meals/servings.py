"""Canonical meal-serving normalization shared by APIs, agents, and services."""

from __future__ import annotations

import math
from typing import Annotated, Any

from pydantic import BeforeValidator


def normalize_meal_servings(value: Any) -> float:
    """Round a positive serving count half-up to the nearest 0.5."""
    if isinstance(value, bool):
        raise ValueError("Meal servings must be a positive finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Meal servings must be a positive finite number") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError("Meal servings must be a positive finite number")
    return max(0.5, math.floor(number * 2 + 0.5) / 2)


MealServings = Annotated[float, BeforeValidator(normalize_meal_servings)]
