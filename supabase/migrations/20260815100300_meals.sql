-- ONE table. Everything the app displays lives here, and a day renders with no
-- join: meal_date and meal_type are columns, not foreign keys.
--
-- VERSIONED IN PLACE: all rows of a day share a version; editing a day inserts
-- version+1 and deactivates the old set. A parent day table would carry only
-- (date, version) - already on every row - and would cost a join on the hottest
-- read in the product.
--
-- dish_name is REQUIRED, food_id is OPTIONAL: "200 g of some low-calorie thing"
-- is a first-class row. It displays, it counts, it appears in reports.
--
-- nutrients '{}' means UNKNOWN, never zero. The day total says "3 items
-- unaccounted" rather than silently under-counting.

CREATE TABLE IF NOT EXISTS meals (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

    -- the day and slot are COLUMNS. No day table, no slot table.
    meal_date         date NOT NULL,
    meal_type         meal_type NOT NULL,
    slot_time         time,                    -- optional, omit when unknown

    -- day versioning
    version           integer NOT NULL DEFAULT 1,
    is_active         boolean NOT NULL DEFAULT true,

    -- what was eaten
    dish_name         text NOT NULL,           -- ALWAYS displayable
    food_id           uuid,                    -- logical dish id, NULLABLE
    category          food_category,           -- copied at write time for reporting

    -- how much. `portions` is THE multiplier: 1.5 katori, 3 rotis.
    portions          numeric NOT NULL DEFAULT 1 CHECK (portions > 0),
    portion_unit      text NOT NULL,
    grams             numeric CHECK (grams IS NULL OR grams >= 0),

    -- what is in it
    nutrients         jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_from     resolved_from NOT NULL,  -- which level of the chain answered
    confidence        text,                    -- set when it came from a photo

    source            entry_source NOT NULL DEFAULT 'manual',
    note              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Macros as generated columns so report aggregates stay typed and indexable.
-- The 18 micros stay in the JSONB and never force a migration.
ALTER TABLE meals
    ADD COLUMN IF NOT EXISTS calories_kcal numeric
        GENERATED ALWAYS AS ((nutrients->>'calories_kcal')::numeric) STORED,
    ADD COLUMN IF NOT EXISTS protein_g numeric
        GENERATED ALWAYS AS ((nutrients->>'protein_g')::numeric) STORED,
    ADD COLUMN IF NOT EXISTS carbs_g numeric
        GENERATED ALWAYS AS ((nutrients->>'carbs_g')::numeric) STORED,
    ADD COLUMN IF NOT EXISTS fat_g numeric
        GENERATED ALWAYS AS ((nutrients->>'fat_g')::numeric) STORED,
    ADD COLUMN IF NOT EXISTS fiber_g numeric
        GENERATED ALWAYS AS ((nutrients->>'fiber_g')::numeric) STORED;

-- THE hot read: one day, and the date-range scan behind the meals screen and
-- every report. Partial on is_active because superseded versions are only ever
-- read from the history endpoint.
CREATE INDEX IF NOT EXISTS idx_meals_user_date
    ON meals (user_id, meal_date DESC) WHERE is_active;

-- keyset pagination for the infinite-scroll timeline
CREATE INDEX IF NOT EXISTS idx_meals_keyset
    ON meals (user_id, meal_date DESC, id DESC) WHERE is_active;

-- version history lookup
CREATE INDEX IF NOT EXISTS idx_meals_versions
    ON meals (user_id, meal_date, version);

-- item goals ("30 g of paneer daily") sum over this
CREATE INDEX IF NOT EXISTS idx_meals_food
    ON meals (user_id, food_id) WHERE is_active AND food_id IS NOT NULL;

COMMENT ON COLUMN meals.nutrients IS
  'Frozen at log time. A user''s history must not silently change when the dish
   universe is refreshed. ''{}'' means UNKNOWN nutrition, never zero.';
COMMENT ON COLUMN meals.food_id IS
  'Logical dish id (dish_global.dish_id), NOT the row id - so a meal binds to
   THE DISH, not to a version of it. NULL for unmatched free-text items.';
