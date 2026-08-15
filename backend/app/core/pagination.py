"""Pagination: ONE envelope, ONE dependency, used by every list endpoint.

The assignment requires pagination on *all* list APIs. KookarCore has five
hand-rolled styles across ~90 endpoints and no shared helper, and its one
generic model is ``items: List[Any]``. This is the opposite: a single generic
envelope, plus a test that walks the OpenAPI document and fails if any list
route returns a bare array.
"""

from __future__ import annotations

import base64
import json
import math
from typing import Any, cast

from fastapi import Query
from pydantic import BaseModel, Field


class PaginationParams(BaseModel):
    """Offset pagination. The default for every list endpoint."""

    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=200)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size

    @property
    def limit(self) -> int:
        return self.page_size


def pagination(
    page: int = Query(1, ge=1, description="1-indexed page number"),
    page_size: int = Query(50, ge=1, le=200, description="Items per page (max 200)"),
) -> PaginationParams:
    """FastAPI dependency. Every list endpoint takes exactly this."""
    return PaginationParams(page=page, page_size=page_size)


class Page[T](BaseModel):
    """The one and only list envelope."""

    items: list[T]
    total: int
    page: int
    page_size: int
    total_pages: int
    has_more: bool
    next_cursor: str | None = None

    @classmethod
    def build(
        cls,
        items: list[T],
        total: int,
        params: PaginationParams,
        next_cursor: str | None = None,
    ) -> Page[T]:
        total_pages = max(1, math.ceil(total / params.page_size)) if total else 1
        return cls(
            items=items,
            total=total,
            page=params.page,
            page_size=params.page_size,
            total_pages=total_pages,
            has_more=params.page < total_pages,
            next_cursor=next_cursor,
        )


# ---------------------------------------------------------------------------
# Keyset pagination, for the meals timeline only.
#
# The meals screen is an infinite scroll over a date axis, where offset paging
# drifts if a row is inserted mid-scroll. That endpoint additionally accepts a
# cursor - but still returns the same Page[T] envelope, so the contract stays
# uniform across the whole API.
# ---------------------------------------------------------------------------


def encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> dict[str, Any]:
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        decoded = json.loads(base64.urlsafe_b64decode(padded))
        return cast(dict[str, Any], decoded) if isinstance(decoded, dict) else {}
    except Exception:
        return {}
