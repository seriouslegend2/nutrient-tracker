"""Nutrition chat agent for typed messages and speech-to-text transcripts.

This file ONLY builds the agent: resolve model, assemble middleware, wire
tools, return. No business logic - that lives in tools.py (which delegates to
app/domain/) and middleware.py. Equivalent to KookarCore's index.ts.
"""

from __future__ import annotations

from langchain.agents import create_agent
from langchain.agents.structured_output import AutoStrategy
from langchain_core.runnables import RunnableConfig

from app.agents.nutrition_chat.middleware import (
    ModelAndPromptMiddleware,
    UserContextMiddleware,
    resolve_model,
)
from app.agents.nutrition_chat.models import ChatTurn
from app.agents.nutrition_chat.prompt import NUTRITION_CHAT_PROMPT
from app.agents.nutrition_chat.state import NutritionChatState
from app.agents.nutrition_chat.tools import confirmation_required_tools, mutation_tools, read_tools
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.utils.logger import logger


async def build_nutrition_chat_agent(
    config: RunnableConfig | None = None,
    *,
    allow_mutations: bool = True,
    allow_nutrition_entry: bool = False,
):
    """Build the agent. Called once per invocation by the agent registry."""
    middleware = [
        ModelAndPromptMiddleware(  # MUST be first
            langsmith_prompt_name="nutrition-chat-v1",
            fallback_prompt=NUTRITION_CHAT_PROMPT,
        ),
        UserContextMiddleware(),
    ]

    available_tools = read_tools
    if allow_mutations:
        available_tools = [*read_tools, *mutation_tools]
        if allow_nutrition_entry:
            available_tools.extend(confirmation_required_tools)

    agent = create_agent(
        model=resolve_model(),
        tools=available_tools,
        name="nutrition_chat",
        state_schema=NutritionChatState,
        context_schema=NutrientTrackerRuntimeContext,
        response_format=AutoStrategy(ChatTurn),
        middleware=middleware,
    )
    agent = agent.with_config(recursion_limit=20)
    logger.info("[nutrition_chat] agent built")
    return agent


if __name__ == "__main__":
    import asyncio

    async def _local_test() -> None:
        agent = await build_nutrition_chat_agent()
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "how much protein have I had today?"}]},
            config={"configurable": {"user_id": "test-user-id"}},
        )
        print(result.get("structured_response"))

    asyncio.run(_local_test())
