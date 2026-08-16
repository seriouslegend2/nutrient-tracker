"""API v1 - the dish universe and portion overrides.

Endpoints (mounted under /api/v1):
    GET /dishes/search              Hybrid search, paginated
    GET /dishes/{id}                One dish
    GET /dishes/{id}/portion        Resolved portion + WHICH level answered
    GET /categories                 Global defaults merged with my overrides
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import CurrentUser, get_current_user
from app.core.exceptions import NotFoundError
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.dishes import repository as repo
from app.domain.dishes.resolve import resolve_portion

router = APIRouter(tags=["dishes"])


class DishResponse(BaseModel):
    dish_id: str
    name: str
    category: str
    portion_unit: str
    portion_grams: float
    nutrients_per_unit: dict[str, Any] = {}
    aliases: list[str] = []
    source: str


class PortionResponse(BaseModel):
    portion_unit: str
    portion_grams: float | None
    nutrients_per_unit: dict[str, Any] = {}
    resolved_from: str


class CategoryPortionResponse(BaseModel):
    category: str
    portion_unit: str
    portion_grams: float
    portion_count: float
    effective_portion_grams: float
    is_custom: bool
    global_portion_grams: float
    global_portion_count: float
    source: str | None = None


@router.get("/dishes/search", response_model=Page[DishResponse])
async def search_dishes(
    q: str = Query("", description="Search text, e.g. 'dal tadka'"),
    category: str | None = Query(None),
    _: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[DishResponse]:
    items, total = await repo.search_dishes(
        q, limit=params.page_size, offset=params.offset, category=category
    )
    return Page.build([DishResponse(**i) for i in items], total, params)


@router.get("/dishes/{dish_id}", response_model=DishResponse)
async def get_dish(dish_id: str, _: CurrentUser = Depends(get_current_user)) -> DishResponse:
    dish = await repo.get_dish(dish_id)
    if not dish:
        raise NotFoundError("Dish not found", code="DISH_NOT_FOUND")
    return DishResponse(**dish)


@router.get("/dishes/{dish_id}/portion", response_model=PortionResponse)
async def get_portion(
    dish_id: str, user: CurrentUser = Depends(get_current_user)
) -> PortionResponse:
    """Runs the chain and reports WHICH level answered.

    That last field is what makes a wrong number attributable: the UI can say
    "this used the general katori portion, not yours" and offer a one-tap fix.
    """
    dish = await repo.get_dish(dish_id)
    chain = await resolve_portion(user.id, dish_id, dish["category"] if dish else None)
    return PortionResponse(**chain)


@router.get("/categories", response_model=Page[CategoryPortionResponse])
async def list_categories(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[CategoryPortionResponse]:
    """The fixed categories: global defaults with my overrides applied and flagged.

    This drives the portion picker in one query - no unit logic in the client.
    Paginated like every other list route: the set is bounded at 18 today, but
    an exception to the contract is worse than an envelope nobody notices.
    """
    rows = await repo.list_category_portions(user.id)
    window = rows[params.offset : params.offset + params.page_size]
    return Page.build([CategoryPortionResponse(**r) for r in window], len(rows), params)
