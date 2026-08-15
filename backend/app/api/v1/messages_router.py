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

import base64
import json
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field

from app.agents.media_extraction import run_media_extraction_agent
from app.agents.nutrition_chat.runner import run_nutrition_chat_agent
from app.core.deps import CurrentUser, get_current_user
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.core.pagination import Page, PaginationParams, pagination
from app.domain.meals import service as meals_service
from app.domain.messages import repository as message_repo
from app.services.media_extraction import validate_media_upload
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


class ConfirmRequest(BaseModel):
    meal_date: date
    meal_type: str
    # The user's edits win over the model's draft.
    items: list[dict[str, Any]] = Field(default_factory=list)


def _agent_messages(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Convert persisted thread rows into the model's conversation format."""
    messages: list[dict[str, str]] = []
    for row in rows:
        if row.get("status") == "failed":
            continue
        content = row.get("msg_text") or ""
        payload = row.get("payload") or {}
        if row.get("direction") == "inbound" and payload:
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
    """Normalize uploaded media, then run every successful turn through chat."""
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
        validation_error = validate_media_upload(mime, file.size or 0)
        if validation_error:
            raise ValidationError(
                validation_error,
                code=("VIDEO_UNSUPPORTED" if mime.startswith("video/") else "INVALID_MEDIA"),
                suggested_action="Attach a supported image, audio file, or PDF within the limit.",
            )
        file_bytes = await file.read()
        validation_error = validate_media_upload(mime, len(file_bytes))
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
    extraction_payload: dict[str, Any] = {}

    if file:
        await message_repo.update_message(
            user_id=user.id,
            message_id=inbound["id"],
            patch={"status": "processing"},
        )
        data_b64 = base64.b64encode(file_bytes or b"").decode()
        extraction = await run_media_extraction_agent(
            user_id=user.id,
            thread_id=inbound["thread_id"],
            mime_type=mime,
            data_b64=data_b64,
            user_text=text,
            filename=file.filename,
            samples=3 if mime.startswith("image/") else 1,
            correlation_id=inbound["correlation_id"],
        )
        if not extraction.ok:
            return await _failure_reply(
                user_id=user.id,
                inbound=inbound,
                detail=extraction.detail or "I couldn't read that attachment.",
            )
        normalized_text = extraction.as_tagged(mtype)
        if text:
            normalized_text = f"{normalized_text}\n\nUser note: {text}".strip()
        extraction_payload = extraction.payload

    status = "needs_confirmation" if extraction_payload else "confirmed"
    updated = await message_repo.update_message(
        user_id=user.id,
        message_id=inbound["id"],
        patch={
            "msg_text": normalized_text,
            "payload": extraction_payload,
            "status": status,
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
            extraction_payload=extraction_payload,
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
    logger.info("message_processed user_id={} type={} status={}", user.id, mtype, status)
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

    items = body.items or []
    if not items:
        for item in (message.get("payload") or {}).get("items", []):
            grams = item.get("estimated_mass_g")
            confidence = item.get("confidence")
            if isinstance(confidence, dict):
                confidence = confidence.get("mass") or confidence.get("identity")
            items.append(
                {
                    "dish_name": item.get("name") or "Unknown item",
                    "grams": grams,
                    "portions": 1.0 if grams is not None else item.get("quantity") or 1.0,
                    "portion_unit": "g" if grams is not None else item.get("unit"),
                    "confidence": confidence,
                }
            )
    if not items:
        raise ValidationError(
            "This draft has no meal items to import.",
            code="EMPTY_MEAL_DRAFT",
            suggested_action="Review the extraction or add at least one meal item.",
        )

    created = []
    source_kind = ((message.get("payload") or {}).get("source_metadata") or {}).get("kind")
    source = {
        "food_photo": "photo",
        "nutrition_label": "label",
        "food_diary_pdf": "pdf_import",
    }.get(source_kind, "photo" if message["msg_type"] == "image" else "pdf_import")
    for item in items:
        created.append(
            await meals_service.add_item(
                user_id=user.id,
                meal_date=body.meal_date,
                meal_type=body.meal_type,
                dish_name=item["dish_name"],
                food_id=item.get("food_id"),
                grams=item.get("grams"),
                portions=item.get("portions", 1.0),
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
