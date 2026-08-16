"""One-call structured media-facts agent."""

from __future__ import annotations

import re
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from openai import AsyncOpenAI

from app.agents.media_facts.models import MassRange, MediaFacts, MediaFactsAgentOutput, MediaKind
from app.agents.media_facts.prompt import (
    MEDIA_FACTS_PROMPT,
    MEDIA_FACTS_PROMPT_NAME,
    MEDIA_FACTS_USER_PROMPT,
)
from app.agents.media_facts.state import MediaFactsRuntimeContext, MediaFactsState
from app.config.settings import settings
from app.services.prompts import resolve_prompt
from app.utils.logger import logger

MEDIA_FACTS_AGENT_NAME = "media_facts"
SUPPORTED_MEDIA_MIME_TYPES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "application/pdf"}
)


def media_kind_for_mime(mime_type: str) -> MediaKind:
    if mime_type in {"image/jpeg", "image/png", "image/webp"}:
        return "image"
    if mime_type == "application/pdf":
        return "pdf"
    raise ValueError(f"Unsupported media facts input: {mime_type}")


def build_provider_input(
    *,
    system_prompt: str,
    user_template: str,
    mime_type: str,
    data_b64: str,
    filename: str | None,
    user_note: str | None,
) -> list[dict[str, Any]]:
    """Keep immutable instructions and request-specific input in separate roles."""
    media_kind = media_kind_for_mime(mime_type)
    prompt = ChatPromptTemplate.from_messages(
        [("system", system_prompt), ("user", user_template)]
    )
    messages = prompt.format_messages(
        media_kind=media_kind,
        filename=filename or "not provided",
        user_note=user_note or "not provided",
    )
    dynamic_text = str(messages[1].content)
    content: list[dict[str, Any]] = [{"type": "input_text", "text": dynamic_text}]
    if media_kind == "image":
        content.append(
            {"type": "input_image", "image_url": f"data:{mime_type};base64,{data_b64}"}
        )
    else:
        content.append(
            {
                "type": "input_file",
                "filename": filename or "upload.pdf",
                "file_data": f"data:application/pdf;base64,{data_b64}",
            }
        )
    return [
        {"role": "system", "content": str(messages[0].content)},
        {"role": "user", "content": content},
    ]


async def _call_provider(provider_input: list[dict[str, Any]]) -> Any:
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    return await client.responses.parse(
        model=settings.VISION_MODEL,
        input=provider_input,
        text_format=MediaFacts,
    )


def _normalise_quantity_provenance(facts: MediaFacts, user_note: str | None) -> None:
    """Correct model provenance claims against the actual dynamic user message."""
    note = (user_note or "").lower()
    note_numbers = {
        float(value) for value in re.findall(r"\b\d+(?:\.\d+)?\b", note)
    }
    for item in facts.items:
        quantity = item.quantity
        if quantity.source == "user_stated" and float(quantity.value) not in note_numbers:
            quantity.source = "estimated"
        if quantity.source == "estimated" and quantity.range_g is None:
            grams = quantity.total_grams
            if grams is None and quantity.unit.lower() in {"g", "gram", "grams"}:
                grams = quantity.value
            if grams is not None:
                quantity.range_g = MassRange(
                    low=round(float(grams) * 0.7, 1),
                    high=round(float(grams) * 1.3, 1),
                )


async def _extract_node(
    state: MediaFactsState,
    runtime: Runtime[MediaFactsRuntimeContext],
) -> dict[str, MediaFactsAgentOutput]:
    resolved_prompt = await resolve_prompt(
        MEDIA_FACTS_PROMPT_NAME,
        MEDIA_FACTS_PROMPT,
        fallback_user_template=MEDIA_FACTS_USER_PROMPT,
    )
    provider_input = build_provider_input(
        system_prompt=resolved_prompt.text,
        user_template=resolved_prompt.user_template or MEDIA_FACTS_USER_PROMPT,
        mime_type=state["mime_type"],
        data_b64=state["data_b64"],
        filename=state.get("filename") or None,
        user_note=state.get("user_note") or None,
    )
    response = await _call_provider(provider_input)
    parsed = getattr(response, "output_parsed", None)
    if parsed is None:
        raise ValueError("OpenAI returned no parsed media facts")
    facts = parsed if isinstance(parsed, MediaFacts) else MediaFacts.model_validate(parsed)
    if facts.media_kind != media_kind_for_mime(state["mime_type"]):
        raise ValueError("Parsed media kind does not match the uploaded file")
    _normalise_quantity_provenance(facts, state.get("user_note") or None)

    usage = getattr(response, "usage", None)
    output = MediaFactsAgentOutput(
        facts=facts,
        model=str(getattr(response, "model", None) or settings.VISION_MODEL),
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        cost_usd=getattr(usage, "cost_usd", None),
        prompt_name=resolved_prompt.name,
        prompt_version=resolved_prompt.version,
        prompt_source=resolved_prompt.source,
    )
    logger.info(
        "media_facts_completed user_id={} kind={} usable={}",
        runtime.context.user_id,
        facts.media_kind,
        facts.usable,
    )
    return {"structured_response": output}


def build_media_facts_agent():
    graph = StateGraph(MediaFactsState, context_schema=MediaFactsRuntimeContext)
    graph.add_node("extract_facts", _extract_node)
    graph.add_edge(START, "extract_facts")
    graph.add_edge("extract_facts", END)
    return graph.compile(name=MEDIA_FACTS_AGENT_NAME)
