"""Persistence boundary for durable agent actions."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.domain.agent_actions.models import ActionClaim, JsonObject
from app.services.supabase import call_rpc


class AgentActionRepository(Protocol):
    """Allows a SQL-native atomic execution repository to replace this adapter."""

    async def create(
        self,
        *,
        user_id: str,
        action_type: str,
        arguments: JsonObject,
        summary: str,
        idempotency_key: str,
        expires_at: datetime,
    ) -> dict[str, Any]: ...

    async def get(self, *, user_id: str, action_id: UUID) -> dict[str, Any]: ...

    async def confirm(self, *, user_id: str, action_id: UUID) -> dict[str, Any]: ...

    async def discard(self, *, user_id: str, action_id: UUID) -> dict[str, Any]: ...

    async def claim(self, *, user_id: str, action_id: UUID, lease_seconds: int) -> ActionClaim: ...

    async def complete(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        result: JsonObject,
    ) -> dict[str, Any]: ...

    async def fail(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        error: JsonObject,
    ) -> dict[str, Any]: ...

    async def execute_meal_action(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        prepared: JsonObject,
    ) -> dict[str, Any]: ...


def _one(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    if isinstance(value, dict):
        return value
    raise RuntimeError("Agent action RPC returned no row")


async def _action_rpc(function_name: str, params: dict[str, Any]) -> Any:
    try:
        return await call_rpc(function_name, params)
    except Exception as exc:
        code = str(getattr(exc, "code", ""))
        hint = str(getattr(exc, "hint", ""))
        detail = f"{code} {hint} {exc}"
        if code == "PT404" or "agent_action_not_found" in detail:
            raise NotFoundError("Agent action not found.", code="AGENT_ACTION_NOT_FOUND") from exc
        if code == "PT409" or ("agent_action_" in hint and "conflict" in hint):
            raise ConflictError(
                "Agent action state conflict.", code="AGENT_ACTION_CONFLICT"
            ) from exc
        if code == "22023":
            raise ValidationError(
                "Agent action request is invalid.", code="AGENT_ACTION_INVALID"
            ) from exc
        raise


class SupabaseAgentActionRepository:
    async def create(
        self,
        *,
        user_id: str,
        action_type: str,
        arguments: JsonObject,
        summary: str,
        idempotency_key: str,
        expires_at: datetime,
    ) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_create_agent_action",
                {
                    "p_user_id": user_id,
                    "p_action_type": action_type,
                    "p_arguments": arguments,
                    "p_summary": summary,
                    "p_idempotency_key": idempotency_key,
                    "p_expires_at": expires_at,
                },
            )
        )

    async def get(self, *, user_id: str, action_id: UUID) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_get_agent_action", {"p_user_id": user_id, "p_action_id": action_id}
            )
        )

    async def confirm(self, *, user_id: str, action_id: UUID) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_confirm_agent_action", {"p_user_id": user_id, "p_action_id": action_id}
            )
        )

    async def discard(self, *, user_id: str, action_id: UUID) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_discard_agent_action", {"p_user_id": user_id, "p_action_id": action_id}
            )
        )

    async def claim(self, *, user_id: str, action_id: UUID, lease_seconds: int) -> ActionClaim:
        value = await _action_rpc(
            "fn_claim_agent_action",
            {
                "p_user_id": user_id,
                "p_action_id": action_id,
                "p_lease_seconds": lease_seconds,
            },
        )
        return ActionClaim.model_validate(value)

    async def complete(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        result: JsonObject,
    ) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_complete_agent_action",
                {
                    "p_user_id": user_id,
                    "p_action_id": action_id,
                    "p_execution_token": claim_token,
                    "p_result": result,
                },
            )
        )

    async def fail(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        error: JsonObject,
    ) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_fail_agent_action",
                {
                    "p_user_id": user_id,
                    "p_action_id": action_id,
                    "p_execution_token": claim_token,
                    "p_error": error,
                },
            )
        )

    async def execute_meal_action(
        self,
        *,
        user_id: str,
        action_id: UUID,
        claim_token: UUID,
        prepared: JsonObject,
    ) -> dict[str, Any]:
        return _one(
            await _action_rpc(
                "fn_execute_meal_agent_action",
                {
                    "p_user_id": user_id,
                    "p_action_id": action_id,
                    "p_execution_token": claim_token,
                    "p_prepared": prepared,
                },
            )
        )


repository = SupabaseAgentActionRepository()
