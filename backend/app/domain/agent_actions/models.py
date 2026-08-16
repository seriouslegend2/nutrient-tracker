"""Public models for durable agent actions."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

JsonObject = dict[str, JsonValue]
ActionType = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]{0,99}$")]
IdempotencyKey = Annotated[str, Field(min_length=1, max_length=200)]


class AgentActionStatus(StrEnum):
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    DISCARDED = "discarded"


class AgentActionCreate(BaseModel):
    """Immutable proposal supplied by an agent integration."""

    model_config = ConfigDict(extra="forbid")

    action_type: ActionType
    arguments: JsonObject
    summary: str = Field(min_length=1, max_length=500)
    idempotency_key: IdempotencyKey
    expires_at: datetime


class AgentAction(BaseModel):
    """Public action state. Execution fencing tokens are intentionally hidden."""

    model_config = ConfigDict(extra="ignore")

    id: UUID
    user_id: UUID
    action_type: ActionType
    arguments: JsonObject = Field(exclude=True)
    summary: str
    idempotency_key: IdempotencyKey = Field(exclude=True)
    status: AgentActionStatus
    expires_at: datetime
    confirmed_at: datetime | None = None
    execution_started_at: datetime | None = None
    execution_lease_expires_at: datetime | None = None
    execution_attempt: int = 0
    completed_at: datetime | None = None
    failed_at: datetime | None = None
    discarded_at: datetime | None = None
    result: JsonObject | None = None
    error: JsonObject | None = None
    created_at: datetime
    updated_at: datetime


class ActionClaim(BaseModel):
    """Internal claim response; never expose the token through the API."""

    claimed: bool
    claim_token: UUID | None = None
    action: AgentAction


class AgentActionPublic(BaseModel):
    """Customer-safe lifecycle state used by APIs and message cards."""

    model_config = ConfigDict(extra="ignore")

    id: UUID
    action_type: ActionType
    summary: str
    status: AgentActionStatus
    expires_at: datetime
    confirmed_at: datetime | None = None
    execution_started_at: datetime | None = None
    completed_at: datetime | None = None
    result: JsonObject | None = None
    error: JsonObject | None = None
    created_at: datetime
    updated_at: datetime


def public_action(action: AgentAction) -> AgentActionPublic:
    error = None
    if action.error:
        code = str(action.error.get("code") or "EXECUTION_FAILED")
        error = {
            "code": code,
            "message": (
                "The operation was interrupted. Check your records before trying again."
                if code == "EXECUTION_INTERRUPTED"
                else "This change could not be applied."
            ),
        }
    return AgentActionPublic(
        id=action.id,
        action_type=action.action_type,
        summary=action.summary,
        status=action.status,
        expires_at=action.expires_at,
        confirmed_at=action.confirmed_at,
        execution_started_at=action.execution_started_at,
        completed_at=action.completed_at,
        result=action.result,
        error=error,
        created_at=action.created_at,
        updated_at=action.updated_at,
    )
