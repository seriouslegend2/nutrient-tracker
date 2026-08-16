from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

from langchain_core.prompts import ChatPromptTemplate

from app.agents.manual_meal_resolver.prompt import MANUAL_MEAL_RESOLVER_PROMPT_NAME
from app.agents.media_facts.prompt import MEDIA_FACTS_PROMPT_NAME
from app.agents.media_meal_resolver.prompt import MEDIA_MEAL_RESOLVER_PROMPT_NAME
from app.services import prompts
from scripts.publish_prompts import PROMPTS, prompt_object


async def test_prompt_resolution_falls_back_without_langsmith(monkeypatch) -> None:
    prompts.clear_prompt_cache()
    monkeypatch.setattr(prompts.settings, "LANGSMITH_API_KEY", "")

    resolved = await prompts.resolve_prompt("test-prompt", "checked-in fallback")

    assert resolved.text == "checked-in fallback"
    assert resolved.source == "code"
    assert resolved.version is None


async def test_prompt_resolution_extracts_template_and_commit(monkeypatch) -> None:
    prompts.clear_prompt_cache()

    class FakeClient:
        def pull_prompt(self, name: str, *, include_model: bool) -> SimpleNamespace:
            assert name == "test-prompt"
            assert include_model is False
            return SimpleNamespace(
                template="remote {{prompt}}",
                metadata={
                    "lc_hub_commit_hash": "commit-123",
                    "nutrient_tracker_literal_braces": True,
                },
            )

    monkeypatch.setattr(prompts, "langsmith_client", lambda: FakeClient())

    resolved = await prompts.resolve_prompt("test-prompt", "fallback")

    assert resolved.text == "remote {prompt}"
    assert resolved.source == "langsmith"
    assert resolved.version == "commit-123"


async def test_prompt_resolution_extracts_chat_system_and_user_messages(monkeypatch) -> None:
    prompts.clear_prompt_cache()
    template = ChatPromptTemplate.from_messages(
        [("system", "Remote system"), ("user", "Meal: {dish_name}; servings: {servings}")]
    )
    template.metadata = {"lc_hub_commit_hash": "chat-commit"}

    class FakeClient:
        def pull_prompt(self, _name: str, *, include_model: bool) -> ChatPromptTemplate:
            assert include_model is False
            return template

    monkeypatch.setattr(prompts, "langsmith_client", lambda: FakeClient())

    resolved = await prompts.resolve_prompt("manual", "fallback")

    assert resolved.text == "Remote system"
    assert resolved.user_template == "Meal: {dish_name}; servings: {servings}"
    assert resolved.version == "chat-commit"


def test_manual_resolver_publishes_as_a_chat_prompt() -> None:
    text = PROMPTS[MANUAL_MEAL_RESOLVER_PROMPT_NAME][0]
    prompt = prompt_object(MANUAL_MEAL_RESOLVER_PROMPT_NAME, text)

    assert isinstance(prompt, ChatPromptTemplate)
    assert [type(message).__name__ for message in prompt.messages] == [
        "SystemMessagePromptTemplate",
        "HumanMessagePromptTemplate",
    ]
    assert set(prompt.input_variables) == {
        "dish_name",
        "global_categories",
        "global_dishes",
        "household_portions",
        "meal_id",
        "servings",
    }


def test_media_facts_publishes_as_a_chat_prompt() -> None:
    text = PROMPTS[MEDIA_FACTS_PROMPT_NAME][0]
    prompt = prompt_object(MEDIA_FACTS_PROMPT_NAME, text)

    assert isinstance(prompt, ChatPromptTemplate)
    assert [type(message).__name__ for message in prompt.messages] == [
        "SystemMessagePromptTemplate",
        "HumanMessagePromptTemplate",
    ]
    assert set(prompt.input_variables) == {"filename", "media_kind", "user_note"}


def test_media_resolver_publishes_as_a_chat_prompt() -> None:
    text = PROMPTS[MEDIA_MEAL_RESOLVER_PROMPT_NAME][0]
    prompt = prompt_object(MEDIA_MEAL_RESOLVER_PROMPT_NAME, text)

    assert isinstance(prompt, ChatPromptTemplate)
    assert [type(message).__name__ for message in prompt.messages] == [
        "SystemMessagePromptTemplate",
        "HumanMessagePromptTemplate",
    ]
    assert prompt.input_variables == ["resolver_input"]


def test_agent_trace_records_sanitized_inputs_and_outputs(monkeypatch) -> None:
    captured: dict = {}

    class FakeRun:
        def add_outputs(self, outputs: dict) -> None:
            captured["outputs"] = outputs

    @contextmanager
    def fake_tracing_context(**kwargs):
        captured["project"] = kwargs["project_name"]
        yield

    @contextmanager
    def fake_trace(name: str, **kwargs):
        captured["name"] = name
        captured["inputs"] = kwargs["inputs"]
        yield FakeRun()

    monkeypatch.setattr(prompts, "langsmith_client", lambda: object())
    monkeypatch.setattr(prompts.settings, "LANGSMITH_TRACING", True)
    monkeypatch.setattr(prompts, "tracing_context", fake_tracing_context)
    monkeypatch.setattr(prompts, "trace", fake_trace)

    with prompts.trace_agent(
        "media_facts",
        inputs={"filename": "meal.png", "byte_count": 123},
    ) as run:
        assert run is not None
        run.add_outputs({"facts": {"items": 3}})

    assert captured["name"] == "media_facts"
    assert captured["inputs"] == {"filename": "meal.png", "byte_count": 123}
    assert captured["outputs"] == {"facts": {"items": 3}}


def test_every_runtime_agent_prompt_is_published() -> None:
    assert set(PROMPTS) == {
        "media-facts-v1",
        "media-meal-resolver-v1",
        "manual-meal-resolver-v1",
        "nutrition-chat-v1",
    }
