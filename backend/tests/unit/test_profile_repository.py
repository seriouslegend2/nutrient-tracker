from __future__ import annotations

from datetime import date
from typing import Any

from app.domain.profile import repository


class _Query:
    def __init__(self) -> None:
        self.data = [{"user_id": "user-1"}]

    async def execute(self) -> _Query:
        return self


class _Table:
    def __init__(self, client: _Client) -> None:
        self.client = client

    def upsert(self, payload: dict[str, Any], **_kwargs: Any) -> _Query:
        self.client.payload = payload
        return _Query()


class _Client:
    payload: dict[str, Any] | None = None

    def table(self, _name: str) -> _Table:
        return _Table(self)


async def test_upsert_profile_serialises_dates(monkeypatch) -> None:
    client = _Client()

    async def fake_get_supabase() -> _Client:
        return client

    async def fake_get_profile(_user_id: str) -> None:
        return None

    monkeypatch.setattr(repository, "get_supabase", fake_get_supabase)
    monkeypatch.setattr(repository, "get_profile", fake_get_profile)

    await repository.upsert_profile(
        "user-1", {"birth_date": date(1990, 1, 2), "display_name": "Test"}
    )

    assert client.payload == {
        "birth_date": "1990-01-02",
        "display_name": "Test",
        "user_id": "user-1",
    }
