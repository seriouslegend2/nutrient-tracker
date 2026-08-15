"""Typed validation at the PostgREST JSON boundary."""

from __future__ import annotations

from typing import Any, cast

type Row = dict[str, Any]


def as_row(value: object) -> Row:
    if not isinstance(value, dict):
        raise RuntimeError("Database response did not contain an object")
    return cast(Row, value)


def as_rows(value: object) -> list[Row]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise RuntimeError("Database response did not contain a list of objects")
    return cast(list[Row], value)
