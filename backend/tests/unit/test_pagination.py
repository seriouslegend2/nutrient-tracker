"""Page.build boundaries. Pure, no I/O."""

from types import SimpleNamespace

import pytest

from app.core.pagination import Page, PaginationParams, decode_cursor, encode_cursor
from app.domain.meals import repository


@pytest.mark.unit
def test_offset_is_zero_indexed_from_page_one():
    assert PaginationParams(page=1, page_size=50).offset == 0
    assert PaginationParams(page=2, page_size=50).offset == 50
    assert PaginationParams(page=3, page_size=20).offset == 40


@pytest.mark.unit
def test_total_pages_rounds_up():
    p = PaginationParams(page=1, page_size=10)
    assert Page.build([], 0, p).total_pages == 1  # empty is still one page
    assert Page.build([1], 1, p).total_pages == 1
    assert Page.build([1], 10, p).total_pages == 1
    assert Page.build([1], 11, p).total_pages == 2  # the boundary that matters
    assert Page.build([1], 100, p).total_pages == 10


@pytest.mark.unit
def test_has_more_is_false_on_the_last_page():
    assert Page.build([1], 25, PaginationParams(page=1, page_size=10)).has_more is True
    assert Page.build([1], 25, PaginationParams(page=3, page_size=10)).has_more is False


@pytest.mark.unit
def test_cursor_round_trips_and_a_bad_cursor_does_not_crash():
    payload = {"meal_date": "2026-08-15", "id": "abc"}
    assert decode_cursor(encode_cursor(payload)) == payload
    assert decode_cursor("not-a-cursor") == {}  # client error, not a 500


@pytest.mark.unit
async def test_meal_cursor_uses_date_and_id_tie_breaker(monkeypatch):
    class Query:
        def __init__(self):
            self.filters = []
            self.orders = []

        def select(self, *args, **kwargs):
            return self

        def eq(self, *args):
            return self

        def or_(self, value):
            self.filters.append(value)
            return self

        def order(self, field, *, desc=False):
            self.orders.append((field, desc))
            return self

        def range(self, *args):
            return self

        async def execute(self):
            return SimpleNamespace(data=[], count=0)

    query = Query()
    client = SimpleNamespace(table=lambda _name: query)

    async def fake_supabase():
        return client

    monkeypatch.setattr(repository, "get_supabase", fake_supabase)
    await repository.list_meals(
        user_id="user",
        cursor={"meal_date": "2026-08-15", "id": "00000000-0000-0000-0000-000000000010"},
    )

    assert query.filters == [
        "meal_date.lt.2026-08-15,and(meal_date.eq.2026-08-15,"
        "id.lt.00000000-0000-0000-0000-000000000010)"
    ]
    assert query.orders == [("meal_date", True), ("id", True)]
