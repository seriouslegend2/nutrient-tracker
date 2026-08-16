"""The lookup chain, and the nutrition maths on top of it.

    ① meals row already has it
    ② dish_household      (user, dish)
    ③ category_household  (user, category)
    ④ dish_global         (dish)
    ⑤ category_global     (category)      <- always answers

    grams     = portions x portion_grams
    nutrients = nutrients_per_unit x portions

The chain itself is a Postgres function (``fn_resolve_portion``) so that a
trigger, a backfill and the API all evaluate the same logic. This module is the
thin Python side: it calls the RPC, does the arithmetic, and records WHICH level
answered so a wrong number is always attributable.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.core.exceptions import UnresolvedDishError
from app.services.supabase import call_rpc
from app.utils.logger import logger

# Energy is ALWAYS computed from macros, never stored or borrowed.
# EuroFIR recipe guideline Step 10: "Do not borrow data on energy values."
ATWATER = {"protein_g": 4.0, "carbs_g": 4.0, "fat_g": 9.0, "fiber_g": 2.0}


@dataclass(frozen=True)
class Resolution:
    """What the chain produced for one logged item."""

    portion_unit: str
    portion_grams: float | None
    grams: float | None
    nutrients: dict[str, float]
    resolved_from: str

    @property
    def is_unknown(self) -> bool:
        """True when we could establish an amount but not what is in it."""
        return not self.nutrients


async def resolve_portion(
    user_id: str, food_id: str | None, category: str | None
) -> dict[str, Any]:
    """Return the fixed category unit and nutrients for exactly one unit."""
    rows = await call_rpc(
        "fn_resolve_portion",
        {"p_user_id": user_id, "p_food_id": food_id, "p_category": category},
    )
    if not rows:
        return {
            "portion_unit": "g",
            "portion_grams": None,
            "nutrients_per_unit": {},
            "resolved_from": "unknown",
        }
    return rows[0] if isinstance(rows, list) else rows


def scale_unit_nutrients(
    nutrients_per_unit: dict[str, Any], units: float
) -> dict[str, float]:
    """Scale one fixed category unit and always recompute energy from macros."""
    if not nutrients_per_unit:
        return {}
    out: dict[str, float] = {}
    for key, value in nutrients_per_unit.items():
        if key == "calories_kcal":
            continue  # recomputed below, never carried through
        try:
            out[key] = round(float(value) * float(units), 2)
        except (TypeError, ValueError):
            continue
    energy = sum(out.get(k, 0.0) * f for k, f in ATWATER.items())
    out["calories_kcal"] = float(math.floor(energy + 0.5))
    return out


def scale_nutrients_for_grams(
    nutrients_per_unit: dict[str, Any], grams: float, unit_grams: float
) -> dict[str, float]:
    """Convert an observed gram amount to fixed units, then scale nutrition."""
    if unit_grams <= 0:
        return {}
    return scale_unit_nutrients(nutrients_per_unit, grams / unit_grams)


async def resolve_item(
    *,
    user_id: str,
    dish_name: str,
    food_id: str | None = None,
    category: str | None = None,
    portions: float = 1.0,
    grams_override: float | None = None,
    portion_unit_override: str | None = None,
) -> Resolution:
    """Resolve one logged item to grams + nutrients.

    ``grams_override`` is level ① - the user stated an amount, so nothing else
    runs. Otherwise the chain supplies one portion and ``portions`` multiplies.
    """
    if grams_override is not None:
        chain = await resolve_portion(user_id, food_id, category)
        fixed_unit_grams = chain.get("portion_grams")
        nutrients = (
            scale_nutrients_for_grams(
                chain.get("nutrients_per_unit") or {},
                grams_override,
                float(fixed_unit_grams),
            )
            if fixed_unit_grams is not None
            else {}
        )
        return Resolution(
            portion_unit=portion_unit_override or chain.get("portion_unit") or "g",
            portion_grams=grams_override,
            grams=grams_override,
            nutrients=nutrients,
            resolved_from="meals",
        )

    chain = await resolve_portion(user_id, food_id, category)
    portion_grams = chain.get("portion_grams")
    resolved_from = chain.get("resolved_from") or "unknown"

    if portion_grams is None:
        # Nothing in the chain could give an amount, and no amount was stated.
        # Ask - never guess silently.
        logger.info("portion_unresolved user_id={} dish={} food_id={}", user_id, dish_name, food_id)
        raise UnresolvedDishError(dish_name)

    grams = float(portion_grams) * float(portions)
    nutrients = scale_unit_nutrients(chain.get("nutrients_per_unit") or {}, portions)

    return Resolution(
        portion_unit=portion_unit_override or chain.get("portion_unit") or "g",
        portion_grams=float(portion_grams),
        grams=round(grams, 2),
        nutrients=nutrients,
        resolved_from="unknown" if not nutrients else resolved_from,
    )
