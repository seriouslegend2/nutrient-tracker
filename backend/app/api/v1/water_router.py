"""API v1 - hydration.

POST /water   Log water
GET  /water   History, paginated
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.deps import CurrentUser, get_current_user
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.water import service

router = APIRouter(prefix="/water", tags=["water"])


class WaterRequest(BaseModel):
    volume_ml: float = Field(..., gt=0)
    logged_on: date | None = None


@router.post("", status_code=201)
async def log_water(
    body: WaterRequest, user: CurrentUser = Depends(get_current_user)
) -> dict[str, Any]:
    return await service.log_water(user.id, body.volume_ml, body.logged_on or date.today())


@router.get("", response_model=Page[dict])
async def list_water(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[dict[str, Any]]:
    rows, total = await service.list_water(
        user.id,
        limit=params.page_size,
        offset=params.offset,
    )
    return Page.build(rows, total, params)
