"""nutrition_chat's own middleware.

Two responsibilities, kept in one file the way KookarCore keeps one
middleware.ts per agent: resolve the model + system prompt (must run first),
then load user context (profile, active goal, preferences) into state before
each model call. Position in the list passed to create_agent() IS the
registration - ModelAndPromptMiddleware goes first, always.
"""

from __future__ import annotations

import asyncio
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import SystemMessage

from app.config.settings import settings
from app.services.prompts import resolve_prompt
from app.utils.logger import logger


class ModelAndPromptMiddleware(AgentMiddleware):
    """ALWAYS FIRST in the middleware list. Resolves the LLM and system prompt."""

    def __init__(self, *, langsmith_prompt_name: str, fallback_prompt: str) -> None:
        super().__init__()  # ALWAYS call super
        self.langsmith_prompt_name = langsmith_prompt_name
        self.fallback_prompt = fallback_prompt

    def before_agent(self, state: dict, runtime: Any) -> dict | None:
        # Prompt loading happens in awrap_model_call for concurrency safety.
        return None

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        prompt = await resolve_prompt(self.langsmith_prompt_name, self.fallback_prompt)
        prompt_text = prompt.text
        logger.info(
            "prompt_resolved agent=nutrition_chat source={} version={}",
            prompt.source,
            prompt.version or "fallback",
        )
        state = dict(request.state or {})
        for field in ("user_profile", "active_goal", "preferences"):
            prompt_text = prompt_text.replace(
                "{" + field + "}", str(state.get(field) or "Not available.")
            )
        messages = [m for m in request.messages if not isinstance(m, SystemMessage)]
        updated_request = request.override(
            system_message=SystemMessage(content=prompt_text),
            messages=messages,
        )
        return await handler(updated_request)

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        # Sync path is dead in this stack - every agent is invoked with
        # ainvoke/astream only.
        raise RuntimeError("nutrition_chat: sync invocation is not supported.")


def resolve_model() -> BaseChatModel:
    """KookarCore-style provider-qualified model initialization."""
    return init_chat_model(f"openai:{settings.CHAT_MODEL}")


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
    """Loads profile, active goal and preferences before each model call.

    State field names MUST equal prompt.py's template variables: user_profile,
    active_goal, preferences. Deliberately does NOT gate on a "loaded" flag
    across turns - preferences can change mid-conversation, so re-reading
    every turn prevents a stale existing_preferences being replayed.
    """

    def before_model(self, state: dict, runtime: Any) -> dict | None:
        return asyncio.run(self.abefore_model(state, runtime))

    async def abefore_model(self, state: dict, runtime: Any) -> dict | None:
        user_id = _user_id(state, runtime)
        if not user_id:
            return None

        from app.domain.goals import service as goals_service
        from app.domain.profile import repository as profile_repo

        profile, goal, prefs = await asyncio.gather(
            profile_repo.get_profile(user_id),
            goals_service.get_active_goal(user_id),
            profile_repo.list_preferences(user_id, limit=50),
        )

        return {
            "user_id": user_id,
            "user_profile": _render_profile(profile),
            "active_goal": _render_goal(goal),
            "preferences": _render_preferences(prefs[0] if prefs else []),
        }


def _render_profile(profile: dict | None) -> str:
    if not profile:
        return "No profile set up yet."
    parts = []
    if profile.get("sex"):
        parts.append(f"sex={profile['sex']}")
    if profile.get("bmi"):
        parts.append(f"BMI={profile['bmi']}")
    if profile.get("bmr_kcal"):
        parts.append(f"BMR={profile['bmr_kcal']}kcal")
    if profile.get("tdee_kcal"):
        parts.append(f"TDEE={profile['tdee_kcal']}kcal")
    if profile.get("diet"):
        parts.append(f"diet={profile['diet']}")
    if profile.get("allergies"):
        parts.append(f"allergies={', '.join(profile['allergies'])}")
    return ", ".join(parts) if parts else "Profile incomplete."


def _render_goal(goal: dict | None) -> str:
    if not goal:
        return "No active goal."
    targets = (goal.get("daily_targets") or {}).get("targets", [])
    lines = [f"kind={goal['kind']}"]
    for t in targets:
        lines.append(f"  {t.get('metric')}: {t.get('direction')} {t.get('value')}{t.get('unit')}")
    derivation = goal.get("derivation") or {}
    if derivation.get("clamp_fired") or derivation.get("floor_applied"):
        lines.append("  NOTE: this target was safety-clamped from what was requested.")
    return "\n".join(lines)


def _render_preferences(prefs: list[dict]) -> str:
    if not prefs:
        return "Nothing recorded yet."
    return "\n".join(f"- [{p['pref_id']}] {p['topic_title']}: {p['content']}" for p in prefs)
