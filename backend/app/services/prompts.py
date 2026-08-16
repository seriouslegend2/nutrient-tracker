"""LangSmith prompt resolution with checked-in, always-available fallbacks."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
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
    chat_template: ChatPromptTemplate | None = None

    def format_messages(
        self,
        *,
        conversation: Sequence[Any] | None = None,
        current_user_input: str | None = None,
        **variables: Any,
    ) -> list[BaseMessage]:
        """Format a retained chat prompt without promoting context data to instructions."""
        if self.chat_template is None:
            raise ValueError(f"Prompt {self.name!r} is not a chat prompt")

        values = dict(variables)
        system_variables = _system_input_variables(self.chat_template)
        unsafe_system_variables = system_variables.intersection(values)
        if unsafe_system_variables:
            names = ", ".join(sorted(unsafe_system_variables))
            raise ValueError(f"Chat prompt places dynamic data in its system message: {names}")
        if conversation is not None:
            if isinstance(conversation, (str, bytes)):
                raise TypeError("conversation must be a sequence of chat messages")
            if not _has_messages_placeholder(self.chat_template, "conversation"):
                raise ValueError("Chat prompt has no conversation messages placeholder")
            if "conversation" in values:
                raise ValueError("conversation was supplied more than once")
            values["conversation"] = list(conversation)
        if current_user_input is not None:
            if "current_user_input" in system_variables:
                raise ValueError("Chat prompt places current_user_input in a system message")
            if "current_user_input" in values:
                raise ValueError("current_user_input was supplied more than once")
            values["current_user_input"] = current_user_input
        return self.chat_template.format_messages(**values)


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


def _system_input_variables(template: ChatPromptTemplate) -> set[str]:
    variables: set[str] = set()
    for message in template.messages:
        if type(message).__name__ == "SystemMessagePromptTemplate":
            variables.update(message.input_variables)
    return variables


def _has_messages_placeholder(template: ChatPromptTemplate, variable_name: str) -> bool:
    return any(
        isinstance(message, MessagesPlaceholder) and message.variable_name == variable_name
        for message in template.messages
    )


def _chat_template_signature(template: ChatPromptTemplate) -> tuple[Any, ...]:
    signature = []
    for message in template.messages:
        if isinstance(message, MessagesPlaceholder):
            signature.append(("messages", message.variable_name, message.optional))
        else:
            signature.append((type(message).__name__, tuple(sorted(message.input_variables))))
    return tuple(signature)


def _fallback_chat_template(
    fallback: str | ChatPromptTemplate,
    fallback_user_template: str | None,
    fallback_chat_template: ChatPromptTemplate | None,
) -> ChatPromptTemplate | None:
    if fallback_chat_template is not None:
        return fallback_chat_template
    if isinstance(fallback, ChatPromptTemplate):
        return fallback
    if fallback_user_template is None:
        return None
    return ChatPromptTemplate.from_messages(
        [("system", fallback), ("user", fallback_user_template)]
    )


def _resolved_from_template(
    *,
    name: str,
    template: ChatPromptTemplate,
    source: str,
    version: str | None = None,
) -> ResolvedPrompt:
    system_template = _chat_message_template(template, "SystemMessagePromptTemplate")
    if system_template is None:
        raise ValueError("Chat prompt has no non-empty system message")
    return ResolvedPrompt(
        name=name,
        text=system_template,
        source=source,
        version=version,
        user_template=_chat_message_template(template, "HumanMessagePromptTemplate"),
        chat_template=template,
    )


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
    name: str,
    fallback: str | ChatPromptTemplate,
    *,
    fallback_user_template: str | None = None,
    fallback_chat_template: ChatPromptTemplate | None = None,
) -> ResolvedPrompt:
    """Pull one prompt without ever making LangSmith a runtime dependency."""
    fallback_template = _fallback_chat_template(
        fallback, fallback_user_template, fallback_chat_template
    )
    cached = _PROMPT_CACHE.get(name)
    if cached and time.monotonic() - cached[1] < _CACHE_TTL_SECONDS:
        cached_prompt = cached[0]
        if fallback_template is None or (
            cached_prompt.chat_template is not None
            and _chat_template_signature(cached_prompt.chat_template)
            == _chat_template_signature(fallback_template)
        ):
            return cached_prompt

    client = langsmith_client()
    if client is None:
        if fallback_template is not None:
            return _resolved_from_template(name=name, template=fallback_template, source="code")
        assert isinstance(fallback, str)
        return ResolvedPrompt(
            name=name, text=fallback, source="code", user_template=fallback_user_template
        )

    try:
        template = await asyncio.to_thread(
            client.pull_prompt,
            name,
            include_model=False,
        )
        if fallback_template is not None:
            if not isinstance(template, ChatPromptTemplate):
                raise ValueError("LangSmith prompt is not a ChatPromptTemplate")
            if _chat_template_signature(template) != _chat_template_signature(fallback_template):
                raise ValueError("LangSmith chat prompt structure is incompatible with fallback")
            resolved = _resolved_from_template(
                name=name,
                template=template,
                source="langsmith",
                version=_template_version(template),
            )
            _PROMPT_CACHE[name] = (resolved, time.monotonic())
            return resolved

        text = _template_text(template)
        if not text:
            raise ValueError("LangSmith prompt has no string template")
        chat_template = template if isinstance(template, ChatPromptTemplate) else None
        resolved = ResolvedPrompt(
            name=name,
            text=text,
            source="langsmith",
            version=_template_version(template),
            user_template=_chat_message_template(template, "HumanMessagePromptTemplate"),
            chat_template=chat_template,
        )
        _PROMPT_CACHE[name] = (resolved, time.monotonic())
        return resolved
    except Exception as exc:
        logger.warning("langsmith_pull_failed prompt={} error={}", name, str(exc))
        if fallback_template is not None:
            return _resolved_from_template(name=name, template=fallback_template, source="code")
        assert isinstance(fallback, str)
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
