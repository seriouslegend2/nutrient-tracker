"""Validated domain executors for confirmed nutrition-chat actions."""

from __future__ import annotations

import json
from datetime import date
from typing import Any
from uuid import UUID

from app.domain.agent_actions.models import AgentAction, JsonObject
from app.domain.agent_actions.repository import repository as action_repository
from app.domain.agent_actions.service import default_dispatcher
from app.domain.dishes import repository as dish_repo
from app.domain.dishes.resolve import resolve_item
from app.domain.goals import service as goals_service
from app.domain.meals import repository as meals_repo
from app.domain.meals import service as meals_service
from app.domain.profile import repository as profile_repo
from app.domain.water import service as water_service


def _date(value: Any) -> date:
    return date.fromisoformat(str(value))


async def _log_meal(action: AgentAction) -> JsonObject:
    args = action.arguments
    row = await meals_service.add_item(
        user_id=str(action.user_id),
        meal_date=_date(args["meal_date"]),
        meal_type=str(args["meal_type"]),
        dish_name=str(args["dish_name"]),
        food_id=str(args["food_id"]) if args.get("food_id") else None,
        portions=float(args.get("portions") or 1),
        grams=float(args["grams"]) if args.get("grams") is not None else None,
        source="chat",
    )
    return {"meal_id": str(row["id"]), "resolved_from": str(row.get("resolved_from") or "unknown")}


async def _log_nutrition(action: AgentAction) -> JsonObject:
    args = action.arguments
    nutrients = {
        key: float(args[key])
        for key in ("calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g")
        if args.get(key) is not None
    }
    row = await meals_service.add_item(
        user_id=str(action.user_id),
        meal_date=_date(args["meal_date"]),
        meal_type=str(args["meal_type"]),
        dish_name=str(args["label"]) if args.get("label") else None,
        portions=1,
        portion_unit="serving",
        source="chat",
        nutrients=nutrients,
    )
    return {"meal_id": str(row["id"]), "resolved_from": "meals"}


async def _edit_meal(action: AgentAction) -> JsonObject:
    args = action.arguments
    row = await meals_service.adjust_item(
        user_id=str(action.user_id),
        meal_id=str(args["meal_id"]),
        portions=float(args["portions"]) if args.get("portions") is not None else None,
        grams=float(args["grams"]) if args.get("grams") is not None else None,
    )
    return {"meal_id": str(row["id"]), "version": int(row["version"])}


async def _remove_meal(action: AgentAction) -> JsonObject:
    deleted = await meals_repo.delete_meal(str(action.user_id), str(action.arguments["meal_id"]))
    if not deleted:
        raise ValueError("Meal item was not found or is no longer active")
    return {"deleted": True}


async def _set_goal(action: AgentAction) -> JsonObject:
    args = action.arguments
    current_preview = await goals_service.preview(
        user_id=str(action.user_id),
        kind=str(args["kind"]),
        spec=dict(args["spec"]),
        starts_on=_date(args["starts_on"]),
        ends_on=_date(args["ends_on"]),
        cadence=str(args.get("cadence") or "daily"),
        make_primary=bool(args.get("make_primary")),
    )
    if json.dumps(current_preview, sort_keys=True, default=str) != json.dumps(
        args.get("safety_preview"), sort_keys=True, default=str
    ):
        raise ValueError("Goal safety resolution changed; prepare a new goal proposal")
    goal = await goals_service.create_goal(
        user_id=str(action.user_id),
        kind=str(args["kind"]),
        spec=dict(args["spec"]),
        starts_on=_date(args["starts_on"]),
        ends_on=_date(args["ends_on"]),
        cadence=str(args.get("cadence") or "daily"),
        make_primary=bool(args.get("make_primary")),
    )
    return {"goal_id": str(goal["goal_id"]), "kind": str(goal["kind"])}


async def _log_water(action: AgentAction) -> JsonObject:
    args = action.arguments
    row = await water_service.log_water(
        str(action.user_id), float(args["volume_ml"]), _date(args["logged_on"])
    )
    return {"water_log_id": str(row["id"]), "volume_ml": float(row["volume_ml"])}


async def _log_weight(action: AgentAction) -> JsonObject:
    args = action.arguments
    row = await profile_repo.add_body_metric(
        str(action.user_id),
        float(args["weight_kg"]),
        measured_on=_date(args["measured_on"]),
    )
    return {"body_metric_id": str(row["id"]), "weight_kg": float(row["weight_kg"])}


async def _set_portion(action: AgentAction) -> JsonObject:
    args = action.arguments
    row = await dish_repo.set_category_household(
        user_id=str(action.user_id),
        category=str(args["category"]),
        portion_count=float(args["portion_count"]),
        source="chat",
    )
    return {"category": str(row["category"]), "portion_count": float(row["portion_count"])}


async def _identify_unknown(action: AgentAction) -> JsonObject:
    args = action.arguments
    user_id = str(action.user_id)
    meal_id = str(args["meal_id"])
    food_id = str(args["food_id"])
    current = await meals_repo.get_meal(user_id, meal_id)
    dish = await dish_repo.get_dish(food_id)
    if not current or not dish:
        raise ValueError("Meal item or catalog dish was not found")
    resolution = await resolve_item(
        user_id=user_id,
        dish_name=current["dish_name"],
        food_id=food_id,
        category=dish["category"],
        portions=current["portions"],
        grams_override=current.get("grams"),
        portion_unit_override=current.get("portion_unit"),
    )
    updated = await meals_repo.update_meal(
        user_id,
        meal_id,
        {
            "dish_name": dish["name"],
            "food_id": food_id,
            "category": dish["category"],
            "portion_unit": resolution.portion_unit,
            "grams": resolution.grams,
            "nutrients": resolution.nutrients,
            "resolved_from": resolution.resolved_from,
        },
    )
    if not updated:
        raise ValueError("Meal item is no longer active")
    return {"meal_id": str(updated["id"]), "food_id": food_id}


async def _set_goal_active(action: AgentAction) -> JsonObject:
    args = action.arguments
    goal = await goals_service.set_active(
        str(action.user_id), str(args["goal_id"]), bool(args["active"])
    )
    return {"goal_id": str(goal["goal_id"]), "active": bool(goal.get("is_active"))}


async def _set_goal_primary(action: AgentAction) -> JsonObject:
    goal = await goals_service.set_primary(str(action.user_id), str(action.arguments["goal_id"]))
    return {"goal_id": str(goal["goal_id"]), "is_primary": bool(goal.get("is_primary"))}


async def _training_check_in(action: AgentAction) -> JsonObject:
    row = await goals_service.check_in_activity(
        str(action.user_id), _date(action.arguments["activity_date"])
    )
    return {
        "activity_log_id": str(row["id"]),
        "activity_date": str(row["activity_date"]),
        "activity_type": str(row["activity_type"]),
    }


async def _execute_atomic_meal_action(action: AgentAction, claim_token: UUID) -> AgentAction:
    args = action.arguments
    if action.action_type == "log_meal":
        item = await meals_service.prepare_item(
            user_id=str(action.user_id),
            meal_type=str(args["meal_type"]),
            dish_name=str(args["dish_name"]),
            food_id=str(args["food_id"]) if args.get("food_id") else None,
            portions=float(args.get("portions") or 1),
            grams=float(args["grams"]) if args.get("grams") is not None else None,
            source="chat",
        )
        prepared: JsonObject = {"item": item}
    elif action.action_type == "log_nutrition_entry":
        nutrients = {
            key: float(args[key])
            for key in ("calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g")
            if args.get(key) is not None
        }
        item = await meals_service.prepare_item(
            user_id=str(action.user_id),
            meal_type=str(args["meal_type"]),
            dish_name=str(args["label"]) if args.get("label") else None,
            portions=1,
            portion_unit="serving",
            source="chat",
            nutrients=nutrients,
            derive_calories=False,
        )
        prepared = {"item": item}
    elif action.action_type == "edit_meal":
        prepared = {
            "patch": await meals_service.prepare_adjustment(
                user_id=str(action.user_id),
                meal_id=str(args["meal_id"]),
                portions=float(args["portions"]) if args.get("portions") is not None else None,
                grams=float(args["grams"]) if args.get("grams") is not None else None,
            )
        }
    elif action.action_type == "identify_unknown_item":
        user_id = str(action.user_id)
        meal_id = str(args["meal_id"])
        food_id = str(args["food_id"])
        current = await meals_repo.get_meal(user_id, meal_id)
        dish = await dish_repo.get_dish(food_id)
        if not current or not dish:
            raise ValueError("Meal item or catalog dish was not found")
        resolution = await resolve_item(
            user_id=user_id,
            dish_name=current["dish_name"],
            food_id=food_id,
            category=dish["category"],
            portions=current["portions"],
            grams_override=current.get("grams"),
            portion_unit_override=current.get("portion_unit"),
        )
        prepared = {
            "patch": {
                "dish_name": dish["name"],
                "food_id": food_id,
                "category": dish["category"],
                "portion_unit": resolution.portion_unit,
                "grams": resolution.grams,
                "nutrients": resolution.nutrients,
                "resolved_from": resolution.resolved_from,
            }
        }
    else:
        prepared = {}
    row = await action_repository.execute_meal_action(
        user_id=str(action.user_id),
        action_id=action.id,
        claim_token=claim_token,
        prepared=prepared,
    )
    return AgentAction.model_validate(row)


def register_action_executors() -> None:
    registrations = {
        "set_goal": _set_goal,
        "log_water": _log_water,
        "log_weight": _log_weight,
        "set_portion_default": _set_portion,
        "set_goal_active": _set_goal_active,
        "set_goal_primary": _set_goal_primary,
        "training_check_in": _training_check_in,
    }
    for action_type, executor in registrations.items():
        try:
            default_dispatcher.register(action_type, executor)
        except ValueError as exc:
            if "already registered" not in str(exc):
                raise
    for action_type in (
        "log_meal",
        "log_nutrition_entry",
        "edit_meal",
        "remove_meal",
        "identify_unknown_item",
    ):
        try:
            default_dispatcher.register_atomic(action_type, _execute_atomic_meal_action)
        except ValueError as exc:
            if "already registered" not in str(exc):
                raise
