"""Prompt-free OpenAI speech transcription service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

from app.config.settings import settings

AUDIO_SIZE_LIMITS = {
    "audio/mpeg": 25 * 1024 * 1024,
    "audio/mp3": 25 * 1024 * 1024,
    "audio/mp4": 25 * 1024 * 1024,
    "audio/wav": 25 * 1024 * 1024,
    "audio/webm": 25 * 1024 * 1024,
    "audio/ogg": 25 * 1024 * 1024,
}


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


def validate_audio_upload(mime_type: str, size_bytes: int) -> str | None:
    limit = AUDIO_SIZE_LIMITS.get(mime_type)
    if limit is None:
        return f"Unsupported file type: {mime_type}"
    if size_bytes > limit:
        return f"That audio is too large. The limit is {limit // (1024 * 1024)} MB."
    return None


async def transcribe_audio(
    *, data: bytes, mime_type: str, filename: str | None = None
) -> TranscriptionResult:
    validation_error = validate_audio_upload(mime_type, len(data))
    if validation_error:
        raise ValueError(validation_error)
    if not settings.ai_enabled:
        raise RuntimeError("AI features are disabled - no OPENAI_API_KEY is configured.")

    extension = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/wav": "wav",
        "audio/webm": "webm",
        "audio/ogg": "ogg",
    }[mime_type]
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    response: Any = await client.audio.transcriptions.create(
        model=settings.AUDIO_MODEL,
        file=(filename or f"voice-note.{extension}", data, mime_type),
    )
    text = str(getattr(response, "text", "")).strip()
    if not text:
        raise ValueError("No speech was detected in the audio.")
    usage = getattr(response, "usage", None)
    return TranscriptionResult(
        text=text,
        model=str(getattr(response, "model", None) or settings.AUDIO_MODEL),
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
    )
