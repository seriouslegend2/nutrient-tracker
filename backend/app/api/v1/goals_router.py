"""API v1 - goals.

Endpoints (mounted under /api/v1):
    POST /goals                  Create; runs the safety ladder, may 422
    POST /goals/preview          DRY-RUN: requested vs clamped, writes nothing
    GET  /goals                  List, paginated
    GET  /goals/active           The primary homepage goal, or 204
    GET  /goals/progress/summary Progress for every active goal
    POST /goals/activity/check-in Explicit training check-in
    GET  /goals/{id}/progress    Goal vs actual over any date range
    POST /goals/{id}/activate    Enable a goal without disabling other goals
    POST /goals/{id}/deactivate  Stand a goal down
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field

from app.core.deps import CurrentUser, get_current_user
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.goals import service

router = APIRouter(prefix="/goals", tags=["goals"])


class GoalRequest(BaseModel):
    kind: Literal["nutrient", "body_weight", "item", "hydration", "behaviour"] = Field(
        ..., description="nutrient|body_weight|item|hydration|behaviour"
    )
    spec: dict[str, Any] = Field(..., description="What the user asked for, verbatim")
    starts_on: date
    ends_on: date
    cadence: Literal["daily", "weekly", "monthly", "period"] = "daily"
    make_primary: bool | None = None


class GoalResponse(BaseModel):
    goal_id: str
    kind: str
    spec: dict[str, Any]
    starts_on: date
    ends_on: date
    daily_targets: dict[str, Any]
    derivation: dict[str, Any]
    status: str
    version: int
    is_active: bool
    cadence: str
    is_primary: bool


class PreviewResponse(BaseModel):
    daily_targets: dict[str, Any]
    derivation: dict[str, Any]
    clamp_fired: bool
    cadence: str


class ActivityCheckInRequest(BaseModel):
    activity_date: date = Field(default_factory=date.today, alias="date")
    activity_type: Literal["training"] = "training"


class ActivityResponse(BaseModel):
    id: str
    activity_date: date
    activity_type: str
    created_at: str


class ProgressValue(BaseModel):
    status: str
    actual: float | None
    target: float
    unit: str
    direction: str | None = None
    progress_pct: float | None = None
    completed_buckets: int | None = None
    total_buckets: int | None = None


class StreakResponse(BaseModel):
    current: int
    longest: int
    unit: str


class CalendarDayResponse(BaseModel):
    date: date
    status: str
    actual: float | None
    target: float


class GoalProgressSummary(BaseModel):
    goal_id: str
    kind: str
    metric: str | None = None
    cadence: str
    is_primary: bool
    label: str
    starts_on: date
    ends_on: date
    today: ProgressValue
    period: ProgressValue
    streak: StreakResponse
    calendar: list[CalendarDayResponse]


class ProgressSummaryResponse(BaseModel):
    as_of: date
    goals: list[GoalProgressSummary]


@router.post("/preview", response_model=PreviewResponse)
async def preview_goal(
    body: GoalRequest, user: CurrentUser = Depends(get_current_user)
) -> PreviewResponse:
    """Dry-run a goal without writing anything.

    The most important non-obvious endpoint in the API: it lets the UI show
    "here is what you asked for, here is what is safe, here is the realistic
    date" BEFORE anything is stored, which is what makes the safety ladder read
    as guidance rather than rejection.
    """
    return PreviewResponse(
        **await service.preview(
            user_id=user.id,
            kind=body.kind,
            spec=body.spec,
            starts_on=body.starts_on,
            ends_on=body.ends_on,
            cadence=body.cadence,
            make_primary=bool(body.make_primary),
        )
    )


@router.post("", response_model=GoalResponse, status_code=201)
async def create_goal(
    body: GoalRequest, user: CurrentUser = Depends(get_current_user)
) -> GoalResponse:
    row = await service.create_goal(
        user_id=user.id,
        kind=body.kind,
        spec=body.spec,
        starts_on=body.starts_on,
        ends_on=body.ends_on,
        cadence=body.cadence,
        make_primary=bool(body.make_primary),
    )
    return GoalResponse(**row)


@router.get("", response_model=Page[GoalResponse])
async def list_goals(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
    status: str | None = Query(None),
) -> Page[GoalResponse]:
    items, total = await service.list_goals(
        user.id, limit=params.page_size, offset=params.offset, status=status
    )
    return Page.build([GoalResponse(**i) for i in items], total, params)


@router.get("/active", response_model=GoalResponse | None)
async def active_goal(
    response: Response, user: CurrentUser = Depends(get_current_user)
) -> GoalResponse | None:
    """Compatibility endpoint for the one active primary goal."""
    row = await service.get_active_goal(user.id)
    if not row:
        response.status_code = 204
        return None
    return GoalResponse(**row)


@router.post("/activity/check-in", response_model=ActivityResponse, status_code=201)
async def activity_check_in(
    body: ActivityCheckInRequest, user: CurrentUser = Depends(get_current_user)
) -> ActivityResponse:
    row = await service.check_in_activity(user.id, body.activity_date, body.activity_type)
    return ActivityResponse(**row)


@router.get("/activity", response_model=Page[ActivityResponse])
async def activity_history(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
) -> Page[ActivityResponse]:
    today = date.today()
    items, total = await service.list_activity(
        user.id,
        date_from or today - timedelta(days=29),
        date_to or today,
        limit=params.page_size,
        offset=params.offset,
    )
    return Page.build([ActivityResponse(**item) for item in items], total, params)


@router.get("/progress/summary", response_model=ProgressSummaryResponse)
async def all_goal_progress(
    user: CurrentUser = Depends(get_current_user),
    as_of: date | None = Query(None),
) -> ProgressSummaryResponse:
    return ProgressSummaryResponse(**await service.progress_summary(user.id, as_of or date.today()))


@router.get("/{goal_id}/progress")
async def goal_progress(
    goal_id: str,
    user: CurrentUser = Depends(get_current_user),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
) -> dict[str, Any]:
    """Progress is a SUM over meals compared to daily_targets. Pure maths."""
    today = date.today()
    return await service.progress(
        user.id, goal_id, date_from or (today - timedelta(days=6)), date_to or today
    )


@router.post("/{goal_id}/activate", response_model=GoalResponse)
async def activate(goal_id: str, user: CurrentUser = Depends(get_current_user)) -> GoalResponse:
    return GoalResponse(**await service.set_active(user.id, goal_id, True))


@router.post("/{goal_id}/deactivate", response_model=GoalResponse)
async def deactivate(goal_id: str, user: CurrentUser = Depends(get_current_user)) -> GoalResponse:
    return GoalResponse(**await service.set_active(user.id, goal_id, False))


@router.post("/{goal_id}/primary", response_model=GoalResponse)
async def make_primary(goal_id: str, user: CurrentUser = Depends(get_current_user)) -> GoalResponse:
    return GoalResponse(**await service.set_primary(user.id, goal_id))
