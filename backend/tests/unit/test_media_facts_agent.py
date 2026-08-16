from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.agents.media_facts.agent import _normalise_quantity_provenance, build_provider_input
from app.agents.media_facts.models import MediaFactItem, MediaFacts, MediaQuantity
from app.agents.media_facts.prompt import MEDIA_FACTS_PROMPT, MEDIA_FACTS_USER_PROMPT


@pytest.mark.parametrize(
    ("mime_type", "media_content_type"),
    [("image/jpeg", "input_image"), ("application/pdf", "input_file")],
)
def test_image_and_pdf_share_prompt_with_dynamic_input_in_user_role(
    mime_type: str, media_content_type: str
) -> None:
    messages = build_provider_input(
        system_prompt=MEDIA_FACTS_PROMPT,
        user_template=MEDIA_FACTS_USER_PROMPT,
        mime_type=mime_type,
        data_b64="bWVkaWE=",
        filename="private-name.pdf",
        user_note="I ate half",
    )

    assert messages[0] == {"role": "system", "content": MEDIA_FACTS_PROMPT}
    assert messages[1]["role"] == "user"
    assert messages[1]["content"][0]["type"] == "input_text"
    assert "I ate half" in messages[1]["content"][0]["text"]
    assert "I ate half" not in messages[0]["content"]
    assert messages[1]["content"][1]["type"] == media_content_type
    assert "one item for each clearly separable food" in messages[0]["content"]


@pytest.mark.parametrize("forbidden_field", ["food_id", "calculated_calories"])
def test_media_fact_schema_rejects_resolution_and_calculated_nutrition_fields(
    forbidden_field: str,
) -> None:
    item = {
        "evidence_id": "evidence-1",
        "observed_item_name": "Dal",
        "normalized_name": "dal",
        "quantity": {
            "value": 180,
            "unit": "g",
            "total_grams": 180,
            "source": "estimated",
            "confidence": "medium",
            "basis": "visible bowl",
            "range_g": {"low": 140, "high": 220},
        },
        "confidence": "high",
        forbidden_field: "forbidden",
    }

    with pytest.raises(ValidationError):
        MediaFactItem.model_validate(item)


def test_media_facts_schema_rejects_unknown_top_level_nutrition() -> None:
    with pytest.raises(ValidationError):
        MediaFacts.model_validate(
            {
                "usable": True,
                "media_kind": "image",
                "content_kind": "food_photo",
                "items": [],
                "confidence": "high",
                "resolved_nutrition": {"calories_kcal": 400},
            }
        )


def test_visual_mass_cannot_claim_it_was_user_stated() -> None:
    facts = MediaFacts(
        usable=True,
        media_kind="image",
        content_kind="food_photo",
        items=[
            MediaFactItem(
                evidence_id="one",
                observed_item_name="Paneer tikka",
                normalized_name="paneer tikka",
                quantity=MediaQuantity(
                    value=200,
                    unit="g",
                    total_grams=200,
                    source="user_stated",
                    confidence="medium",
                    basis="visual approximation",
                ),
                confidence="medium",
            )
        ],
        confidence="medium",
    )

    _normalise_quantity_provenance(facts, "Estimate the food shown.")

    quantity = facts.items[0].quantity
    assert quantity.source == "estimated"
    assert quantity.range_g is not None
    assert quantity.range_g.low == 140
    assert quantity.range_g.high == 260
