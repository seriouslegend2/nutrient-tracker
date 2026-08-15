-- Extensions and the shared enum vocabulary.
--
-- These types are referenced by nearly every table that follows, so this
-- migration must land first. Enum values are deliberately conservative:
-- ALTER TYPE ... ADD VALUE cannot run in the same transaction as a statement
-- that uses the new value, so adding one later is a two-migration dance.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy dish-name matching
CREATE EXTENSION IF NOT EXISTS "vector";       -- dish embeddings for hybrid search

-- ---------------------------------------------------------------------------
-- Food categories.
--
-- This is the vocabulary that decides THE UNIT. A user is never asked "katori
-- or piece" - the food's category already answers. See PLAN.html §04.
-- ---------------------------------------------------------------------------
CREATE TYPE food_category AS ENUM (
    'dal_gravy',      -- katori
    'dry_sabzi',      -- katori
    'rice_grain',     -- bowl
    'flatbread',      -- piece, and one portion is TWO of them
    'idli',           -- piece
    'dosa',           -- piece
    'protein_main',   -- grams
    'paneer_tofu',    -- grams
    'egg',            -- piece
    'curd_raita',     -- katori
    'salad_raw',      -- serving
    'fruit',          -- piece
    'beverage_milk',  -- glass
    'beverage_hot',   -- cup
    'snack_fried',    -- piece
    'sweet',          -- piece
    'nuts_seeds',     -- handful
    'fat_oil'         -- tsp
);

-- Six slots. 'misc' exists so an unclassifiable item is never blocked.
CREATE TYPE meal_type AS ENUM (
    'breakfast', 'brunch', 'lunch', 'snacks', 'dinner', 'misc'
);

-- Which level of the lookup chain produced a meal row's numbers.
-- Recorded on every row so a wrong figure is always attributable.
CREATE TYPE resolved_from AS ENUM (
    'meals',               -- the row already carried it
    'dish_household',      -- this house's version of this dish
    'category_household',  -- this house's portion for the category
    'dish_global',         -- the dish universe default
    'category_global',     -- the global category default
    'unknown'              -- free-text item we could not resolve
);

-- How a meal row got created. Drives provenance in the UI.
CREATE TYPE entry_source AS ENUM (
    'manual', 'photo', 'label', 'pdf_import', 'chat'
);

CREATE TYPE goal_kind AS ENUM (
    'nutrient',     -- "150 g protein daily"
    'body_weight',  -- "lose 10 kg by March"
    'item',         -- "30 g of paneer daily"
    'hydration',
    'behaviour'     -- "log every day this month"
);

CREATE TYPE goal_status AS ENUM ('active', 'completed', 'abandoned');

CREATE TYPE app_role AS ENUM ('customer', 'admin');

CREATE TYPE biological_sex AS ENUM ('male', 'female');

-- FAO/WHO/UNU band in comments; the multipliers live in fn_tdee (see the
-- formulas migration). 'sedentary' at 1.2 sits BELOW FAO's lowest free-living
-- value of 1.40 - kept for user familiarity, flagged in the function.
CREATE TYPE activity_level AS ENUM (
    'sedentary', 'light', 'moderate', 'very_active', 'extra_active'
);

CREATE TYPE diet_type AS ENUM (
    'vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain'
);

CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');

CREATE TYPE message_type AS ENUM ('text', 'image', 'video', 'audio', 'pdf', 'system');

CREATE TYPE message_status AS ENUM (
    'received', 'processing', 'needs_confirmation', 'confirmed', 'failed', 'not_applicable'
);
