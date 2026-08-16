"""API v1 - messages. ONE endpoint for every modality.

    POST /messages              Send anything: text, image, video, audio, pdf
    GET  /messages              Thread history, paginated
    GET  /messages/{id}         Poll one message (status + payload draft)
    POST /messages/{id}/confirm Commit the draft into meals rows

Extraction is a STATUS on the message row, not a jobs table: the lifecycle IS
the message's lifecycle, and a jobs table would duplicate user_id, the media
reference, the raw output and a status the message needs anyway.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.agents.media_facts.runner import run_media_facts_agent, validate_media_upload
from app.agents.nutrition_chat.runner import run_nutrition_chat_agent
from app.core.deps import CurrentUser, get_current_user
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.dishes import repository as dish_repo
from app.domain.meals import service as meals_service
from app.domain.messages import repository as message_repo
from app.services.media_meal_draft import build_media_meal_draft
from app.services.speech_to_text import transcribe_audio, validate_audio_upload
from app.utils.logger import logger

router = APIRouter(prefix="/messages", tags=["messages"])

_MIME_TO_TYPE = {
    "image": "image",
    "video": "video",
    "audio": "audio",
    "application/pdf": "pdf",
}


def _msg_type(mime: str) -> str:
    if mime == "application/pdf":
        return "pdf"
    return _MIME_TO_TYPE.get(mime.split("/")[0], "text")


class MessageResponse(BaseModel):
    id: str
    thread_id: str
    correlation_id: str
    direction: str
    msg_type: str
    msg_text: str | None = None
    media_url: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: str


class ConfirmationItem(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")

    dish_name: str = Field(..., min_length=1)
    evidence_id: str | None = None
    food_id: str | None = None
    grams: float | None = Field(None, gt=0)
    portions: float = Field(1.0, gt=0)
    portion_unit: str | None = None
    confidence: str | None = None

    @field_validator("dish_name")
    @classmethod
    def normalise_dish_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Dish name cannot be blank")
        return value

    @field_validator("evidence_id", "food_id", "portion_unit", "confidence", mode="before")
    @classmethod
    def normalise_optional_text(cls, value: Any) -> Any:
        if value is None:
            return None
        value = str(value).strip()
        return value or None


class ConfirmRequest(BaseModel):
    meal_date: date
    meal_type: Literal["breakfast", "brunch", "lunch", "snacks", "dinner", "misc"]
    # The user's edits win over the model's draft.
    items: list[ConfirmationItem] = Field(default_factory=list)


def _agent_messages(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Convert persisted thread rows into the model's conversation format."""
    messages: list[dict[str, str]] = []
    for row in rows:
        if row.get("status") == "failed":
            continue
        content = row.get("msg_text") or ""
        payload = row.get("payload") or {}
        if (
            row.get("direction") == "inbound"
            and row.get("status") == "needs_confirmation"
            and payload
        ):
            content += "\n\nStructured media draft (not yet confirmed): " + json.dumps(
                payload, separators=(",", ":")
            )
        if content:
            messages.append(
                {
                    "role": "user" if row.get("direction") == "inbound" else "assistant",
                    "content": content,
                }
            )
    return messages


async def _failure_reply(
    *, user_id: str, inbound: dict[str, Any], detail: str
) -> list[MessageResponse]:
    updated = await message_repo.update_message(
        user_id=user_id,
        message_id=inbound["id"],
        patch={"status": "failed"},
    )
    reply = await message_repo.create_message(
        {
            "user_id": user_id,
            "thread_id": inbound["thread_id"],
            "correlation_id": inbound["correlation_id"],
            "direction": "outbound",
            "msg_type": "text",
            "msg_text": detail,
            "status": "not_applicable",
        }
    )
    return [MessageResponse(**(updated or inbound)), MessageResponse(**reply)]


@router.post("", response_model=list[MessageResponse], status_code=201)
async def send_message(
    user: CurrentUser = Depends(get_current_user),
    text: str | None = Form(None),
    thread_id: str | None = Form(None),
    file: UploadFile | None = File(None),
) -> list[MessageResponse]:
    """Route text and transcribed audio to chat; route visual media to review."""
    if not file and not (text or "").strip():
        raise ValidationError(
            "Send a message or attach a file.",
            code="EMPTY_MESSAGE",
            suggested_action="Type what you ate or attach an image or audio file.",
        )

    mime = ((file.content_type if file else "text/plain") or "text/plain").split(";", 1)[0]
    mime = mime.strip().lower()
    mtype = _msg_type(mime)
    file_bytes: bytes | None = None
    if file:
        if mtype in {"image", "pdf"}:
            validation_error = validate_media_upload(mime, file.size or 0)
        elif mtype == "audio":
            validation_error = validate_audio_upload(mime, file.size or 0)
        else:
            validation_error = f"Unsupported file type: {mime}"
        if validation_error:
            raise ValidationError(
                validation_error,
                code=("VIDEO_UNSUPPORTED" if mime.startswith("video/") else "INVALID_MEDIA"),
                suggested_action="Attach a supported image, audio file, or PDF within the limit.",
            )
        file_bytes = await file.read()
        if mtype in {"image", "pdf"}:
            validation_error = validate_media_upload(mime, len(file_bytes))
        else:
            validation_error = validate_audio_upload(mime, len(file_bytes))
        if validation_error:
            raise ValidationError(
                validation_error,
                code="MEDIA_TOO_LARGE",
                suggested_action="Attach a smaller file.",
            )

    row = {
        "user_id": user.id,
        "direction": "inbound",
        "msg_type": mtype,
        "msg_text": text,
        "status": "received",
        "media_meta": {
            "mime": mime,
            "filename": file.filename if file else None,
            "bytes": len(file_bytes) if file_bytes is not None else None,
        },
    }
    if thread_id:
        row["thread_id"] = thread_id
    inbound = await message_repo.create_message(row)
    normalized_text = (text or "").strip()
    draft_payload: dict[str, Any] = {}

    if file and mtype in {"image", "pdf"}:
        await message_repo.update_message(
            user_id=user.id,
            message_id=inbound["id"],
            patch={"status": "processing"},
        )
        try:
            media_result = await run_media_facts_agent(
                user_id=user.id,
                thread_id=inbound["thread_id"],
                mime_type=mime,
                data=file_bytes or b"",
                user_note=text,
                filename=file.filename,
                correlation_id=inbound["correlation_id"],
            )
        except Exception as exc:
            logger.exception("media_facts_failed user_id={} error={}", user.id, str(exc))
            return await _failure_reply(
                user_id=user.id,
                inbound=inbound,
                detail="I couldn't read that attachment. Please try again.",
            )
        if not media_result.ok or not media_result.facts or not media_result.facts.items:
            return await _failure_reply(
                user_id=user.id,
                inbound=inbound,
                detail=media_result.detail or "I couldn't find reviewable food evidence.",
            )
        try:
            draft_payload = await build_media_meal_draft(
                user_id=user.id,
                thread_id=inbound["thread_id"],
                facts=media_result.facts,
                correlation_id=inbound["correlation_id"],
            )
        except Exception as exc:
            logger.exception("meal_resolver_failed user_id={} error={}", user.id, str(exc))
            return await _failure_reply(
                user_id=user.id,
                inbound=inbound,
                detail="I couldn't prepare that meal draft. Please try again.",
            )
        draft_payload.setdefault("source_metadata", {}).update(
            {"mime_type": mime, "filename": file.filename}
        )
        updated = await message_repo.update_message(
            user_id=user.id,
            message_id=inbound["id"],
            patch={
                "msg_text": normalized_text or None,
                "payload": draft_payload,
                "status": "needs_confirmation",
            },
        )
        if not updated:
            raise NotFoundError("Message not found", code="MESSAGE_NOT_FOUND")
        item_count = len(draft_payload.get("items") or [])
        review_text = (
            f"I prepared {item_count} item{'s' if item_count != 1 else ''} from the "
            "attachment. Review and edit the meal draft before confirming."
        )
        reply = await message_repo.create_message(
            {
                "user_id": user.id,
                "thread_id": inbound["thread_id"],
                "correlation_id": inbound["correlation_id"],
                "direction": "outbound",
                "msg_type": "text",
                "msg_text": review_text,
                "payload": {"needs_confirmation": True},
                "status": "not_applicable",
            }
        )
        logger.info("message_processed user_id={} type={} status=needs_confirmation", user.id, mtype)
        return [MessageResponse(**updated), MessageResponse(**reply)]

    if file and mtype == "audio":
        await message_repo.update_message(
            user_id=user.id,
            message_id=inbound["id"],
            patch={"status": "processing"},
        )
        try:
            transcription = await transcribe_audio(
                data=file_bytes or b"",
                mime_type=mime,
                filename=file.filename,
            )
            normalized_text = transcription.text
        except Exception as exc:
            logger.exception("audio_transcription_failed user_id={} error={}", user.id, str(exc))
            return await _failure_reply(
                user_id=user.id,
                inbound=inbound,
                detail="I couldn't transcribe that audio. Please try again or type your message.",
            )

    updated = await message_repo.update_message(
        user_id=user.id,
        message_id=inbound["id"],
        patch={
            "msg_text": normalized_text,
            "payload": {},
            "status": "confirmed",
        },
    )
    if not updated:
        raise NotFoundError("Message not found", code="MESSAGE_NOT_FOUND")

    history = await message_repo.list_thread_messages(
        user_id=user.id, thread_id=inbound["thread_id"]
    )
    try:
        turn = await run_nutrition_chat_agent(
            user_id=user.id,
            thread_id=inbound["thread_id"],
            messages=_agent_messages(history),
            extraction_payload={},
            correlation_id=inbound["correlation_id"],
        )
    except Exception as exc:
        logger.exception("nutrition_agent_failed user_id={} error={}", user.id, str(exc))
        return await _failure_reply(
            user_id=user.id,
            inbound=updated,
            detail="The nutrition assistant couldn't respond. Please try again.",
        )

    reply = await message_repo.create_message(
        {
            "user_id": user.id,
            "thread_id": inbound["thread_id"],
            "correlation_id": inbound["correlation_id"],
            "direction": "outbound",
            "msg_type": "text",
            "msg_text": turn.reply,
            "payload": {
                "tool_calls": [call.model_dump() for call in turn.tool_calls],
                "needs_confirmation": turn.needs_confirmation,
            },
            "status": "not_applicable",
        }
    )
    logger.info("message_processed user_id={} type={} status=confirmed", user.id, mtype)
    return [MessageResponse(**updated), MessageResponse(**reply)]


@router.get("", response_model=Page[MessageResponse])
async def list_messages(
    user: CurrentUser = Depends(get_current_user),
    params: PaginationParams = Depends(pagination),
    thread_id: str | None = None,
) -> Page[MessageResponse]:
    rows, total = await message_repo.list_messages(
        user_id=user.id,
        offset=params.offset,
        limit=params.page_size,
        thread_id=thread_id,
    )
    return Page.build([MessageResponse(**m) for m in rows], total, params)


@router.get("/{message_id}", response_model=MessageResponse)
async def get_message(
    message_id: str, user: CurrentUser = Depends(get_current_user)
) -> MessageResponse:
    message = await message_repo.get_message(user.id, message_id)
    if not message:
        raise NotFoundError("Message not found", code="MESSAGE_NOT_FOUND")
    return MessageResponse(**message)


@router.post("/{message_id}/discard", status_code=204)
async def discard_message(
    message_id: str, user: CurrentUser = Depends(get_current_user)
) -> Response:
    """Close a review draft without writing meal rows."""
    message = await message_repo.get_message(user.id, message_id)
    if not message:
        raise NotFoundError("Message not found", code="MESSAGE_NOT_FOUND")
    if message["status"] == "confirmed":
        raise ConflictError(
            "This draft has already been logged.", code="MESSAGE_ALREADY_CONFIRMED"
        )
    if message["status"] == "needs_confirmation":
        await message_repo.update_message(
            user_id=user.id,
            message_id=message_id,
            patch={"status": "not_applicable"},
        )
    return Response(status_code=204)


@router.post("/{message_id}/confirm")
async def confirm_message(
    message_id: str,
    body: ConfirmRequest,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Commit an extraction draft. Staged, never direct - a bulk import that
    silently writes 200 wrong entries is worse than no import."""
    message = await message_repo.get_message(user.id, message_id)
    if not message:
        raise NotFoundError("Message not found", code="MESSAGE_NOT_FOUND")
    if message["status"] != "needs_confirmation":
        raise ConflictError(
            "This message has already been confirmed or has no draft.",
            code="MESSAGE_NOT_CONFIRMABLE",
        )

    items = list(body.items)
    if not items:
        for item in (message.get("payload") or {}).get("items", []):
            grams = item.get("total_grams") or item.get("estimated_mass_g")
            confidence = item.get("confidence")
            if isinstance(confidence, dict):
                confidence = confidence.get("mass") or confidence.get("identity")
            items.append(
                ConfirmationItem(
                    dish_name=item.get("resolved_name") or item.get("name") or "Unknown item",
                    evidence_id=item.get("evidence_id"),
                    food_id=item.get("food_id"),
                    grams=grams,
                    portions=item.get("servings") or item.get("portions") or 1.0,
                    portion_unit=item.get("portion_unit") or ("g" if grams is not None else None),
                    confidence=confidence,
                )
            )
    if not items:
        raise ValidationError(
            "This draft has no meal items to import.",
            code="EMPTY_MEAL_DRAFT",
            suggested_action="Review the extraction or add at least one meal item.",
        )

    draft_items = (message.get("payload") or {}).get("items", [])
    draft_by_evidence = {
        str(item["evidence_id"]): item
        for item in draft_items
        if item.get("evidence_id")
    }
    evidence_ids = [item.evidence_id for item in items if item.evidence_id]
    if len(evidence_ids) != len(set(evidence_ids)):
        raise ValidationError("A draft item can be confirmed only once.", code="DUPLICATE_DRAFT_ITEM")

    resolved_items: list[dict[str, Any]] = []
    for item in items:
        stored = draft_by_evidence.get(item.evidence_id or "") if item.evidence_id else None
        if item.evidence_id and stored is None:
            raise ValidationError(
                "The selected draft item no longer exists.",
                code="DRAFT_ITEM_NOT_FOUND",
            )
        if stored:
            portion_metadata = stored.get("portion_metadata") or {}
            portion_grams = portion_metadata.get("portion_grams")
            try:
                fixed_grams = float(portion_grams)
            except (TypeError, ValueError) as exc:
                raise ValidationError(
                    "The selected dish has no fixed serving size.",
                    code="SERVING_SIZE_UNAVAILABLE",
                ) from exc
            if fixed_grams <= 0:
                raise ValidationError(
                    "The selected dish has no fixed serving size.",
                    code="SERVING_SIZE_UNAVAILABLE",
                )
            resolved_items.append(
                {
                    "dish_name": stored.get("resolved_name") or stored.get("name"),
                    "food_id": stored.get("food_id"),
                    "grams": round(item.portions * fixed_grams, 2),
                    "portions": item.portions,
                    "portion_unit": portion_metadata.get("portion_unit") or "serving",
                    "confidence": stored.get("confidence") or item.confidence,
                }
            )
        else:
            resolved_items.append(item.model_dump())

    created = []
    source_kind = ((message.get("payload") or {}).get("source_metadata") or {}).get("kind")
    source = {
        "food_photo": "photo",
        "nutrition_label": "label",
        "food_diary_pdf": "pdf_import",
    }.get(source_kind, "photo" if message["msg_type"] == "image" else "pdf_import")
    for item in resolved_items:
        if item.get("food_id") and not await dish_repo.get_dish(item["food_id"]):
            raise ValidationError(
                "The selected dish does not exist or is no longer active.",
                code="DISH_NOT_FOUND",
                suggested_action="Choose an active dish and confirm again.",
                context={"food_id": item["food_id"]},
            )

    for item in resolved_items:
        created.append(
            await meals_service.add_item(
                user_id=user.id,
                meal_date=body.meal_date,
                meal_type=body.meal_type,
                dish_name=item["dish_name"],
                food_id=item.get("food_id"),
                grams=item.get("grams"),
                portions=item["portions"],
                portion_unit=item.get("portion_unit"),
                source=source,
                confidence=item.get("confidence"),
            )
        )

    await message_repo.update_message(
        user_id=user.id,
        message_id=message_id,
        patch={"status": "confirmed"},
    )
    await message_repo.create_message(
        {
            "user_id": user.id,
            "thread_id": message["thread_id"],
            "correlation_id": message["correlation_id"],
            "direction": "outbound",
            "msg_type": "text",
            "msg_text": f"Logged {len(created)} item{'s' if len(created) != 1 else ''}.",
            "status": "not_applicable",
        }
    )
    try:
        await message_repo.create_audit_record(
            {
                "entity": "meal",
                "entity_id": created[0].get("id") if created else None,
                "user_id": user.id,
                "action": "CREATE",
                "new_value": {
                    "message_id": message_id,
                    "meal_date": body.meal_date.isoformat(),
                    "meal_type": body.meal_type,
                    "meal_ids": [meal.get("id") for meal in created],
                    "item_count": len(created),
                    "source": source,
                },
                "actor": user.id,
                "source": "api",
            }
        )
    except Exception as exc:
        logger.warning(
            "meal_import_audit_failed user_id={} message_id={} error={}",
            user.id,
            message_id,
            str(exc),
        )
    return {"created": len(created), "meals": created}
