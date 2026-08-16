from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from pydantic import ValidationError

from app.agents.manual_meal_resolver import agent as resolver_agent
from app.agents.manual_meal_resolver import middleware as resolver_middleware
from app.agents.manual_meal_resolver import runner
from app.agents.manual_meal_resolver.middleware import render_manual_user_prompt
from app.agents.manual_meal_resolver.models import (
    GlobalCategoryContext,
    GlobalDishContext,
    HouseholdPortionContext,
    ManualResolution,
    ManualResolverInput,
    ResolvedManualDish,
)
from app.agents.manual_meal_resolver.prompt import MANUAL_MEAL_RESOLVER_USER_PROMPT
from app.domain.dishes.models import NutrientsPerUnit
from app.services.prompts import ResolvedPrompt


def test_manual_resolution_requires_action_specific_references() -> None:
    with pytest.raises(ValidationError):
        ManualResolution(
            action="create_new",
            category="fruit",
            canonical_name="Amla",
            confidence="high",
            reason="New fruit",
        )


def test_existing_match_discards_irrelevant_model_fields() -> None:
    resolution = ManualResolution(
        action="match_existing",
        selected_food_id="dish-1",
        updated_meal_id="meal-2",
        category="protein_main",
        canonical_name="Ignored",
        confidence="high",
        reason="Existing catalog match",
    )

    assert resolution.selected_food_id == "dish-1"
    assert resolution.category is None
    assert resolution.canonical_name is None


def test_successful_create_tool_recovers_missing_structured_response() -> None:
    resolution = resolver_agent._resolution_from_tools(
        {
            "messages": [
                ToolMessage(
                    content='{"status":"OK","food_id":"dish-new","name":"Amla","category":"fruit","nutrients_per_unit":{"protein_g":1.2,"carbs_g":12,"fat_g":0.6}}',
                    name="create_global_dish",
                    tool_call_id="create-1",
                )
            ]
        }
    )

    assert resolution is not None
    assert resolution.action == "create_new"
    assert resolution.selected_food_id == "dish-new"
    assert resolution.updated_meal_id is None


def _resolver_input() -> ManualResolverInput:
    return ManualResolverInput(
        meal_id="meal-1",
        dish_name="amla",
        servings=1.5,
        global_dishes=[
            GlobalDishContext(
                food_id="dish-1",
                name="Apple",
                name_normalized="apple",
                category="fruit",
                nutrients_per_unit={"protein_g": 0.36},
                source="seed",
            )
        ],
        global_categories=[
            GlobalCategoryContext(
                category="fruit", portion_unit="piece", portion_grams=120, portion_count=1
            )
        ],
        household_portions=[
            HouseholdPortionContext(
                category="fruit",
                portion_unit="piece",
                portion_count=2,
                effective_portion_grams=240,
                is_custom=True,
            )
        ],
    )


def test_manual_prompt_middleware_renders_every_input_separately() -> None:
    state = resolver_agent._resolver_state(_resolver_input())
    rendered = render_manual_user_prompt(MANUAL_MEAL_RESOLVER_USER_PROMPT, state)

    assert "{dish_name}" not in rendered
    assert '"meal-1"' in rendered
    assert "{global_dishes}" not in rendered
    assert '"amla"' in rendered
    assert '"effective_portion_grams":240.0' in rendered


async def test_manual_agent_registers_its_own_prompt_middleware(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def create_agent(**kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(resolver_agent, "resolve_manual_resolver_model", lambda: object())
    monkeypatch.setattr(resolver_agent, "create_agent", create_agent)

    _, middleware = await resolver_agent.build_manual_meal_resolver_agent()

    assert [tool.name for tool in captured["tools"]] == [
        "create_global_dish",
        "update_meal_resolution",
    ]
    assert captured["middleware"] == [middleware]
    assert captured["state_schema"].__name__ == "ManualMealResolverState"
    assert captured["context_schema"].__name__ == "NutrientTrackerRuntimeContext"


async def test_prompt_middleware_preserves_tool_history(monkeypatch) -> None:
    state = resolver_agent._resolver_state(_resolver_input())
    original_tool_message = ToolMessage(
        content='{"status":"OK","food_id":"dish-new"}',
        name="create_global_dish",
        tool_call_id="call-1",
    )
    captured: dict[str, Any] = {}

    class Request:
        def __init__(self) -> None:
            self.state = state
            self.messages = [HumanMessage(content="original"), original_tool_message]

        def override(self, **kwargs: Any) -> Any:
            captured.update(kwargs)
            return self

    async def prompt(*_args: Any, **_kwargs: Any) -> ResolvedPrompt:
        return ResolvedPrompt(
            name="manual-meal-resolver-v1",
            text="system",
            user_template=MANUAL_MEAL_RESOLVER_USER_PROMPT,
            source="code",
        )

    async def handler(request: Any) -> Any:
        return request

    monkeypatch.setattr(resolver_middleware, "resolve_prompt", prompt)

    await resolver_middleware.ManualResolverPromptMiddleware().awrap_model_call(
        Request(), handler
    )

    assert len(captured["messages"]) == 2
    assert '"amla"' in captured["messages"][0].content
    assert captured["messages"][1] is original_tool_message


async def _dishes() -> list[dict[str, Any]]:
    return [
        {
            "dish_id": "dish-1",
            "name": "Chicken curry",
            "name_normalized": "chicken curry",
            "aliases": [],
            "category": "protein_main",
            "nutrients_per_unit": {"protein_g": 27, "carbs_g": 6, "fat_g": 15},
            "source": "seed",
        }
    ]


async def _categories() -> list[dict[str, Any]]:
    return [
        {
            "category": "fruit",
            "portion_unit": "piece",
            "portion_grams": 120,
            "portion_count": 1,
        },
        {
            "category": "protein_main",
            "portion_unit": "serving",
            "portion_grams": 150,
            "portion_count": 1,
        },
    ]


async def _household(_user_id: str) -> list[dict[str, Any]]:
    return [
        {
            "category": "fruit",
            "portion_unit": "piece",
            "portion_count": 1,
            "effective_portion_grams": 120,
            "is_custom": False,
        }
    ]


def _setup(monkeypatch) -> None:
    monkeypatch.setattr(runner.settings, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(runner.dish_repo, "list_active_dishes", _dishes)
    monkeypatch.setattr(runner.dish_repo, "list_active_categories", _categories)
    monkeypatch.setattr(runner.dish_repo, "list_category_portions", _household)

    async def record(_row: dict[str, Any]) -> None:
        return None

    monkeypatch.setattr(runner, "_record_run", record)
async def test_runner_accepts_only_an_existing_supplied_food_id(monkeypatch) -> None:
    _setup(monkeypatch)

    async def resolve(resolver_input, *, user_id: str):
        assert user_id == "user-1"
        assert len(resolver_input.global_dishes) == 1
        return (
            ManualResolution(
                action="match_existing",
                selected_food_id="dish-1",
                updated_meal_id="meal-2",
                confidence="high",
                reason="Same dish",
            ),
            ResolvedPrompt(name="manual-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    monkeypatch.setattr(runner, "resolve_manual_meal", resolve)

    async def mapped(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {"id": "meal-2", "food_id": "dish-1", "is_active": True}

    monkeypatch.setattr(runner.meal_repo, "get_meal", mapped)

    result = await runner.run_manual_meal_resolver(
        user_id="user-1",
        meal_id="meal-1",
        dish_name="home chicken curry",
        servings=2,
    )

    assert result == ResolvedManualDish(
        food_id="dish-1",
        name="Chicken curry",
        category="protein_main",
        confidence="high",
        action="match_existing",
        updated_meal_id="meal-2",
    )


async def test_runner_accepts_the_food_id_returned_by_the_creation_tool(monkeypatch) -> None:
    _setup(monkeypatch)
    async def resolve(_resolver_input, *, user_id: str):
        assert user_id == "user-1"
        return (
            ManualResolution(
                action="create_new",
                selected_food_id="dish-new",
                category="fruit",
                canonical_name="Amla",
                nutrients_per_unit=NutrientsPerUnit(
                    protein_g=1.08, carbs_g=12.24, fat_g=0.72
                ),
                updated_meal_id="meal-2",
                confidence="high",
                reason="Created through the global dish tool",
            ),
            ResolvedPrompt(name="manual-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    async def created(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-new", "name": "Amla", "category": "fruit"}

    async def mapped(_user_id: str, _meal_id: str) -> dict[str, Any]:
        return {"id": "meal-2", "food_id": "dish-new", "is_active": True}

    monkeypatch.setattr(runner, "resolve_manual_meal", resolve)
    monkeypatch.setattr(runner.dish_repo, "get_dish", created)
    monkeypatch.setattr(runner.meal_repo, "get_meal", mapped)

    result = await runner.run_manual_meal_resolver(
        user_id="user-1", meal_id="meal-1", dish_name="amla", servings=2
    )

    assert result and result.food_id == "dish-new"
    assert result.updated_meal_id == "meal-2"


async def test_runner_trusts_tool_results_over_reframed_final_action(monkeypatch) -> None:
    _setup(monkeypatch)

    async def resolve(_resolver_input, *, user_id: str):
        assert user_id == "user-1"
        return (
            ManualResolution(
                action="match_existing",
                selected_food_id="dish-new",
                confidence="high",
                reason="The newly created dish now exists.",
            ),
            ResolvedPrompt(name="manual-meal-resolver-v1", text="prompt", source="code"),
            {
                "messages": [
                    ToolMessage(
                        content='{"status":"OK","food_id":"dish-new","category":"fruit"}',
                        name="create_global_dish",
                        tool_call_id="create-1",
                    ),
                    ToolMessage(
                        content='{"status":"OK","meal":{"id":"meal-2","food_id":"dish-new","is_active":true}}',
                        name="update_meal_resolution",
                        tool_call_id="update-1",
                    ),
                ]
            },
        )

    async def created(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-new", "name": "Amla", "category": "fruit"}

    monkeypatch.setattr(runner, "resolve_manual_meal", resolve)
    monkeypatch.setattr(runner.dish_repo, "get_dish", created)

    result = await runner.run_manual_meal_resolver(
        user_id="user-1", meal_id="meal-1", dish_name="Amla", servings=1
    )

    assert result == ResolvedManualDish(
        food_id="dish-new",
        name="Amla",
        category="fruit",
        confidence="high",
        action="create_new",
        updated_meal_id="meal-2",
    )


async def test_placeholder_name_is_sent_to_model_and_remains_unresolved(monkeypatch) -> None:
    _setup(monkeypatch)
    called = False

    async def resolve(_resolver_input, *, user_id: str):
        nonlocal called
        called = True
        assert user_id == "user-1"
        return (
            ManualResolution(
                action="unresolved",
                confidence="high",
                reason="The name is a placeholder, not a food identity.",
            ),
            ResolvedPrompt(name="manual-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    monkeypatch.setattr(runner, "resolve_manual_meal", resolve)

    result = await runner.run_manual_meal_resolver(
        user_id="user-1", meal_id="meal-1", dish_name="dish1", servings=1
    )

    assert called
    assert result is None
