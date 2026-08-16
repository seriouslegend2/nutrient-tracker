"""Run destructive, isolated-user Nutrition Chat acceptance scenarios end to end."""

from __future__ import annotations

import argparse
import asyncio
from datetime import date, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import jwt

from app.config.settings import settings
from app.domain.agent_actions import service as action_service
from app.main import app


class LiveMatrix:
    def __init__(self, client: httpx.AsyncClient, headers: dict[str, str], user_id: str) -> None:
        self.client = client
        self.headers = headers
        self.user_id = user_id
        self.thread_id = str(uuid4())
        self.results: list[dict[str, Any]] = []

    async def send(
        self,
        name: str,
        text: str,
        *,
        expected_tool: str | None = None,
        expected_action: str | None = None,
        expect_no_action: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        response = await self.client.post(
            "/api/v1/messages",
            headers=self.headers,
            data={"text": text, "thread_id": self.thread_id, "timezone": "Asia/Kolkata"},
        )
        response.raise_for_status()
        outbound = response.json()[-1]
        payload = outbound.get("payload") or {}
        tools = [call.get("tool") for call in payload.get("tool_calls") or []]
        actions = payload.get("agent_actions") or []
        if expected_tool and expected_tool not in tools:
            raise AssertionError(f"{name}: expected {expected_tool}, got tools={tools}")
        if expect_no_action and actions:
            raise AssertionError(f"{name}: unexpectedly proposed actions={actions}")

        stored: dict[str, Any] | None = None
        if expected_action:
            if len(actions) != 1:
                raise AssertionError(f"{name}: expected one action, got {actions}")
            action = await action_service.get(
                user_id=self.user_id,
                action_id=UUID(actions[0]["id"]),
            )
            if action.action_type != expected_action:
                raise AssertionError(
                    f"{name}: expected action {expected_action}, got {action.action_type}"
                )
            stored = {
                "id": str(action.id),
                "action_type": action.action_type,
                "arguments": action.arguments,
                "status": action.status.value,
            }
            if stored["status"] != "completed":
                raise AssertionError(f"{name}: text action was not executed immediately: {stored}")

        self.results.append(
            {
                "scenario": name,
                "tools": tools,
                "action": stored["action_type"] if stored else None,
                "reply": outbound.get("msg_text"),
            }
        )
        return outbound, stored

    async def confirm(self, action: dict[str, Any]) -> dict[str, Any]:
        response = await self.client.post(
            f"/api/v1/agent-actions/{action['id']}/confirm",
            headers=self.headers,
        )
        response.raise_for_status()
        result = response.json()
        if result["status"] != "completed":
            raise AssertionError(f"Action did not complete: {result}")
        return result

    async def discard(self, action: dict[str, Any]) -> None:
        response = await self.client.post(
            f"/api/v1/agent-actions/{action['id']}/discard",
            headers=self.headers,
        )
        response.raise_for_status()
        if response.json()["status"] != "discarded":
            raise AssertionError("Action did not become discarded")

    async def get(self, path: str) -> Any:
        response = await self.client.get(path, headers=self.headers)
        response.raise_for_status()
        return response.json()


async def create_test_user(client: httpx.AsyncClient) -> str:
    response = await client.post(
        f"{settings.SUPABASE_URL}/auth/v1/admin/users",
        headers={
            "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        },
        json={
            "email": f"nutrition-chat-matrix-{uuid4()}@example.invalid",
            "password": f"Acceptance-{uuid4()}",
            "email_confirm": True,
        },
    )
    response.raise_for_status()
    return str(response.json()["id"])


async def delete_test_user(client: httpx.AsyncClient, user_id: str) -> None:
    response = await client.delete(
        f"{settings.SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers={
            "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        },
    )
    response.raise_for_status()


def active_meals(day_payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for rows in day_payload.get("slots", {}).values() for item in rows]


async def run_matrix(matrix: LiveMatrix) -> None:
    today = date.today()
    end_date = today + timedelta(days=31)

    await matrix.send(
        "capabilities",
        "What can you help me do in this nutrition tracker? Do not change anything.",
        expect_no_action=True,
    )
    await matrix.send(
        "catalog_search",
        "Use the food catalog to search for dal and list the available matches. Do not log it.",
        expected_tool="search_food_catalog",
        expect_no_action=True,
    )
    await matrix.send(
        "ambiguous_meal",
        "2 rotis and dal for lunch",
        expect_no_action=True,
    )

    before = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    _, meal_action = await matrix.send(
        "meal_create_half_step",
        f"Log 1.25 servings of Dal Tadka for lunch on {today.isoformat()}.",
        expected_tool="manage_meal_entry",
        expected_action="log_meal",
    )
    assert meal_action is not None
    if float(meal_action["arguments"]["portions"]) != 1.5:
        raise AssertionError(f"Meal proposal was not normalized: {meal_action['arguments']}")
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    dal = next((item for item in meals if "dal" in item["dish_name"].lower()), None)
    if not dal or float(dal["portions"]) != 1.5:
        raise AssertionError(f"Confirmed normalized meal missing: {meals}")
    if len(meals) != len(before) + 1:
        raise AssertionError("Direct meal write created an unexpected row count")

    _, nutrition_action = await matrix.send(
        "exact_nutrition_create",
        (
            f"Log an exact nutrition entry for dinner on {today.isoformat()}: "
            "500 calories and 25 g protein. Do not estimate anything else."
        ),
        expected_tool="manage_meal_entry",
        expected_action="log_nutrition_entry",
    )
    assert nutrition_action is not None
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    exact = next(item for item in meals if item["nutrients"].get("calories_kcal") == 500)
    if exact["nutrients"] != {"calories_kcal": 500, "protein_g": 25}:
        raise AssertionError(f"Exact nutrients changed: {exact['nutrients']}")

    await matrix.send(
        "meal_history",
        (
            f"Use my tracker history to list meals from {today.isoformat()} "
            f"through {today.isoformat()}."
        ),
        expected_tool="query_tracker_history",
        expect_no_action=True,
    )
    _, edit_action = await matrix.send(
        "meal_edit_half_step",
        "Change today's Dal Tadka meal to 1.75 servings.",
        expected_tool="manage_meal_entry",
        expected_action="edit_meal",
    )
    assert edit_action is not None
    if float(edit_action["arguments"]["portions"]) != 2.0:
        raise AssertionError(f"Meal edit was not normalized: {edit_action['arguments']}")
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    dal = next(item for item in meals if "dal" in item["dish_name"].lower())
    if float(dal["portions"]) != 2.0:
        raise AssertionError(f"Edited serving count was not persisted: {dal}")

    _, delete_action = await matrix.send(
        "meal_delete_direct",
        "Delete the exact 500 calorie dinner entry I logged today.",
        expected_tool="manage_meal_entry",
        expected_action="remove_meal",
    )
    assert delete_action is not None
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    if any(item["nutrients"].get("calories_kcal") == 500 for item in meals):
        raise AssertionError("Confirmed delete did not remove the meal")

    unknown_response = await matrix.client.post(
        "/api/v1/meals",
        headers=matrix.headers,
        json={
            "meal_date": today.isoformat(),
            "meal_type": "dinner",
            "dish_name": "Unknown dinner item",
            "portions": 1,
        },
    )
    unknown_response.raise_for_status()
    unknown_meal_id = unknown_response.json()["id"]
    _, identify_action = await matrix.send(
        "dosa_identity_update",
        "Update today's dinner to plain dosa.",
        expected_tool="manage_meal_entry",
        expected_action="identify_unknown_item",
    )
    assert identify_action is not None
    if identify_action["arguments"]["meal_id"] != unknown_meal_id:
        raise AssertionError(f"Dosa update selected the wrong meal: {identify_action}")
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    dosa = next(
        (
            item
            for item in meals
            if item["meal_type"] == "dinner" and "plain dosa" in item["dish_name"].lower()
        ),
        None,
    )
    if not dosa or "plain dosa" not in dosa["dish_name"].lower() or not dosa.get("food_id"):
        raise AssertionError(f"Dosa identity update was not persisted: {meals}")

    _, goal_action = await matrix.send(
        "goal_create",
        (
            "Create a daily protein goal of at least 100 g from "
            f"{today.isoformat()} through {end_date.isoformat()} and make it primary."
        ),
        expected_tool="manage_goal",
        expected_action="set_goal",
    )
    assert goal_action is not None
    goals = await matrix.get("/api/v1/goals?page=1&page_size=20")
    if not goals["items"]:
        raise AssertionError("Confirmed goal was not stored")

    for name, request, action_type in (
        (
            "water_log",
            f"Log 350 ml of water on {today.isoformat()}.",
            "log_water",
        ),
        (
            "weight_log",
            f"Record my weight as 71.2 kg on {today.isoformat()}.",
            "log_weight",
        ),
        (
            "training_checkin",
            f"Record a training check-in on {today.isoformat()}.",
            "training_check_in",
        ),
    ):
        _, health_action = await matrix.send(
            name,
            request,
            expected_tool="record_health_event",
            expected_action=action_type,
        )
        assert health_action is not None

    water = await matrix.get("/api/v1/water?page=1&page_size=20")
    if not any(float(item["volume_ml"]) == 350 for item in water["items"]):
        raise AssertionError("Water event was not stored")
    metrics = await matrix.get("/api/v1/me/body-metrics?page=1&page_size=20")
    if not any(float(item["weight_kg"]) == 71.2 for item in metrics["items"]):
        raise AssertionError("Weight event was not stored")
    activity = await matrix.get(
        f"/api/v1/goals/activity?date_from={today.isoformat()}&date_to={today.isoformat()}"
    )
    if not activity["items"]:
        raise AssertionError("Training event was not stored")

    _, portion_action = await matrix.send(
        "portion_preference",
        "Set my usual dal_gravy portion count to exactly 1.25 fixed units.",
        expected_tool="set_portion_preference",
        expected_action="set_portion_default",
    )
    assert portion_action is not None
    portions = await matrix.get("/api/v1/me/portions?page=1&page_size=100")
    dal_portion = next(item for item in portions["items"] if item["category"] == "dal_gravy")
    if float(dal_portion["portion_count"]) != 1.25:
        raise AssertionError("Usual portion preference was incorrectly half-rounded")

    await matrix.send(
        "hydration_history",
        (
            f"Use tracker history to show my hydration from {today.isoformat()} "
            f"through {today.isoformat()}."
        ),
        expected_tool="query_tracker_history",
        expect_no_action=True,
    )
    await matrix.send(
        "body_history",
        "Use tracker history to show my recent body-weight measurements.",
        expected_tool="query_tracker_history",
        expect_no_action=True,
    )
    await matrix.send(
        "nutrition_report",
        (
            f"Use tracker history for a macro report from {today.isoformat()} "
            f"through {today.isoformat()}."
        ),
        expected_tool="query_tracker_history",
        expect_no_action=True,
    )

    used_tools = {tool for result in matrix.results for tool in result["tools"]}
    expected_tools = {
        "search_food_catalog",
        "query_tracker_history",
        "manage_meal_entry",
        "manage_goal",
        "record_health_event",
        "set_portion_preference",
    }
    if used_tools != expected_tools:
        raise AssertionError(f"Tool coverage mismatch: expected={expected_tools}, used={used_tools}")


async def run_dosa_conversation(matrix: LiveMatrix) -> None:
    today = date.today()
    await matrix.send(
        "dosa_amount_fragment",
        "2 dosa",
        expect_no_action=True,
    )
    await matrix.send(
        "dosa_identity_fragment",
        "plain",
        expect_no_action=True,
    )
    _, action = await matrix.send(
        "dosa_explicit_add",
        "dude please add 2 plain dosa to dinner",
        expected_tool="manage_meal_entry",
        expected_action="log_meal",
    )
    assert action is not None
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    plain_dosa = [item for item in meals if "plain dosa" in item["dish_name"].lower()]
    if len(plain_dosa) != 1 or float(plain_dosa[0]["portions"]) != 2:
        raise AssertionError(f"Plain dosa was not written correctly: {meals}")
    _, identity_action = await matrix.send(
        "dosa_identity_update",
        "update today's dinner to masala dosa",
        expected_tool="manage_meal_entry",
        expected_action="identify_unknown_item",
    )
    assert identity_action is not None
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    masala_dosa = [item for item in meals if "masala dosa" in item["dish_name"].lower()]
    if len(masala_dosa) != 1 or not masala_dosa[0].get("food_id"):
        raise AssertionError(f"Masala dosa identity update was not written correctly: {meals}")


async def run_breakfast_conversation(matrix: LiveMatrix) -> None:
    today = date.today()
    response = await matrix.client.post(
        "/api/v1/meals",
        headers=matrix.headers,
        json={
            "meal_date": today.isoformat(),
            "meal_type": "breakfast",
            "dish_name": "Unknown dish test placeholder",
            "portions": 1,
        },
    )
    response.raise_for_status()
    original_id = response.json()["id"]

    first, _ = await matrix.send(
        "breakfast_generic_dosa",
        "yup hey also update the breakfast to dosa today?",
        expect_no_action=True,
    )
    first_tools = {
        call.get("tool") for call in (first.get("payload") or {}).get("tool_calls") or []
    }
    if not first_tools.intersection({"search_food_catalog", "manage_meal_entry"}):
        raise AssertionError(f"Generic dosa used no relevant tool: {first}")
    if "plain" not in first["msg_text"].lower() or "masala" not in first["msg_text"].lower():
        raise AssertionError(f"Generic dosa did not request identity clarification: {first}")

    second, _ = await matrix.send(
        "breakfast_add_ambiguous",
        "add new dish",
        expect_no_action=True,
    )
    if "plain" not in second["msg_text"].lower() or "masala" not in second["msg_text"].lower():
        raise AssertionError(f"New dish did not request a catalog identity: {second}")
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    if len(meals) != 1 or meals[0]["id"] != original_id:
        raise AssertionError(f"Ambiguous turns unexpectedly changed breakfast: {meals}")

    _, action = await matrix.send(
        "breakfast_exact_add",
        "add 1 plain dosa as a new breakfast dish today",
        expected_tool="manage_meal_entry",
        expected_action="log_meal",
    )
    assert action is not None
    meals = active_meals(await matrix.get(f"/api/v1/meals/day/{today.isoformat()}"))
    if (
        len(meals) != 2
        or not any(
            "plain dosa" in item["dish_name"].lower() and item.get("food_id")
            for item in meals
        )
    ):
        raise AssertionError(f"Exact breakfast addition was not persisted: {meals}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dosa-only", action="store_true")
    parser.add_argument("--breakfast-only", action="store_true")
    args = parser.parse_args()
    if not settings.OPENAI_API_KEY or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise SystemExit("Live credentials are not configured")
    user_id: str | None = None
    async with httpx.AsyncClient(timeout=60) as admin:
        try:
            user_id = await create_test_user(admin)
            token = jwt.encode(
                {"user_id": user_id, "house_id": 0, "roles": ["user"]},
                settings.JWT_SECRET_KEY,
                algorithm=settings.JWT_ALGORITHM,
            )
            headers = {"Authorization": f"Bearer {token}"}
            transport = httpx.ASGITransport(app=app)
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                transport=transport,
                base_url="http://acceptance",
                timeout=300,
            ) as client:
                onboarding = await client.post(
                    "/api/v1/me/onboarding",
                    headers=headers,
                    json={
                        "sex": "male",
                        "date_of_birth": "1990-01-01",
                        "height_cm": 175,
                        "weight_kg": 75,
                        "activity": "moderate",
                        "diet": "vegetarian",
                        "allergies": ["peanut"],
                        "portions": {"dal_gravy": {"count": 1}},
                    },
                )
                onboarding.raise_for_status()
                matrix = LiveMatrix(client, headers, user_id)
                if args.breakfast_only:
                    await run_breakfast_conversation(matrix)
                elif args.dosa_only:
                    await run_dosa_conversation(matrix)
                else:
                    await run_matrix(matrix)
                print(
                    {
                        "model": settings.ORCHESTRATION_MODEL,
                        "scenarios_passed": len(matrix.results),
                        "tool_coverage": sorted(
                            {tool for result in matrix.results for tool in result["tools"]}
                        ),
                        "results": matrix.results,
                    }
                )
        finally:
            if user_id:
                await delete_test_user(admin, user_id)


if __name__ == "__main__":
    asyncio.run(main())
