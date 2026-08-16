"""Strict contracts for manual dish matching and catalog creation."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.domain.dishes.models import NutrientsPerUnit
from app.domain.meals.servings import MealServings


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class GlobalDishContext(StrictModel):
    food_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    name_normalized: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    category: str
    nutrients_per_unit: dict[str, float] = Field(default_factory=dict)
    source: str


class GlobalCategoryContext(StrictModel):
    category: str
    portion_unit: str
    portion_grams: float = Field(gt=0)
    portion_count: float = Field(gt=0)


class HouseholdPortionContext(StrictModel):
    category: str
    portion_unit: str
    portion_count: float = Field(gt=0)
    effective_portion_grams: float = Field(gt=0)
    is_custom: bool


class ManualResolverInput(StrictModel):
    meal_id: str = Field(min_length=1)
    dish_name: str = Field(min_length=1)
    servings: MealServings
    global_dishes: list[GlobalDishContext]
    global_categories: list[GlobalCategoryContext]
    household_portions: list[HouseholdPortionContext]


class ManualResolution(StrictModel):
    action: Literal["match_existing", "create_new", "unresolved"]
    selected_food_id: str | None = None
    category: str | None = None
    canonical_name: str | None = None
    nutrients_per_unit: NutrientsPerUnit | None = None
    updated_meal_id: str | None = None
    confidence: Literal["high", "medium", "low"]
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def action_fields_are_consistent(self) -> ManualResolution:
        if self.action == "match_existing":
            if not self.selected_food_id:
                raise ValueError("Existing matches require selected_food_id")
            self.category = None
            self.canonical_name = None
            self.nutrients_per_unit = None
        elif self.action == "create_new":
            if (
                not self.selected_food_id
                or not self.category
                or not self.canonical_name
                or not self.nutrients_per_unit
            ):
                raise ValueError(
                    "New dishes require the tool-returned food ID, category, canonical name, and one-unit nutrition"
                )
        else:
            self.selected_food_id = None
            self.category = None
            self.canonical_name = None
            self.nutrients_per_unit = None
            self.updated_meal_id = None
        return self


class ResolvedManualDish(StrictModel):
    food_id: str
    name: str
    category: str
    confidence: Literal["high", "medium", "low"]
    action: Literal["match_existing", "create_new"]
    updated_meal_id: str
