from __future__ import annotations

from typing import Any

import pytest

from app.services import supabase as supabase_service


async def test_shared_client_uses_service_role_key(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_create(url: str, key: str, *, options):
        client = object()
        calls.append({"url": url, "key": key, "options": options, "client": client})
        return client

    monkeypatch.setattr(supabase_service, "acreate_client", fake_create)
    await supabase_service.stop_supabase_pool()
    await supabase_service.start_supabase_pool()
    try:
        first = await supabase_service.get_supabase()
        second = await supabase_service.get_supabase()
        assert first is second is calls[0]["client"]
        assert len(calls) == 1
        assert calls[0]["key"] == supabase_service.settings.SUPABASE_SERVICE_ROLE_KEY
        assert calls[0]["options"].auto_refresh_token is False
        assert calls[0]["options"].persist_session is False
    finally:
        await supabase_service.stop_supabase_pool()


async def test_missing_service_role_configuration_is_rejected(monkeypatch) -> None:
    await supabase_service.stop_supabase_pool()
    monkeypatch.setattr(supabase_service.settings, "SUPABASE_SERVICE_ROLE_KEY", "")
    with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY"):
        await supabase_service.start_supabase_pool()
