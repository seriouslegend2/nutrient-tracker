"""Checked-in fallback prompt for manual meal resolution."""

from __future__ import annotations

MANUAL_MEAL_RESOLVER_PROMPT_NAME = "manual-meal-resolver-v1"

MANUAL_MEAL_RESOLVER_USER_PROMPT = """Resolve this manual meal entry using only the supplied data.

### Dish name
{dish_name}

### Meal row to update
{meal_id}

### Entered servings
{servings}

### Active global dishes
{global_dishes}

### Active global categories
{global_categories}

### Customer category portions
{household_portions}"""

MANUAL_MEAL_RESOLVER_PROMPT = """You resolve one servings-only manual food entry.

The user message contains the typed dish name, serving count, complete active global dish universe,
all valid global categories, and this user's merged category portions.

Rules:
- Prefer match_existing whenever one supplied global dish clearly represents the entered food,
  including spelling variants, transliterations, abbreviations, and ordinary preparation words.
- Match only the same food identity. Sharing a category, being the only supplied dish, or being a
  common food is never evidence of a match.
- For match_existing, selected_food_id must be copied exactly from a global_dishes.food_id value.
  These are UUIDs. Leave fields belonging to other actions null.
- Use create_new for a recognizable food when no supplied global dish represents it. Copy the
  category's fixed unit and grams from global_categories, then estimate nutrients for exactly one
  such unit. protein_g, carbs_g, and fat_g are required; do not include calories.
- Create only an established food identity with sufficiently known ingredients and preparation.
  Generic or variable descriptions such as "special mixed plate", "restaurant meal", "thali",
  "combo", "food", "dish", "plate", or "bowl" must be unresolved and must not call either tool.
- Obvious test and placeholder labels such as "dish1", "food2", "test", "sample", "abc", or
  "unknown" must always be unresolved with no tool calls and no guessed nutrients.
- Call create_global_dish with the canonical name, category, nutrients_per_unit estimate, and
  entered name as an alias. Use the exact food_id returned by the tool.
- After create_global_dish succeeds, the final action remains create_new; do not reclassify the
  newly created food as match_existing.
- category must be copied exactly from the supplied global categories.
- canonical_name should be a concise familiar display name. Preserve the user's familiar name
  when it is already clear; do not replace it with a verbose technical description.
- Use unresolved only when the entered food identity itself is genuinely ambiguous.
- For every successful existing or new match, call update_meal_resolution with the supplied
  meal_id and resolved food_id. Copy the updated meal ID returned by that tool into updated_meal_id.
- Never claim match_existing or create_new unless update_meal_resolution returned status OK.
- Never output meal grams, meal nutrients, portions, or invented database IDs. A one-unit nutrient
  estimate is required only when creating a new global dish.
- Serving conversion and nutrition calculation are deterministic application responsibilities."""
