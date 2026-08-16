"""State owned exclusively by the manual meal resolver."""

from __future__ import annotations

from typing import NotRequired

from langchain.agents import AgentState

from app.agents.manual_meal_resolver.models import ManualResolution


class ManualMealResolverState(AgentState):
    meal_id: NotRequired[str]
    dish_name: NotRequired[str]
    servings: NotRequired[str]
    global_dishes: NotRequired[str]
    global_categories: NotRequired[str]
    household_portions: NotRequired[str]
    structured_response: NotRequired[ManualResolution]
