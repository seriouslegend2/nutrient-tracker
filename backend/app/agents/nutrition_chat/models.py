"""nutrition_chat's structured output model."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolCallSummary(BaseModel):
    tool: str
    status: Literal["OK", "ERROR"]
    detail: dict[str, Any] = Field(default_factory=dict)


class ChatResponse(BaseModel):
    """The only model-authored output; execution state is server-derived."""

    reply: str = Field(..., description="What to say back to the user")


class ChatTurn(BaseModel):
    """One normalized turn with authoritative server-derived execution state."""

    reply: str
    tool_calls: list[ToolCallSummary] = Field(default_factory=list)
    needs_confirmation: bool = Field(
        False, description="True if a mutation is proposed but not yet applied"
    )
    agent_actions: list[dict[str, Any]] = Field(default_factory=list, exclude=True)
