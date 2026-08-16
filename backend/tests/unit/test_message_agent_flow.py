from __future__ import annotations

import base64
import json
import math
from datetime import date
from typing import Any

import pytest

from app.agents.media_extraction import runner as media_runner
from app.agents.nutrition_chat.models import ChatTurn
from app.agents.nutrition_chat.runner import _allow_mutations, _confirmed_follow_up
from app.api.v1 import messages_router
from app.core.deps import CurrentUser
from app.core.exceptions import ValidationError
from app.domain.meals import drafts
from app.services import media_extraction
from app.services.media_extraction import MEDIA_SIZE_LIMITS, ExtractionResult
from app.services.prompts import ResolvedPrompt


class FakeUpload:
    content_type = "image/jpeg"
    filename = "meal.jpg"
    size = len(b"image-bytes")

    async def read(self) -> bytes:
        return b"image-bytes"


@pytest.fixture(autouse=True)
def checked_in_media_prompts(monkeypatch) -> None:
    async def resolve(name: str, fallback: str) -> ResolvedPrompt:
        return ResolvedPrompt(name=name, text=fallback, source="code")

    monkeypatch.setattr(media_extraction, "resolve_prompt", resolve)


def _message_store(monkeypatch) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    async def create_message(row: dict[str, Any]) -> dict[str, Any]:
        saved = {
            "id": f"message-{len(rows) + 1}",
            "thread_id": row.get("thread_id", "thread-1"),
            "correlation_id": row.get("correlation_id", "correlation-1"),
            "media_url": None,
            "payload": {},
            "created_at": f"2026-08-15T00:00:0{len(rows)}Z",
            **row,
        }
        rows.append(saved)
        return saved

    async def update_message(
        *, user_id: str, message_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        for row in rows:
            if row["id"] == message_id and row["user_id"] == user_id:
                row.update(patch)
                return row
        return None

    async def list_thread_messages(
        *, user_id: str, thread_id: str, limit: int = 30
    ) -> list[dict[str, Any]]:
        return [
            row
            for row in rows[-limit:]
            if row["user_id"] == user_id and row["thread_id"] == thread_id
        ]

    monkeypatch.setattr(messages_router.message_repo, "create_message", create_message)
    monkeypatch.setattr(messages_router.message_repo, "update_message", update_message)
    monkeypatch.setattr(messages_router.message_repo, "list_thread_messages", list_thread_messages)
    return rows


def _user() -> CurrentUser:
    return CurrentUser(id="user-1", roles=[], access_token="token")


async def test_text_message_runs_nutrition_agent_and_persists_reply(monkeypatch) -> None:
    rows = _message_store(monkeypatch)
    invocation: dict[str, Any] = {}

    async def run_nutrition(**kwargs):
        invocation.update(kwargs)
        return ChatTurn(reply="Logged your lunch.")

    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_nutrition)

    response = await messages_router.send_message(
        user=_user(), text="2 rotis for lunch", thread_id=None, file=None
    )

    assert [message.direction for message in response] == ["inbound", "outbound"]
    assert response[1].msg_text == "Logged your lunch."
    assert invocation["thread_id"] == "thread-1"
    assert invocation["messages"][-1] == {
        "role": "user",
        "content": "2 rotis for lunch",
    }
    assert rows[-1]["direction"] == "outbound"


async def test_image_runs_extraction_then_read_only_nutrition_agent(monkeypatch) -> None:
    _message_store(monkeypatch)
    invocation: dict[str, Any] = {}

    async def run_extraction(**kwargs):
        assert kwargs["mime_type"] == "image/jpeg"
        return ExtractionResult(
            text="Plate with dal (180 g)",
            payload={"items": [{"name": "dal", "estimated_mass_g": 180}]},
        )

    async def run_nutrition(**kwargs):
        invocation.update(kwargs)
        return ChatTurn(reply="I found dal. Review the amount below.")

    async def find_by_name(_name: str) -> dict[str, Any]:
        return {"dish_id": "dish-1", "name": "Dal", "category": "dal_gravy"}

    async def list_portions(_user_id: str) -> list[dict[str, Any]]:
        return [
            {
                "category": "dal_gravy",
                "portion_unit": "katori",
                "portion_grams": 160,
                "portion_count": 1.5,
                "effective_portion_grams": 240,
                "is_custom": True,
            }
        ]

    async def resolve_portion(*_args: Any) -> dict[str, Any]:
        return {
            "portion_unit": "katori",
            "portion_grams": 240,
            "per_100g": {"protein_g": 10},
            "resolved_from": "category_household",
        }

    monkeypatch.setattr(messages_router, "run_media_extraction_agent", run_extraction)
    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_nutrition)
    monkeypatch.setattr(drafts.dish_repo, "find_by_name", find_by_name)
    monkeypatch.setattr(drafts.dish_repo, "list_category_portions", list_portions)
    monkeypatch.setattr(drafts, "resolve_portion", resolve_portion)

    response = await messages_router.send_message(
        user=_user(), text=None, thread_id=None, file=FakeUpload()
    )

    assert response[0].status == "needs_confirmation"
    assert response[1].msg_text == "I found dal. Review the amount below."
    assert invocation["extraction_payload"]["items"][0]["name"] == "dal"
    assert invocation["extraction_payload"]["items"][0]["food_id"] == "dish-1"
    assert invocation["extraction_payload"]["items"][0]["nutrients"]["protein_g"] == 18
    assert "not yet confirmed" in invocation["messages"][-1]["content"]


async def test_nutrition_label_without_items_is_not_confirmable(monkeypatch) -> None:
    _message_store(monkeypatch)

    async def run_extraction(**_kwargs):
        return ExtractionResult(
            text="Nutrition label with a 30 g serving",
            payload={
                "serving_size_g": 30,
                "per_100g": {"protein_g": 20},
                "source_metadata": {"kind": "nutrition_label"},
            },
        )

    async def run_nutrition(**_kwargs):
        return ChatTurn(reply="I read the label.")

    monkeypatch.setattr(messages_router, "run_media_extraction_agent", run_extraction)
    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_nutrition)

    response = await messages_router.send_message(
        user=_user(), text="Read this nutrition label", thread_id=None, file=FakeUpload()
    )

    assert response[0].status == "confirmed"
    assert response[0].payload["source_metadata"]["kind"] == "nutrition_label"


async def test_pdf_rows_become_reviewable_meal_items(monkeypatch) -> None:
    monkeypatch.setattr(media_extraction.settings, "OPENAI_API_KEY", "test-key")
    provider_payload = {
        "rows": [
            {
                "date": "2026-08-10",
                "meal_type": "lunch",
                "item": "dal",
                "quantity": 0.2,
                "unit": "kg",
                "calories_kcal": 220,
            }
        ],
        "row_count": 1,
        "date_range": {"from": "2026-08-10", "to": "2026-08-10"},
        "columns_detected": ["date", "meal_type", "item", "quantity", "unit"],
        "confidence": "high",
    }

    async def call_provider(prompt: str, data_b64: str, mime: str) -> str:
        assert prompt == media_extraction.FOOD_DIARY_PDF_PROMPT
        return json.dumps(provider_payload)

    monkeypatch.setattr(media_extraction, "_call_openai_media", call_provider)
    result = await media_extraction.extract_media(
        mime_type="application/pdf",
        data_b64=base64.b64encode(b"pdf").decode(),
        filename="diary.pdf",
    )

    assert result.ok
    assert result.payload["items"][0]["name"] == "dal"
    assert result.payload["items"][0]["estimated_mass_g"] == 200
    assert result.payload["items"][0]["source_metadata"]["row"] == provider_payload["rows"][0]
    assert result.payload["rows"] == provider_payload["rows"]


@pytest.mark.parametrize("mime_type", ["image/jpeg", "audio/webm", "application/pdf"])
def test_media_limits_are_explicit_per_supported_mime_class(mime_type: str) -> None:
    limit = MEDIA_SIZE_LIMITS[mime_type]
    assert media_extraction.validate_media_upload(mime_type, limit) is None
    assert "too large" in (media_extraction.validate_media_upload(mime_type, limit + 1) or "")


async def test_nutrition_label_hint_uses_label_prompt_once(monkeypatch) -> None:
    monkeypatch.setattr(media_extraction.settings, "OPENAI_API_KEY", "test-key")
    prompts: list[str] = []

    async def call_provider(prompt: str, data_b64: str, mime: str) -> str:
        prompts.append(prompt)
        return json.dumps(
            {
                "serving_size_g": 30,
                "servings_per_pack": 2,
                "per_100g": {"calories_kcal": 400},
                "per_serve": {"calories_kcal": 120},
                "confidence": "high",
            }
        )

    monkeypatch.setattr(media_extraction, "_call_openai_media", call_provider)
    result = await media_extraction.extract_media(
        mime_type="image/jpeg",
        data_b64=base64.b64encode(b"label").decode(),
        filename="nutrition-label.jpg",
        samples=3,
    )

    assert result.ok
    assert len(prompts) == 1
    assert prompts[0].startswith("Read this nutrition label.")
    assert result.payload["source_metadata"]["routing"] == "explicit_request_or_filename_hint"


async def test_upload_limit_is_checked_before_read_and_extraction(monkeypatch) -> None:
    class OversizedUpload(FakeUpload):
        size = MEDIA_SIZE_LIMITS["image/jpeg"] + 1

        async def read(self) -> bytes:
            pytest.fail("oversized upload must be rejected before reading")

    async def run_extraction(**kwargs):
        pytest.fail("oversized upload must not reach the provider")

    monkeypatch.setattr(messages_router, "run_media_extraction_agent", run_extraction)

    with pytest.raises(ValidationError) as error:
        await messages_router.send_message(
            user=_user(), text=None, thread_id=None, file=OversizedUpload()
        )

    assert error.value.code == "INVALID_MEDIA"
    assert "10 MB" in error.value.message


async def test_confirmation_honors_selected_date_for_pdf_items(monkeypatch) -> None:
    selected_date = date(2026, 8, 16)
    captured: list[dict[str, Any]] = []
    message = {
        "id": "message-1",
        "user_id": "user-1",
        "thread_id": "thread-1",
        "correlation_id": "correlation-1",
        "msg_type": "pdf",
        "status": "needs_confirmation",
        "payload": {
            "items": [
                {
                    "name": "dal",
                    "estimated_mass_g": 180,
                    "meal_date": "2026-08-10",
                    "meal_type": "lunch",
                }
            ],
            "source_metadata": {"kind": "food_diary_pdf"},
        },
    }

    async def get_message(user_id: str, message_id: str) -> dict[str, Any]:
        return message

    async def add_item(**kwargs) -> dict[str, Any]:
        captured.append(kwargs)
        return {"id": "meal-1", **kwargs}

    async def update_message(**kwargs) -> dict[str, Any]:
        return message

    async def create_message(row: dict[str, Any]) -> dict[str, Any]:
        return row

    async def create_audit_record(row: dict[str, Any]) -> dict[str, Any]:
        captured.append({"audit": row})
        return row

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.message_repo, "update_message", update_message)
    monkeypatch.setattr(messages_router.message_repo, "create_message", create_message)
    monkeypatch.setattr(messages_router.message_repo, "create_audit_record", create_audit_record)
    monkeypatch.setattr(messages_router.meals_service, "add_item", add_item)

    response = await messages_router.confirm_message(
        message_id="message-1",
        body=messages_router.ConfirmRequest(meal_date=selected_date, meal_type="dinner"),
        user=_user(),
    )

    assert response["created"] == 1
    assert captured[0]["meal_date"] == selected_date
    assert captured[0]["meal_type"] == "dinner"
    assert captured[0]["source"] == "pdf_import"
    assert captured[1]["audit"]["new_value"]["meal_date"] == "2026-08-16"


async def test_confirmation_rejects_inactive_food_id_before_creating_meals(monkeypatch) -> None:
    message = {
        "id": "message-1",
        "user_id": "user-1",
        "thread_id": "thread-1",
        "correlation_id": "correlation-1",
        "msg_type": "image",
        "status": "needs_confirmation",
        "payload": {"items": [{"name": "Dal", "estimated_mass_g": 180}]},
    }

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def get_dish(_food_id: str) -> None:
        return None

    async def add_item(**_kwargs):
        pytest.fail("invalid food IDs must be rejected before meal creation")

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.dish_repo, "get_dish", get_dish)
    monkeypatch.setattr(messages_router.meals_service, "add_item", add_item)
    body = messages_router.ConfirmRequest(
        meal_date=date(2026, 8, 16),
        meal_type="dinner",
        items=[{"dish_name": "Dal", "food_id": " inactive-id ", "grams": 180}],
    )

    with pytest.raises(ValidationError) as error:
        await messages_router.confirm_message("message-1", body, _user())

    assert error.value.code == "DISH_NOT_FOUND"
    assert error.value.context == {"food_id": "inactive-id"}


async def test_discard_closes_draft_without_logging(monkeypatch) -> None:
    message = {
        "id": "message-1",
        "user_id": "user-1",
        "status": "needs_confirmation",
    }
    patches: list[dict[str, Any]] = []

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def update_message(**kwargs) -> dict[str, Any]:
        patches.append(kwargs["patch"])
        return {**message, **kwargs["patch"]}

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.message_repo, "update_message", update_message)

    response = await messages_router.discard_message("message-1", _user())

    assert response.status_code == 204
    assert patches == [{"status": "not_applicable"}]


@pytest.mark.parametrize(
    "field,value",
    [("grams", 0), ("grams", math.inf), ("grams", math.nan), ("portions", -1)],
)
def test_confirmation_amounts_must_be_positive_and_finite(field: str, value: float) -> None:
    item = {"dish_name": "Dal", field: value}

    with pytest.raises(ValueError):
        messages_router.ConfirmationItem(**item)


async def test_agent_run_persistence_failure_does_not_fail_media_result(monkeypatch) -> None:
    class FakeAgent:
        async def ainvoke(self, state, *, config, context):
            return {
                "structured_response": {
                    "text": "Plate with dal (180 g)",
                    "payload": {"items": [{"name": "dal", "estimated_mass_g": 180}]},
                    "ok": True,
                    "detail": None,
                }
            }

    async def build_agent(config):
        return FakeAgent()

    async def persist_run(row: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("observability unavailable")

    from app.agents.media_extraction import agent as media_agent

    monkeypatch.setattr(media_agent, "build_media_extraction_agent", build_agent)
    monkeypatch.setattr(media_runner.message_repo, "create_agent_run", persist_run)

    result = await media_runner.run_media_extraction_agent(
        user_id="user-1",
        thread_id="thread-1",
        mime_type="image/jpeg",
        data_b64="aW1hZ2U=",
        correlation_id="correlation-1",
    )

    assert result.ok
    assert result.payload["items"][0]["name"] == "dal"


def test_ambiguous_text_cannot_mutate_until_explicit_confirmation() -> None:
    assert not _allow_mutations([{"role": "user", "content": "2 rotis for lunch"}], payload={})
    assert _allow_mutations(
        [{"role": "user", "content": "Please log 2 rotis for lunch"}], payload={}
    )
    assert _allow_mutations(
        [
            {"role": "user", "content": "2 rotis for lunch"},
            {"role": "assistant", "content": "Should I log that?"},
            {"role": "user", "content": "yes"},
        ],
        payload={},
    )


def test_numeric_nutrition_entry_requires_a_separate_confirmation_turn() -> None:
    assert not _confirmed_follow_up(
        [{"role": "user", "content": "Log 500 calories for dinner"}], payload={}
    )
    assert _confirmed_follow_up(
        [
            {"role": "user", "content": "Log 500 calories for dinner"},
            {"role": "assistant", "content": "Log Dinner item with 500 kcal?"},
            {"role": "user", "content": "confirm"},
        ],
        payload={},
    )
    assert _confirmed_follow_up(
        [
            {"role": "assistant", "content": "Log 25 g protein for Dinner item?"},
            {"role": "user", "content": "yes, go ahead"},
        ],
        payload={},
    )
    assert not _confirmed_follow_up(
        [
            {"role": "assistant", "content": "Remove the dinner entry?"},
            {"role": "user", "content": "confirm"},
        ],
        payload={},
    )
