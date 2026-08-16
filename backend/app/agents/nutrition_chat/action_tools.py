"""Durable mutation proposals for nutrition chat.

These tools never mutate nutrition-domain rows directly. They persist one
immutable action which is executed only through the user-scoped confirmation
endpoint.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.exceptions import AppError
from app.domain.agent_actions import service as action_service
from app.domain.agent_actions.models import public_action
from app.domain.dishes import repository as dish_repo
from app.domain.goals import service as goals_service
from app.domain.meals.servings import MealServings

MealType = Literal["breakfast", "brunch", "lunch", "snacks", "dinner", "misc"]


class StrictActionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class LogDishesInput(StrictActionInput):
    meal_date: date
    meal_type: MealType
    dish_name: str = Field(min_length=1, max_length=200)
    food_id: str | None = Field(..., max_length=100)
    portions: MealServings = Field(..., le=100)
    grams: float | None = Field(..., gt=0, le=100_000)


class LogNutritionEntryInput(StrictActionInput):
    meal_date: date
    meal_type: MealType
    label: str | None = Field(..., max_length=200)
    calories_kcal: float | None = Field(..., ge=0, le=100_000)
    protein_g: float | None = Field(..., ge=0, le=10_000)
    carbs_g: float | None = Field(..., ge=0, le=10_000)
    fat_g: float | None = Field(..., ge=0, le=10_000)
    fiber_g: float | None = Field(..., ge=0, le=10_000)

    @model_validator(mode="after")
    def require_nutrition(self) -> LogNutritionEntryInput:
        if all(
            value is None
            for value in (
                self.calories_kcal,
                self.protein_g,
                self.carbs_g,
                self.fat_g,
                self.fiber_g,
            )
        ):
            raise ValueError("At least one stated nutrient value is required")
        return self


class EditMealInput(StrictActionInput):
    meal_id: str = Field(min_length=1, max_length=100)
    portions: MealServings | None = Field(..., le=100)
    grams: float | None = Field(..., gt=0, le=100_000)

    @model_validator(mode="after")
    def require_change(self) -> EditMealInput:
        if self.portions is None and self.grams is None:
            raise ValueError("A new portion count or exact weight is required")
        return self


class RemoveMealInput(StrictActionInput):
    meal_id: str = Field(min_length=1, max_length=100)


class SetGoalInput(StrictActionInput):
    kind: Literal["nutrient", "body_weight", "item", "hydration", "behaviour"]
    spec_json: str = Field(
        min_length=2,
        max_length=4000,
        description="Goal specification as a JSON object string",
    )
    starts_on: date
    ends_on: date
    cadence: Literal["daily", "weekly", "monthly", "period"]
    make_primary: bool

    @model_validator(mode="after")
    def validate_spec_json(self) -> SetGoalInput:
        try:
            value = json.loads(self.spec_json)
        except json.JSONDecodeError as exc:
            raise ValueError("spec_json must contain valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("spec_json must contain a JSON object")
        return self

    def parsed_spec(self) -> dict[str, Any]:
        return json.loads(self.spec_json)


class LogWaterInput(StrictActionInput):
    volume_ml: float = Field(gt=0, le=20_000)
    logged_on: date


class LogWeightInput(StrictActionInput):
    weight_kg: float = Field(gt=0, lt=500)
    measured_on: date


class SetPortionInput(StrictActionInput):
    category: str = Field(min_length=1, max_length=100)
    portion_count: float = Field(gt=0, le=20)


class IdentifyUnknownInput(StrictActionInput):
    meal_id: str = Field(min_length=1, max_length=100)
    food_id: str = Field(min_length=1, max_length=100)


class GoalStateInput(StrictActionInput):
    goal_id: str = Field(min_length=1, max_length=100)
    active: bool


class GoalPrimaryInput(StrictActionInput):
    goal_id: str = Field(min_length=1, max_length=100)


class TrainingCheckInInput(StrictActionInput):
    activity_date: date


def _runtime_value(config: RunnableConfig, key: str) -> str | None:
    value = (config or {}).get("configurable", {}).get(key)
    return str(value) if value else None


def _runtime_flag(config: RunnableConfig, key: str) -> bool:
    return (config or {}).get("configurable", {}).get(key) is True


async def _propose(
    *,
    action_type: str,
    arguments: dict[str, Any],
    summary: str,
    config: RunnableConfig,
) -> dict[str, Any]:
    user_id = _runtime_value(config, "user_id")
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    source = _runtime_value(config, "source_message_id") or _runtime_value(config, "thread_id")
    safe_arguments = json.loads(json.dumps(arguments, sort_keys=True, default=str))
    canonical = json.dumps(safe_arguments, sort_keys=True, separators=(",", ":"))
    key_material = f"nutrition-chat-v2\n{source or 'unknown'}\n{action_type}\n{canonical}"
    idempotency_key = hashlib.sha256(key_material.encode("utf-8")).hexdigest()
    action = await action_service.create_action(
        user_id=user_id,
        action_type=action_type,
        arguments=safe_arguments,
        summary=summary,
        idempotency_key=idempotency_key,
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    if _runtime_flag(config, "auto_execute_actions"):
        action = await action_service.confirm_and_execute(
            user_id=user_id,
            action_id=action.id,
        )
        status = action.status.value.upper()
        return {
            "status": status,
            "message": (
                "The requested tracker change was applied."
                if status == "COMPLETED"
                else "The requested tracker change could not be applied."
            ),
            "agent_action": public_action(action).model_dump(mode="json"),
        }
    return {
        "status": "PROPOSED",
        "message": "The change is ready for the user to confirm.",
        "agent_action": public_action(action).model_dump(mode="json"),
    }


@tool("log_dishes", args_schema=LogDishesInput)
async def propose_log_dishes(
    meal_date: date,
    meal_type: MealType,
    dish_name: str,
    food_id: str | None = None,
    portions: float = 1,
    grams: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a meal log for explicit customer confirmation."""
    arguments = LogDishesInput(
        meal_date=meal_date,
        meal_type=meal_type,
        dish_name=dish_name,
        food_id=food_id,
        portions=portions,
        grams=grams,
    ).model_dump(mode="json")
    amount = (
        f"{grams:g} g ({portions:g} serving{'s' if portions != 1 else ''})"
        if grams is not None
        else f"{portions:g} serving{'s' if portions != 1 else ''}"
    )
    return await _propose(
        action_type="log_meal",
        arguments=arguments,
        summary=f"Log {amount} of {dish_name} for {meal_type} on {meal_date.isoformat()}.",
        config=config,
    )


@tool("log_nutrition_entry", args_schema=LogNutritionEntryInput)
async def propose_log_nutrition_entry(
    meal_date: date,
    meal_type: MealType,
    label: str | None = None,
    calories_kcal: float | None = None,
    protein_g: float | None = None,
    carbs_g: float | None = None,
    fat_g: float | None = None,
    fiber_g: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare an exact user-stated nutrient entry; never estimate missing values."""
    model = LogNutritionEntryInput(
        meal_date=meal_date,
        meal_type=meal_type,
        label=label,
        calories_kcal=calories_kcal,
        protein_g=protein_g,
        carbs_g=carbs_g,
        fat_g=fat_g,
        fiber_g=fiber_g,
    )
    stated = [
        f"{value:g} {unit}"
        for value, unit in (
            (calories_kcal, "kcal"),
            (protein_g, "g protein"),
            (carbs_g, "g carbs"),
            (fat_g, "g fat"),
            (fiber_g, "g fiber"),
        )
        if value is not None
    ]
    return await _propose(
        action_type="log_nutrition_entry",
        arguments=model.model_dump(mode="json"),
        summary=f"Log {', '.join(stated)} for {label or meal_type} on {meal_date.isoformat()}.",
        config=config,
    )


@tool("edit_meal_dish", args_schema=EditMealInput)
async def propose_edit_meal(
    meal_id: str,
    portions: float | None = None,
    grams: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a quantity change for one exact active meal item."""
    model = EditMealInput(meal_id=meal_id, portions=portions, grams=grams)
    changes = []
    if portions is not None:
        changes.append(f"{portions:g} servings")
    if grams is not None:
        changes.append(f"{grams:g} g")
    return await _propose(
        action_type="edit_meal",
        arguments=model.model_dump(mode="json"),
        summary=f"Change the selected meal item to {' and '.join(changes)}.",
        config=config,
    )


@tool("remove_meal_dish", args_schema=RemoveMealInput)
async def propose_remove_meal(meal_id: str, config: RunnableConfig = None) -> dict[str, Any]:
    """Prepare removal of one exact active meal item."""
    return await _propose(
        action_type="remove_meal",
        arguments={"meal_id": meal_id},
        summary="Remove the selected meal item.",
        config=config,
    )


@tool("set_goal", args_schema=SetGoalInput)
async def propose_set_goal(
    kind: str,
    spec_json: str,
    starts_on: date,
    ends_on: date,
    cadence: str,
    make_primary: bool,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a goal that will still pass through server safety resolution."""
    model = SetGoalInput(
        kind=kind,
        spec_json=spec_json,
        starts_on=starts_on,
        ends_on=ends_on,
        cadence=cadence,
        make_primary=make_primary,
    )
    spec = model.parsed_spec()
    user_id = _runtime_value(config, "user_id")
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    preview = await goals_service.preview(
        user_id=user_id,
        kind=kind,
        spec=spec,
        starts_on=starts_on,
        ends_on=ends_on,
        cadence=cadence,
        make_primary=make_primary,
    )
    arguments = model.model_dump(mode="json", exclude={"spec_json"})
    arguments["spec"] = spec
    arguments["safety_preview"] = preview
    targets = (preview.get("daily_targets") or {}).get("targets") or []
    target_text = ", ".join(
        f"{target.get('metric')} {target.get('direction')} {target.get('value')} {target.get('unit')}"
        for target in targets
    )
    safety_text = "Safety-adjusted target" if preview.get("clamp_fired") else "Resolved target"
    return await _propose(
        action_type="set_goal",
        arguments=arguments,
        summary=(
            f"Create a {cadence} {kind.replace('_', ' ')} goal through "
            f"{ends_on.isoformat()}. {safety_text}: {target_text or 'server-validated goal'}."
        ),
        config=config,
    )


@tool("log_water", args_schema=LogWaterInput)
async def propose_log_water(
    volume_ml: float,
    logged_on: date,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a water log for one user-local date."""
    return await _propose(
        action_type="log_water",
        arguments={"volume_ml": volume_ml, "logged_on": logged_on.isoformat()},
        summary=f"Log {volume_ml:g} ml of water on {logged_on.isoformat()}.",
        config=config,
    )


@tool("log_weight", args_schema=LogWeightInput)
async def propose_log_weight(
    weight_kg: float,
    measured_on: date,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a body-weight measurement."""
    return await _propose(
        action_type="log_weight",
        arguments={"weight_kg": weight_kg, "measured_on": measured_on.isoformat()},
        summary=f"Log body weight of {weight_kg:g} kg on {measured_on.isoformat()}.",
        config=config,
    )


@tool("set_portion_default", args_schema=SetPortionInput)
async def propose_set_portion(
    category: str,
    portion_count: float,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare a change to the user's usual fixed-unit count."""
    return await _propose(
        action_type="set_portion_default",
        arguments={"category": category, "portion_count": portion_count},
        summary=f"Set the usual {category.replace('_', ' ')} serving to {portion_count:g} fixed units.",
        config=config,
    )


@tool("identify_unknown_item", args_schema=IdentifyUnknownInput)
async def propose_identify_unknown(
    meal_id: str,
    food_id: str,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare linking one unresolved meal to one selected catalog dish."""
    return await _propose(
        action_type="identify_unknown_item",
        arguments={"meal_id": meal_id, "food_id": food_id},
        summary="Resolve the selected unknown meal using the selected catalog dish.",
        config=config,
    )


@tool("set_goal_active", args_schema=GoalStateInput)
async def propose_goal_state(
    goal_id: str,
    active: bool,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare activation or deactivation of one exact goal."""
    return await _propose(
        action_type="set_goal_active",
        arguments={"goal_id": goal_id, "active": active},
        summary=f"{'Activate' if active else 'Deactivate'} the selected goal.",
        config=config,
    )


@tool("set_goal_primary", args_schema=GoalPrimaryInput)
async def propose_goal_primary(
    goal_id: str,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare making one active goal the primary goal."""
    return await _propose(
        action_type="set_goal_primary",
        arguments={"goal_id": goal_id},
        summary="Make the selected goal the primary goal.",
        config=config,
    )


@tool("check_in_training", args_schema=TrainingCheckInInput)
async def propose_training_check_in(
    activity_date: date,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Prepare an explicit training check-in for one user-local date."""
    return await _propose(
        action_type="training_check_in",
        arguments={"activity_date": activity_date.isoformat()},
        summary=f"Record a training check-in on {activity_date.isoformat()}.",
        config=config,
    )


class ManageMealEntryInput(StrictActionInput):
    operation: Literal["create", "update_quantity", "delete", "identify"]
    entry_basis: Literal["catalog_or_free_text", "user_stated_nutrition"] | None = Field(...)
    meal_id: str | None = Field(..., min_length=1, max_length=100)
    meal_date: date | None = Field(...)
    meal_type: MealType | None = Field(...)
    dish_name: str | None = Field(..., min_length=1, max_length=200)
    food_id: str | None = Field(..., min_length=1, max_length=100)
    portions: MealServings | None = Field(..., le=100)
    grams: float | None = Field(..., gt=0, le=100_000)
    calories_kcal: float | None = Field(..., ge=0, le=100_000)
    protein_g: float | None = Field(..., ge=0, le=10_000)
    carbs_g: float | None = Field(..., ge=0, le=10_000)
    fat_g: float | None = Field(..., ge=0, le=10_000)
    fiber_g: float | None = Field(..., ge=0, le=10_000)

    @model_validator(mode="after")
    def validate_operation(self) -> ManageMealEntryInput:
        nutrients = (
            self.calories_kcal,
            self.protein_g,
            self.carbs_g,
            self.fat_g,
            self.fiber_g,
        )
        if self.operation == "create":
            if self.meal_id is not None or self.meal_date is None or self.meal_type is None:
                raise ValueError("Create requires meal_date and meal_type, without meal_id")
            if self.entry_basis == "catalog_or_free_text":
                if not self.dish_name or any(value is not None for value in nutrients):
                    raise ValueError("Food creation requires a name and no supplied nutrients")
            elif self.entry_basis == "user_stated_nutrition":
                if self.food_id is not None or self.portions is not None or self.grams is not None:
                    raise ValueError(
                        "Nutrition creation cannot include catalog identity or quantity"
                    )
                if all(value is None for value in nutrients):
                    raise ValueError("Nutrition creation requires at least one stated nutrient")
            else:
                raise ValueError("Create requires entry_basis")
            return self

        if not self.meal_id:
            raise ValueError(f"{self.operation} requires meal_id")
        if self.operation == "update_quantity":
            if self.portions is None and self.grams is None:
                raise ValueError("Quantity update requires portions or grams")
        elif self.operation == "delete":
            self.portions = None
            self.grams = None
        elif self.operation == "identify":
            if not self.food_id and not self.dish_name:
                raise ValueError("Identify requires food_id or dish_name")
            self.portions = None
            self.grams = None
        self.entry_basis = None
        self.meal_date = None
        self.meal_type = None
        if self.operation != "identify":
            self.dish_name = None
        if self.operation != "identify":
            self.food_id = None
        self.calories_kcal = None
        self.protein_g = None
        self.carbs_g = None
        self.fat_g = None
        self.fiber_g = None
        return self


class ManageGoalInput(StrictActionInput):
    operation: Literal["create", "activate", "deactivate", "set_primary"]
    goal_id: str | None = Field(..., min_length=1, max_length=100)
    kind: Literal["nutrient", "body_weight", "item", "hydration", "behaviour"] | None = Field(...)
    spec_json: str | None = Field(
        ...,
        min_length=2,
        max_length=4000,
        description=(
            "JSON object. Nutrient example: "
            '{"nutrients":{"protein_g":100},"direction":"at_least"}. '
            'Hydration: {"target_ml":2400}. Behaviour: {"target":4}. '
            'Body weight: {"direction":"lose","amount_kg":5}.'
        ),
    )
    starts_on: date | None = Field(...)
    ends_on: date | None = Field(...)
    cadence: Literal["daily", "weekly", "monthly", "period"] | None = Field(...)
    make_primary: bool | None = Field(...)

    @model_validator(mode="after")
    def validate_operation(self) -> ManageGoalInput:
        create_values = (
            self.kind,
            self.spec_json,
            self.starts_on,
            self.ends_on,
            self.cadence,
            self.make_primary,
        )
        if self.operation == "create":
            if self.goal_id is not None or any(value is None for value in create_values):
                raise ValueError("Goal creation requires every goal field and no goal_id")
            try:
                spec = json.loads(self.spec_json or "")
            except json.JSONDecodeError as exc:
                raise ValueError("spec_json must contain valid JSON") from exc
            if not isinstance(spec, dict):
                raise ValueError("spec_json must contain a JSON object")
            if self.kind == "nutrient" and "nutrients" not in spec:
                metric = spec.get("nutrient") or spec.get("metric")
                target = spec.get("target") or spec.get("value")
                if metric is not None and target is not None:
                    direction = {
                        "gte": "at_least",
                        ">=": "at_least",
                        "lte": "at_most",
                        "<=": "at_most",
                    }.get(str(spec.get("operator") or spec.get("direction")), "at_least")
                    spec = {"nutrients": {str(metric): target}, "direction": direction}
                    self.spec_json = json.dumps(spec, separators=(",", ":"), sort_keys=True)
        elif not self.goal_id or any(value is not None for value in create_values):
            raise ValueError(f"{self.operation} requires only goal_id")
        return self


class RecordHealthEventInput(StrictActionInput):
    event_type: Literal["water", "weight", "training"]
    event_date: date
    volume_ml: float | None = Field(..., gt=0, le=20_000)
    weight_kg: float | None = Field(..., gt=0, lt=500)

    @model_validator(mode="after")
    def validate_event(self) -> RecordHealthEventInput:
        if self.event_type == "water" and (self.volume_ml is None or self.weight_kg is not None):
            raise ValueError("Water requires only volume_ml")
        if self.event_type == "weight" and (self.weight_kg is None or self.volume_ml is not None):
            raise ValueError("Weight requires only weight_kg")
        if self.event_type == "training" and (
            self.volume_ml is not None or self.weight_kg is not None
        ):
            raise ValueError("Training accepts only event_date")
        return self


class SetPortionPreferenceInput(StrictActionInput):
    category: str = Field(min_length=1, max_length=100)
    usual_count: float = Field(gt=0, le=20)


@tool("manage_meal_entry", args_schema=ManageMealEntryInput)
async def manage_meal_entry(
    operation: str,
    entry_basis: str | None = None,
    meal_id: str | None = None,
    meal_date: date | None = None,
    meal_type: MealType | None = None,
    dish_name: str | None = None,
    food_id: str | None = None,
    portions: float | None = None,
    grams: float | None = None,
    calories_kcal: float | None = None,
    protein_g: float | None = None,
    carbs_g: float | None = None,
    fat_g: float | None = None,
    fiber_g: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Apply one explicit text or voice meal change through the durable ledger.

    Create catalog_or_free_text for a named food and optional portions/grams;
    a null food_id intentionally stores an unknown food. Create
    user_stated_nutrition only for exact nutrient numbers supplied by the user.
    Existing rows can be quantity-updated, deleted, or identified by food_id or exact dish_name.
    Delete uses only operation and meal_id; set every other required nullable field to null.
    This tool executes immediately when auto_execute_actions is enabled.
    """
    model = ManageMealEntryInput(
        operation=operation,
        entry_basis=entry_basis,
        meal_id=meal_id,
        meal_date=meal_date,
        meal_type=meal_type,
        dish_name=dish_name,
        food_id=food_id,
        portions=portions,
        grams=grams,
        calories_kcal=calories_kcal,
        protein_g=protein_g,
        carbs_g=carbs_g,
        fat_g=fat_g,
        fiber_g=fiber_g,
    )
    if model.operation == "create" and model.entry_basis == "catalog_or_free_text":
        effective_portions = model.portions or 1.0
        amount = (
            f"{model.grams:g} g"
            if model.grams is not None
            else f"{effective_portions:g} serving(s)"
        )
        return await _propose(
            action_type="log_meal",
            arguments={
                "meal_date": model.meal_date.isoformat(),
                "meal_type": model.meal_type,
                "dish_name": model.dish_name,
                "food_id": model.food_id,
                "portions": effective_portions,
                "grams": model.grams,
            },
            summary=(
                f"Log {amount} of {model.dish_name} for {model.meal_type} "
                f"on {model.meal_date.isoformat()}."
            ),
            config=config,
        )
    if model.operation == "create":
        nutrients = {
            key: value
            for key, value in {
                "calories_kcal": model.calories_kcal,
                "protein_g": model.protein_g,
                "carbs_g": model.carbs_g,
                "fat_g": model.fat_g,
                "fiber_g": model.fiber_g,
            }.items()
            if value is not None
        }
        stated = ", ".join(f"{value:g} {key}" for key, value in nutrients.items())
        return await _propose(
            action_type="log_nutrition_entry",
            arguments={
                "meal_date": model.meal_date.isoformat(),
                "meal_type": model.meal_type,
                "label": model.dish_name,
                **{
                    key: getattr(model, key)
                    for key in ("calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g")
                },
            },
            summary=f"Log {stated} for {model.dish_name or model.meal_type} on {model.meal_date}.",
            config=config,
        )
    if model.operation == "update_quantity":
        changes = [
            text
            for text in (
                f"{model.portions:g} servings" if model.portions is not None else None,
                f"{model.grams:g} g" if model.grams is not None else None,
            )
            if text
        ]
        return await _propose(
            action_type="edit_meal",
            arguments={"meal_id": model.meal_id, "portions": model.portions, "grams": model.grams},
            summary=f"Change the selected meal item to {' and '.join(changes)}.",
            config=config,
        )
    if model.operation == "delete":
        return await _propose(
            action_type="remove_meal",
            arguments={"meal_id": model.meal_id},
            summary="Remove the selected meal item.",
            config=config,
        )
    food_id = model.food_id
    if not food_id and model.dish_name:
        matched = await dish_repo.find_by_name(model.dish_name)
        if not matched:
            candidates, _ = await dish_repo.search_dishes(model.dish_name, limit=5)
            return {
                "status": "ERROR",
                "message": (
                    "No exact catalog food matched that name. Ask the user to choose one "
                    "of the returned candidates, then retry identify with its food_id."
                ),
                "candidates": [
                    {"food_id": row.get("dish_id"), "name": row.get("name")}
                    for row in candidates
                ],
            }
        food_id = str(matched["dish_id"])
    return await _propose(
        action_type="identify_unknown_item",
        arguments={"meal_id": model.meal_id, "food_id": food_id},
        summary=f"Change the selected meal identity to {model.dish_name or 'the selected food'}.",
        config=config,
    )


@tool("manage_goal", args_schema=ManageGoalInput)
async def manage_goal(
    operation: str,
    goal_id: str | None = None,
    kind: str | None = None,
    spec_json: str | None = None,
    starts_on: date | None = None,
    ends_on: date | None = None,
    cadence: str | None = None,
    make_primary: bool | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Apply one explicit goal create, activation, deactivation, or primary change."""
    model = ManageGoalInput(
        operation=operation,
        goal_id=goal_id,
        kind=kind,
        spec_json=spec_json,
        starts_on=starts_on,
        ends_on=ends_on,
        cadence=cadence,
        make_primary=make_primary,
    )
    if model.operation == "create":
        spec = json.loads(model.spec_json or "{}")
        user_id = _runtime_value(config, "user_id")
        if not user_id:
            return {"status": "ERROR", "message": "No authenticated user in context"}
        try:
            preview = await goals_service.preview(
                user_id=user_id,
                kind=model.kind,
                spec=spec,
                starts_on=model.starts_on,
                ends_on=model.ends_on,
                cadence=model.cadence,
                make_primary=model.make_primary,
            )
        except AppError as exc:
            return {
                "status": "ERROR",
                "code": exc.code,
                "message": exc.message,
                "suggested_action": exc.suggested_action,
            }
        targets = (preview.get("daily_targets") or {}).get("targets") or []
        target_text = ", ".join(
            f"{target.get('metric')} {target.get('direction')} {target.get('value')} "
            f"{target.get('unit')}"
            for target in targets
        )
        safety_text = "Safety-adjusted target" if preview.get("clamp_fired") else "Resolved target"
        return await _propose(
            action_type="set_goal",
            arguments={
                "kind": model.kind,
                "spec": spec,
                "starts_on": model.starts_on.isoformat(),
                "ends_on": model.ends_on.isoformat(),
                "cadence": model.cadence,
                "make_primary": model.make_primary,
                "safety_preview": preview,
            },
            summary=(
                f"Create the reviewed {model.kind} goal through {model.ends_on}. "
                f"{safety_text}: {target_text or 'server-validated goal'}."
            ),
            config=config,
        )
    if model.operation == "set_primary":
        return await _propose(
            action_type="set_goal_primary",
            arguments={"goal_id": model.goal_id},
            summary="Make the selected goal the primary goal.",
            config=config,
        )
    active = model.operation == "activate"
    return await _propose(
        action_type="set_goal_active",
        arguments={"goal_id": model.goal_id, "active": active},
        summary=f"{'Activate' if active else 'Deactivate'} the selected goal.",
        config=config,
    )


@tool("record_health_event", args_schema=RecordHealthEventInput)
async def record_health_event(
    event_type: str,
    event_date: date,
    volume_ml: float | None = None,
    weight_kg: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Apply one explicit water, weight, or training event."""
    model = RecordHealthEventInput(
        event_type=event_type,
        event_date=event_date,
        volume_ml=volume_ml,
        weight_kg=weight_kg,
    )
    if model.event_type == "water":
        return await _propose(
            action_type="log_water",
            arguments={"volume_ml": model.volume_ml, "logged_on": model.event_date.isoformat()},
            summary=f"Log {model.volume_ml:g} ml of water on {model.event_date}.",
            config=config,
        )
    if model.event_type == "weight":
        return await _propose(
            action_type="log_weight",
            arguments={"weight_kg": model.weight_kg, "measured_on": model.event_date.isoformat()},
            summary=f"Log body weight of {model.weight_kg:g} kg on {model.event_date}.",
            config=config,
        )
    return await _propose(
        action_type="training_check_in",
        arguments={"activity_date": model.event_date.isoformat()},
        summary=f"Record a training check-in on {model.event_date}.",
        config=config,
    )


@tool("set_portion_preference", args_schema=SetPortionPreferenceInput)
async def set_portion_preference(
    category: str,
    usual_count: float,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Apply a change to one category's usual fixed-unit count."""
    model = SetPortionPreferenceInput(category=category, usual_count=usual_count)
    return await _propose(
        action_type="set_portion_default",
        arguments={"category": model.category, "portion_count": model.usual_count},
        summary=(
            f"Set the usual {model.category.replace('_', ' ')} serving to "
            f"{model.usual_count:g} fixed units."
        ),
        config=config,
    )


mutation_action_tools = [
    manage_meal_entry,
    manage_goal,
    record_health_event,
    set_portion_preference,
]
