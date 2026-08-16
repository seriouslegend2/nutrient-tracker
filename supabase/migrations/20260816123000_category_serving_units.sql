-- Customer meal logging changes only the serving count. Personal serving sizes
-- are category-household settings, not per-meal or per-dish overrides.

WITH previous AS (
    UPDATE public.category_global
       SET is_active = false
     WHERE category = 'protein_main' AND is_active
       AND (portion_unit, portion_grams, portion_count)
           IS DISTINCT FROM ('serving'::text, 150::numeric, 1::numeric)
     RETURNING category, source, version
)
INSERT INTO public.category_global (
    category, portion_unit, portion_grams, portion_count, source, version, is_active)
SELECT category, 'serving', 150, 1, source, version + 1, true
  FROM previous;

WITH previous AS (
    UPDATE public.category_global
       SET is_active = false
     WHERE category = 'paneer_tofu' AND is_active
       AND (portion_unit, portion_grams, portion_count)
           IS DISTINCT FROM ('serving'::text, 100::numeric, 1::numeric)
     RETURNING category, source, version
)
INSERT INTO public.category_global (
    category, portion_unit, portion_grams, portion_count, source, version, is_active)
SELECT category, 'serving', 100, 1, source, version + 1, true
  FROM previous;

-- Preserve each household's effective grams while normalizing the representation
-- from e.g. 100 x 1 g to 1 x 100 g serving.
WITH previous AS (
    UPDATE public.category_household
       SET is_active = false
     WHERE category IN ('protein_main', 'paneer_tofu')
       AND is_active
       AND portion_unit = 'g'
     RETURNING *
)
INSERT INTO public.category_household (
    user_id, category, portion_unit, portion_grams, portion_count,
    source, version, is_active)
SELECT user_id, category, 'serving', portion_grams * portion_count, 1,
       source, version + 1, true
  FROM previous;

-- Per-dish household overrides were briefly exposed by the meal editor. Keep
-- their audit history but remove them from the active resolution chain.
UPDATE public.dish_household SET is_active = false WHERE is_active;
