"""LangGraph builder for multimodal extraction.

The one-node StateGraph follows KookarCore's recipe-media-understanding agent:
the graph owns orchestration while a focused service owns provider I/O.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from app.agents.media_extraction.state import MediaExtractionState
from app.agents.runtime_context import NutrientTrackerRuntimeContext
from app.services.media_extraction import extract_media
from app.utils.logger import logger

MEDIA_EXTRACTION_AGENT_NAME = "media_extraction"


async def _extract_media_node(
    state: MediaExtractionState,
    runtime: Runtime[NutrientTrackerRuntimeContext],
) -> dict[str, Any]:
    result = await extract_media(
        mime_type=str(state.get("mime_type") or "application/octet-stream"),
        data_b64=str(state.get("data_b64") or ""),
        text=str(state.get("user_text") or "") or None,
        filename=str(state.get("filename") or "") or None,
        samples=int(state.get("samples") or 1),
    )
    output = {
        "text": result.text,
        "payload": result.payload,
        "ok": result.ok,
        "detail": result.detail,
        "model": result.model,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "cost_usd": result.cost_usd,
        "prompt_name": result.prompt_name,
        "prompt_version": result.prompt_version,
        "prompt_source": result.prompt_source,
    }
    logger.info(
        "media_extraction_agent_completed user_id={} mime={} ok={}",
        runtime.context.user_id,
        state.get("mime_type"),
        result.ok,
    )
    return {
        "messages": [AIMessage(content=result.text or result.detail or "Extraction completed")],
        "structured_response": output,
    }


async def build_media_extraction_agent(config: RunnableConfig | None = None):
    graph = StateGraph(
        MediaExtractionState,
        context_schema=NutrientTrackerRuntimeContext,
    )
    graph.add_node("extract_media", _extract_media_node)
    graph.add_edge(START, "extract_media")
    graph.add_edge("extract_media", END)
    agent = graph.compile(name=MEDIA_EXTRACTION_AGENT_NAME)
    logger.info("media_extraction_agent_built")
    return agent
