"""OpenAI provider I/O used by the media extraction LangGraph node."""

from __future__ import annotations

import asyncio
import base64
import json
import statistics
from dataclasses import dataclass, field
from typing import Any

from app.config.settings import settings
from app.services.prompts import ResolvedPrompt, resolve_prompt
from app.utils.logger import logger

# ---------------------------------------------------------------------------
# Prompts, one per modality. Checked in as the fallback; LangSmith (when
# configured) is the runtime source of truth, as in KookarCore.
# ---------------------------------------------------------------------------

FOOD_PHOTO_PROMPT = """You are estimating what is on a plate so a nutrition app can log it.

Return MASS, never calories. The app multiplies your grams by its own food
table, so every number stays auditable and recomputable when the user edits a
portion.

Rules that matter:
- `mass_range_g` is MANDATORY and must be non-degenerate (low != high).
- Separate `visible_ingredients` from `inferred_ingredients`. Cooking oil and
  ghee are almost never visible but are the single largest error source in
  Indian food - put them in `inferred_ingredients` with your reasoning.
- Countables use count x unit_mass_g. "3 rotis", never "135 g of roti".
- Do NOT pick a database id. Emit a normalised name; the app retrieves candidates.
- If the image is unusable, say so in image_quality.usable=false rather than guessing.

Return ONLY valid JSON:
{
  "image_quality": {"usable": bool, "issues": [str],
                    "scale_reference": {"type": str, "source": "visible"|"assumed"}},
  "meal_context": {"cuisine": str, "setting": str},
  "items": [{
    "name": str, "name_normalized": str, "container": str,
    "estimated_mass_g": number,
    "mass_range_g": {"low": number, "high": number},
    "mass_basis": "container_volume"|"area_x_depth"|"count_x_unit"|"user_stated",
    "count": number|null, "unit_mass_g": number|null,
    "visible_ingredients": [str],
    "inferred_ingredients": [{"name": str, "estimated_g": number,
                              "basis": str, "confidence": "low"|"medium"|"high"}],
    "assumptions": [str],
    "confidence": {"identity": str, "mass": str}
  }],
  "possible_missed_items": [str]
}"""

NUTRITION_LABEL_PROMPT = """Read this nutrition label.

FSSAI panels declare per 100 g/ml AND per serve, so the panel is natively two
or three numeric columns. Binding the right number to the right column is where
this task fails - finding the field NAMES is easy, binding VALUES is not.

Per-serve vs per-100g confusion is a silent 3.3x error. Be explicit about which
column each value came from.

Consistency check you can run yourself: FSSAI fixes the %RDA basis by
regulation (2000 kcal, 67 g fat, 22 g saturated fat, 2 g trans fat, 50 g added
sugar, 2000 mg sodium). If the panel shows a %RDA column, recompute it from the
absolute values. If it does not reconcile, your column mapping is wrong - say so.

Return ONLY valid JSON:
{
  "serving_size_g": number|null,
  "servings_per_pack": number|null,
  "per_100g": {"calories_kcal": number, "protein_g": number, "carbs_g": number,
               "fat_g": number, "fiber_g": number, "sodium_mg": number},
  "per_serve": {...same keys...},
  "rda_reconciles": bool|null,
  "confidence": "low"|"medium"|"high",
  "notes": str
}"""

VOICE_LOG_PROMPT = """Transcribe this audio exactly. It is someone saying what they ate.

Return ONLY the transcript text, nothing else. Do not summarise, do not
interpret quantities, do not add punctuation the speaker did not imply.
If there is no speech, return exactly: <NO_SPEECH/>"""

FOOD_DIARY_PDF_PROMPT = """Extract the food diary rows from this PDF.

Return ONLY valid JSON:
{
  "rows": [{"date": "YYYY-MM-DD", "meal_type": str, "item": str,
            "quantity": number|null, "unit": str|null,
            "calories_kcal": number|null}],
  "row_count": number,
  "date_range": {"from": str, "to": str},
  "columns_detected": [str],
  "confidence": "low"|"medium"|"high"
}

If a column is ambiguous, say so in columns_detected rather than guessing a mapping."""

FOOD_PHOTO_PROMPT_NAME = "food-photo-v1"
NUTRITION_LABEL_PROMPT_NAME = "nutrition-label-v1"
VOICE_LOG_PROMPT_NAME = "voice-log-v1"
FOOD_DIARY_PDF_PROMPT_NAME = "food-diary-pdf-v1"


MEDIA_SIZE_LIMITS = {
    "image/jpeg": 10 * 1024 * 1024,
    "image/png": 10 * 1024 * 1024,
    "image/webp": 10 * 1024 * 1024,
    "audio/mpeg": 25 * 1024 * 1024,
    "audio/mp3": 25 * 1024 * 1024,
    "audio/mp4": 25 * 1024 * 1024,
    "audio/wav": 25 * 1024 * 1024,
    "audio/webm": 25 * 1024 * 1024,
    "audio/ogg": 25 * 1024 * 1024,
    "application/pdf": 20 * 1024 * 1024,
}


@dataclass
class ProviderOutput:
    text: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


@dataclass
class ExtractionResult:
    """What the layer hands to the agent."""

    text: str = ""  # ALWAYS populated
    payload: dict[str, Any] = field(default_factory=dict)
    ok: bool = True
    detail: str | None = None  # user-readable failure reason
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    prompt_name: str | None = None
    prompt_version: str | None = None
    prompt_source: str | None = None

    def as_tagged(self, msg_type: str) -> str:
        """Splice into the message body as tags - KookarCore's exact shape."""
        if not self.text:
            return ""
        if msg_type == "image":
            return f"<image>{self.text}</image>\n\nUser sent an image, description above"
        if msg_type == "audio":
            return f"<audio>{self.text}</audio>"
        if msg_type == "video":
            return f"[auto-video-caption]: {self.text}"
        if msg_type == "pdf":
            return f"<document>{self.text}</document>"
        return self.text


def validate_media_upload(mime_type: str, size_bytes: int) -> str | None:
    """Return a user-readable validation error before encoding/provider work."""
    if mime_type.startswith("video/"):
        return "Video extraction is not supported yet. Send a photo or voice note."
    limit = MEDIA_SIZE_LIMITS.get(mime_type)
    if limit is None:
        return f"Unsupported file type: {mime_type}"
    if size_bytes > limit:
        return (
            f"That {mime_type.split('/')[0]} is too large. "
            f"The limit is {limit // (1024 * 1024)} MB."
        )
    return None


def _decoded_b64_size(data_b64: str) -> int:
    data = data_b64.strip()
    return max(0, len(data) * 3 // 4 - data[-2:].count("=")) if data else 0


def _provider_output(response: Any, *, fallback_model: str) -> ProviderOutput:
    if isinstance(response, ProviderOutput):
        return response
    if isinstance(response, str):
        return ProviderOutput(text=response, model=fallback_model)
    usage = getattr(response, "usage", None)
    return ProviderOutput(
        text=str(getattr(response, "output_text", None) or getattr(response, "text", "")),
        model=str(getattr(response, "model", None) or fallback_model),
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        cost_usd=getattr(usage, "cost_usd", None),
    )


async def _call_openai_media(prompt: str, media_b64: str, mime: str) -> ProviderOutput:
    """Call the cheapest configured OpenAI vision model through Responses API."""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    if mime.startswith("image/"):
        content.append(
            {
                "type": "input_image",
                "image_url": f"data:{mime};base64,{media_b64}",
            }
        )
    elif mime == "application/pdf":
        content.append(
            {
                "type": "input_file",
                "filename": "food-diary.pdf",
                "file_data": f"data:{mime};base64,{media_b64}",
            }
        )
    else:
        raise ValueError(f"Unsupported OpenAI media input: {mime}")

    response = await client.responses.create(
        model=settings.VISION_MODEL,
        input=[{"role": "user", "content": content}],
        temperature=0,
    )
    return _provider_output(response, fallback_model=settings.VISION_MODEL)


async def _transcribe_openai_audio(
    data_b64: str, mime: str, prompt: str = VOICE_LOG_PROMPT
) -> ProviderOutput:
    """Transcribe audio with OpenAI's lowest-cost transcription model."""
    from openai import AsyncOpenAI

    extension = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/wav": "wav",
        "audio/webm": "webm",
        "audio/ogg": "ogg",
    }.get(mime, "audio")
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    response = await client.audio.transcriptions.create(
        model=settings.AUDIO_MODEL,
        file=(f"voice-note.{extension}", base64.b64decode(data_b64), mime),
        prompt=prompt,
    )
    return _provider_output(response, fallback_model=settings.AUDIO_MODEL)


def _parse_json(raw: str) -> dict[str, Any]:
    """Models fence JSON even when told not to. Salvage rather than fail."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    return {}


def _describe(payload: dict[str, Any]) -> str:
    """Turn a photo payload into the one line the agent reads."""
    items = payload.get("items") or []
    if not items:
        return "A photo of food, but no items could be identified."
    parts = [f"{i.get('name', 'item')} ({i.get('estimated_mass_g', '?')} g)" for i in items]
    return "Plate with " + "; ".join(parts)


def _is_nutrition_label_request(text: str | None, filename: str | None) -> bool:
    """Use only explicit language and filenames; this is not vision classification."""
    request = (text or "").lower()
    if any(
        phrase in request
        for phrase in ("nutrition label", "nutritional label", "nutrition facts", "back of pack")
    ):
        return True
    normalized_name = (filename or "").lower().replace("_", "-").replace(" ", "-")
    return any(
        marker in normalized_name
        for marker in ("nutrition-label", "nutritional-label", "nutrition-facts", "food-label")
    )


def _pdf_row_mass_g(row: dict[str, Any]) -> float | None:
    quantity = row.get("quantity")
    try:
        amount = float(quantity)
    except (TypeError, ValueError):
        return None
    unit = str(row.get("unit") or "").strip().lower()
    if unit in {"g", "gram", "grams"}:
        return amount
    if unit in {"kg", "kilogram", "kilograms"}:
        return amount * 1000
    return None


def _pdf_rows_to_items(rows: list[Any]) -> list[dict[str, Any]]:
    """Map diary rows to the same review contract used by meal photos."""
    items: list[dict[str, Any]] = []
    for index, value in enumerate(rows):
        if not isinstance(value, dict) or not str(value.get("item") or "").strip():
            continue
        row = dict(value)
        items.append(
            {
                "name": str(row["item"]).strip(),
                "estimated_mass_g": _pdf_row_mass_g(row),
                "quantity": row.get("quantity"),
                "unit": row.get("unit"),
                "meal_date": row.get("date"),
                "meal_type": row.get("meal_type"),
                "source_metadata": {"kind": "pdf_row", "row_index": index, "row": row},
            }
        )
    return items


def _usage_totals(outputs: list[ProviderOutput]) -> dict[str, Any]:
    def total(field_name: str) -> int | None:
        values = [getattr(output, field_name) for output in outputs]
        present = [value for value in values if value is not None]
        return sum(present) if present else None

    costs = [output.cost_usd for output in outputs if output.cost_usd is not None]
    return {
        "model": next((output.model for output in outputs if output.model), None),
        "input_tokens": total("input_tokens"),
        "output_tokens": total("output_tokens"),
        "cost_usd": sum(costs) if costs else None,
    }


def _prompt_metadata(prompt: ResolvedPrompt) -> dict[str, str | None]:
    return {
        "prompt_name": prompt.name,
        "prompt_version": prompt.version,
        "prompt_source": prompt.source,
    }


async def extract_media(
    *,
    mime_type: str,
    data_b64: str | None = None,
    text: str | None = None,
    filename: str | None = None,
    samples: int = 1,
) -> ExtractionResult:
    """THE function. Branches on MIME, returns normalised text + structure.

    ``samples`` runs the vision path N times for dispersion-based confidence -
    we do NOT ask the model how confident it is, because verbalised confidence
    tracks commitment rather than correctness.
    """
    if mime_type.startswith("text/") or mime_type == "text/plain":
        return ExtractionResult(text=text or "")

    validation_error = validate_media_upload(mime_type, _decoded_b64_size(data_b64 or ""))
    if validation_error:
        return ExtractionResult(ok=False, detail=validation_error)

    if not settings.ai_enabled:
        return ExtractionResult(
            text=text or "",
            ok=False,
            detail="AI features are disabled - no OPENAI_API_KEY is configured.",
        )

    try:
        if mime_type.startswith("image/"):
            if _is_nutrition_label_request(text, filename):
                resolved_prompt = await resolve_prompt(
                    NUTRITION_LABEL_PROMPT_NAME, NUTRITION_LABEL_PROMPT
                )
                prompt = resolved_prompt.text
                if text:
                    prompt += f"\n\nThe user added this context: {text}"
                provider_output = _provider_output(
                    await _call_openai_media(prompt, data_b64 or "", mime_type),
                    fallback_model=settings.VISION_MODEL,
                )
                parsed = _parse_json(provider_output.text)
                if not parsed:
                    return ExtractionResult(
                        ok=False,
                        detail="I couldn't read that nutrition label. Try a closer, sharper photo.",
                        **_prompt_metadata(resolved_prompt),
                        **_usage_totals([provider_output]),
                    )
                parsed["source_metadata"] = {
                    "kind": "nutrition_label",
                    "mime_type": mime_type,
                    "filename": filename,
                    "routing": "explicit_request_or_filename_hint",
                }
                serving = parsed.get("serving_size_g")
                return ExtractionResult(
                    text=f"Nutrition label{f' with a {serving} g serving' if serving else ''}",
                    payload=parsed,
                    **_prompt_metadata(resolved_prompt),
                    **_usage_totals([provider_output]),
                )

            resolved_prompt = await resolve_prompt(FOOD_PHOTO_PROMPT_NAME, FOOD_PHOTO_PROMPT)
            prompt = resolved_prompt.text
            if text:
                prompt += f"\n\nThe user added this context: {text}"
            responses = await asyncio.gather(
                *(
                    _call_openai_media(prompt, data_b64 or "", mime_type)
                    for _ in range(max(1, samples))
                )
            )
            provider_outputs = [
                _provider_output(response, fallback_model=settings.VISION_MODEL)
                for response in responses
            ]
            runs: list[dict[str, Any]] = []
            for provider_output in provider_outputs:
                parsed = _parse_json(provider_output.text)
                if parsed:
                    runs.append(parsed)
            if not runs:
                return ExtractionResult(
                    ok=False,
                    detail="I couldn't read that photo. Try again with more light, "
                    "or just tell me what you ate.",
                    **_prompt_metadata(resolved_prompt),
                    **_usage_totals(provider_outputs),
                )
            payload = _merge_samples(runs)
            payload["source_metadata"] = {
                "kind": "food_photo",
                "mime_type": mime_type,
                "filename": filename,
                "routing": "default_photo_path",
            }
            if not (payload.get("image_quality") or {}).get("usable", True):
                return ExtractionResult(
                    ok=False,
                    detail="That photo is hard to read - a retake with more light "
                    "would help, or tell me what you ate.",
                    **_prompt_metadata(resolved_prompt),
                    **_usage_totals(provider_outputs),
                )
            return ExtractionResult(
                text=_describe(payload),
                payload=payload,
                **_prompt_metadata(resolved_prompt),
                **_usage_totals(provider_outputs),
            )

        if mime_type.startswith("audio/"):
            resolved_prompt = await resolve_prompt(VOICE_LOG_PROMPT_NAME, VOICE_LOG_PROMPT)
            provider_output = _provider_output(
                await _transcribe_openai_audio(
                    data_b64 or "", mime_type, resolved_prompt.text
                ),
                fallback_model=settings.AUDIO_MODEL,
            )
            transcript = provider_output.text.strip()
            if not transcript or transcript == "<NO_SPEECH/>":
                return ExtractionResult(
                    ok=False,
                    detail="I got your voice note but couldn't hear any speech. "
                    "Send it again, or type what you ate.",
                    **_prompt_metadata(resolved_prompt),
                    **_usage_totals([provider_output]),
                )
            return ExtractionResult(
                text=transcript,
                **_prompt_metadata(resolved_prompt),
                **_usage_totals([provider_output]),
            )

        if mime_type == "application/pdf":
            resolved_prompt = await resolve_prompt(
                FOOD_DIARY_PDF_PROMPT_NAME, FOOD_DIARY_PDF_PROMPT
            )
            provider_output = _provider_output(
                await _call_openai_media(resolved_prompt.text, data_b64 or "", mime_type),
                fallback_model=settings.VISION_MODEL,
            )
            payload = _parse_json(provider_output.text)
            rows = payload.get("rows") or []
            items = _pdf_rows_to_items(rows)
            if not items:
                return ExtractionResult(
                    ok=False,
                    detail="I couldn't find any reviewable food diary rows in that PDF.",
                    **_prompt_metadata(resolved_prompt),
                    **_usage_totals([provider_output]),
                )
            payload["items"] = items
            payload["source_metadata"] = {
                "kind": "food_diary_pdf",
                "mime_type": mime_type,
                "filename": filename,
                "original_row_count": len(rows),
            }
            return ExtractionResult(
                text=f"Food diary with {len(rows)} entries "
                f"({payload.get('date_range', {}).get('from', '?')} to "
                f"{payload.get('date_range', {}).get('to', '?')})",
                payload=payload,
                **_prompt_metadata(resolved_prompt),
                **_usage_totals([provider_output]),
            )

        return ExtractionResult(ok=False, detail=f"Unsupported file type: {mime_type}")

    except Exception as exc:
        logger.exception("media_extraction_failed mime={} error={}", mime_type, str(exc))
        return ExtractionResult(
            ok=False, detail="Something went wrong reading that. Please try again."
        )


def _merge_samples(runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Sample-and-disperse: the median mass, and the SPREAD as the range.

    Confidence comes from inter-sample dispersion, not from asking the model.
    """
    if len(runs) == 1:
        return runs[0]

    base = dict(runs[0])
    merged_items = []
    for idx, item in enumerate(base.get("items") or []):
        masses = []
        for run in runs:
            items = run.get("items") or []
            if idx < len(items):
                try:
                    masses.append(float(items[idx].get("estimated_mass_g", 0)))
                except (TypeError, ValueError):
                    continue
        if masses:
            median = statistics.median(masses)
            item = dict(item)
            item["estimated_mass_g"] = round(median, 1)
            item["mass_range_g"] = {"low": round(min(masses), 1), "high": round(max(masses), 1)}
            cv = (statistics.pstdev(masses) / median) if median else 0
            item["confidence"] = {
                **(item.get("confidence") or {}),
                "mass": "high" if cv < 0.15 else "medium" if cv < 0.35 else "low",
                "sample_cv": round(cv, 3),
            }
        merged_items.append(item)

    base["items"] = merged_items
    base["_samples"] = len(runs)
    return base


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()
