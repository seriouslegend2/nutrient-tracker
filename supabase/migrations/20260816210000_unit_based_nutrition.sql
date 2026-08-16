-- Store dish nutrition for one fixed category unit, never per 100 g.
-- Household portion_count remains a usual-count preference and does not alter
-- the globally fixed unit-to-grams conversion.

CREATE OR REPLACE FUNCTION public._scale_nutrient_json(
    p_nutrients jsonb, p_factor numeric)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        jsonb_object_agg(e.key, to_jsonb(round((e.value #>> '{}')::numeric * p_factor, 2))),
        '{}'::jsonb)
      FROM jsonb_each(coalesce(p_nutrients, '{}'::jsonb) - 'calories_kcal') e;
$$;

ALTER TABLE public.dish_global
    ADD COLUMN nutrients_per_unit jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.dish_household
    ADD COLUMN nutrients_per_unit jsonb;

UPDATE public.dish_global dg
   SET nutrients_per_unit = public._scale_nutrient_json(
           dg.per_100g, cg.portion_grams / 100.0),
       portion_unit = cg.portion_unit,
       portion_grams = cg.portion_grams
  FROM public.category_global cg
 WHERE cg.category = dg.category
   AND cg.is_active;

UPDATE public.dish_household dh
   SET nutrients_per_unit = CASE
           WHEN dh.per_100g IS NULL THEN NULL
           ELSE public._scale_nutrient_json(dh.per_100g, cg.portion_grams / 100.0)
       END,
       portion_unit = cg.portion_unit,
       portion_grams = cg.portion_grams
  FROM public.dish_global dg,
       public.category_global cg
 WHERE dg.dish_id = dh.dish_id
   AND dg.is_active
   AND cg.category = dg.category
   AND cg.is_active;

DROP FUNCTION IF EXISTS public.fn_resolve_portion(uuid, uuid, food_category);
DROP FUNCTION IF EXISTS public.fn_create_global_dish(
    text, text, food_category, jsonb, text, uuid, text, text[]);
DROP FUNCTION IF EXISTS public.fn_set_dish_household(
    uuid, uuid, text, numeric, jsonb, text);

ALTER TABLE public.dish_global DROP COLUMN kcal_per_100g;
ALTER TABLE public.dish_global DROP COLUMN per_100g;
ALTER TABLE public.dish_household DROP COLUMN per_100g;

CREATE OR REPLACE FUNCTION public.fn_create_global_dish(
    p_name text,
    p_name_normalized text,
    p_category food_category,
    p_nutrients_per_unit jsonb,
    p_source text,
    p_actor_user_id uuid,
    p_actor text,
    p_aliases text[] DEFAULT ARRAY[]::text[])
RETURNS SETOF public.dish_global
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.dish_global%ROWTYPE;
    v_category public.category_global%ROWTYPE;
    v_id uuid := gen_random_uuid();
    v_nutrients jsonb := coalesce(p_nutrients_per_unit, '{}'::jsonb) - 'calories_kcal';
BEGIN
    IF p_actor NOT IN ('manual_meal_resolver', 'media_meal_resolver') THEN
        RAISE EXCEPTION 'Unsupported catalog actor';
    END IF;
    IF p_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Catalog writes require an authenticated actor';
    END IF;
    IF nullif(btrim(p_name), '') IS NULL OR nullif(btrim(p_name_normalized), '') IS NULL THEN
        RAISE EXCEPTION 'Dish name is required';
    END IF;
    IF NOT (v_nutrients ? 'protein_g' AND v_nutrients ? 'carbs_g' AND v_nutrients ? 'fat_g') THEN
        RAISE EXCEPTION 'One-unit protein, carbs, and fat are required';
    END IF;

    SELECT * INTO v_existing
      FROM public.dish_global
     WHERE name_normalized = p_name_normalized AND is_active
     LIMIT 1;
    IF FOUND THEN
        RETURN QUERY SELECT * FROM public.dish_global WHERE id = v_existing.id;
        RETURN;
    END IF;

    SELECT * INTO v_category
      FROM public.category_global
     WHERE category = p_category AND is_active
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active food category: %', p_category;
    END IF;

    INSERT INTO public.dish_global (
        id, dish_id, name, name_normalized, aliases, category, portion_unit,
        portion_grams, nutrients_per_unit, source, version, is_active)
    VALUES (
        v_id, v_id, btrim(p_name), p_name_normalized,
        coalesce(p_aliases, ARRAY[]::text[]), p_category,
        v_category.portion_unit, v_category.portion_grams,
        v_nutrients, p_source, 1, true);

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    SELECT 'dish_global', dg.dish_id, p_actor_user_id, 'CREATE', to_jsonb(dg), p_actor, 'agent'
      FROM public.dish_global dg WHERE dg.id = v_id;

    RETURN QUERY SELECT * FROM public.dish_global WHERE id = v_id;
EXCEPTION
    WHEN unique_violation THEN
        RETURN QUERY
        SELECT * FROM public.dish_global
         WHERE name_normalized = p_name_normalized AND is_active
         LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_dish_household(
    p_user_id uuid, p_dish_id uuid, p_portion_unit text,
    p_portion_grams numeric, p_nutrients_per_unit jsonb, p_note text)
RETURNS SETOF public.dish_household
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_old public.dish_household%ROWTYPE;
    v_global public.dish_global%ROWTYPE;
    v_category public.category_global%ROWTYPE;
    v_version integer;
    v_id uuid := gen_random_uuid();
BEGIN
    SELECT * INTO v_global FROM public.dish_global
     WHERE dish_id = p_dish_id AND is_active LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown active dish'; END IF;
    SELECT * INTO v_category FROM public.category_global
     WHERE category = v_global.category AND is_active LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown active dish category'; END IF;

    SELECT * INTO v_old FROM public.dish_household
     WHERE user_id = p_user_id AND dish_id = p_dish_id AND is_active LIMIT 1;
    v_version := coalesce(v_old.version + 1, 1);
    IF FOUND THEN
        UPDATE public.dish_household SET is_active = false WHERE id = v_old.id;
    END IF;

    INSERT INTO public.dish_household (
        id, user_id, dish_id, portion_unit, portion_grams, nutrients_per_unit,
        note, version, is_active)
    VALUES (
        v_id, p_user_id, p_dish_id, v_category.portion_unit,
        v_category.portion_grams, p_nutrients_per_unit, p_note, v_version, true);
    RETURN QUERY SELECT * FROM public.dish_household WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_resolve_portion(
    p_user_id uuid, p_food_id uuid, p_category food_category)
RETURNS TABLE (
    portion_unit text, portion_grams numeric,
    nutrients_per_unit jsonb, resolved_from resolved_from)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_cat food_category := p_category;
    r record;
BEGIN
    IF v_cat IS NULL AND p_food_id IS NOT NULL THEN
        SELECT dg.category INTO v_cat FROM public.dish_global dg
         WHERE dg.dish_id = p_food_id AND dg.is_active;
    END IF;

    IF p_food_id IS NOT NULL THEN
        SELECT cg.portion_unit, cg.portion_grams,
               coalesce(dh.nutrients_per_unit, dg.nutrients_per_unit, '{}'::jsonb)
                   AS nutrients_per_unit,
               CASE WHEN dh.id IS NULL THEN 'dish_global'::resolved_from
                    ELSE 'dish_household'::resolved_from END AS source
          INTO r
          FROM public.dish_global dg
          JOIN public.category_global cg ON cg.category = dg.category AND cg.is_active
          LEFT JOIN public.dish_household dh
                 ON dh.user_id = p_user_id AND dh.dish_id = dg.dish_id AND dh.is_active
         WHERE dg.dish_id = p_food_id AND dg.is_active
         LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams,
                                r.nutrients_per_unit, r.source;
            RETURN;
        END IF;
    END IF;

    IF v_cat IS NOT NULL THEN
        SELECT cg.portion_unit, cg.portion_grams, '{}'::jsonb AS nutrients_per_unit
          INTO r
          FROM public.category_global cg
         WHERE cg.category = v_cat AND cg.is_active
         LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams,
                                r.nutrients_per_unit, 'category_global'::resolved_from;
            RETURN;
        END IF;
    END IF;

    RETURN QUERY
    SELECT 'g'::text, NULL::numeric, '{}'::jsonb, 'unknown'::resolved_from;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_global_dish(
    text, text, food_category, jsonb, text, uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_global_dish(
    text, text, food_category, jsonb, text, uuid, text, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.fn_set_dish_household(
    uuid, uuid, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_dish_household(
    uuid, uuid, text, numeric, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_resolve_portion(uuid, uuid, food_category)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_portion(uuid, uuid, food_category)
    TO service_role;

DROP FUNCTION public._scale_nutrient_json(jsonb, numeric);
