"""State and typed runtime context for media_facts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import NotRequired, TypedDict

from app.agents.media_facts.models import MediaFactsAgentOutput


@dataclass(frozen=True)
class MediaFactsRuntimeContext:
    user_id: str
    thread_id: str | None = None


class MediaFactsState(TypedDict):
    mime_type: str
    data_b64: str
    filename: str
    user_note: str
    structured_response: NotRequired[MediaFactsAgentOutput]
