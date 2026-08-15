"""Persistence needed while resolving an authenticated application identity."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.db_results import as_rows
from app.services.supabase import get_supabase


@dataclass(frozen=True, slots=True)
class IdentityRecord:
    email: str | None
    roles: list[str]


async def load_identity(user_id: str) -> IdentityRecord:
    """Ensure the application user exists and load trusted database roles."""
    sb = await get_supabase()
    user_result = await sb.table("app_users").upsert({"id": user_id}, on_conflict="id").execute()
    await (
        sb.table("user_roles")
        .upsert(
            {"user_id": user_id, "role": "customer"},
            on_conflict="user_id,role",
            ignore_duplicates=True,
        )
        .execute()
    )
    role_result = await sb.table("user_roles").select("role").eq("user_id", user_id).execute()

    users = as_rows(user_result.data)
    roles = [role for row in as_rows(role_result.data) if isinstance(role := row.get("role"), str)]
    email = users[0].get("email") if users else None
    return IdentityRecord(email=email if isinstance(email, str) else None, roles=roles)
