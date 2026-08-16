-- Dish nutrition belongs to exactly one fixed category unit, never to 100 g.
-- Household portion_count is only a UI/default preference and never changes
-- the globally fixed unit-to-grams conversion.

INSERT INTO public.category_global (
    category, portion_unit, portion_grams, portion_count, source, version, is_active)
VALUES ('unknown', 'g', 1, 1, 'system_fallback', 1, true)
ON CONFLICT (category, version) DO NOTHING;

CREATE OR REPLACE FUNCTION public._nutrient_json_is_valid(
    p_nutrients jsonb, p_require_macros boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_typeof(coalesce(p_nutrients, '{}'::jsonb)) = 'object'
       AND NOT (coalesce(p_nutrients, '{}'::jsonb) ? 'calories_kcal')
       AND (
           NOT p_require_macros
           OR (
               p_nutrients ? 'protein_g'
               AND p_nutrients ? 'carbs_g'
               AND p_nutrients ? 'fat_g'
           )
       )
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each(coalesce(p_nutrients, '{}'::jsonb)) nutrient
            WHERE CASE
                WHEN jsonb_typeof(nutrient.value) <> 'number' THEN true
                ELSE (nutrient.value #>> '{}')::numeric < 0
            END
       );
$$;

CREATE OR REPLACE FUNCTION public._scale_nutrient_json(
    p_nutrients jsonb, p_factor numeric)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        jsonb_object_agg(
            nutrient.key,
            to_jsonb((nutrient.value #>> '{}')::numeric * p_factor)
        ),
        '{}'::jsonb
    )
      FROM jsonb_each(coalesce(p_nutrients, '{}'::jsonb) - 'calories_kcal') nutrient;
$$;

DO $$
BEGIN
    IF (SELECT count(*) FROM public.category_global WHERE is_active) <> 19 THEN
        RAISE EXCEPTION 'Unit-nutrition migration requires exactly 19 active categories';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM public.dish_global dish
          LEFT JOIN public.category_global category
            ON category.category = dish.category AND category.is_active
         WHERE category.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Every dish version must map to an active category';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM public.dish_household household
          LEFT JOIN public.dish_global dish
            ON dish.dish_id = household.dish_id AND dish.is_active
         WHERE dish.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Every household dish version must map to an active global dish';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.dish_global
         WHERE NOT public._nutrient_json_is_valid(per_100g - 'calories_kcal', false)
    ) OR EXISTS (
        SELECT 1 FROM public.dish_household
         WHERE per_100g IS NOT NULL
           AND NOT public._nutrient_json_is_valid(per_100g - 'calories_kcal', false)
    ) THEN
        RAISE EXCEPTION 'Legacy dish nutrition contains invalid values';
    END IF;
END;
$$;

ALTER TABLE public.dish_global ADD COLUMN nutrients_per_unit jsonb;
ALTER TABLE public.dish_household ADD COLUMN nutrients_per_unit jsonb;

UPDATE public.dish_global dish
   SET nutrients_per_unit = public._scale_nutrient_json(
           dish.per_100g, category.portion_grams / 100.0),
       portion_unit = category.portion_unit,
       portion_grams = category.portion_grams
  FROM public.category_global category
 WHERE category.category = dish.category
   AND category.is_active;

UPDATE public.dish_household household
   SET nutrients_per_unit = CASE
           WHEN household.per_100g IS NULL THEN NULL
           ELSE public._scale_nutrient_json(
               household.per_100g, category.portion_grams / 100.0)
       END,
       portion_unit = category.portion_unit,
       portion_grams = category.portion_grams
  FROM public.dish_global dish,
       public.category_global category
 WHERE dish.dish_id = household.dish_id
   AND dish.is_active
   AND category.category = dish.category
   AND category.is_active;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.dish_global WHERE nutrients_per_unit IS NULL) THEN
        RAISE EXCEPTION 'Global dish unit-nutrition backfill was incomplete';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.dish_household
         WHERE per_100g IS NOT NULL AND nutrients_per_unit IS NULL
    ) THEN
        RAISE EXCEPTION 'Household dish unit-nutrition backfill was incomplete';
    END IF;
END;
$$;

ALTER TABLE public.dish_global
    ALTER COLUMN nutrients_per_unit SET DEFAULT '{}'::jsonb,
    ALTER COLUMN nutrients_per_unit SET NOT NULL,
    ADD CONSTRAINT ck_dish_global_unit_nutrients
        CHECK (public._nutrient_json_is_valid(nutrients_per_unit, false));
ALTER TABLE public.dish_household
    ADD CONSTRAINT ck_dish_household_unit_nutrients
        CHECK (
            nutrients_per_unit IS NULL
            OR public._nutrient_json_is_valid(nutrients_per_unit, false)
        );

DROP FUNCTION IF EXISTS public.fn_resolve_portion(uuid, uuid, public.food_category);
DROP FUNCTION IF EXISTS public.fn_create_global_dish(
    text, text, public.food_category, jsonb, text, uuid, text, text[]);
DROP FUNCTION IF EXISTS public.fn_set_dish_household(
    uuid, uuid, text, numeric, jsonb, text);

ALTER TABLE public.dish_global DROP COLUMN kcal_per_100g;
ALTER TABLE public.dish_global DROP COLUMN per_100g;
ALTER TABLE public.dish_household DROP COLUMN per_100g;

CREATE OR REPLACE FUNCTION public._enforce_fixed_category_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    previous public.category_global%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        OLD.portion_unit IS DISTINCT FROM NEW.portion_unit
        OR OLD.portion_grams IS DISTINCT FROM NEW.portion_grams
    ) THEN
        RAISE EXCEPTION 'Category unit and grams are globally immutable for %', NEW.category
            USING ERRCODE = '22023';
    END IF;
    SELECT * INTO previous
      FROM public.category_global
     WHERE category = NEW.category
       AND id <> NEW.id
     ORDER BY version DESC
     LIMIT 1;
    IF FOUND AND (
        previous.portion_unit IS DISTINCT FROM NEW.portion_unit
        OR previous.portion_grams IS DISTINCT FROM NEW.portion_grams
    ) THEN
        RAISE EXCEPTION 'Category unit and grams are globally immutable for %', NEW.category
            USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_category_global_fixed_unit
BEFORE INSERT OR UPDATE OF portion_unit, portion_grams
ON public.category_global
FOR EACH ROW EXECUTE FUNCTION public._enforce_fixed_category_unit();

CREATE OR REPLACE FUNCTION public._sync_global_dish_category_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    category public.category_global%ROWTYPE;
BEGIN
    SELECT * INTO category
      FROM public.category_global
     WHERE category_global.category = NEW.category AND is_active
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active food category: %', NEW.category
            USING ERRCODE = '22023';
    END IF;
    NEW.portion_unit := category.portion_unit;
    NEW.portion_grams := category.portion_grams;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dish_global_fixed_unit
BEFORE INSERT OR UPDATE OF category, portion_unit, portion_grams
ON public.dish_global
FOR EACH ROW EXECUTE FUNCTION public._sync_global_dish_category_unit();

CREATE OR REPLACE FUNCTION public._sync_household_dish_category_unit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    category public.category_global%ROWTYPE;
BEGIN
    SELECT category_global.* INTO category
      FROM public.dish_global dish
      JOIN public.category_global category_global
        ON category_global.category = dish.category AND category_global.is_active
     WHERE dish.dish_id = NEW.dish_id AND dish.is_active
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active dish or category'
            USING ERRCODE = '22023';
    END IF;
    NEW.portion_unit := category.portion_unit;
    NEW.portion_grams := category.portion_grams;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dish_household_fixed_unit
BEFORE INSERT OR UPDATE OF dish_id, portion_unit, portion_grams
ON public.dish_household
FOR EACH ROW EXECUTE FUNCTION public._sync_household_dish_category_unit();

CREATE OR REPLACE FUNCTION public.fn_create_global_dish(
    p_name text,
    p_name_normalized text,
    p_category public.food_category,
    p_nutrients_per_unit jsonb,
    p_source text,
    p_actor_user_id uuid,
    p_actor text,
    p_aliases text[] DEFAULT ARRAY[]::text[])
RETURNS SETOF public.dish_global
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    existing public.dish_global%ROWTYPE;
    category public.category_global%ROWTYPE;
    created public.dish_global%ROWTYPE;
    normalized_name text := regexp_replace(btrim(lower(p_name_normalized)), '\s+', ' ', 'g');
    nutrients jsonb := coalesce(p_nutrients_per_unit, '{}'::jsonb) - 'calories_kcal';
BEGIN
    IF p_actor NOT IN ('manual_meal_resolver', 'media_meal_resolver') THEN
        RAISE EXCEPTION 'Unsupported catalog actor' USING ERRCODE = '22023';
    END IF;
    IF p_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Catalog writes require an authenticated actor' USING ERRCODE = '22023';
    END IF;
    IF nullif(btrim(p_name), '') IS NULL OR normalized_name = '' THEN
        RAISE EXCEPTION 'Dish name is required' USING ERRCODE = '22023';
    END IF;
    IF nullif(btrim(p_source), '') IS NULL THEN
        RAISE EXCEPTION 'Dish source is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public._nutrient_json_is_valid(nutrients, p_category <> 'unknown') THEN
        RAISE EXCEPTION 'Valid one-unit protein, carbs, and fat are required'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(normalized_name, 0));
    SELECT * INTO existing
      FROM public.dish_global
     WHERE name_normalized = normalized_name AND is_active
     LIMIT 1;
    IF FOUND THEN
        IF existing.category <> p_category THEN
            RAISE EXCEPTION 'Existing dish category does not match requested category'
                USING ERRCODE = '22023';
        END IF;
        RETURN NEXT existing;
        RETURN;
    END IF;

    SELECT * INTO category
      FROM public.category_global
     WHERE category_global.category = p_category AND is_active
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active food category: %', p_category
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.dish_global (
        name, name_normalized, aliases, category, portion_unit,
        portion_grams, nutrients_per_unit, source, version, is_active)
    VALUES (
        btrim(p_name), normalized_name, coalesce(p_aliases, ARRAY[]::text[]),
        p_category, category.portion_unit, category.portion_grams,
        nutrients, btrim(p_source), 1, true)
    RETURNING * INTO created;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    VALUES (
        'dish_global', created.dish_id, p_actor_user_id, 'CREATE',
        to_jsonb(created), p_actor, 'agent');

    RETURN NEXT created;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_dish_household(
    p_user_id uuid, p_dish_id uuid, p_nutrients_per_unit jsonb, p_note text)
RETURNS SETOF public.dish_household
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    old_row public.dish_household%ROWTYPE;
    global_row public.dish_global%ROWTYPE;
    category public.category_global%ROWTYPE;
    created public.dish_household%ROWTYPE;
    next_version integer := 1;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown application user' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO global_row FROM public.dish_global
     WHERE dish_id = p_dish_id AND is_active LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active dish' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO category FROM public.category_global
     WHERE category_global.category = global_row.category AND is_active LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active dish category' USING ERRCODE = '22023';
    END IF;
    IF p_nutrients_per_unit IS NOT NULL
       AND NOT public._nutrient_json_is_valid(p_nutrients_per_unit - 'calories_kcal', false) THEN
        RAISE EXCEPTION 'Invalid household one-unit nutrition' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO old_row FROM public.dish_household
     WHERE user_id = p_user_id AND dish_id = p_dish_id AND is_active
     FOR UPDATE;
    IF FOUND THEN
        next_version := old_row.version + 1;
        UPDATE public.dish_household SET is_active = false WHERE id = old_row.id;
    END IF;

    INSERT INTO public.dish_household (
        user_id, dish_id, portion_unit, portion_grams, nutrients_per_unit,
        note, version, is_active)
    VALUES (
        p_user_id, p_dish_id, category.portion_unit, category.portion_grams,
        CASE WHEN p_nutrients_per_unit IS NULL THEN NULL
             ELSE p_nutrients_per_unit - 'calories_kcal' END,
        p_note, next_version, true)
    RETURNING * INTO created;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    VALUES (
        'dish_household', created.dish_id, p_user_id,
        CASE WHEN old_row.id IS NULL THEN 'CREATE' ELSE 'VERSION' END,
        CASE WHEN old_row.id IS NULL THEN NULL ELSE to_jsonb(old_row) END,
        to_jsonb(created), p_user_id::text, 'api');

    RETURN NEXT created;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_resolve_portion(
    p_user_id uuid, p_food_id uuid, p_category public.food_category)
RETURNS TABLE (
    portion_unit text, portion_grams numeric,
    nutrients_per_unit jsonb, resolved_from public.resolved_from)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    category_name public.food_category := p_category;
    result record;
BEGIN
    IF p_food_id IS NOT NULL THEN
        SELECT category_global.portion_unit, category_global.portion_grams,
               coalesce(household.nutrients_per_unit, dish.nutrients_per_unit, '{}'::jsonb)
                   AS nutrients_per_unit,
               CASE WHEN household.nutrients_per_unit IS NOT NULL
                    THEN 'dish_household'::public.resolved_from
                    ELSE 'dish_global'::public.resolved_from END AS source,
               dish.category
          INTO result
          FROM public.dish_global dish
          JOIN public.category_global category_global
            ON category_global.category = dish.category AND category_global.is_active
          LEFT JOIN public.dish_household household
            ON household.user_id = p_user_id
           AND household.dish_id = dish.dish_id
           AND household.is_active
         WHERE dish.dish_id = p_food_id AND dish.is_active
         LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT result.portion_unit, result.portion_grams,
                                result.nutrients_per_unit, result.source;
            RETURN;
        END IF;
    END IF;

    IF category_name IS NOT NULL THEN
        SELECT category_global.portion_unit, category_global.portion_grams
          INTO result
          FROM public.category_global category_global
         WHERE category_global.category = category_name AND category_global.is_active
         LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT result.portion_unit, result.portion_grams,
                                '{}'::jsonb, 'category_global'::public.resolved_from;
            RETURN;
        END IF;
    END IF;

    SELECT category_global.portion_unit, category_global.portion_grams
      INTO result
      FROM public.category_global category_global
     WHERE category_global.category = 'unknown' AND category_global.is_active
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown fallback category is missing';
    END IF;
    RETURN QUERY SELECT result.portion_unit, result.portion_grams,
                        '{}'::jsonb, 'category_global'::public.resolved_from;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_global_dish(
    text, text, public.food_category, jsonb, text, uuid, text, text[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_global_dish(
    text, text, public.food_category, jsonb, text, uuid, text, text[])
    TO service_role;

REVOKE ALL ON FUNCTION public.fn_set_dish_household(uuid, uuid, jsonb, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_dish_household(uuid, uuid, jsonb, text)
    TO service_role;

REVOKE ALL ON FUNCTION public.fn_resolve_portion(uuid, uuid, public.food_category)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_portion(uuid, uuid, public.food_category)
    TO service_role;

DROP FUNCTION public._scale_nutrient_json(jsonb, numeric);
NOTIFY pgrst, 'reload schema';
