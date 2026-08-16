"""Build, validate, trace, and apply draft-only media dish resolution."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any

from app.agents.media_facts.models import MediaFacts
from app.agents.media_meal_resolver.agent import (
    MEDIA_MEAL_RESOLVER_AGENT_NAME,
    resolve_media_meals,
)
from app.agents.media_meal_resolver.models import (
    GlobalCategoryContext,
    GlobalDishContext,
    HouseholdPortionContext,
    MediaMealResolverRunResult,
    MediaResolutionPlan,
    MediaResolverInput,
    ResolvedMediaDish,
)
from app.config.settings import settings
from app.domain.dishes import repository as dish_repo
from app.domain.messages import repository as message_repo
from app.services.prompts import trace_agent
from app.utils.logger import logger


def _usage(responses: list[Any]) -> tuple[int | None, int | None, float | None]:
    def value(usage: Any, key: str) -> Any:
        return usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)

    usages: list[Any] = []
    for response in responses:
        if isinstance(response, dict):
            usages.extend(
                usage
                for message in (response.get("messages") or [])
                if (usage := getattr(message, "usage_metadata", None))
            )
        elif usage := getattr(response, "usage", None):
            usages.append(usage)
    inputs = [amount for usage in usages if (amount := value(usage, "input_tokens"))]
    outputs = [amount for usage in usages if (amount := value(usage, "output_tokens"))]
    costs = [amount for usage in usages if (amount := value(usage, "cost_usd"))]
    return (
        sum(inputs) if inputs else None,
        sum(outputs) if outputs else None,
        sum(costs) if costs else None,
    )


async def _record_run(row: dict[str, Any]) -> None:
    try:
        await message_repo.create_agent_run(row)
    except Exception as exc:
        logger.warning("agent_run_persist_failed agent=media_meal_resolver error={}", str(exc))


def _resolver_input(
    *,
    facts: MediaFacts,
    dishes: list[dict[str, Any]],
    categories: list[dict[str, Any]],
    household: list[dict[str, Any]],
    fallback_names: dict[str, str] | None = None,
) -> MediaResolverInput:
    return MediaResolverInput(
        facts=facts,
        global_dishes=[
            GlobalDishContext(
                food_id=str(row["dish_id"]),
                name=str(row["name"]),
                normalized_name=str(row["name_normalized"]),
                aliases=list(row.get("aliases") or []),
                category=str(row["category"]),
            )
            for row in dishes
        ],
        global_categories=[
            GlobalCategoryContext(
                category=str(row["category"]),
                portion_unit=str(row["portion_unit"]),
                portion_grams=row["portion_grams"],
                portion_count=row.get("portion_count") or 1,
            )
            for row in categories
        ],
        household_portions=[
            HouseholdPortionContext(
                category=str(row["category"]),
                portion_unit=str(row["portion_unit"]),
                portion_grams=row["portion_grams"],
                portion_count=row.get("portion_count") or 1,
                is_custom=bool(row.get("is_custom", False)),
            )
            for row in household
        ],
        fallback_names=fallback_names or {},
    )


def _unknown_fallback_names(facts: MediaFacts, created_at: datetime) -> dict[str, str]:
    timestamp = created_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    return {
        item.evidence_id: f"Unknown dish {timestamp} #{index}"
        for index, item in enumerate(facts.items, start=1)
    }


def validate_media_resolution_plan(
    resolver_input: MediaResolverInput, plan: MediaResolutionPlan
) -> None:
    evidence_ids = {item.evidence_id for item in resolver_input.facts.items}
    decision_ids = [decision.evidence_id for decision in plan.decisions]
    if len(decision_ids) != len(set(decision_ids)) or set(decision_ids) != evidence_ids:
        raise ValueError("Media resolution requires exactly one decision per evidence item")
    food_ids = {dish.food_id for dish in resolver_input.global_dishes}
    dishes_by_id = {dish.food_id: dish for dish in resolver_input.global_dishes}
    categories = {category.category for category in resolver_input.global_categories}
    for decision in plan.decisions:
        if decision.action == "match_existing" and decision.selected_food_id not in food_ids:
            raise ValueError("Media resolver selected a food ID outside the supplied catalog")
        if decision.action == "create_new" and (
            not decision.selected_food_id
            or not decision.category
            or not decision.canonical_name
            or decision.selected_food_id not in food_ids
            or dishes_by_id[decision.selected_food_id].category != decision.category
            or (
                decision.category == "unknown"
                and decision.canonical_name
                != resolver_input.fallback_names.get(decision.evidence_id)
            )
        ):
            raise ValueError("Media resolver did not complete global dish creation")
        if decision.category and decision.category not in categories:
            raise ValueError("Media resolver selected a category outside the supplied catalog")


def media_resolution_repair_ids(
    resolver_input: MediaResolverInput, plan: MediaResolutionPlan
) -> list[str]:
    decision_ids = [decision.evidence_id for decision in plan.decisions]
    food_ids = {dish.food_id for dish in resolver_input.global_dishes}
    dishes_by_id = {dish.food_id: dish for dish in resolver_input.global_dishes}
    categories = {category.category for category in resolver_input.global_categories}
    decisions_by_id = {decision.evidence_id: decision for decision in plan.decisions}
    return [
        item.evidence_id
        for item in resolver_input.facts.items
        if decision_ids.count(item.evidence_id) != 1
        or (
            (decision := decisions_by_id.get(item.evidence_id)) is not None
            and (
                (
                    decision.action == "match_existing"
                    and decision.selected_food_id not in food_ids
                )
                or (
                    decision.action == "create_new"
                    and (
                        not decision.selected_food_id
                        or not decision.category
                        or not decision.canonical_name
                        or decision.selected_food_id not in food_ids
                        or (
                            decision.selected_food_id in dishes_by_id
                            and dishes_by_id[decision.selected_food_id].category
                            != decision.category
                        )
                        or (
                            decision.category == "unknown"
                            and decision.canonical_name
                            != resolver_input.fallback_names.get(decision.evidence_id)
                        )
                    )
                )
                or (decision.category is not None and decision.category not in categories)
            )
        )
    ]


def merge_media_resolution_plans(
    resolver_input: MediaResolverInput,
    initial: MediaResolutionPlan,
    repaired: MediaResolutionPlan | None,
) -> MediaResolutionPlan:
    repair_ids = set(media_resolution_repair_ids(resolver_input, initial))
    candidates = [
        decision
        for decision in initial.decisions
        if decision.evidence_id not in repair_ids
    ]
    if repaired is not None:
        candidates.extend(
            decision for decision in repaired.decisions if decision.evidence_id in repair_ids
        )
    by_id: dict[str, list[Any]] = {}
    for decision in candidates:
        by_id.setdefault(decision.evidence_id, []).append(decision)
    ordered = [
        decisions[0]
        for item in resolver_input.facts.items
        if len(decisions := by_id.get(item.evidence_id, [])) == 1
    ]
    return MediaResolutionPlan(decisions=ordered)


async def _apply_plan(
    *,
    resolver_input: MediaResolverInput,
    plan: MediaResolutionPlan,
) -> list[ResolvedMediaDish]:
    dishes = {dish.food_id: dish for dish in resolver_input.global_dishes}
    output: list[ResolvedMediaDish] = []
    for decision in plan.decisions:
        if decision.action == "match_existing":
            selected = dishes[decision.selected_food_id or ""]
            output.append(
                ResolvedMediaDish(
                    evidence_id=decision.evidence_id,
                    food_id=selected.food_id,
                    name=selected.name,
                    category=selected.category,
                    confidence=decision.confidence,
                    action="match_existing",
                )
            )
            continue
        created = await dish_repo.get_dish(decision.selected_food_id or "")
        if not created or str(created["category"]) != decision.category:
            raise ValueError("create_new must use the food_id returned by create_global_dish")
        output.append(
            ResolvedMediaDish(
                evidence_id=decision.evidence_id,
                food_id=str(created["dish_id"]),
                name=str(created["name"]),
                category=str(created["category"]),
                confidence=decision.confidence,
                action="create_new",
            )
        )
    return output


async def run_media_meal_resolver_agent(
    *,
    user_id: str,
    thread_id: str,
    facts: MediaFacts,
    correlation_id: str | None = None,
) -> MediaMealResolverRunResult:
    """Resolve/create catalog dishes only; never write customer meal rows."""
    started = time.perf_counter()
    prompt_name = prompt_version = prompt_source = None
    try:
        dishes, categories, household = await asyncio.gather(
            dish_repo.list_active_dishes(),
            dish_repo.list_active_categories(),
            dish_repo.list_category_portions(user_id),
        )
        fallback_names = _unknown_fallback_names(facts, datetime.now(UTC))
        resolver_input = _resolver_input(
            facts=facts,
            dishes=dishes,
            categories=categories,
            household=household,
            fallback_names=fallback_names,
        )
        with trace_agent(
            MEDIA_MEAL_RESOLVER_AGENT_NAME,
            {"thread_id": thread_id, "item_count": len(facts.items)},
            {"resolver_input": resolver_input.model_dump(mode="json")},
        ) as trace_run:
            plan, prompt, response = await resolve_media_meals(
                resolver_input,
                user_id=user_id,
                thread_id=thread_id,
            )
            responses = [response]
            dishes = await dish_repo.list_active_dishes()
            resolver_input = _resolver_input(
                facts=facts,
                dishes=dishes,
                categories=categories,
                household=household,
                fallback_names=fallback_names,
            )
            plan = merge_media_resolution_plans(resolver_input, plan, None)
            for _attempt in range(2):
                repair_ids = media_resolution_repair_ids(resolver_input, plan)
                if not repair_ids:
                    break
                repair_id_set = set(repair_ids)
                repair_facts = facts.model_copy(
                    update={
                        "items": [
                            item for item in facts.items if item.evidence_id in repair_id_set
                        ]
                    }
                )
                repair_input = _resolver_input(
                    facts=repair_facts,
                    dishes=dishes,
                    categories=categories,
                    household=household,
                    fallback_names={
                        evidence_id: fallback_names[evidence_id]
                        for evidence_id in repair_id_set
                    },
                )
                repaired_plan, prompt, response = await resolve_media_meals(
                    repair_input,
                    user_id=user_id,
                    thread_id=thread_id,
                )
                responses.append(response)
                dishes = await dish_repo.list_active_dishes()
                resolver_input = _resolver_input(
                    facts=facts,
                    dishes=dishes,
                    categories=categories,
                    household=household,
                    fallback_names=fallback_names,
                )
                plan = merge_media_resolution_plans(resolver_input, plan, repaired_plan)
            validate_media_resolution_plan(resolver_input, plan)
            if trace_run is not None:
                trace_run.add_inputs(
                    {"resolver_input": resolver_input.model_dump(mode="json")}
                )
                trace_run.add_outputs(
                    {
                        "plan": plan.model_dump(mode="json"),
                        "prompt_name": prompt.name,
                        "prompt_version": prompt.version,
                        "prompt_source": prompt.source,
                    }
                )
            resolved = await _apply_plan(
                resolver_input=resolver_input,
                plan=plan,
            )
            if trace_run is not None:
                trace_run.add_outputs(
                    {
                        "resolved_dishes": [dish.model_dump(mode="json") for dish in resolved],
                    }
                )
        prompt_name, prompt_version, prompt_source = prompt.name, prompt.version, prompt.source
        input_tokens, output_tokens, cost_usd = _usage(responses)
        result = MediaMealResolverRunResult(
            dishes=resolved,
            plan=plan,
            model=settings.MEDIA_MEAL_RESOLVER_MODEL,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            prompt_name=prompt_name,
            prompt_version=prompt_version,
            prompt_source=prompt_source,
            raw_metadata={"thread_id": thread_id},
        )
    except Exception as exc:
        await _record_run(
            {
                "user_id": user_id,
                "correlation_id": correlation_id,
                "agent_name": MEDIA_MEAL_RESOLVER_AGENT_NAME,
                "model": settings.MEDIA_MEAL_RESOLVER_MODEL,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "status": "failed",
                "error_message": str(exc),
                "output": {"prompt_name": prompt_name, "prompt_version": prompt_version},
            }
        )
        raise
    await _record_run(
        {
            "user_id": user_id,
            "correlation_id": correlation_id,
            "agent_name": MEDIA_MEAL_RESOLVER_AGENT_NAME,
            "model": result.model,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "cost_usd": result.cost_usd,
            "status": "ok",
            "output": {
                "item_count": len(result.dishes),
                "prompt_name": result.prompt_name,
                "prompt_version": result.prompt_version,
                "prompt_source": result.prompt_source,
            },
        }
    )
    return result
