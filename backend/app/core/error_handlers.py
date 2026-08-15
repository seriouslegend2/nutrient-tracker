"""The three global exception handlers KookarCore never wrote.

That codebase has ZERO global handlers across the whole app and ~1,805
hand-written ``raise HTTPException`` sites, so an uncaught error returns
Starlette's plaintext 500. Here every response has an identical shape and a
``request_id`` that appears in the logs, and routers stop carrying try/except
boilerplate: they raise domain errors and the handler does the mapping.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.exceptions import AppError
from app.utils.logger import logger


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "unknown")


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        logger.warning(
            "app_error code={} status={} path={} request_id={}",
            exc.code,
            exc.status_code,
            request.url.path,
            _request_id(request),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.message,
                "code": exc.code,
                "suggested_action": exc.suggested_action,
                "context": exc.context,
                "request_id": _request_id(request),
            },
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "detail": "Request validation failed",
                "code": "VALIDATION_ERROR",
                "suggested_action": None,
                "context": {"errors": _safe_errors(exc)},
                "request_id": _request_id(request),
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.detail,
                "code": f"HTTP_{exc.status_code}",
                "suggested_action": None,
                "context": {},
                "request_id": _request_id(request),
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # Log the real error; NEVER leak the exception text to the client.
        logger.exception(
            "unhandled_error path={} request_id={} error={}",
            request.url.path,
            _request_id(request),
            str(exc),
        )
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal server error",
                "code": "INTERNAL_ERROR",
                "suggested_action": None,
                "context": {},
                "request_id": _request_id(request),
            },
        )


def _safe_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    """Strip non-serialisable values (e.g. bytes bodies) out of validation errors."""
    out: list[dict[str, object]] = []
    for err in exc.errors():
        out.append(
            {
                "loc": list(err.get("loc", [])),
                "msg": err.get("msg"),
                "type": err.get("type"),
            }
        )
    return out
