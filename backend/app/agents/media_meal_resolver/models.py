"""Strict contracts for draft-only media dish resolution."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.agents.media_facts.models import MediaFacts


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class GlobalDishContext(StrictModel):
    food_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    normalized_name: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    category: str


class GlobalCategoryContext(StrictModel):
    category: str
    portion_unit: str
    portion_grams: float = Field(gt=0)
    portion_count: float = Field(gt=0)


class HouseholdPortionContext(StrictModel):
    category: str
    portion_unit: str
    portion_grams: float = Field(gt=0)
    portion_count: float = Field(gt=0)
    is_custom: bool


class MediaResolverInput(StrictModel):
    facts: MediaFacts
    global_dishes: list[GlobalDishContext]
    global_categories: list[GlobalCategoryContext]
    household_portions: list[HouseholdPortionContext]
    fallback_names: dict[str, str] = Field(default_factory=dict)


class MediaResolutionDecision(StrictModel):
    evidence_id: str = Field(min_length=1)
    action: Literal["match_existing", "create_new"]
    selected_food_id: str | None = None
    category: str | None = None
    canonical_name: str | None = None
    confidence: Literal["high", "medium", "low"]
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def normalize_action_fields(self) -> MediaResolutionDecision:
        if self.action == "match_existing":
            if not self.selected_food_id:
                raise ValueError("Existing matches require selected_food_id")
            self.category = None
            self.canonical_name = None
        return self


class MediaResolutionPlan(StrictModel):
    decisions: list[MediaResolutionDecision]


class ResolvedMediaDish(StrictModel):
    evidence_id: str
    food_id: str
    name: str
    category: str
    confidence: Literal["high", "medium", "low"]
    action: Literal["match_existing", "create_new"]


class MediaMealResolverRunResult(StrictModel):
    dishes: list[ResolvedMediaDish]
    plan: MediaResolutionPlan
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    prompt_name: str
    prompt_version: str | None = None
    prompt_source: str
    raw_metadata: dict[str, Any] = Field(default_factory=dict)
