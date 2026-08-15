"""FastAPI application.

The ONLY service that talks to Supabase. Both frontends reach it exclusively
through their own BFF route handlers - neither has a database client.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config.settings import settings
from app.core.error_handlers import register_error_handlers
from app.router_registry import register_all_routers
from app.utils.logger import logger
from app.utils.middleware import RequestIdMiddleware, SecurityHeadersMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Subsystems are imported lazily inside the body, and every shutdown step
    is individually wrapped, so one failure cannot block the rest."""
    logger.info(
        "startup env={} ai_enabled={} version={}",
        settings.ENVIRONMENT,
        settings.ai_enabled,
        settings.API_VERSION,
    )
    if not settings.ai_enabled:
        # The app is fully usable without a key; AI features show a disabled state.
        logger.warning("openai_key_absent - AI features will report as disabled")

    from app.services.supabase import start_supabase_pool, stop_supabase_pool

    await start_supabase_pool()
    yield
    await stop_supabase_pool()
    logger.info("shutdown_complete")


app = FastAPI(
    title=settings.API_NAME,
    version=settings.API_VERSION,
    description=settings.DESCRIPTION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Order matters: last added runs first in Starlette.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)
app.add_middleware(RequestIdMiddleware)

register_error_handlers(app)
register_all_routers(app)


@app.get("/health", tags=["health"])
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "version": settings.API_VERSION,
        "environment": settings.ENVIRONMENT,
        "ai_enabled": settings.ai_enabled,
    }
