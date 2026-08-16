"""Create the LangSmith project and publish every checked-in agent prompt."""

from __future__ import annotations

from langchain_core.prompts import PromptTemplate

from app.agents.nutrition_chat.prompt import NUTRITION_CHAT_PROMPT
from app.config.settings import settings
from app.services.media_extraction import (
    FOOD_DIARY_PDF_PROMPT,
    FOOD_DIARY_PDF_PROMPT_NAME,
    FOOD_PHOTO_PROMPT,
    FOOD_PHOTO_PROMPT_NAME,
    NUTRITION_LABEL_PROMPT,
    NUTRITION_LABEL_PROMPT_NAME,
    VOICE_LOG_PROMPT,
    VOICE_LOG_PROMPT_NAME,
)
from app.services.prompts import langsmith_client

PROMPTS = {
    "nutrition-chat-v1": (
        NUTRITION_CHAT_PROMPT,
        "System instructions for the authenticated nutrition chat agent.",
    ),
    FOOD_PHOTO_PROMPT_NAME: (
        FOOD_PHOTO_PROMPT,
        "Structured dish identity and quantity evidence from meal photographs.",
    ),
    NUTRITION_LABEL_PROMPT_NAME: (
        NUTRITION_LABEL_PROMPT,
        "Structured nutrition-panel extraction with column reconciliation.",
    ),
    VOICE_LOG_PROMPT_NAME: (
        VOICE_LOG_PROMPT,
        "Exact transcription guidance for spoken food logs.",
    ),
    FOOD_DIARY_PDF_PROMPT_NAME: (
        FOOD_DIARY_PDF_PROMPT,
        "Structured row extraction from food-diary PDFs.",
    ),
}


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
        # Escape every brace so JSON examples and runtime {context} tokens are
        # data, not PromptTemplate variables. The runtime resolver reverses it.
        escaped = text.replace("{", "{{").replace("}", "}}")
        prompt = PromptTemplate.from_template(
            escaped,
            template_format="f-string",
            metadata={"nutrient_tracker_literal_braces": True},
        )
        url = client.push_prompt(
            name,
            object=prompt,
            is_public=False,
            description=description,
            tags=["nutrient-tracker", "agent-prompt"],
            commit_description="Sync checked-in fallback prompt",
        )
        print(f"Published {name}: {url}")


if __name__ == "__main__":
    main()
