"""Seed the dish universe.

SOURCES, and the honest state of each:

  IFCT 2017 (ICMR-NIN)  528 raw foods, per 100 g, analytical. Says so itself:
                        "All data except for poultry and egg pertains to raw
                        food". So a RAW dal value of 352 kcal/100 g must become
                        a COOKED value of ~116 before it is written, or every
                        grain and pulse in the product is 3x too high.

  INDB                  1,014 cooked Indian recipes, open, peer-reviewed. Best
                        available cooked-dish source. CAVEAT: its authors list
                        yield-factor correction as FUTURE WORK, so its
                        per-serving grams are the sum of RAW ingredient weights
                        divided by servings - NOT plate weight.

  USDA FDC              CC0, unencumbered. Gap-fill for anything the Indian
                        sources miss, and the source of the yield factors.

YIELD FACTORS (Bognar 2002), applied once here and never again:
  rice 2.98 · lentils 2.73 · chicken 0.75 · potato 1.00 · spinach 0.95
Cross-check: YF = (100 - water_raw) / (100 - water_cooked) gives 2.80 for rice
and 3.02 for lentils, which matches the published tables.

This file ships a curated starter set. Wire the full IFCT/INDB/USDA ETL behind
the same `upsert_dish` interface when the licensed data is in place.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from supabase import AsyncClient, acreate_client
from supabase.lib.client_options import AsyncClientOptions

from app.config.settings import settings
from app.utils.logger import logger

# Yield factors: cooked grams per raw gram. Used to convert IFCT raw values.
YIELD = {
    "rice": 2.98, "lentils": 2.73, "dal": 2.73, "chicken": 0.75,
    "potato": 1.00, "spinach": 0.95, "pasta": 2.60, "rajma": 2.50, "chole": 2.50,
}


def normalize(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", name.lower())).strip()


def cooked(per_100g_raw: dict[str, float], food_key: str) -> dict[str, float]:
    """Convert a RAW per-100g vector to COOKED. The 3x correction."""
    factor = YIELD.get(food_key)
    if not factor:
        return per_100g_raw
    return {k: round(v / factor, 2) for k, v in per_100g_raw.items()}


# ---------------------------------------------------------------------------
# Starter set. per_100g is COOKED/as-eaten - every row is the form a user logs.
# `calories_kcal` is omitted deliberately: energy is always recomputed from
# macros (EuroFIR Step 10), never stored.
# ---------------------------------------------------------------------------
DishSeed = tuple[str, str, str, float, dict[str, float]]

DISHES: list[DishSeed] = [
    # --- dal / gravy -------------------------------------------------------
    ("Toor dal", "dal_gravy", "katori", 200, {"protein_g": 6.5, "carbs_g": 12.0, "fat_g": 2.5, "fiber_g": 2.2, "iron_mg": 1.3}),
    ("Dal tadka", "dal_gravy", "katori", 200, {"protein_g": 6.0, "carbs_g": 12.5, "fat_g": 5.0, "fiber_g": 2.0, "iron_mg": 1.2}),
    ("Dal makhani", "dal_gravy", "katori", 200, {"protein_g": 7.0, "carbs_g": 14.0, "fat_g": 9.0, "fiber_g": 3.0, "iron_mg": 1.8}),
    ("Rajma curry", "dal_gravy", "katori", 200, {"protein_g": 6.0, "carbs_g": 15.0, "fat_g": 4.0, "fiber_g": 4.5, "iron_mg": 1.6}),
    ("Chole", "dal_gravy", "katori", 200, {"protein_g": 6.5, "carbs_g": 18.0, "fat_g": 5.0, "fiber_g": 5.0, "iron_mg": 1.9}),
    ("Sambar", "dal_gravy", "katori", 200, {"protein_g": 3.5, "carbs_g": 9.0, "fat_g": 2.5, "fiber_g": 2.5, "iron_mg": 0.9}),
    ("Rasam", "dal_gravy", "katori", 200, {"protein_g": 1.5, "carbs_g": 5.0, "fat_g": 1.5, "fiber_g": 1.0, "iron_mg": 0.6}),
    ("Kadhi", "dal_gravy", "katori", 200, {"protein_g": 3.5, "carbs_g": 8.0, "fat_g": 5.0, "fiber_g": 0.8, "calcium_mg": 90}),

    # --- dry sabzi ---------------------------------------------------------
    ("Aloo sabzi", "dry_sabzi", "katori", 150, {"protein_g": 2.0, "carbs_g": 17.0, "fat_g": 5.0, "fiber_g": 2.0}),
    ("Bhindi masala", "dry_sabzi", "katori", 150, {"protein_g": 2.0, "carbs_g": 7.0, "fat_g": 6.0, "fiber_g": 3.2}),
    ("Aloo methi", "dry_sabzi", "katori", 150, {"protein_g": 2.5, "carbs_g": 14.0, "fat_g": 5.5, "fiber_g": 3.0, "iron_mg": 1.8}),
    ("Mixed vegetable sabzi", "dry_sabzi", "katori", 150, {"protein_g": 2.2, "carbs_g": 9.0, "fat_g": 5.0, "fiber_g": 3.0, "vitamin_a_ug": 210}),
    ("Palak sabzi", "dry_sabzi", "katori", 150, {"protein_g": 3.0, "carbs_g": 5.0, "fat_g": 5.0, "fiber_g": 2.5, "iron_mg": 2.7, "vitamin_a_ug": 470}),
    ("Baingan bharta", "dry_sabzi", "katori", 150, {"protein_g": 1.8, "carbs_g": 8.0, "fat_g": 6.0, "fiber_g": 3.4}),
    ("Cabbage poriyal", "dry_sabzi", "katori", 150, {"protein_g": 1.8, "carbs_g": 6.0, "fat_g": 4.0, "fiber_g": 2.5, "vitamin_c_mg": 22}),

    # --- rice / grains -----------------------------------------------------
    ("Steamed rice", "rice_grain", "bowl", 150, {"protein_g": 2.7, "carbs_g": 28.0, "fat_g": 0.3, "fiber_g": 0.4}),
    ("Jeera rice", "rice_grain", "bowl", 150, {"protein_g": 2.8, "carbs_g": 28.0, "fat_g": 3.5, "fiber_g": 0.6}),
    ("Veg pulao", "rice_grain", "bowl", 150, {"protein_g": 3.5, "carbs_g": 27.0, "fat_g": 4.5, "fiber_g": 1.5}),
    ("Chicken biryani", "rice_grain", "bowl", 150, {"protein_g": 9.0, "carbs_g": 25.0, "fat_g": 7.0, "fiber_g": 1.0}),
    ("Khichdi", "rice_grain", "bowl", 150, {"protein_g": 3.5, "carbs_g": 18.0, "fat_g": 2.5, "fiber_g": 1.5}),
    ("Curd rice", "rice_grain", "bowl", 150, {"protein_g": 3.5, "carbs_g": 20.0, "fat_g": 3.0, "calcium_mg": 85}),
    ("Lemon rice", "rice_grain", "bowl", 150, {"protein_g": 2.8, "carbs_g": 27.0, "fat_g": 4.5, "fiber_g": 0.8}),

    # --- flatbread (one portion = 2 pieces) --------------------------------
    ("Roti", "flatbread", "piece", 45, {"protein_g": 7.5, "carbs_g": 50.0, "fat_g": 2.0, "fiber_g": 6.5, "iron_mg": 2.5}),
    ("Phulka", "flatbread", "piece", 40, {"protein_g": 7.5, "carbs_g": 51.0, "fat_g": 1.5, "fiber_g": 6.8, "iron_mg": 2.5}),
    ("Paratha", "flatbread", "piece", 60, {"protein_g": 6.5, "carbs_g": 45.0, "fat_g": 14.0, "fiber_g": 5.0}),
    ("Aloo paratha", "flatbread", "piece", 90, {"protein_g": 5.5, "carbs_g": 40.0, "fat_g": 12.0, "fiber_g": 4.0}),
    ("Naan", "flatbread", "piece", 90, {"protein_g": 8.0, "carbs_g": 50.0, "fat_g": 6.0, "fiber_g": 2.0}),
    ("Bhakri", "flatbread", "piece", 50, {"protein_g": 7.0, "carbs_g": 52.0, "fat_g": 2.5, "fiber_g": 7.0, "iron_mg": 3.0}),

    # --- south indian ------------------------------------------------------
    ("Idli", "idli", "piece", 40, {"protein_g": 4.5, "carbs_g": 28.0, "fat_g": 0.5, "fiber_g": 1.0}),
    ("Plain dosa", "dosa", "piece", 90, {"protein_g": 4.0, "carbs_g": 30.0, "fat_g": 6.0, "fiber_g": 1.2}),
    ("Masala dosa", "dosa", "piece", 150, {"protein_g": 4.0, "carbs_g": 30.0, "fat_g": 8.0, "fiber_g": 1.8}),
    ("Upma", "rice_grain", "bowl", 150, {"protein_g": 3.5, "carbs_g": 22.0, "fat_g": 5.0, "fiber_g": 1.5}),
    ("Poha", "rice_grain", "bowl", 150, {"protein_g": 2.5, "carbs_g": 25.0, "fat_g": 4.0, "fiber_g": 1.2, "iron_mg": 2.7}),

    # --- protein mains -----------------------------------------------------
    ("Chicken curry", "protein_main", "serving", 150, {"protein_g": 18.0, "carbs_g": 4.0, "fat_g": 10.0, "iron_mg": 1.2, "vitamin_b12_ug": 0.4}),
    ("Grilled chicken breast", "protein_main", "serving", 150, {"protein_g": 31.0, "carbs_g": 0.0, "fat_g": 3.6, "vitamin_b12_ug": 0.3}),
    ("Fish curry", "protein_main", "serving", 150, {"protein_g": 17.0, "carbs_g": 3.0, "fat_g": 8.0, "vitamin_d_iu": 40, "vitamin_b12_ug": 1.2}),
    ("Mutton curry", "protein_main", "serving", 150, {"protein_g": 16.0, "carbs_g": 3.0, "fat_g": 14.0, "iron_mg": 2.0, "vitamin_b12_ug": 1.8}),
    ("Egg curry", "protein_main", "serving", 150, {"protein_g": 11.0, "carbs_g": 4.0, "fat_g": 11.0, "vitamin_b12_ug": 0.9}),

    # --- paneer / eggs -----------------------------------------------------
    ("Paneer butter masala", "paneer_tofu", "serving", 100, {"protein_g": 10.0, "carbs_g": 6.0, "fat_g": 18.0, "calcium_mg": 200}),
    ("Palak paneer", "paneer_tofu", "serving", 100, {"protein_g": 9.0, "carbs_g": 5.0, "fat_g": 13.0, "calcium_mg": 230, "iron_mg": 2.2}),
    ("Paneer bhurji", "paneer_tofu", "serving", 100, {"protein_g": 13.0, "carbs_g": 4.0, "fat_g": 16.0, "calcium_mg": 250}),
    ("Boiled egg", "egg", "piece", 50, {"protein_g": 12.6, "carbs_g": 1.1, "fat_g": 10.6, "vitamin_b12_ug": 1.1, "vitamin_d_iu": 87}),
    ("Egg bhurji", "egg", "piece", 60, {"protein_g": 11.0, "carbs_g": 2.5, "fat_g": 13.0, "vitamin_b12_ug": 1.0}),

    # --- curd / dairy ------------------------------------------------------
    ("Curd", "curd_raita", "katori", 150, {"protein_g": 3.5, "carbs_g": 4.5, "fat_g": 4.0, "calcium_mg": 120}),
    ("Boondi raita", "curd_raita", "katori", 150, {"protein_g": 3.0, "carbs_g": 8.0, "fat_g": 5.0, "calcium_mg": 100}),
    ("Milk", "beverage_milk", "glass", 200, {"protein_g": 3.2, "carbs_g": 4.8, "fat_g": 3.5, "calcium_mg": 120, "vitamin_b12_ug": 0.4}),
    ("Masala chai", "beverage_hot", "cup", 150, {"protein_g": 1.5, "carbs_g": 7.0, "fat_g": 1.8, "calcium_mg": 55}),
    ("Lassi", "beverage_milk", "glass", 200, {"protein_g": 3.0, "carbs_g": 12.0, "fat_g": 3.0, "calcium_mg": 110}),

    # --- salad / fruit -----------------------------------------------------
    ("Green salad", "salad_raw", "serving", 100, {"protein_g": 1.0, "carbs_g": 4.0, "fat_g": 0.2, "fiber_g": 1.8, "vitamin_c_mg": 15}),
    ("Sprout salad", "salad_raw", "serving", 100, {"protein_g": 14.0, "carbs_g": 20.0, "fat_g": 2.0, "fiber_g": 6.0, "iron_mg": 2.2, "vitamin_c_mg": 20}),
    ("Cucumber", "salad_raw", "serving", 100, {"protein_g": 0.7, "carbs_g": 3.6, "fat_g": 0.1, "fiber_g": 0.5, "vitamin_c_mg": 3}),
    ("Banana", "fruit", "piece", 120, {"protein_g": 1.1, "carbs_g": 23.0, "fat_g": 0.3, "fiber_g": 2.6, "potassium_mg": 358}),
    ("Apple", "fruit", "piece", 120, {"protein_g": 0.3, "carbs_g": 14.0, "fat_g": 0.2, "fiber_g": 2.4, "vitamin_c_mg": 5}),
    ("Papaya", "fruit", "piece", 120, {"protein_g": 0.5, "carbs_g": 11.0, "fat_g": 0.3, "fiber_g": 1.7, "vitamin_c_mg": 61, "vitamin_a_ug": 47}),

    # --- snacks / sweets / fats -------------------------------------------
    ("Samosa", "snack_fried", "piece", 50, {"protein_g": 5.0, "carbs_g": 32.0, "fat_g": 26.0, "fiber_g": 2.5}),
    ("Pakora", "snack_fried", "piece", 30, {"protein_g": 6.0, "carbs_g": 28.0, "fat_g": 22.0, "fiber_g": 3.0}),
    ("Gulab jamun", "sweet", "piece", 40, {"protein_g": 4.0, "carbs_g": 45.0, "fat_g": 15.0}),
    ("Almonds", "nuts_seeds", "handful", 25, {"protein_g": 21.0, "carbs_g": 22.0, "fat_g": 50.0, "fiber_g": 12.0, "magnesium_mg": 270, "vitamin_e_mg": 25}),
    ("Peanuts", "nuts_seeds", "handful", 25, {"protein_g": 26.0, "carbs_g": 16.0, "fat_g": 49.0, "fiber_g": 8.5, "magnesium_mg": 168}),
    ("Ghee", "fat_oil", "tsp", 5, {"protein_g": 0.0, "carbs_g": 0.0, "fat_g": 100.0}),
    ("Mustard oil", "fat_oil", "tsp", 5, {"protein_g": 0.0, "carbs_g": 0.0, "fat_g": 100.0}),
]


async def upsert_dish(
    sb: AsyncClient,
    name: str,
    category: str,
    unit: str,
    grams: float,
    per_100g: dict[str, float],
) -> None:
    existing = (
        await sb.table("dish_global").select(
            "id,dish_id,version,name,category,portion_unit,portion_grams,per_100g,source"
        )
        .eq("name_normalized", normalize(name)).eq("is_active", True).limit(1).execute()
    )
    row = {
        "name": name,
        "name_normalized": normalize(name),
        "category": category,
        "portion_unit": unit,
        "portion_grams": grams,
        "per_100g": per_100g,
        "source": "seed",
        "is_active": True,
    }
    if existing.data:
        old = existing.data[0]
        unchanged = (
            old["name"] == name
            and old["category"] == category
            and old["portion_unit"] == unit
            and float(old["portion_grams"]) == float(grams)
            and old["per_100g"] == per_100g
            and old["source"] == "seed"
        )
        if unchanged:
            return
        await sb.table("dish_global").update({"is_active": False}).eq("id", old["id"]).execute()
        row["dish_id"] = old["dish_id"]
        row["version"] = old["version"] + 1
    await sb.table("dish_global").insert(row).execute()


async def main() -> None:
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for seeding"
        )
    http_client = httpx.AsyncClient(timeout=60, verify=True)
    sb = await acreate_client(
        settings.SUPABASE_URL,
        settings.SUPABASE_SERVICE_ROLE_KEY,
        options=AsyncClientOptions(httpx_client=http_client),
    )
    logger.info("seed_start dishes={}", len(DISHES))
    try:
        for name, category, unit, grams, per_100g in DISHES:
            await upsert_dish(sb, name, category, unit, grams, per_100g)
        logger.info("seed_complete dishes={}", len(DISHES))
        print(
            f"Seeded {len(DISHES)} dishes across "
            f"{len({d[1] for d in DISHES})} categories."
        )
    finally:
        await http_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
