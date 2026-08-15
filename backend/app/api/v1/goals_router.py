"""API v1 - goals.

Endpoints (mounted under /api/v1):
    POST /goals                  Create; runs the safety ladder, may 422
    POST /goals/preview          DRY-RUN: requested vs clamped, writes nothing
    GET  /goals                  List, paginated
    GET  /goals/active           The homepage goal - exactly one row, or 204
    GET  /goals/{id}/progress    Goal vs actual over any date range
    POST /goals/{id}/activate    Switch active goal (deactivates the current)
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


class PreviewResponse(BaseModel):
    daily_targets: dict[str, Any]
    derivation: dict[str, Any]
    clamp_fired: bool


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
    """The homepage goal. A partial unique index guarantees at most one."""
    row = await service.get_active_goal(user.id)
    if not row:
        response.status_code = 204
        return None
    return GoalResponse(**row)


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
