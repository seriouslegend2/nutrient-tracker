"""API v1 - me, profile, body metrics, preferences, portions, onboarding.

Endpoints (mounted under /api/v1):
    GET   /me                          Profile + roles
    PATCH /me/profile                  Body metrics, activity; re-derives targets
    POST  /me/onboarding               Submit the 13-question questionnaire
    GET   /me/body-metrics             Weight history, paginated
    POST  /me/body-metrics             Log a weight (trigger refreshes the profile)
    GET   /me/preferences              Everything we know about you, paginated
    PUT   /me/preferences/{topic}      Edit a cluster; mints a new version
    GET   /me/portions                 My category portion profile
    PUT   /me/portions/{category}      Set my portion for a category
    PUT   /me/dishes/{id}/portion      Correct one specific dish
"""

from __future__ import annotations

from datetime import UTC, date
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.core.deps import CurrentUser, get_current_user
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.dishes import repository as dish_repo
from app.domain.profile import repository as repo

router = APIRouter(prefix="/me", tags=["profile"])


class MeResponse(BaseModel):
    id: str
    email: str | None = None
    roles: list[str]
    profile: dict[str, Any] | None = None
    onboarding_complete: bool


class ProfilePatchRequest(BaseModel):
    sex: str | None = None
    date_of_birth: date | None = None
    height_cm: float | None = Field(None, gt=0, lt=300)
    waist_cm: float | None = Field(None, gt=0)
    activity: str | None = None
    diet: str | None = None
    allergies: list[str] | None = None
    breakfast_time: str | None = None
    lunch_time: str | None = None
    dinner_time: str | None = None
    is_pregnant_or_nursing: bool | None = None
    has_medical_condition: bool | None = None


class CategoryPortionRequest(BaseModel):
    portion_unit: str
    portion_grams: float = Field(..., gt=0)
    portion_count: float = Field(1.0, gt=0)


class DishPortionRequest(BaseModel):
    portion_unit: str
    portion_grams: float = Field(..., gt=0)
    note: str | None = None


class BodyMetricRequest(BaseModel):
    weight_kg: float = Field(..., gt=0, lt=500)
    waist_cm: float | None = Field(None, gt=0)
    measured_on: date | None = None


class PreferenceRequest(BaseModel):
    content: str
    type: str = "Permanent"
    expires_on: date | None = None


class OnboardingRequest(BaseModel):
    """The 13 questions. Everything is optional so a user can tap straight
    through and still end up with a working profile."""

    sex: str | None = None
    date_of_birth: date | None = None
    height_cm: float | None = None
    weight_kg: float | None = None
    waist_cm: float | None = None
    activity: str | None = "moderate"
    diet: str | None = None
    allergies: list[str] = []
    breakfast_time: str | None = None
    lunch_time: str | None = None
    dinner_time: str | None = None
    # Q10-Q11: portions by category, e.g. {"dal_gravy": {"count": 1.5}}
    portions: dict[str, dict[str, float]] = {}
    is_pregnant_or_nursing: bool = False
    has_medical_condition: bool = False


@router.get("", response_model=MeResponse)
async def me(user: CurrentUser = Depends(get_current_user)) -> MeResponse:
    profile = await repo.get_profile(user.id)
    return MeResponse(
        id=user.id,
        email=user.email,
        roles=[r.value for r in user.roles],
        profile=profile,
        onboarding_complete=bool(profile and profile.get("onboarding_completed_at")),
    )


@router.patch("/profile")
async def patch_profile(
    body: ProfilePatchRequest, user: CurrentUser = Depends(get_current_user)
) -> dict[str, Any]:
    """Structural body-profile changes recompute metrics and version the active goal."""
    return await repo.upsert_profile(user.id, body.model_dump(exclude_none=True))


@router.post("/onboarding")
async def submit_onboarding(
    body: OnboardingRequest, user: CurrentUser = Depends(get_current_user)
) -> dict[str, Any]:
    """Submit the questionnaire: profile, first weight, and portion profile."""
    from datetime import datetime

    patch = body.model_dump(exclude_none=True, exclude={"portions", "weight_kg"})
    patch["onboarding_completed_at"] = datetime.now(UTC).isoformat()
    profile = await repo.upsert_profile(user.id, patch)

    if body.weight_kg:
        await repo.add_body_metric(user.id, body.weight_kg, body.waist_cm)

    # Q10-Q11 seed lookup level ③ - the one that answers every dish forever.
    saved = 0
    defaults = {r["category"]: r for r in await dish_repo.list_category_portions(user.id)}
    for category, values in body.portions.items():
        base = defaults.get(category)
        if not base:
            continue
        await dish_repo.set_category_household(
            user_id=user.id,
            category=category,
            portion_unit=base["portion_unit"],
            portion_grams=values.get("grams", base["global_portion_grams"]),
            portion_count=values.get("count", base["global_portion_count"]),
        )
        saved += 1

    return {"profile": await repo.get_profile(user.id) or profile, "portions_saved": saved}


@router.get("/body-metrics", response_model=Page[dict])
async def list_body_metrics(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    items, total = await repo.list_body_metrics(
        user.id, limit=params.page_size, offset=params.offset
    )
    return Page.build(items, total, params)


@router.post("/body-metrics", status_code=201)
async def add_body_metric(
    body: BodyMetricRequest, user: CurrentUser = Depends(get_current_user)
) -> dict[str, Any]:
    """Append-only. The INSERT trigger refreshes BMR/TDEE and MAY version the
    active goal - but only on a >=2 kg change or after 14 days, so a target
    never moves on scale noise."""
    return await repo.add_body_metric(user.id, body.weight_kg, body.waist_cm, body.measured_on)


@router.get("/preferences", response_model=Page[dict])
async def list_preferences(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
    active_only: bool = Query(True),
) -> Page[dict]:
    items, total = await repo.list_preferences(
        user.id, limit=params.page_size, offset=params.offset, active_only=active_only
    )
    return Page.build(items, total, params)


@router.put("/preferences/{topic}")
async def upsert_preference(
    topic: str, body: PreferenceRequest, user: CurrentUser = Depends(get_current_user)
) -> dict[str, Any]:
    """An update re-emits the COMPLETE rewritten content, never a diff."""
    return await repo.upsert_preference(
        user.id,
        topic,
        body.content,
        pref_type=body.type,
        source="manual",
        expires_on=body.expires_on,
    )


@router.get("/portions", response_model=Page[dict])
async def my_portions(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    """My category portion profile - lookup level ③."""
    rows = await dish_repo.list_category_portions(user.id)
    window = rows[params.offset : params.offset + params.page_size]
    return Page.build(window, len(rows), params)


@router.put("/portions/{category}")
async def set_category_portion(
    category: str,
    body: CategoryPortionRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Lookup level ③. Editable forever, from About, a meal row, or chat."""
    return await dish_repo.set_category_household(
        user_id=user.id,
        category=category,
        portion_unit=body.portion_unit,
        portion_grams=body.portion_grams,
        portion_count=body.portion_count,
        source="manual",
    )


@router.put("/dishes/{dish_id}/portion")
async def set_dish_portion(
    dish_id: str,
    body: DishPortionRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Lookup level ②: a per-dish correction. Rare by design."""
    return await dish_repo.set_dish_household(
        user_id=user.id,
        dish_id=dish_id,
        portion_unit=body.portion_unit,
        portion_grams=body.portion_grams,
        note=body.note,
    )
