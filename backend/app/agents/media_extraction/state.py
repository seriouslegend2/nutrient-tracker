"""State schema for multimodal extraction."""

from __future__ import annotations

from typing import Any, NotRequired

from langchain.agents import AgentState


class MediaExtractionState(AgentState):
    mime_type: NotRequired[str]
    data_b64: NotRequired[str]
    user_text: NotRequired[str]
    filename: NotRequired[str]
    samples: NotRequired[int]
    structured_response: NotRequired[dict[str, Any]]
