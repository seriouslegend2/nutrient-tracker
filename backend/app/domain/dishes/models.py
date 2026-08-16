"""Shared fixed-unit catalog contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class CatalogActor(StrEnum):
    MANUAL_MEAL_RESOLVER = "manual_meal_resolver"
    MEDIA_MEAL_RESOLVER = "media_meal_resolver"


@dataclass(frozen=True, slots=True)
class CatalogAuditIdentity:
    actor_user_id: str
    actor: CatalogActor


class NutrientsPerUnit(BaseModel):
    """Nutrition in exactly one globally fixed category unit."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    protein_g: float | None = Field(default=None, ge=0)
    carbs_g: float | None = Field(default=None, ge=0)
    fat_g: float | None = Field(default=None, ge=0)
    fiber_g: float | None = Field(default=None, ge=0)
    sugar_g: float | None = Field(default=None, ge=0)
    saturated_fat_g: float | None = Field(default=None, ge=0)
    trans_fat_g: float | None = Field(default=None, ge=0)
    cholesterol_mg: float | None = Field(default=None, ge=0)
    calcium_mg: float | None = Field(default=None, ge=0)
    iron_mg: float | None = Field(default=None, ge=0)
    magnesium_mg: float | None = Field(default=None, ge=0)
    phosphorus_mg: float | None = Field(default=None, ge=0)
    potassium_mg: float | None = Field(default=None, ge=0)
    sodium_mg: float | None = Field(default=None, ge=0)
    zinc_mg: float | None = Field(default=None, ge=0)
    vitamin_a_ug: float | None = Field(default=None, ge=0)
    vitamin_b1_mg: float | None = Field(default=None, ge=0)
    vitamin_b2_mg: float | None = Field(default=None, ge=0)
    vitamin_b3_mg: float | None = Field(default=None, ge=0)
    vitamin_b6_mg: float | None = Field(default=None, ge=0)
    vitamin_b12_ug: float | None = Field(default=None, ge=0)
    vitamin_c_mg: float | None = Field(default=None, ge=0)
    vitamin_d_iu: float | None = Field(default=None, ge=0)
    vitamin_e_mg: float | None = Field(default=None, ge=0)
    vitamin_k_ug: float | None = Field(default=None, ge=0)
    folate_ug: float | None = Field(default=None, ge=0)
    iodine_ug: float | None = Field(default=None, ge=0)
    selenium_ug: float | None = Field(default=None, ge=0)
    copper_mg: float | None = Field(default=None, ge=0)
    manganese_mg: float | None = Field(default=None, ge=0)
