"""Create the LangSmith project and publish every checked-in agent prompt."""

from __future__ import annotations

from langchain_core.prompts import ChatPromptTemplate, PromptTemplate
from langsmith.utils import LangSmithConflictError

from app.agents.manual_meal_resolver.prompt import (
    MANUAL_MEAL_RESOLVER_PROMPT,
    MANUAL_MEAL_RESOLVER_PROMPT_NAME,
    MANUAL_MEAL_RESOLVER_USER_PROMPT,
)
from app.agents.media_facts.prompt import (
    MEDIA_FACTS_PROMPT,
    MEDIA_FACTS_PROMPT_NAME,
    MEDIA_FACTS_USER_PROMPT,
)
from app.agents.media_meal_resolver.prompt import (
    MEDIA_MEAL_RESOLVER_PROMPT,
    MEDIA_MEAL_RESOLVER_PROMPT_NAME,
    MEDIA_MEAL_RESOLVER_USER_PROMPT,
)
from app.agents.nutrition_chat.prompt import (
    NUTRITION_CHAT_PROMPT,
    NUTRITION_CHAT_PROMPT_NAME,
    nutrition_chat_prompt_template,
)
from app.config.settings import settings
from app.services.prompts import langsmith_client

PROMPTS = {
    NUTRITION_CHAT_PROMPT_NAME: (
        NUTRITION_CHAT_PROMPT,
        "System instructions for the authenticated nutrition chat agent.",
    ),
    MEDIA_FACTS_PROMPT_NAME: (
        MEDIA_FACTS_PROMPT,
        "Factual evidence extraction for supported images and PDFs.",
    ),
    MEDIA_MEAL_RESOLVER_PROMPT_NAME: (
        MEDIA_MEAL_RESOLVER_PROMPT,
        "Draft-only media dish mapping and tool-driven catalog creation.",
    ),
    MANUAL_MEAL_RESOLVER_PROMPT_NAME: (
        MANUAL_MEAL_RESOLVER_PROMPT,
        "Manual dish matching and tool-driven catalog creation.",
    ),
}


def prompt_object(name: str, text: str | ChatPromptTemplate) -> ChatPromptTemplate | PromptTemplate:
    if name == NUTRITION_CHAT_PROMPT_NAME:
        if isinstance(text, ChatPromptTemplate):
            return text
        return nutrition_chat_prompt_template(text)

    if not isinstance(text, str):
        raise TypeError(f"Prompt {name!r} requires a string fallback")

    chat_user_templates = {
        MANUAL_MEAL_RESOLVER_PROMPT_NAME: MANUAL_MEAL_RESOLVER_USER_PROMPT,
        MEDIA_FACTS_PROMPT_NAME: MEDIA_FACTS_USER_PROMPT,
        MEDIA_MEAL_RESOLVER_PROMPT_NAME: MEDIA_MEAL_RESOLVER_USER_PROMPT,
    }
    if name in chat_user_templates:
        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", text),
                ("user", chat_user_templates[name]),
            ]
        )
        prompt.metadata = {"nutrient_tracker_chat_prompt": True}
        return prompt

    escaped = text.replace("{", "{{").replace("}", "}}")
    return PromptTemplate.from_template(
        escaped,
        template_format="f-string",
        metadata={"nutrient_tracker_literal_braces": True},
    )


def main() -> None:
    client = langsmith_client()
    if client is None:
        raise SystemExit("LANGSMITH_API_KEY is not configured")

    client.create_project(
        settings.LANGSMITH_PROJECT,
        description="Nutrient Tracker agent traces and prompt evaluations.",
        metadata={"application": "nutrient-tracker"},
        upsert=True,
    )
    print(f"LangSmith project ready: {settings.LANGSMITH_PROJECT}")

    for name, (text, description) in PROMPTS.items():
        prompt = prompt_object(name, text)
        try:
            url = client.push_prompt(
                name,
                object=prompt,
                is_public=False,
                description=description,
                tags=["nutrient-tracker", "agent-prompt"],
                commit_description="Sync checked-in fallback prompt",
            )
            print(f"Published {name}: {url}")
        except LangSmithConflictError as exc:
            if "Nothing to commit" not in str(exc):
                raise
            print(f"Unchanged {name}")


if __name__ == "__main__":
    main()
