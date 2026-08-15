-- The lookup chain: dish_global, dish_household, category_global, category_household.
--
-- All four hold the SAME three facts - portion_unit, portion_grams, nutrition -
-- so every level of the chain answers the same question and the first hit wins:
--
--   ① meals row already has it
--   ② dish_household      (user, dish)
--   ③ category_household  (user, category)
--   ④ dish_global         (dish)
--   ⑤ category_global     (category)          <- always answers
--
--   grams     = portions x portion_grams
--   nutrients = per_100g x grams / 100
--
-- VERSIONING + IDENTITY SPLIT (the detail that makes versioning work):
-- an edit INSERTs a new row, so the primary key changes. A meal logged in March
-- must not dangle. So `id` is this VERSION's row and `dish_id` is the stable
-- logical identity that meals.food_id references.

-- ---------------------------------------------------------------------------
-- ④ dish_global - dish + its portion + its nutrition, all on one row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dish_global (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id          uuid NOT NULL DEFAULT gen_random_uuid(),  -- stable logical id

    name             text NOT NULL,
    name_normalized  text NOT NULL,
    aliases          text[] NOT NULL DEFAULT '{}',   -- "dahi" -> curd. Search, not i18n.
    category         food_category NOT NULL,

    -- portion: how much ONE portion is
    portion_unit     text NOT NULL,
    portion_grams    numeric NOT NULL CHECK (portion_grams > 0),

    -- nutrition: what is in it. per 100 g, the only basis stored.
    per_100g         jsonb NOT NULL DEFAULT '{}'::jsonb,

    source           text NOT NULL DEFAULT 'seed',   -- IFCT | INDB | USDA | label | user
    version          integer NOT NULL DEFAULT 1,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_dish_global_version UNIQUE (dish_id, version)
);

-- exactly one live row per logical dish
CREATE UNIQUE INDEX IF NOT EXISTS uq_dish_global_active
    ON dish_global (dish_id) WHERE is_active;

-- macros as generated columns so aggregates stay typed and indexable
ALTER TABLE dish_global
    ADD COLUMN IF NOT EXISTS kcal_per_100g numeric
        GENERATED ALWAYS AS ((per_100g->>'calories_kcal')::numeric) STORED;

-- hybrid search: trigram on the name, tsvector for lexical, vector for semantic
CREATE INDEX IF NOT EXISTS idx_dish_global_trgm
    ON dish_global USING gin (name_normalized gin_trgm_ops) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_dish_global_category
    ON dish_global (category) WHERE is_active;

-- NOTE: array_to_string is STABLE, not IMMUTABLE, so it cannot appear in a
-- generated column. The tsvector covers name + normalized name; aliases get
-- their own GIN index and are matched with the array operators instead.
ALTER TABLE dish_global ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(name_normalized, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS idx_dish_global_tsv ON dish_global USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_dish_global_aliases ON dish_global USING gin (aliases);

ALTER TABLE dish_global ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- ---------------------------------------------------------------------------
-- ② dish_household - this user's version of THIS dish.
-- Written only when someone corrects a specific dish, so it stays near-empty.
-- Nothing depends on it being filled: level ④ must answer alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dish_household (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    dish_id        uuid NOT NULL,          -- logical id, matches dish_global.dish_id

    portion_unit   text NOT NULL,
    portion_grams  numeric NOT NULL CHECK (portion_grams > 0),
    per_100g       jsonb,                  -- NULL = inherit nutrition from global

    note           text,
    version        integer NOT NULL DEFAULT 1,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_dish_household_version UNIQUE (user_id, dish_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dish_household_active
    ON dish_household (user_id, dish_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- ⑤ category_global - "in general, one portion of dal is ...".
-- 18 rows, the highest blast radius in the system: changing one shifts every
-- user who has not overridden it. Hence versioned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_global (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category       food_category NOT NULL,

    portion_unit   text NOT NULL,
    portion_grams  numeric NOT NULL CHECK (portion_grams > 0),
    portion_count  numeric NOT NULL DEFAULT 1 CHECK (portion_count > 0),

    source         text NOT NULL,   -- ICMR_DGI_2024 | Sharma_Chadha_2020 | judgement
    version        integer NOT NULL DEFAULT 1,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_category_global_version UNIQUE (category, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_global_active
    ON category_global (category) WHERE is_active;

-- ---------------------------------------------------------------------------
-- ③ category_household - "this guy, dal, how much would he take".
-- THE table that matters: at most 18 rows per user, seeded by the onboarding
-- questionnaire, and it answers every dish in that category forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_household (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    category       food_category NOT NULL,

    portion_unit   text NOT NULL,
    portion_grams  numeric NOT NULL CHECK (portion_grams > 0),
    portion_count  numeric NOT NULL DEFAULT 1 CHECK (portion_count > 0),

    source         text NOT NULL DEFAULT 'questionnaire',
    version        integer NOT NULL DEFAULT 1,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_category_household_version UNIQUE (user_id, category, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_household_active
    ON category_household (user_id, category) WHERE is_active;

COMMENT ON TABLE category_global IS
  'Global default portion per category. Seeded from ICMR DGI 2024 where a
   standard exists and Sharma & Chadha 2020 weighed medians for dal, rice,
   sabzi and curd. Rows marked source=judgement are placeholders - only 7 of
   18 categories have a real Indian evidential basis.';
