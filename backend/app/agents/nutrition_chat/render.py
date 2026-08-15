"""nutrition_chat's PURE render functions: DB rows -> prompt strings.

Kept separate from middleware.py so the string formatting is unit-testable
with no mocks - middleware.py just calls these and stays thin.
"""

from __future__ import annotations

from typing import Any


def render_extraction_payload(payload: dict[str, Any] | None) -> str:
    """A photo/PDF draft, formatted for the model to reference in conversation."""
    if not payload:
        return ""
    items = payload.get("items")
    if items:
        lines = [
            f"- {i.get('name')}: ~{i.get('estimated_mass_g')}g "
            f"(range {i.get('mass_range_g', {}).get('low')}-{i.get('mass_range_g', {}).get('high')}g)"
            for i in items
        ]
        return "Draft from the last photo:\n" + "\n".join(lines)
    rows = payload.get("rows")
    if rows:
        return f"Draft food diary: {len(rows)} rows extracted, awaiting confirmation."
    return ""
