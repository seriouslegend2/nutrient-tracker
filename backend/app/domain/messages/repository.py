"""User-scoped persistence for chat messages."""

from __future__ import annotations

from typing import Any

from app.services.supabase import get_supabase


async def create_message(row: dict[str, Any]) -> dict[str, Any]:
    sb = await get_supabase()
    res = await sb.table("communication_master").insert(row).execute()
    return res.data[0]


async def create_agent_run(row: dict[str, Any]) -> dict[str, Any]:
    sb = await get_supabase()
    res = await sb.table("agent_runs").insert(row).execute()
    return res.data[0]


async def create_audit_record(row: dict[str, Any]) -> dict[str, Any]:
    sb = await get_supabase()
    res = await sb.table("audit_log").insert(row).execute()
    return res.data[0]


async def update_message(
    *, user_id: str, message_id: str, patch: dict[str, Any]
) -> dict[str, Any] | None:
    sb = await get_supabase()
    res = (
        await sb.table("communication_master")
        .update(patch)
        .eq("id", message_id)
        .eq("user_id", user_id)
        .execute()
    )
    return (res.data or [None])[0]


async def get_message(user_id: str, message_id: str) -> dict[str, Any] | None:
    sb = await get_supabase()
    res = (
        await sb.table("communication_master")
        .select("*")
        .eq("id", message_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return (res.data or [None])[0]


async def list_messages(
    *, user_id: str, offset: int, limit: int, thread_id: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    sb = await get_supabase()
    query = sb.table("communication_master").select("*", count="exact").eq("user_id", user_id)
    if thread_id:
        query = query.eq("thread_id", thread_id)
    res = await query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    return res.data or [], res.count or 0


async def list_thread_messages(
    *, user_id: str, thread_id: str, limit: int = 30
) -> list[dict[str, Any]]:
    sb = await get_supabase()
    res = (
        await sb.table("communication_master")
        .select("*")
        .eq("user_id", user_id)
        .eq("thread_id", thread_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return list(reversed(res.data or []))
