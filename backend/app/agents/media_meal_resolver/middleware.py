"""Prompt and model middleware for media_meal_resolver."""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from app.agents.media_meal_resolver.prompt import (
    MEDIA_MEAL_RESOLVER_PROMPT,
    MEDIA_MEAL_RESOLVER_PROMPT_NAME,
    MEDIA_MEAL_RESOLVER_USER_PROMPT,
)
from app.config.settings import settings
from app.services.prompts import ResolvedPrompt, resolve_prompt


class MediaResolverPromptMiddleware(AgentMiddleware):
    """Resolve and render the versioned chat prompt before every model call."""

    def __init__(self) -> None:
        super().__init__()
        self.resolved_prompt: ResolvedPrompt | None = None

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        resolver_input = (request.state or {}).get("resolver_input")
        if not isinstance(resolver_input, str):
            raise ValueError("Media resolver state is missing resolver_input")
        prompt = await resolve_prompt(
            MEDIA_MEAL_RESOLVER_PROMPT_NAME,
            MEDIA_MEAL_RESOLVER_PROMPT,
            fallback_user_template=MEDIA_MEAL_RESOLVER_USER_PROMPT,
        )
        self.resolved_prompt = prompt
        user_message = (prompt.user_template or MEDIA_MEAL_RESOLVER_USER_PROMPT).replace(
            "{resolver_input}", resolver_input
        )
        messages = list(request.messages or [])
        if messages:
            messages[0] = HumanMessage(content=user_message)
        else:
            messages = [HumanMessage(content=user_message)]
        return await handler(
            request.override(
                system_message=SystemMessage(content=prompt.text),
                messages=messages,
            )
        )

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        raise RuntimeError("media_meal_resolver: sync invocation is not supported")


def resolve_media_resolver_model() -> BaseChatModel:
    return init_chat_model(
        f"openai:{settings.MEDIA_MEAL_RESOLVER_MODEL}",
        api_key=settings.OPENAI_API_KEY,
    )
