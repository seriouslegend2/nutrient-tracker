from __future__ import annotations

import inspect
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from app.agents.media_facts.models import MediaFactItem, MediaFacts, MediaQuantity
from app.agents.media_meal_resolver import agent, runner
from app.agents.media_meal_resolver.middleware import MediaResolverPromptMiddleware
from app.agents.media_meal_resolver.models import (
    GlobalCategoryContext,
    GlobalDishContext,
    MediaResolutionDecision,
    MediaResolutionPlan,
    MediaResolverInput,
)
from app.services.prompts import ResolvedPrompt
from app.tools import media_meal_resolver_tools as tools


def _facts(name: str = "Dal") -> MediaFacts:
    return MediaFacts(
        usable=True,
        media_kind="image",
        content_kind="food_photo",
        items=[
            MediaFactItem(
                evidence_id="evidence-1",
                observed_item_name=name,
                normalized_name=name.lower(),
                quantity=MediaQuantity(
                    value=550,
                    unit="g",
                    total_grams=550,
                    source="estimated",
                    confidence="medium",
                    basis="visible plate",
                    range_g={"low": 450, "high": 650},
                ),
                confidence="high",
            )
        ],
        confidence="high",
    )


def _input() -> MediaResolverInput:
    return MediaResolverInput(
        facts=_facts(),
        global_dishes=[
            GlobalDishContext(
                food_id="dish-1",
                name="Dal Tadka",
                normalized_name="dal tadka",
                category="dal_gravy",
            )
        ],
        global_categories=[
            GlobalCategoryContext(
                category="dal_gravy",
                portion_unit="katori",
                portion_grams=150,
                portion_count=1,
            )
        ],
        household_portions=[],
    )


async def test_agent_registers_only_the_global_dish_creation_tool(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def create_agent(**kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(agent, "resolve_media_resolver_model", lambda: object())
    monkeypatch.setattr(agent, "create_agent", create_agent)

    _, middleware = await agent.build_media_meal_resolver_agent()

    assert [tool.name for tool in captured["tools"]] == ["create_global_dish"]
    assert captured["middleware"] == [middleware]
    assert isinstance(middleware, MediaResolverPromptMiddleware)


def test_agent_state_contains_the_complete_supplied_catalog() -> None:
    state = agent._resolver_state(_input())

    assert '"food_id":"dish-1"' in state["resolver_input"]
    assert '"total_grams":550.0' in state["resolver_input"]


def test_unknown_fallback_name_contains_a_stable_utc_timestamp() -> None:
    names = runner._unknown_fallback_names(
        _facts("Unknown packaged item"),
        datetime(2026, 8, 16, 14, 30, tzinfo=UTC),
    )

    assert names == {"evidence-1": "Unknown dish 2026-08-16 14:30:00 UTC #1"}


def test_media_resolution_has_no_unresolved_action() -> None:
    with pytest.raises(ValueError, match=r"match_existing.*create_new"):
        MediaResolutionDecision.model_validate(
            {
                "evidence_id": "evidence-1",
                "action": "unresolved",
                "confidence": "low",
                "reason": "ambiguous",
            }
        )


def test_plan_rejects_existing_ids_outside_supplied_catalog() -> None:
    plan = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="match_existing",
                selected_food_id="invented-id",
                confidence="high",
                reason="invented",
            )
        ]
    )

    with pytest.raises(ValueError, match="outside the supplied catalog"):
        runner.validate_media_resolution_plan(_input(), plan)


@pytest.mark.parametrize(
    ("decisions", "expected_repair_ids"),
    [
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="match_existing",
                    selected_food_id="dish-1",
                    confidence="high",
                    reason="Valid match",
                )
            ],
            [],
        ),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="create_new",
                    selected_food_id="dish-1",
                    category="dal_gravy",
                    canonical_name="Dal",
                    confidence="high",
                    reason="Valid completed creation",
                )
            ],
            [],
        ),
        ([], ["evidence-1"]),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="match_existing",
                    selected_food_id="dish-1",
                    confidence="high",
                    reason="Duplicate one",
                ),
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="match_existing",
                    selected_food_id="dish-1",
                    confidence="high",
                    reason="Duplicate two",
                ),
            ],
            ["evidence-1"],
        ),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="match_existing",
                    selected_food_id="invented-id",
                    confidence="high",
                    reason="Invalid match ID",
                )
            ],
            ["evidence-1"],
        ),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="create_new",
                    confidence="high",
                    reason="Tool not called",
                )
            ],
            ["evidence-1"],
        ),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="create_new",
                    selected_food_id="invented-id",
                    category="dal_gravy",
                    canonical_name="Dal",
                    confidence="high",
                    reason="Fabricated creation ID",
                )
            ],
            ["evidence-1"],
        ),
        (
            [
                MediaResolutionDecision(
                    evidence_id="evidence-1",
                    action="create_new",
                    selected_food_id="dish-1",
                    category="fruit",
                    canonical_name="Dal",
                    confidence="high",
                    reason="Wrong category",
                )
            ],
            ["evidence-1"],
        ),
    ],
    ids=[
        "valid-match",
        "valid-create",
        "missing",
        "duplicate",
        "invalid-match-id",
        "create-without-tool",
        "fabricated-create-id",
        "invalid-create-category",
    ],
)
def test_resolution_state_repair_matrix(decisions, expected_repair_ids) -> None:
    plan = MediaResolutionPlan(decisions=decisions)

    assert runner.media_resolution_repair_ids(_input(), plan) == expected_repair_ids


def test_unexpected_decisions_are_removed_during_normalization() -> None:
    plan = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="match_existing",
                selected_food_id="dish-1",
                confidence="high",
                reason="Expected",
            ),
            MediaResolutionDecision(
                evidence_id="unexpected",
                action="create_new",
                confidence="low",
                reason="Unexpected",
            ),
        ]
    )

    normalized = runner.merge_media_resolution_plans(_input(), plan, None)

    assert [decision.evidence_id for decision in normalized.decisions] == ["evidence-1"]


def test_missing_decision_is_repaired_and_merged_in_evidence_order() -> None:
    resolver_input = _input()
    second_item = resolver_input.facts.items[0].model_copy(
        update={"evidence_id": "evidence-2", "observed_item_name": "Roti"}
    )
    resolver_input = resolver_input.model_copy(
        update={
            "facts": resolver_input.facts.model_copy(
                update={"items": [resolver_input.facts.items[0], second_item]}
            )
        }
    )
    initial = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="match_existing",
                selected_food_id="dish-1",
                confidence="high",
                reason="Existing dish",
            )
        ]
    )
    repaired = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-2",
                action="create_new",
                selected_food_id="dish-2",
                category="dal_gravy",
                canonical_name="Roti",
                confidence="medium",
                reason="Created missing dish",
            )
        ]
    )

    assert runner.media_resolution_repair_ids(resolver_input, initial) == ["evidence-2"]
    merged = runner.merge_media_resolution_plans(resolver_input, initial, repaired)

    assert [decision.evidence_id for decision in merged.decisions] == [
        "evidence-1",
        "evidence-2",
    ]


async def test_create_tool_writes_an_idempotent_agent_estimate(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    async def categories() -> list[dict[str, Any]]:
        return [{"category": "dal_gravy"}]

    async def create(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"dish_id": "dish-new", "name": "Dal", "category": "dal_gravy"}

    monkeypatch.setattr(tools.dish_service.dish_repo, "list_active_categories", categories)
    monkeypatch.setattr(tools.dish_service.dish_repo, "create_global_dish", create)

    result = await tools.create_global_dish.ainvoke(
        {
            "evidence_id": "evidence-1",
            "canonical_name": "Dal",
            "category": "dal_gravy",
            "nutrients_per_unit": {"protein_g": 12, "carbs_g": 36, "fat_g": 10},
            "alias": "home dal",
        },
        config={"configurable": {"user_id": "user-1"}},
    )

    assert result["food_id"] == "dish-new"
    assert result["evidence_id"] == "evidence-1"
    assert captured["actor"] == "media_meal_resolver"
    assert captured["source"] == "media_meal_resolver"


async def test_unknown_tool_requires_the_application_timestamped_name() -> None:
    result = await tools.create_global_dish.ainvoke(
        {
            "evidence_id": "evidence-1",
            "canonical_name": "Unknown packaged item",
            "category": "unknown",
            "nutrients_per_unit": {"protein_g": 0, "carbs_g": 0, "fat_g": 0},
        },
        config={
            "configurable": {
                "user_id": "user-1",
                "fallback_names": {
                    "evidence-1": "Unknown dish 2026-08-16 14:30:00 UTC #1"
                },
            }
        },
    )

    assert result["status"] == "ERROR"
    assert "timestamped name" in result["message"]


def test_create_decision_is_bound_to_its_successful_tool_result() -> None:
    pending = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="create_new",
                confidence="high",
                reason="Missing from supplied catalog",
            )
        ]
    )
    result = {
        "messages": [
            ToolMessage(
                content=(
                    '{"status":"OK","evidence_id":"evidence-1",'
                    '"food_id":"dish-new","name":"Dal","category":"dal_gravy"}'
                ),
                name="create_global_dish",
                tool_call_id="call-1",
            )
        ]
    }

    bound = agent._bind_creation_results(pending, result)

    assert bound.decisions[0].selected_food_id == "dish-new"
    assert bound.decisions[0].canonical_name == "Dal"
    assert bound.decisions[0].category == "dal_gravy"


def test_tool_created_match_is_normalized_to_create_new() -> None:
    plan = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="match_existing",
                selected_food_id="stale-id",
                confidence="high",
                reason="Created during this turn",
            )
        ]
    )
    result = {
        "messages": [
            ToolMessage(
                content=(
                    '{"status":"OK","evidence_id":"evidence-1",'
                    '"food_id":"dish-new","name":"Dal","category":"dal_gravy"}'
                ),
                name="create_global_dish",
                tool_call_id="call-1",
            )
        ]
    }

    bound = agent._bind_creation_results(plan, result)

    assert bound.decisions[0].action == "create_new"
    assert bound.decisions[0].selected_food_id == "dish-new"


def test_idempotent_tool_result_for_supplied_dish_remains_a_match() -> None:
    plan = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="create_new",
                confidence="high",
                reason="Unnecessary tool call",
            )
        ]
    )
    result = {
        "messages": [
            ToolMessage(
                content=(
                    '{"status":"OK","evidence_id":"evidence-1",'
                    '"food_id":"dish-1","name":"Dal Tadka","category":"dal_gravy"}'
                ),
                name="create_global_dish",
                tool_call_id="call-1",
            )
        ]
    }

    bound = agent._bind_creation_results(plan, result, {"dish-1"})

    assert bound.decisions[0].action == "match_existing"
    assert bound.decisions[0].selected_food_id == "dish-1"
    assert bound.decisions[0].category is None


def test_create_decision_without_a_tool_result_is_left_for_targeted_repair() -> None:
    pending = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="create_new",
                confidence="high",
                reason="Missing from supplied catalog",
            )
        ]
    )

    bound = agent._bind_creation_results(pending, {"messages": []})

    assert bound.decisions[0].action == "create_new"
    assert bound.decisions[0].selected_food_id is None
    assert runner.media_resolution_repair_ids(_input(), bound) == ["evidence-1"]


@pytest.mark.parametrize(
    "content",
    [
        "not-json",
        '{"status":"ERROR","evidence_id":"evidence-1"}',
        '{"status":"OK","food_id":"dish-new"}',
    ],
    ids=["malformed", "tool-error", "missing-evidence-id"],
)
def test_invalid_creation_tool_outputs_are_not_trusted(content: str) -> None:
    pending = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="create_new",
                confidence="high",
                reason="Pending creation",
            )
        ]
    )
    result = {
        "messages": [
            ToolMessage(
                content=content,
                name="create_global_dish",
                tool_call_id="call-1",
            )
        ]
    }

    bound = agent._bind_creation_results(pending, result)

    assert bound.decisions[0].selected_food_id is None


def test_conflicting_creation_tool_results_fail_closed() -> None:
    pending = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="create_new",
                confidence="high",
                reason="Pending creation",
            )
        ]
    )
    result = {
        "messages": [
            ToolMessage(
                content=(
                    '{"status":"OK","evidence_id":"evidence-1",'
                    '"food_id":"dish-a","name":"Dal","category":"dal_gravy"}'
                ),
                name="create_global_dish",
                tool_call_id="call-1",
            ),
            ToolMessage(
                content=(
                    '{"status":"OK","evidence_id":"evidence-1",'
                    '"food_id":"dish-b","name":"Dal","category":"dal_gravy"}'
                ),
                name="create_global_dish",
                tool_call_id="call-2",
            ),
        ]
    }

    with pytest.raises(ValueError, match="Multiple global dishes"):
        agent._bind_creation_results(pending, result)


def test_structured_plan_falls_back_to_raw_model_tool_call() -> None:
    result = {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "MediaResolutionPlan",
                        "id": "call-plan",
                        "args": {
                            "decisions": [
                                {
                                    "evidence_id": "evidence-1",
                                    "action": "match_existing",
                                    "selected_food_id": "dish-1",
                                    "confidence": "high",
                                    "reason": "Existing dish",
                                }
                            ]
                        },
                    }
                ],
            )
        ]
    }

    plan = agent._structured_plan(result)

    assert plan is not None
    assert plan.decisions[0].selected_food_id == "dish-1"


def test_unsupported_existing_id_is_targeted_for_repair() -> None:
    plan = MediaResolutionPlan(
        decisions=[
            MediaResolutionDecision(
                evidence_id="evidence-1",
                action="match_existing",
                selected_food_id="not-in-catalog",
                confidence="high",
                reason="Invalid ID",
            )
        ]
    )

    assert runner.media_resolution_repair_ids(_input(), plan) == ["evidence-1"]


async def _dishes() -> list[dict[str, Any]]:
    return [
        {
            "dish_id": "dish-1",
            "name": "Dal",
            "name_normalized": "dal",
            "aliases": [],
            "category": "dal_gravy",
        }
    ]


async def _categories() -> list[dict[str, Any]]:
    return [
        {
            "category": "dal_gravy",
            "portion_unit": "katori",
            "portion_grams": 150,
            "portion_count": 1,
        }
    ]


async def _household(_user_id: str) -> list[dict[str, Any]]:
    return []


def _setup(monkeypatch) -> None:
    monkeypatch.setattr(runner.dish_repo, "list_active_dishes", _dishes)
    monkeypatch.setattr(runner.dish_repo, "list_active_categories", _categories)
    monkeypatch.setattr(runner.dish_repo, "list_category_portions", _household)

    async def record(_row: dict[str, Any]) -> None:
        return None

    monkeypatch.setattr(runner, "_record_run", record)


async def test_supplied_catalog_match_needs_no_lookup(monkeypatch) -> None:
    _setup(monkeypatch)

    async def resolve(resolver_input, *, user_id: str, thread_id: str):
        assert user_id == "user-1"
        assert thread_id == "thread-1"
        assert resolver_input.global_dishes[0].food_id == "dish-1"
        return (
            MediaResolutionPlan(
                decisions=[
                    MediaResolutionDecision(
                        evidence_id="evidence-1",
                        action="match_existing",
                        selected_food_id="dish-1",
                        confidence="high",
                        reason="Supplied catalog match",
                    )
                ]
            ),
            ResolvedPrompt(name="media-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    monkeypatch.setattr(runner, "resolve_media_meals", resolve)

    result = await runner.run_media_meal_resolver_agent(
        user_id="user-1", thread_id="thread-1", facts=_facts()
    )

    assert result.dishes[0].food_id == "dish-1"
    assert result.dishes[0].action == "match_existing"


async def test_create_new_accepts_only_the_tool_returned_global_id(monkeypatch) -> None:
    _setup(monkeypatch)
    calls = 0

    async def dishes_after_tool() -> list[dict[str, Any]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return []
        return [
            {
                "dish_id": "dish-new",
                "name": "Amla",
                "name_normalized": "amla",
                "aliases": [],
                "category": "dal_gravy",
            }
        ]

    monkeypatch.setattr(runner.dish_repo, "list_active_dishes", dishes_after_tool)

    async def resolve(_resolver_input, *, user_id: str, thread_id: str):
        return (
            MediaResolutionPlan(
                decisions=[
                    MediaResolutionDecision(
                        evidence_id="evidence-1",
                        action="create_new",
                        selected_food_id="dish-new",
                        category="dal_gravy",
                        canonical_name="Amla",
                        confidence="high",
                        reason="Created through the tool",
                    )
                ]
            ),
            ResolvedPrompt(name="media-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    async def get_dish(food_id: str) -> dict[str, Any]:
        assert food_id == "dish-new"
        return {"dish_id": "dish-new", "name": "Amla", "category": "dal_gravy"}

    monkeypatch.setattr(runner, "resolve_media_meals", resolve)
    monkeypatch.setattr(runner.dish_repo, "get_dish", get_dish)

    result = await runner.run_media_meal_resolver_agent(
        user_id="user-1", thread_id="thread-1", facts=_facts("Amla")
    )

    assert result.dishes[0].food_id == "dish-new"
    assert result.dishes[0].action == "create_new"


async def test_runner_repairs_pending_creation_against_refreshed_catalog(monkeypatch) -> None:
    _setup(monkeypatch)
    dish_calls = 0
    resolve_calls = 0

    async def changing_dishes() -> list[dict[str, Any]]:
        nonlocal dish_calls
        dish_calls += 1
        if dish_calls < 3:
            return []
        return [
            {
                "dish_id": "dish-new",
                "name": "Amla",
                "name_normalized": "amla",
                "aliases": [],
                "category": "dal_gravy",
            }
        ]

    async def resolve(resolver_input, *, user_id: str, thread_id: str):
        nonlocal resolve_calls
        resolve_calls += 1
        decision = MediaResolutionDecision(
            evidence_id="evidence-1",
            action="create_new",
            selected_food_id="dish-new" if resolve_calls == 2 else None,
            category="dal_gravy",
            canonical_name="Amla",
            confidence="high",
            reason="Create missing dish",
        )
        assert len(resolver_input.facts.items) == 1
        return (
            MediaResolutionPlan(decisions=[decision]),
            ResolvedPrompt(name="media-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    async def get_dish(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-new", "name": "Amla", "category": "dal_gravy"}

    monkeypatch.setattr(runner.dish_repo, "list_active_dishes", changing_dishes)
    monkeypatch.setattr(runner.dish_repo, "get_dish", get_dish)
    monkeypatch.setattr(runner, "resolve_media_meals", resolve)

    result = await runner.run_media_meal_resolver_agent(
        user_id="user-1", thread_id="thread-1", facts=_facts("Amla")
    )

    assert resolve_calls == 2
    assert result.dishes[0].food_id == "dish-new"


async def test_runner_fails_closed_after_repair_exhaustion(monkeypatch) -> None:
    _setup(monkeypatch)
    monkeypatch.setattr(runner.dish_repo, "list_active_dishes", _empty)
    resolve_calls = 0

    async def unresolved_creation(_resolver_input, *, user_id: str, thread_id: str):
        nonlocal resolve_calls
        resolve_calls += 1
        return (
            MediaResolutionPlan(
                decisions=[
                    MediaResolutionDecision(
                        evidence_id="evidence-1",
                        action="create_new",
                        category="dal_gravy",
                        canonical_name="Amla",
                        confidence="medium",
                        reason="Tool was not completed",
                    )
                ]
            ),
            ResolvedPrompt(name="media-meal-resolver-v1", text="prompt", source="code"),
            SimpleNamespace(usage=None),
        )

    monkeypatch.setattr(runner, "resolve_media_meals", unresolved_creation)

    with pytest.raises(ValueError, match="did not complete global dish creation"):
        await runner.run_media_meal_resolver_agent(
            user_id="user-1", thread_id="thread-1", facts=_facts("Amla")
        )

    assert resolve_calls == 3


async def _empty() -> list[dict[str, Any]]:
    return []


def test_media_resolver_has_no_lookup_or_meal_mutation_dependency() -> None:
    source = inspect.getsource(runner)
    assert "lookup" not in source
    assert "domain.meals" not in source
    assert "create_global_dish(" not in source
