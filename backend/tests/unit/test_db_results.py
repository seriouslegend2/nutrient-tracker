from __future__ import annotations

import pytest

from app.services.db_results import as_row, as_rows


def test_database_rows_are_validated_at_the_boundary() -> None:
    row = {"id": "one"}
    assert as_row(row) is row
    assert as_rows([row]) == [row]
    assert as_rows(None) == []


@pytest.mark.parametrize("value", ["row", ["row"], {"id": "not-a-list"}])
def test_invalid_database_rows_fail_closed(value: object) -> None:
    with pytest.raises(RuntimeError):
        as_rows(value)
