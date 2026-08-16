"""State owned exclusively by the media meal resolver."""

from __future__ import annotations

from typing import NotRequired

from langchain.agents import AgentState

from app.agents.media_meal_resolver.models import MediaResolutionPlan


class MediaMealResolverState(AgentState):
    resolver_input: NotRequired[str]
    structured_response: NotRequired[MediaResolutionPlan]
