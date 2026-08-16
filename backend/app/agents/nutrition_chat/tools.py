"""nutrition_chat's own tools.

Every one of these is used by exactly this agent, so they live inside its
folder rather than a shared app/tools/ directory - the KookarCore pattern of
one self-contained folder per agent (agent.py, prompt.py, middleware.py,
models.py, render.py, state.py, tools.py all together). A tool only moves out
to a shared location if a SECOND agent needs it too, and none does yet.
"""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field, model_validator

from app.domain.dishes import repository as dish_repo
from app.domain.meals import service as meals_service
from app.utils.logger import logger


def _user_id(config: RunnableConfig) -> str | None:
    return (config or {}).get("configurable", {}).get("user_id")


class LogDishesInput(BaseModel):
    meal_date: str = Field(..., description="YYYY-MM-DD")
    meal_type: str = Field(..., description="breakfast|brunch|lunch|snacks|dinner|misc")
    dish_name: str = Field(..., description="Name of the food, as the user said it")
    food_id: str | None = Field(None, description="Only if a search already resolved one")
    portions: float = Field(1.0, description="The multiplier: 1.5 katori, 3 rotis")
    grams: float | None = Field(None, description="Only if the user stated an exact weight")


@tool(args_schema=LogDishesInput)
async def log_dishes(
    meal_date: str,
    meal_type: str,
    dish_name: str,
    food_id: str | None = None,
    portions: float = 1.0,
    grams: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Log one food item into a meal slot.

    IMPORTANT: this tool never invents a nutrient number. It takes a dish name
    and a portion; the actual nutrients come from the lookup chain
    (household portion -> global dish -> category default). If the dish
    cannot be identified, call search_dishes first and ask the user which one,
    do not guess.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}

    from datetime import date as date_cls

    row = await meals_service.add_item(
        user_id=user_id,
        meal_date=date_cls.fromisoformat(meal_date),
        meal_type=meal_type,
        dish_name=dish_name,
        food_id=food_id,
        portions=portions,
        grams=grams,
        source="chat",
    )
    logger.info(
        "tool_log_dishes user_id={} dish={} resolved_from={}",
        user_id,
        dish_name,
        row.get("resolved_from"),
    )
    return {"status": "OK", "meal": row}


class LogNutritionEntryInput(BaseModel):
    meal_date: str = Field(..., description="YYYY-MM-DD")
    meal_type: str = Field(..., description="breakfast|brunch|lunch|snacks|dinner|misc")
    label: str | None = Field(None, description="Optional display label; defaults to the meal slot")
    calories_kcal: float | None = Field(None, ge=0)
    protein_g: float | None = Field(None, ge=0)
    carbs_g: float | None = Field(None, ge=0)
    fat_g: float | None = Field(None, ge=0)
    fiber_g: float | None = Field(None, ge=0)

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


@tool(args_schema=LogNutritionEntryInput)
async def log_nutrition_entry(
    meal_date: str,
    meal_type: str,
    label: str | None = None,
    calories_kcal: float | None = None,
    protein_g: float | None = None,
    carbs_g: float | None = None,
    fat_g: float | None = None,
    fiber_g: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Log user-stated nutrient totals when the dish itself is unknown.

    Use only numbers stated by the user or an exact active-goal target the user
    explicitly says this meal fulfilled. Never estimate a missing nutrient.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}

    from datetime import date as date_cls

    nutrients = {
        key: value
        for key, value in {
            "calories_kcal": calories_kcal,
            "protein_g": protein_g,
            "carbs_g": carbs_g,
            "fat_g": fat_g,
            "fiber_g": fiber_g,
        }.items()
        if value is not None
    }
    row = await meals_service.add_item(
        user_id=user_id,
        meal_date=date_cls.fromisoformat(meal_date),
        meal_type=meal_type,
        dish_name=label,
        portions=1,
        portion_unit="serving",
        source="chat",
        nutrients=nutrients,
    )
    return {"status": "OK", "meal": row}


class SearchDishesInput(BaseModel):
    query: str = Field(..., description="Search text, e.g. 'dal tadka'")
    limit: int = Field(5, description="Max candidates to return")


@tool(args_schema=SearchDishesInput)
async def search_dishes(
    query: str, limit: int = 5, config: RunnableConfig = None
) -> dict[str, Any]:
    """Search the dish universe for candidates matching a name.

    Use this BEFORE log_dishes when the dish name is ambiguous, so the model
    picks a real food_id instead of leaving the item unresolved.
    """
    items, total = await dish_repo.search_dishes(query, limit=limit)
    return {"status": "OK", "candidates": items, "total": total}


class EditMealDishInput(BaseModel):
    meal_id: str = Field(..., description="The id of the meal row to change")
    portions: float | None = Field(None, description="New multiplier")
    grams: float | None = Field(None, description="New exact weight")


@tool(args_schema=EditMealDishInput)
async def edit_meal_dish(
    meal_id: str,
    portions: float | None = None,
    grams: float | None = None,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Adjust the portion or quantity of an already-logged item. Recomputes nutrients."""
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    row = await meals_service.adjust_item(
        user_id=user_id, meal_id=meal_id, portions=portions, grams=grams
    )
    return {"status": "OK", "meal": row}


class RemoveMealDishInput(BaseModel):
    meal_id: str = Field(..., description="The id of the meal row to remove")


@tool(args_schema=RemoveMealDishInput)
async def remove_meal_dish(meal_id: str, config: RunnableConfig = None) -> dict[str, Any]:
    """Remove one logged item."""
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from app.domain.meals import repository as meals_repo

    ok = await meals_repo.delete_meal(user_id, meal_id)
    return {"status": "OK" if ok else "ERROR", "deleted": ok}


class ListDaysInput(BaseModel):
    date_from: str = Field(..., description="YYYY-MM-DD")
    date_to: str = Field(..., description="YYYY-MM-DD")
    meal_type: str | None = Field(None, description="Filter to one slot")


@tool(args_schema=ListDaysInput)
async def list_days(
    date_from: str, date_to: str, meal_type: str | None = None, config: RunnableConfig = None
) -> dict[str, Any]:
    """List logged meals over a date range."""
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from datetime import date as date_cls

    from app.domain.meals import repository as meals_repo

    items, total = await meals_repo.list_meals(
        user_id=user_id,
        date_from=date_cls.fromisoformat(date_from),
        date_to=date_cls.fromisoformat(date_to),
        meal_types=[meal_type] if meal_type else None,
        limit=200,
    )
    return {"status": "OK", "items": items, "total": total}


class GetGoalStatusInput(BaseModel):
    pass


@tool
async def get_goal_status(config: RunnableConfig = None) -> dict[str, Any]:
    """Get every active goal, its resolved targets, and current progress."""
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from datetime import date, timedelta

    from app.domain.goals import service as goals_service

    today = date.today()
    summary = await goals_service.progress_summary(user_id, today)
    if not summary["goals"]:
        return {"status": "OK", "goal": None, "active_goals": [], "message": "No active goal set"}

    goal = await goals_service.get_active_goal(user_id)
    progress = (
        await goals_service.progress(user_id, goal["goal_id"], today - timedelta(days=6), today)
        if goal
        else None
    )
    return {
        "status": "OK",
        "goal": goal,
        "active_goals": summary["goals"],
        "progress": progress,
    }


class SetGoalInput(BaseModel):
    kind: str = Field(..., description="nutrient|body_weight|item|hydration|behaviour")
    spec: dict[str, Any] = Field(..., description="e.g. {'direction':'lose','amount_kg':5}")
    starts_on: str = Field(..., description="YYYY-MM-DD")
    ends_on: str = Field(..., description="YYYY-MM-DD")


@tool(args_schema=SetGoalInput)
async def set_goal(
    kind: str, spec: dict[str, Any], starts_on: str, ends_on: str, config: RunnableConfig = None
) -> dict[str, Any]:
    """Create a new goal, deactivating any current one.

    ALWAYS runs through the safety ladder - it may return an ERROR with a
    clamped suggestion instead of what was asked for. Explain the clamp in
    plain language (what was requested, what is safe, why) and ask before
    retrying - do not silently substitute the safe version.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from datetime import date as date_cls

    from app.core.exceptions import AppError
    from app.domain.goals import service as goals_service

    try:
        goal = await goals_service.create_goal(
            user_id=user_id,
            kind=kind,
            spec=spec,
            starts_on=date_cls.fromisoformat(starts_on),
            ends_on=date_cls.fromisoformat(ends_on),
        )
        return {"status": "OK", "goal": goal}
    except AppError as exc:
        return {
            "status": "ERROR",
            "code": exc.code,
            "message": exc.message,
            "suggested_action": exc.suggested_action,
            "context": exc.context,
        }


class LogWaterInput(BaseModel):
    volume_ml: float = Field(..., description="Amount of water in millilitres")


@tool(args_schema=LogWaterInput)
async def log_water(volume_ml: float, config: RunnableConfig = None) -> dict[str, Any]:
    """Log water intake."""
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from app.services.supabase import get_supabase

    sb = await get_supabase()
    res = (
        await sb.table("water_logs").insert({"user_id": user_id, "volume_ml": volume_ml}).execute()
    )
    return {"status": "OK", "log": res.data[0]}


class LogWeightInput(BaseModel):
    weight_kg: float = Field(..., description="Body weight in kg")


@tool(args_schema=LogWeightInput)
async def log_weight(weight_kg: float, config: RunnableConfig = None) -> dict[str, Any]:
    """Log today's body weight.

    NOTE: may trigger the DB to re-derive BMR/TDEE and re-version the active
    goal - but only on a real change (>=2kg) or after 14 days. A small change
    intentionally does nothing, so do not be surprised if the goal does not move.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from app.domain.profile import repository as profile_repo

    row = await profile_repo.add_body_metric(user_id, weight_kg)
    return {"status": "OK", "body_metric": row}


class SetPortionDefaultInput(BaseModel):
    category: str = Field(..., description="e.g. dal_gravy, flatbread, protein_main")
    portion_count: float = Field(
        ..., gt=0, le=20, description="How many fixed category units make the usual serving"
    )


@tool(args_schema=SetPortionDefaultInput)
async def set_portion_default(
    category: str,
    portion_count: float,
    config: RunnableConfig = None,
) -> dict[str, Any]:
    """Set what the user usually takes for a food category.

    The category unit and grams are fixed. This changes only how many fixed
    units make the user's usual serving. Never use it when they ate more or
    fewer servings in one specific meal.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    row = await dish_repo.set_category_household(
        user_id=user_id,
        category=category,
        portion_count=portion_count,
        source="chat",
    )
    return {"status": "OK", "portion": row}


class IdentifyUnknownItemInput(BaseModel):
    meal_id: str = Field(..., description="The meal row with unknown nutrition")
    food_id: str = Field(..., description="The dish it should be matched to")


@tool(args_schema=IdentifyUnknownItemInput)
async def identify_unknown_item(
    meal_id: str, food_id: str, config: RunnableConfig = None
) -> dict[str, Any]:
    """Attach a real dish to a previously unresolved free-text meal item.

    Use after search_dishes when a user clarifies what an unknown item was -
    this recomputes its nutrients so it stops showing as unaccounted.
    """
    user_id = _user_id(config)
    if not user_id:
        return {"status": "ERROR", "message": "No authenticated user in context"}
    from app.domain.meals import repository as meals_repo

    current = await meals_repo.get_meal(user_id, meal_id)
    if not current:
        return {"status": "ERROR", "message": "Meal item not found"}

    dish = await dish_repo.get_dish(food_id)
    if not dish:
        return {"status": "ERROR", "message": "Dish not found"}

    await meals_repo.update_meal(
        user_id, meal_id, {"food_id": food_id, "category": dish["category"]}
    )
    updated = await meals_service.adjust_item(user_id=user_id, meal_id=meal_id)
    return {"status": "OK", "meal": updated}


read_tools = [search_dishes, list_days, get_goal_status]

mutation_tools = [
    log_dishes,
    edit_meal_dish,
    remove_meal_dish,
    set_goal,
    log_water,
    log_weight,
    set_portion_default,
    identify_unknown_item,
]

confirmation_required_tools = [log_nutrition_entry]

tools = [*read_tools, *mutation_tools, *confirmation_required_tools]
