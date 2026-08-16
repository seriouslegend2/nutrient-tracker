from __future__ import annotations

import math
from datetime import date
from typing import Any

import pytest

from app.agents.media_facts.models import (
    MediaFactItem,
    MediaFacts,
    MediaFactsRunResult,
    MediaQuantity,
)
from app.agents.nutrition_chat.models import ChatTurn
from app.api.v1 import messages_router
from app.core.deps import CurrentUser
from app.core.exceptions import ValidationError
from app.services.speech_to_text import AUDIO_SIZE_LIMITS, TranscriptionResult


class FakeUpload:
    content_type = "image/jpeg"
    filename = "meal.jpg"
    body = b"image-bytes"
    size = len(body)

    async def read(self) -> bytes:
        return self.body


class FakePdfUpload(FakeUpload):
    content_type = "application/pdf"
    filename = "diary.pdf"
    body = b"pdf-bytes"
    size = len(body)


class FakeAudioUpload(FakeUpload):
    content_type = "audio/webm"
    filename = "voice.webm"
    body = b"audio-bytes"
    size = len(body)


def _facts(media_kind: str = "image") -> MediaFacts:
    return MediaFacts(
        usable=True,
        media_kind=media_kind,
        content_kind="food_photo" if media_kind == "image" else "food_diary",
        items=[
            MediaFactItem(
                evidence_id="evidence-1",
                observed_item_name="dal",
                normalized_name="dal",
                quantity=MediaQuantity(
                    value=180,
                    unit="g",
                    total_grams=180,
                    source="estimated",
                    confidence="medium",
                    basis="visible bowl",
                    range_g={"low": 150, "high": 210},
                ),
                confidence="high",
            )
        ],
        confidence="high",
    )


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


def test_media_history_keeps_only_compact_trusted_lifecycle_state() -> None:
    rows = [
        {
            "direction": "inbound",
            "msg_type": "image",
            "correlation_id": "media-1",
            "msg_text": None,
            "payload": {"workflow": "media", "items": [{"resolved_name": "Dal"}]},
            "status": "needs_confirmation",
        },
        {
            "direction": "outbound",
            "msg_type": "text",
            "correlation_id": "media-1",
            "msg_text": "Review the media draft.",
            "payload": {},
            "status": "not_applicable",
        },
        {
            "direction": "inbound",
            "msg_type": "text",
            "correlation_id": "chat-1",
            "msg_text": "How much protein did I eat?",
            "payload": {},
            "status": "not_applicable",
        },
    ]

    assert messages_router._agent_messages(rows) == [
        {
            "role": "assistant",
            "content": (
                "[Trusted media meal-draft status: needs_confirmation; "
                "resolved items: Dal.]"
            ),
        },
        {"role": "user", "content": "How much protein did I eat?"}
    ]


def test_failed_correlations_are_excluded_from_nutrition_chat_history() -> None:
    rows = [
        {
            "direction": "inbound",
            "msg_type": "text",
            "correlation_id": "failed-1",
            "msg_text": "Log lunch",
            "payload": {},
            "status": "failed",
        },
        {
            "direction": "outbound",
            "msg_type": "text",
            "correlation_id": "failed-1",
            "msg_text": "The nutrition assistant couldn't respond.",
            "payload": {},
            "status": "not_applicable",
        },
        {
            "direction": "inbound",
            "msg_type": "text",
            "correlation_id": "chat-1",
            "msg_text": "How much protein did I eat?",
            "payload": {},
            "status": "confirmed",
        },
    ]

    assert messages_router._agent_messages(rows) == [
        {"role": "user", "content": "How much protein did I eat?"}
    ]


def test_completed_text_actions_do_not_add_internal_lifecycle_markers() -> None:
    rows = [
        {
            "direction": "outbound",
            "msg_type": "text",
            "correlation_id": "chat-1",
            "msg_text": "Review the delete card.",
            "payload": {
                "agent_actions": [
                    {"action_type": "remove_meal", "status": "discarded"}
                ]
            },
            "status": "not_applicable",
        }
    ]

    assert messages_router._agent_messages(rows) == [
        {"role": "assistant", "content": "Review the delete card."}
    ]


async def test_text_message_runs_existing_nutrition_chat(monkeypatch) -> None:
    _message_store(monkeypatch)
    invocation: dict[str, Any] = {}

    async def run_nutrition(**kwargs):
        invocation.update(kwargs)
        return ChatTurn(reply="Reviewing your lunch.")

    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_nutrition)
    response = await messages_router.send_message(
        user=_user(), text="2 rotis for lunch", thread_id=None, file=None
    )

    assert response[1].msg_text == "Reviewing your lunch."
    assert invocation["messages"][-1] == {
        "role": "user",
        "content": "2 rotis for lunch",
    }
    assert invocation["auto_execute_actions"] is True


@pytest.mark.parametrize(
    ("upload", "expected_kind"),
    [(FakeUpload(), "image"), (FakePdfUpload(), "pdf")],
)
async def test_visual_media_runs_specialists_then_sends_compact_draft_to_chat(
    monkeypatch, upload: FakeUpload, expected_kind: str
) -> None:
    _message_store(monkeypatch)
    calls: list[str] = []
    facts = _facts(expected_kind)

    async def run_facts(**kwargs):
        calls.append("media_facts")
        assert kwargs["data"] == upload.body
        return MediaFactsRunResult(ok=True, facts=facts)

    async def run_resolver(**kwargs):
        calls.append("meal_resolver")
        assert kwargs["facts"] == facts
        return {
            "items": [
                {
                    "name": "dal",
                    "resolved_name": "Dal Tadka",
                    "food_id": "dish-1",
                    "category": "dal_gravy",
                    "total_grams": 180,
                    "servings": 1.125,
                    "portion_metadata": {
                        "portion_unit": "katori",
                        "portion_grams": 160,
                        "fixed": True,
                    },
                    "nutrients": {"protein_g": 18},
                    "amount_source": "media_estimated",
                    "matching_confidence": "high",
                    "mass_range_g": {"low": 150, "high": 210},
                    "confidence": "high",
                    "evidence_id": "evidence-1",
                    "source_metadata": {},
                }
            ],
            "evidence": facts.model_dump(mode="json"),
            "meal_date": "2026-08-16",
            "meal_type": "lunch",
            "source_metadata": {"kind": "food_photo"},
        }

    chat_invocation: dict[str, Any] = {}

    async def run_chat(**kwargs):
        calls.append("nutrition_chat")
        chat_invocation.update(kwargs)
        return ChatTurn(reply="I found dal. Review the draft before logging it.")

    monkeypatch.setattr(messages_router, "run_media_facts_agent", run_facts)
    monkeypatch.setattr(messages_router, "build_media_meal_draft", run_resolver)
    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_chat)

    response = await messages_router.send_message(
        user=_user(), text=None, thread_id=None, file=upload
    )

    assert calls == ["media_facts", "meal_resolver", "nutrition_chat"]
    assert response[0].status == "needs_confirmation"
    assert response[0].payload["items"][0]["food_id"] == "dish-1"
    assert response[0].payload["workflow"] == "media"
    assert response[0].payload["source_metadata"]["filename"] == upload.filename
    assert response[1].msg_text == "I found dal. Review the draft before logging it."
    assert response[1].payload["workflow"] == "media_summary"
    assert len(response) == 2
    compact = chat_invocation["pending_media_draft"]
    assert compact["items"] == [
        {
            "name": "dal",
            "resolved_name": "Dal Tadka",
            "category": "dal_gravy",
            "servings": 1.125,
            "portion_unit": "katori",
            "total_grams": 180,
            "nutrients": {"protein_g": 18},
            "confidence": "high",
        }
    ]
    assert "evidence" not in compact
    assert "source_metadata" not in compact
    assert chat_invocation["messages"][-1]["content"].startswith("I uploaded a")
    assert chat_invocation["auto_execute_actions"] is False


async def test_audio_stt_transcript_is_persisted_and_sent_to_chat_without_prefix(
    monkeypatch,
) -> None:
    _message_store(monkeypatch)
    invocation: dict[str, Any] = {}

    async def transcribe(**kwargs):
        assert kwargs["data"] == b"audio-bytes"
        return TranscriptionResult(text="Please log two rotis for lunch")

    async def run_nutrition(**kwargs):
        invocation.update(kwargs)
        return ChatTurn(reply="I can log that.")

    async def run_facts(**_kwargs):
        pytest.fail("audio is not a media-facts agent input")

    monkeypatch.setattr(messages_router, "transcribe_audio", transcribe)
    monkeypatch.setattr(messages_router, "run_nutrition_chat_agent", run_nutrition)
    monkeypatch.setattr(messages_router, "run_media_facts_agent", run_facts)

    response = await messages_router.send_message(
        user=_user(), text=None, thread_id=None, file=FakeAudioUpload()
    )

    assert response[0].msg_text == "Please log two rotis for lunch"
    assert response[0].payload == {}
    assert invocation["messages"][-1]["content"] == "Please log two rotis for lunch"
    assert "<audio>" not in invocation["messages"][-1]["content"]


async def test_upload_limit_is_checked_before_read(monkeypatch) -> None:
    class OversizedAudio(FakeAudioUpload):
        size = AUDIO_SIZE_LIMITS["audio/webm"] + 1

        async def read(self) -> bytes:
            pytest.fail("oversized upload must be rejected before reading")

    with pytest.raises(ValidationError) as error:
        await messages_router.send_message(
            user=_user(), text=None, thread_id=None, file=OversizedAudio()
        )

    assert error.value.code == "INVALID_MEDIA"
    assert "25 MB" in error.value.message


async def test_confirmation_keeps_existing_draft_contract(monkeypatch) -> None:
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
                    "evidence_id": "evidence-1",
                    "name": "dal",
                    "resolved_name": "Dal",
                    "food_id": "dish-1",
                    "servings": 1,
                    "portion_metadata": {"portion_unit": "katori", "portion_grams": 180},
                }
            ],
            "source_metadata": {"kind": "food_diary_pdf"},
        },
    }

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def prepare_item(**kwargs) -> dict[str, Any]:
        captured.append(kwargs)
        return {
            **kwargs,
            "category": "dal_gravy",
            "nutrients": {"protein_g": 10},
            "resolved_from": "dish_global",
        }

    async def confirm_media_draft(**kwargs) -> dict[str, Any]:
        assert len(kwargs["items"]) == 1
        return {"created": 1, "meals": [{"id": "meal-1"}]}

    async def get_dish(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-1"}

    async def passthrough(row=None, **_kwargs):
        return row or message

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.message_repo, "update_message", passthrough)
    monkeypatch.setattr(messages_router.message_repo, "create_message", passthrough)
    monkeypatch.setattr(messages_router.message_repo, "create_audit_record", passthrough)
    monkeypatch.setattr(messages_router.meals_service, "prepare_item", prepare_item)
    monkeypatch.setattr(messages_router.meals_repo, "confirm_media_draft", confirm_media_draft)
    monkeypatch.setattr(messages_router.dish_repo, "get_dish", get_dish)

    response = await messages_router.confirm_message(
        "message-1",
        messages_router.ConfirmRequest(meal_date=selected_date, meal_type="dinner"),
        _user(),
    )

    assert response["created"] == 1
    assert captured[0]["grams"] == 180
    assert captured[0]["source"] == "pdf_import"


async def test_confirmation_uses_stored_identity_and_fixed_serving_conversion(
    monkeypatch,
) -> None:
    captured: list[dict[str, Any]] = []
    message = {
        "id": "message-1",
        "user_id": "user-1",
        "thread_id": "thread-1",
        "correlation_id": "correlation-1",
        "msg_type": "image",
        "status": "needs_confirmation",
        "payload": {
            "items": [
                {
                    "evidence_id": "evidence-1",
                    "name": "paneer dish",
                    "resolved_name": "Paneer Butter Masala",
                    "food_id": "dish-1",
                    "confidence": "high",
                    "portion_metadata": {
                        "portion_unit": "katori",
                        "portion_grams": 160,
                        "fixed": True,
                    },
                }
            ],
            "source_metadata": {"kind": "food_photo"},
        },
    }

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def get_dish(_food_id: str) -> dict[str, Any]:
        return {"dish_id": "dish-1"}

    async def prepare_item(**kwargs) -> dict[str, Any]:
        captured.append(kwargs)
        return {
            **kwargs,
            "category": "paneer_tofu",
            "nutrients": {"protein_g": 20},
            "resolved_from": "dish_global",
        }

    async def confirm_media_draft(**kwargs) -> dict[str, Any]:
        assert kwargs["items"][0]["dish_name"] == "Paneer Butter Masala"
        return {"created": 1, "meals": [{"id": "meal-1"}]}

    async def passthrough(row=None, **_kwargs):
        return row or message

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.message_repo, "update_message", passthrough)
    monkeypatch.setattr(messages_router.message_repo, "create_message", passthrough)
    monkeypatch.setattr(messages_router.message_repo, "create_audit_record", passthrough)
    monkeypatch.setattr(messages_router.dish_repo, "get_dish", get_dish)
    monkeypatch.setattr(messages_router.meals_service, "prepare_item", prepare_item)
    monkeypatch.setattr(messages_router.meals_repo, "confirm_media_draft", confirm_media_draft)
    body = messages_router.ConfirmRequest(
        meal_date=date(2026, 8, 16),
        meal_type="dinner",
        items=[
            {
                "evidence_id": "evidence-1",
                "dish_name": "client tampering is ignored",
                "food_id": "different-id",
                "grams": 1,
                "portions": 2,
                "portion_unit": "kg",
            }
        ],
    )

    response = await messages_router.confirm_message("message-1", body, _user())

    assert response["created"] == 1
    assert captured[0]["dish_name"] == "Paneer Butter Masala"
    assert captured[0]["food_id"] == "dish-1"
    assert captured[0]["portions"] == 2
    assert captured[0]["portion_unit"] == "katori"
    assert captured[0]["grams"] == 320


async def test_confirmation_rejects_inactive_food_id_before_writing(monkeypatch) -> None:
    message = {
        "id": "message-1",
        "user_id": "user-1",
        "thread_id": "thread-1",
        "correlation_id": "correlation-1",
        "msg_type": "image",
        "status": "needs_confirmation",
        "payload": {
            "items": [
                {
                    "evidence_id": "evidence-1",
                    "name": "Dal",
                    "food_id": "inactive-id",
                    "portion_metadata": {"portion_unit": "katori", "portion_grams": 180},
                }
            ]
        },
    }

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def get_dish(_food_id: str) -> None:
        return None

    async def prepare_item(**_kwargs):
        pytest.fail("invalid food IDs must be rejected before meal creation")

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.dish_repo, "get_dish", get_dish)
    monkeypatch.setattr(messages_router.meals_service, "prepare_item", prepare_item)
    body = messages_router.ConfirmRequest(
        meal_date=date(2026, 8, 16),
        meal_type="dinner",
        items=[
            {
                "evidence_id": "evidence-1",
                "dish_name": "Dal",
                "food_id": " inactive-id ",
                "grams": 180,
            }
        ],
    )

    with pytest.raises(ValidationError) as error:
        await messages_router.confirm_message("message-1", body, _user())

    assert error.value.code == "DISH_NOT_FOUND"


async def test_discard_closes_draft_without_logging(monkeypatch) -> None:
    message = {"id": "message-1", "user_id": "user-1", "status": "needs_confirmation"}
    discarded: list[tuple[str, str]] = []

    async def get_message(_user_id: str, _message_id: str) -> dict[str, Any]:
        return message

    async def discard_media_draft(*, user_id: str, message_id: str) -> None:
        discarded.append((user_id, message_id))

    monkeypatch.setattr(messages_router.message_repo, "get_message", get_message)
    monkeypatch.setattr(messages_router.meals_repo, "discard_media_draft", discard_media_draft)

    response = await messages_router.discard_message("message-1", _user())

    assert response.status_code == 204
    assert discarded == [("user-1", "message-1")]


@pytest.mark.parametrize(
    "field,value",
    [("grams", 0), ("grams", math.inf), ("grams", math.nan), ("portions", -1)],
)
def test_confirmation_amounts_must_be_positive_and_finite(field: str, value: float) -> None:
    with pytest.raises(ValueError):
        messages_router.ConfirmationItem(**{"dish_name": "Dal", field: value})
