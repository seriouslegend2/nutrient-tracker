"""Prompt and model middleware for the manual meal resolver only."""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from app.agents.manual_meal_resolver.prompt import (
    MANUAL_MEAL_RESOLVER_PROMPT,
    MANUAL_MEAL_RESOLVER_PROMPT_NAME,
    MANUAL_MEAL_RESOLVER_USER_PROMPT,
)
from app.config.settings import settings
from app.services.prompts import ResolvedPrompt, resolve_prompt

_PROMPT_FIELDS = (
    "meal_id",
    "dish_name",
    "servings",
    "global_dishes",
    "global_categories",
    "household_portions",
)


def render_manual_user_prompt(template: str, state: dict[str, Any]) -> str:
    rendered = template
    for name in _PROMPT_FIELDS:
        value = state.get(name)
        if not isinstance(value, str):
            raise ValueError(f"Manual resolver state is missing prompt field: {name}")
        rendered = rendered.replace(f"{{{name}}}", value)
    return rendered


class ManualResolverPromptMiddleware(AgentMiddleware):
    """Resolve and render the versioned chat prompt before every model call."""

    def __init__(self) -> None:
        super().__init__()
        self.resolved_prompt: ResolvedPrompt | None = None

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        state = dict(request.state or {})
        prompt = await resolve_prompt(
            MANUAL_MEAL_RESOLVER_PROMPT_NAME,
            MANUAL_MEAL_RESOLVER_PROMPT,
            fallback_user_template=MANUAL_MEAL_RESOLVER_USER_PROMPT,
        )
        self.resolved_prompt = prompt
        user_message = render_manual_user_prompt(
            prompt.user_template or MANUAL_MEAL_RESOLVER_USER_PROMPT,
            state,
        )
        messages = list(request.messages or [])
        if messages:
            messages[0] = HumanMessage(content=user_message)
        else:
            messages = [HumanMessage(content=user_message)]
        updated = request.override(
            system_message=SystemMessage(content=prompt.text),
            messages=messages,
        )
        return await handler(updated)

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        raise RuntimeError("manual_meal_resolver: sync invocation is not supported")


def resolve_manual_resolver_model() -> BaseChatModel:
    return init_chat_model(
        f"openai:{settings.MANUAL_RESOLVER_MODEL}",
        api_key=settings.OPENAI_API_KEY,
    )
