"""Shared server-side Supabase service-role client."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import httpx
from supabase import AsyncClient, acreate_client
from supabase.lib.client_options import AsyncClientOptions

from app.config.settings import settings
from app.utils.logger import logger

_client: AsyncClient | None = None
_http_client: httpx.AsyncClient | None = None


async def start_supabase_pool() -> None:
    """Create one immutable service-role client for the API process."""
    global _client, _http_client
    if _client is not None:
        return
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured")
    _http_client = httpx.AsyncClient(timeout=60, verify=True)
    _client = await acreate_client(
        settings.SUPABASE_URL,
        settings.SUPABASE_SERVICE_ROLE_KEY,
        options=AsyncClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            httpx_client=_http_client,
        ),
    )


async def stop_supabase_pool() -> None:
    global _client, _http_client
    if _http_client is not None:
        await _http_client.aclose()
    _client = None
    _http_client = None


async def get_supabase() -> AsyncClient:
    """Return the shared service-role client, creating it lazily if needed."""
    if _client is None:
        await start_supabase_pool()
    assert _client is not None
    return _client


def _serialise(value: Any) -> Any:
    """PostgREST speaks JSON; UUIDs, dates and Decimals do not serialise natively."""
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _serialise(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialise(v) for v in value]
    return value


async def call_rpc(
    function_name: str,
    params: dict[str, Any] | None = None,
    *,
    schema: str | None = None,
) -> Any:
    client = await get_supabase()
    payload = {k: _serialise(v) for k, v in (params or {}).items()}
    try:
        builder = client.schema(schema) if schema else client
        result = await builder.rpc(function_name, payload).execute()
        return result.data
    except Exception:
        logger.exception("rpc_failed function={} params={}", function_name, list(payload.keys()))
        raise
