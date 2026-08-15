"""nutrition_chat's custom state.

Extends the base agent state with the fields UserContextMiddleware writes and
prompt.py reads. Field names here are the contract between middleware.py and
prompt.py - they must match exactly.
"""

from __future__ import annotations

from typing import Any, NotRequired

from langchain.agents import AgentState


class NutritionChatState(AgentState):
    user_id: NotRequired[str]
    user_profile: NotRequired[str]
    active_goal: NotRequired[str]
    preferences: NotRequired[str]
    extraction_payload: NotRequired[dict[str, Any]]
    """Set when the turn started from a photo/video/pdf message - carries the
    mass-distribution or diary-row draft so the model can reference it."""
