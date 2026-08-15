"""API v1 admin - a PHYSICALLY SEPARATE router.

This is the only place `user_id` is an explicit parameter, and that is safe
precisely because the CALLER's own identity was proven cryptographically first
and then checked against READ_ANY_USER. Two different code paths, so a customer
route cannot accidentally drift into being an admin route.

    GET /admin/users                        All users, paginated
    GET /admin/users/{id}                   One user, full detail
    GET /admin/users/{id}/meals             Per-panel, lazy, paginated
    GET /admin/users/{id}/goals
    GET /admin/users/{id}/messages
    GET /admin/users/{id}/agent-runs
    GET /admin/metrics                      System ops
    GET /admin/resolution-mix               Which chain level answers - the
                                            dish-universe quality metric
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, Permission, require_permission
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.admin import service

router = APIRouter(prefix="/admin", tags=["admin"])

_READ_ANY = require_permission(Permission.READ_ANY_USER)
_SYSTEM_OPS = require_permission(Permission.VIEW_SYSTEM_OPS)


@router.get("/users", response_model=Page[dict])
async def list_users(
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    rows, total = await service.list_users(
        limit=params.page_size,
        offset=params.offset,
    )
    return Page.build(rows, total, params)


@router.get("/users/{user_id}")
async def get_user(user_id: str, _: CurrentUser = Depends(_READ_ANY)) -> dict[str, Any]:
    """Overview only. Each panel fetches its own data lazily - a user with
    5,000 entries must not produce a 5,000-row payload because an admin opened
    their profile."""
    return await service.get_user(user_id)


async def _panel(table: str, user_id: str, params: PaginationParams, order: str) -> Page[dict]:
    rows, total = await service.list_panel(
        table,
        user_id,
        order=order,
        limit=params.page_size,
        offset=params.offset,
    )
    return Page.build(rows, total, params)


@router.get("/users/{user_id}/meals", response_model=Page[dict])
async def user_meals(
    user_id: str,
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    return await _panel("meals", user_id, params, "meal_date")


@router.get("/users/{user_id}/goals", response_model=Page[dict])
async def user_goals(
    user_id: str,
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    return await _panel("goals", user_id, params, "created_at")


@router.get("/users/{user_id}/messages", response_model=Page[dict])
async def user_messages(
    user_id: str,
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    return await _panel("communication_master", user_id, params, "created_at")


@router.get("/users/{user_id}/agent-runs", response_model=Page[dict])
async def user_agent_runs(
    user_id: str,
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    return await _panel("agent_runs", user_id, params, "created_at")


@router.get("/users/{user_id}/preferences", response_model=Page[dict])
async def user_preferences(
    user_id: str,
    _: CurrentUser = Depends(_READ_ANY),
    params: PaginationParams = Depends(pagination),
) -> Page[dict]:
    return await _panel("user_preferences", user_id, params, "created_at")


@router.get("/resolution-mix")
async def resolution_mix(_: CurrentUser = Depends(_SYSTEM_OPS)) -> dict[str, Any]:
    """What share of logged items resolve at each level of the chain.

    The single best measure of whether the dish universe is good enough: a high
    `category_global` share means dishes are missing their own portions, and a
    high `unknown` share means search is failing.
    """
    return await service.resolution_mix()


@router.get("/metrics")
async def metrics(_: CurrentUser = Depends(_SYSTEM_OPS)) -> dict[str, Any]:
    return await service.metrics()
