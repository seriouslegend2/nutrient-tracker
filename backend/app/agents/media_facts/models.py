"""Strict input and output models for factual media understanding."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


Confidence = Literal["low", "medium", "high"]
MediaKind = Literal["image", "pdf"]


class MassRange(StrictModel):
    low: float = Field(ge=0)
    high: float = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self) -> MassRange:
        if self.high < self.low:
            raise ValueError("Mass range high must be greater than or equal to low")
        return self


class MediaQuantity(StrictModel):
    value: float = Field(gt=0)
    unit: str = Field(min_length=1)
    total_grams: float = Field(
        gt=0,
        description="Authoritative consumed grams chosen by Agent 1; downstream must not replace it",
    )
    range_g: MassRange | None = None
    source: Literal["user_stated", "document_declared", "visible", "estimated"]
    confidence: Confidence
    basis: str

    @model_validator(mode="after")
    def normalize_estimated_mass(self) -> MediaQuantity:
        normalized_unit = self.unit.strip().lower()
        if self.source == "visible" and (
            self.total_grams is not None
            or normalized_unit in {"g", "gram", "grams", "kg", "kilogram", "kilograms"}
        ):
            self.source = "estimated"
        if (
            self.source == "estimated"
            and self.range_g is not None
            and self.range_g.low == self.range_g.high
        ):
            raise ValueError("Estimated quantity ranges must be non-degenerate")
        return self


class PossibleIngredient(StrictModel):
    name: str = Field(min_length=1)
    possible: Literal[True] = True
    basis: str
    confidence: Confidence


class DocumentDeclaredNutrient(StrictModel):
    name: Literal[
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sodium_mg",
        "sugar_g",
        "saturated_fat_g",
        "trans_fat_g",
        "cholesterol_mg",
        "calcium_mg",
        "iron_mg",
        "magnesium_mg",
        "phosphorus_mg",
        "potassium_mg",
        "zinc_mg",
        "vitamin_a_ug",
        "vitamin_b1_mg",
        "vitamin_b2_mg",
        "vitamin_b3_mg",
        "vitamin_b6_mg",
        "vitamin_b12_ug",
        "vitamin_c_mg",
        "vitamin_d_iu",
        "vitamin_e_mg",
        "vitamin_k_ug",
        "folate_ug",
        "iodine_ug",
        "selenium_ug",
        "copper_mg",
        "manganese_mg",
    ]
    value: float = Field(ge=0)
    unit: str
    basis: Literal["per_100g", "per_serving", "item_total", "row_declared"]
    serving_size_g: float | None = Field(default=None, gt=0)
    source_locator: str


class MediaFactItem(StrictModel):
    evidence_id: str = Field(min_length=1)
    observed_item_name: str = Field(min_length=1)
    normalized_name: str = Field(min_length=1)
    visible_count: float | None = Field(default=None, gt=0)
    visible_container: str | None = None
    quantity: MediaQuantity = Field(
        description="One authoritative quantity for this separable food item"
    )
    visible_ingredients: list[str] = Field(default_factory=list)
    possible_inferred_ingredients: list[PossibleIngredient] = Field(default_factory=list)
    document_declared_nutrients: list[DocumentDeclaredNutrient] = Field(default_factory=list)
    document_row: str | None = None
    row_date: date | None = None
    meal_slot: str | None = None
    source_locator: str | None = None
    confidence: Confidence
    warnings: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)


class MediaFacts(StrictModel):
    usable: bool
    media_kind: MediaKind
    content_kind: Literal[
        "food_photo", "nutrition_label", "food_diary", "mixed", "unknown"
    ]
    items: list[MediaFactItem] = Field(
        default_factory=list,
        description="One entry per separable food; never combine burger, fries, or sauce",
    )
    confidence: Confidence
    warnings: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)


class MediaFactsAgentOutput(StrictModel):
    facts: MediaFacts
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    prompt_name: str
    prompt_version: str | None = None
    prompt_source: str


class MediaFactsRunResult(StrictModel):
    ok: bool
    facts: MediaFacts | None = None
    detail: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    prompt_name: str | None = None
    prompt_version: str | None = None
    prompt_source: str | None = None
