"""API v1 - meals.

Endpoints (mounted under /api/v1):
    GET    /meals                      Time-range listing, paginated + cursor
    POST   /meals                      Log one item (food_id optional)
    PATCH  /meals/{id}                 Adjust portion or quantity, recomputes
    DELETE /meals/{id}                 Remove an item
    GET    /meals/day/{date}           One day, grouped by slot, with totals
    PUT    /meals/day/{date}           Replace a whole day, mints version+1
    GET    /meals/day/{date}/versions  Edit history

There is deliberately NO /meals/{user_id} route: identity comes from the
verified token, never from the path.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, model_validator

from app.core.deps import CurrentUser, get_current_user
from app.core.exceptions import NotFoundError
from app.core.pagination import Page, PaginationParams, decode_cursor, encode_cursor, pagination
from app.domain.meals import repository as repo
from app.domain.meals import service

router = APIRouter(prefix="/meals", tags=["meals"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class MealResponse(BaseModel):
    id: str
    meal_date: date
    meal_type: str
    slot_time: str | None = None
    version: int
    dish_name: str
    food_id: str | None = None
    category: str | None = None
    portions: float
    portion_unit: str
    grams: float | None = None
    nutrients: dict[str, Any] = {}
    resolved_from: str
    confidence: str | None = None
    source: str
    note: str | None = None


class MealCreateRequest(BaseModel):
    meal_date: date
    meal_type: str = Field(..., description="breakfast|brunch|lunch|snacks|dinner|misc")
    dish_name: str | None = Field(None, min_length=1)
    food_id: str | None = Field(None, description="Optional: free text is first-class")
    portions: float = Field(1.0, gt=0, description="The multiplier: 1.5 katori, 3 rotis")
    grams: float | None = Field(None, ge=0, description="Overrides the lookup chain")
    portion_unit: str | None = None
    slot_time: str | None = None
    note: str | None = None
    nutrients: dict[str, float] | None = None

    @model_validator(mode="after")
    def require_dish_or_nutrients(self) -> MealCreateRequest:
        if not (self.dish_name or "").strip() and not self.food_id and not self.nutrients:
            raise ValueError("Provide a dish name, food ID, or at least one nutrient value")
        return self


class MealPatchRequest(BaseModel):
    portions: float | None = Field(None, gt=0)
    portion_unit: str | None = None
    grams: float | None = Field(None, ge=0)


class DayItemRequest(BaseModel):
    meal_type: str
    dish_name: str | None = None
    food_id: str | None = None
    portions: float = 1.0
    grams: float | None = None
    portion_unit: str | None = None
    slot_time: str | None = None
    note: str | None = None
    nutrients: dict[str, float] | None = None

    @model_validator(mode="after")
    def require_dish_or_nutrients(self) -> DayItemRequest:
        if not (self.dish_name or "").strip() and not self.food_id and not self.nutrients:
            raise ValueError("Provide a dish name, food ID, or at least one nutrient value")
        return self


class DayReplaceRequest(BaseModel):
    items: list[DayItemRequest] = Field(..., min_length=1)


class DayResponse(BaseModel):
    meal_date: date
    version: int | None = None
    slots: dict[str, list[MealResponse]]
    totals: dict[str, float]
    unaccounted_items: int


class DayVersionResponse(BaseModel):
    version: int
    is_active: bool
    created_at: str
    item_count: int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("", response_model=Page[MealResponse])
async def list_meals(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    meal_type: list[str] | None = Query(None),
    cursor: str | None = Query(None, description="Keyset cursor for infinite scroll"),
) -> Page[MealResponse]:
    """Time-range listing, filterable by date and meal type."""
    items, total = await repo.list_meals(
        user_id=user.id,
        date_from=date_from,
        date_to=date_to,
        meal_types=meal_type,
        limit=params.page_size,
        offset=0 if cursor else params.offset,
        cursor=decode_cursor(cursor) if cursor else None,
    )
    next_cursor = (
        encode_cursor({"meal_date": items[-1]["meal_date"], "id": items[-1]["id"]})
        if items and len(items) == params.page_size
        else None
    )
    return Page.build([MealResponse(**i) for i in items], total, params, next_cursor=next_cursor)


@router.post("", response_model=MealResponse, status_code=201)
async def create_meal(
    body: MealCreateRequest, user: CurrentUser = Depends(get_current_user)
) -> MealResponse:
    """Log one item. Runs the lookup chain unless grams are stated."""
    row = await service.add_item(
        user_id=user.id,
        meal_date=body.meal_date,
        meal_type=body.meal_type,
        dish_name=body.dish_name,
        food_id=body.food_id,
        portions=body.portions,
        grams=body.grams,
        portion_unit=body.portion_unit,
        slot_time=body.slot_time,
        note=body.note,
        nutrients=body.nutrients,
    )
    return MealResponse(**row)


@router.patch("/{meal_id}", response_model=MealResponse)
async def patch_meal(
    meal_id: str, body: MealPatchRequest, user: CurrentUser = Depends(get_current_user)
) -> MealResponse:
    row = await service.adjust_item(
        user_id=user.id,
        meal_id=meal_id,
        portions=body.portions,
        portion_unit=body.portion_unit,
        grams=body.grams,
    )
    return MealResponse(**row)


@router.delete("/{meal_id}", status_code=204)
async def delete_meal(meal_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    if not await repo.delete_meal(user.id, meal_id):
        raise NotFoundError("Meal item not found", code="MEAL_NOT_FOUND")


@router.get("/day/{day}", response_model=DayResponse)
async def get_day(
    day: date,
    user: CurrentUser = Depends(get_current_user),
    version: int | None = Query(None, description="Read a superseded version"),
) -> DayResponse:
    """One day, grouped by slot. A single query - no joins."""
    rows = await repo.get_day(user.id, day, version)
    slots: dict[str, list[MealResponse]] = {}
    for row in rows:
        slots.setdefault(row["meal_type"], []).append(MealResponse(**row))
    summary = await service.day_totals(rows)
    return DayResponse(
        meal_date=day,
        version=rows[0]["version"] if rows else None,
        slots=slots,
        totals=summary["totals"],
        unaccounted_items=summary["unaccounted_items"],
    )


@router.put("/day/{day}", response_model=DayResponse)
async def replace_day(
    day: date, body: DayReplaceRequest, user: CurrentUser = Depends(get_current_user)
) -> DayResponse:
    """Replace a whole day. Mints version+1 and deactivates the previous set."""
    await service.replace_day(
        user_id=user.id, meal_date=day, items=[i.model_dump() for i in body.items]
    )
    return await get_day(day, user)


@router.get("/day/{day}/versions", response_model=Page[DayVersionResponse])
async def day_versions(
    day: date,
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
) -> Page[DayVersionResponse]:
    versions = await repo.list_day_versions(user.id, day)
    window = versions[params.offset : params.offset + params.page_size]
    return Page.build([DayVersionResponse(**v) for v in window], len(versions), params)
