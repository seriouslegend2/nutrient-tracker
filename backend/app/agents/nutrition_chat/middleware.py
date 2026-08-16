"""Model, prompt, and typed user-context middleware for nutrition chat."""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate

from app.agents.nutrition_chat.context import build_nutrition_context_snapshot
from app.config.settings import settings
from app.services.prompts import resolve_prompt
from app.utils.logger import logger


class ModelAndPromptMiddleware(AgentMiddleware):
    """ALWAYS FIRST in the middleware list. Resolves the LLM and system prompt."""

    def __init__(
        self, *, langsmith_prompt_name: str, fallback_prompt: str | ChatPromptTemplate
    ) -> None:
        super().__init__()  # ALWAYS call super
        self.langsmith_prompt_name = langsmith_prompt_name
        self.fallback_prompt = fallback_prompt

    def before_agent(self, state: dict, runtime: Any) -> dict | None:
        # Prompt loading happens in awrap_model_call for concurrency safety.
        return None

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        prompt = await resolve_prompt(self.langsmith_prompt_name, self.fallback_prompt)
        logger.info(
            "prompt_resolved agent=nutrition_chat source={} version={}",
            prompt.source,
            prompt.version or "fallback",
        )
        state = dict(request.state or {})
        request_messages = list(request.messages)
        current_index = next(
            (
                index
                for index in range(len(request_messages) - 1, -1, -1)
                if isinstance(request_messages[index], HumanMessage)
            ),
            None,
        )
        if current_index is None:
            raise RuntimeError("Nutrition chat request has no current user message")
        conversation = request_messages[:current_index]
        current_user = request_messages[current_index]
        trailing_messages = request_messages[current_index + 1 :]
        formatted = prompt.format_messages(
            clock=state.get("clock", "null"),
            profile=state.get("profile", "null"),
            preferences=state.get("preferences", "[]"),
            portion_categories=state.get("portion_categories", "[]"),
            today_date=state.get("today_date", "null"),
            today_meals=state.get("today_meals", "[]"),
            today_totals=state.get("today_totals", "{}"),
            today_unaccounted_meal_items=state.get("today_unaccounted_meal_items", "0"),
            today_water=state.get("today_water", "{}"),
            today_training_checked_in=state.get("today_training_checked_in", "false"),
            latest_body_metric=state.get("latest_body_metric", "null"),
            active_goals=state.get("active_goals", "[]"),
            pending_media_draft=state.get("pending_media_draft", "null"),
            conversation=conversation,
            current_user_input=str(current_user.content),
        )
        system = next(
            (message for message in formatted if isinstance(message, SystemMessage)), None
        )
        if system is None:
            raise RuntimeError("Nutrition chat prompt did not produce a system message")
        messages = [
            *(message for message in formatted if not isinstance(message, SystemMessage)),
            *trailing_messages,
        ]
        updated_request = request.override(
            system_message=system,
            messages=messages,
        )
        return await handler(updated_request)

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        # Sync path is dead in this stack - every agent is invoked with
        # ainvoke/astream only.
        raise RuntimeError("nutrition_chat: sync invocation is not supported.")


def resolve_model() -> BaseChatModel:
    """Initialize the dedicated high-capability orchestration model."""
    return init_chat_model(
        f"openai:{settings.ORCHESTRATION_MODEL}",
        api_key=settings.OPENAI_API_KEY,
        use_responses_api=True,
    )


def _user_id(state: dict, runtime: Any) -> str | None:
    if state.get("user_id"):
        return state["user_id"]
    ctx = getattr(runtime, "context", None)
    if ctx is not None and getattr(ctx, "user_id", None):
        return ctx.user_id
    cfg = getattr(runtime, "config", None)
    if cfg:
        return cfg.get("configurable", {}).get("user_id")
    return None


class UserContextMiddleware(AgentMiddleware):
    """Load one compact, authoritative snapshot per agent invocation."""

    async def abefore_model(self, state: dict, runtime: Any) -> dict | None:
        if state.get("clock"):
            return None
        user_id = _user_id(state, runtime)
        if not user_id:
            return None
        context = getattr(runtime, "context", None)
        timezone = getattr(context, "timezone", None) or "UTC"
        snapshot = await build_nutrition_context_snapshot(
            user_id=user_id,
            timezone=timezone,
        )
        return {"user_id": user_id, **snapshot.to_prompt_variables()}
