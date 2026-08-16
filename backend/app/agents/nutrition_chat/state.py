"""nutrition_chat's custom state.

Extends the base agent state with the fields UserContextMiddleware writes and
prompt.py reads. Field names here are the contract between middleware.py and
prompt.py - they must match exactly.
"""

from __future__ import annotations

from typing import NotRequired

from langchain.agents import AgentState


class NutritionChatState(AgentState):
    user_id: NotRequired[str]
    clock: NotRequired[str]
    profile: NotRequired[str]
    preferences: NotRequired[str]
    portion_categories: NotRequired[str]
    today_date: NotRequired[str]
    today_meals: NotRequired[str]
    today_totals: NotRequired[str]
    today_unaccounted_meal_items: NotRequired[str]
    today_water: NotRequired[str]
    today_training_checked_in: NotRequired[str]
    latest_body_metric: NotRequired[str]
    active_goals: NotRequired[str]
    pending_media_draft: NotRequired[str]
    """Set when the turn started from a photo/video/pdf message - carries the
    mass-distribution or diary-row draft so the model can reference it."""
