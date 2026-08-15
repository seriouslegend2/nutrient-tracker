"""Central router mounting.

The prefix and OpenAPI tags live HERE, not in the router file - KookarCore's
convention, and it keeps the mount points visible in one place.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.api.v1 import (
    dishes_router,
    goals_router,
    meals_router,
    messages_router,
    profile_router,
    reports_router,
    water_router,
)
from app.api.v1.admin import users_router as admin_users_router

_PREFIX = "/api/v1"


def register_all_routers(app: FastAPI) -> None:
    """Register every router. One call site."""
    app.include_router(profile_router.router, prefix=_PREFIX)
    app.include_router(meals_router.router, prefix=_PREFIX)
    app.include_router(dishes_router.router, prefix=_PREFIX)
    app.include_router(goals_router.router, prefix=_PREFIX)
    app.include_router(reports_router.router, prefix=_PREFIX)
    app.include_router(water_router.router, prefix=_PREFIX)
    app.include_router(messages_router.router, prefix=_PREFIX)
    app.include_router(admin_users_router.router, prefix=_PREFIX)
