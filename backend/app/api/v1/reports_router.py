"""API v1 - reports. The four chart families the assignment requires.

Endpoints (mounted under /api/v1):
    GET /reports/trend           Calorie intake over time (day|week|month)
    GET /reports/macros          Macro breakdown, grams AND % of energy
    GET /reports/micros          18 micronutrients vs RDA + top-5 watchlist
    GET /reports/goal-vs-actual  Target band with actual plotted through it
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query

from app.core.deps import CurrentUser, get_current_user
from app.domain.profile import repository as profile_repo
from app.domain.reports import service

router = APIRouter(prefix="/reports", tags=["reports"])


def _window(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    today = date.today()
    return (date_from or today - timedelta(days=29)), (date_to or today)


@router.get("/trend")
async def trend(
    user: CurrentUser = Depends(get_current_user),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    group_by: str = Query("day", pattern="^(day|week|month)$"),
) -> dict[str, Any]:
    f, t = _window(date_from, date_to)
    return await service.trend(user.id, f, t, group_by)


@router.get("/macros")
async def macros(
    user: CurrentUser = Depends(get_current_user),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    group_by: str = Query("day", pattern="^(day|week|month)$"),
) -> dict[str, Any]:
    f, t = _window(date_from, date_to)
    return await service.macros(user.id, f, t, group_by)


@router.get("/micros")
async def micros(
    user: CurrentUser = Depends(get_current_user),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
) -> dict[str, Any]:
    """Sex drives the RDA column - iron is 19 mg for men and 29 mg for women."""
    f, t = _window(date_from, date_to)
    profile = await profile_repo.get_profile(user.id)
    return await service.micros(user.id, f, t, sex=(profile or {}).get("sex") or "female")


@router.get("/goal-vs-actual")
async def goal_vs_actual(
    user: CurrentUser = Depends(get_current_user),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
) -> dict[str, Any]:
    f, t = _window(date_from, date_to)
    return await service.goal_vs_actual(user.id, f, t)
