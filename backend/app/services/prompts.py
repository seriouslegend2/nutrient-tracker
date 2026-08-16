"""LangSmith prompt resolution with checked-in, always-available fallbacks."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from langsmith import Client, trace, tracing_context

from app.config.settings import settings
from app.utils.logger import logger

_CACHE_TTL_SECONDS = 60.0


@dataclass(frozen=True)
class ResolvedPrompt:
    name: str
    text: str
    source: str
    version: str | None = None
    user_template: str | None = None


_PROMPT_CACHE: dict[str, tuple[ResolvedPrompt, float]] = {}


def langsmith_client() -> Client | None:
    if not settings.LANGSMITH_API_KEY:
        return None
    return Client(
        api_url=settings.LANGSMITH_ENDPOINT,
        api_key=settings.LANGSMITH_API_KEY,
        workspace_id=settings.LANGSMITH_WORKSPACE_ID or None,
    )


def _template_text(template: Any) -> str | None:
    if isinstance(template, str):
        return template.strip() or None
    text = getattr(template, "template", None)
    if not isinstance(text, str):
        text = _chat_message_template(template, "SystemMessagePromptTemplate")
    if not isinstance(text, str) or not text.strip():
        return None
    metadata = getattr(template, "metadata", None)
    if isinstance(metadata, dict) and metadata.get("nutrient_tracker_literal_braces"):
        text = text.replace("{{", "{").replace("}}", "}")
    return text.strip()


def _chat_message_template(template: Any, message_type: str) -> str | None:
    for message in getattr(template, "messages", []) or []:
        if type(message).__name__ != message_type:
            continue
        text = getattr(getattr(message, "prompt", None), "template", None)
        if isinstance(text, str) and text.strip():
            return text.strip()
    return None


def _template_version(template: Any) -> str | None:
    metadata = getattr(template, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    for key in ("lc_hub_commit_hash", "commit_hash", "version"):
        value = metadata.get(key)
        if value:
            return str(value)
    return None


async def resolve_prompt(
    name: str, fallback: str, *, fallback_user_template: str | None = None
) -> ResolvedPrompt:
    """Pull one prompt without ever making LangSmith a runtime dependency."""
    cached = _PROMPT_CACHE.get(name)
    if cached and time.monotonic() - cached[1] < _CACHE_TTL_SECONDS:
        return cached[0]

    client = langsmith_client()
    if client is None:
        return ResolvedPrompt(
            name=name, text=fallback, source="code", user_template=fallback_user_template
        )

    try:
        template = await asyncio.to_thread(
            client.pull_prompt,
            name,
            include_model=False,
        )
        text = _template_text(template)
        if not text:
            raise ValueError("LangSmith prompt has no string template")
        resolved = ResolvedPrompt(
            name=name,
            text=text,
            source="langsmith",
            version=_template_version(template),
            user_template=_chat_message_template(template, "HumanMessagePromptTemplate"),
        )
        _PROMPT_CACHE[name] = (resolved, time.monotonic())
        return resolved
    except Exception as exc:
        logger.warning("langsmith_pull_failed prompt={} error={}", name, str(exc))
        return ResolvedPrompt(
            name=name, text=fallback, source="code", user_template=fallback_user_template
        )


def clear_prompt_cache() -> None:
    """Test and deployment hook for immediately observing a new prompt commit."""
    _PROMPT_CACHE.clear()


@contextmanager
def trace_agent(
    agent_name: str,
    metadata: dict[str, Any] | None = None,
    inputs: dict[str, Any] | None = None,
) -> Iterator[Any | None]:
    """Trace agent executions into the configured project without env mutation."""
    client = langsmith_client()
    if client is None or not settings.LANGSMITH_TRACING:
        yield
        return
    with (
        tracing_context(
            enabled=True,
            project_name=settings.LANGSMITH_PROJECT,
            tags=[agent_name],
            metadata={"agent_name": agent_name, **(metadata or {})},
            client=client,
        ),
        trace(
            agent_name,
            run_type="chain",
            inputs=inputs,
            project_name=settings.LANGSMITH_PROJECT,
            tags=[agent_name],
            metadata={"agent_name": agent_name, **(metadata or {})},
            client=client,
        ) as run,
    ):
        yield run
