"""Strict contracts for manual dish matching and catalog creation."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class GlobalDishContext(StrictModel):
    food_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    name_normalized: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    category: str
    per_100g: dict[str, float] = Field(default_factory=dict)
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


class Per100GNutrients(StrictModel):
    protein_g: float = Field(ge=0)
    carbs_g: float = Field(ge=0)
    fat_g: float = Field(ge=0)
    fiber_g: float | None = Field(default=None, ge=0)
    calcium_mg: float | None = Field(default=None, ge=0)
    iron_mg: float | None = Field(default=None, ge=0)
    magnesium_mg: float | None = Field(default=None, ge=0)
    phosphorus_mg: float | None = Field(default=None, ge=0)
    potassium_mg: float | None = Field(default=None, ge=0)
    sodium_mg: float | None = Field(default=None, ge=0)
    zinc_mg: float | None = Field(default=None, ge=0)
    vitamin_a_ug: float | None = Field(default=None, ge=0)
    vitamin_b12_ug: float | None = Field(default=None, ge=0)
    vitamin_c_mg: float | None = Field(default=None, ge=0)
    vitamin_d_iu: float | None = Field(default=None, ge=0)
    folate_ug: float | None = Field(default=None, ge=0)


class ManualResolverInput(StrictModel):
    meal_id: str = Field(min_length=1)
    dish_name: str = Field(min_length=1)
    servings: float = Field(gt=0)
    global_dishes: list[GlobalDishContext]
    global_categories: list[GlobalCategoryContext]
    household_portions: list[HouseholdPortionContext]


class ManualResolution(StrictModel):
    action: Literal["match_existing", "create_new", "unresolved"]
    selected_food_id: str | None = None
    category: str | None = None
    canonical_name: str | None = None
    per_100g: Per100GNutrients | None = None
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
            self.per_100g = None
        elif self.action == "create_new":
            if (
                not self.selected_food_id
                or not self.category
                or not self.canonical_name
                or not self.per_100g
            ):
                raise ValueError(
                    "New dishes require the tool-returned food ID, category, canonical name, and per-100g estimate"
                )
        else:
            self.selected_food_id = None
            self.category = None
            self.canonical_name = None
            self.per_100g = None
            self.updated_meal_id = None
        return self


class ResolvedManualDish(StrictModel):
    food_id: str
    name: str
    category: str
    confidence: Literal["high", "medium", "low"]
    action: Literal["match_existing", "create_new"]
    updated_meal_id: str
