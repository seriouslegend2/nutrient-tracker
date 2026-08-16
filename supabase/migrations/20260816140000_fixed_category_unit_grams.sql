-- Category grams and units belong to the fixed global catalog. A household may
-- choose only how many of those units make its usual serving.

-- Convert existing household overrides to the fixed global base while keeping
-- their effective usual grams. Also repair protein onboarding rows where a
-- gram choice was accidentally stored as a serving count.
WITH previous AS (
    UPDATE public.category_household ch
       SET is_active = false
      FROM public.category_global cg
     WHERE ch.category = cg.category
       AND ch.is_active
       AND cg.is_active
    RETURNING ch.user_id, ch.category, ch.portion_unit AS old_unit,
              ch.portion_grams AS old_grams, ch.portion_count AS old_count,
              ch.source, ch.version, cg.portion_unit AS fixed_unit,
              cg.portion_grams AS fixed_grams
)
INSERT INTO public.category_household (
    user_id, category, portion_unit, portion_grams, portion_count,
    source, version, is_active)
SELECT user_id, category, fixed_unit, fixed_grams,
       greatest(0.01, least(20, round(
           CASE
               WHEN category = 'protein_main'
                AND old_unit = 'serving'
                AND old_grams = fixed_grams
                AND old_count > 20
               THEN old_count / fixed_grams
               ELSE old_grams * old_count / fixed_grams
           END, 4))),
       source, version + 1, true
  FROM previous;

CREATE OR REPLACE FUNCTION public.fn_set_category_household_count(
    p_user_id uuid, p_category public.food_category,
    p_portion_count numeric, p_source text)
RETURNS SETOF public.category_household
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_old public.category_household%ROWTYPE;
    v_global public.category_global%ROWTYPE;
    v_id uuid;
    v_version integer := 1;
BEGIN
    IF p_portion_count <= 0 OR p_portion_count > 20 THEN
        RAISE EXCEPTION 'Usual serving count must be between 0 and 20';
    END IF;

    SELECT * INTO v_global
      FROM public.category_global
     WHERE category = p_category AND is_active
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown portion category: %', p_category;
    END IF;

    SELECT * INTO v_old
      FROM public.category_household
     WHERE user_id = p_user_id AND category = p_category AND is_active
     FOR UPDATE;
    IF FOUND THEN
        v_version := v_old.version + 1;
        UPDATE public.category_household SET is_active = false WHERE id = v_old.id;
    END IF;

    INSERT INTO public.category_household (
        user_id, category, portion_unit, portion_grams, portion_count,
        source, version, is_active)
    VALUES (
        p_user_id, p_category, v_global.portion_unit, v_global.portion_grams,
        p_portion_count, p_source, v_version, true)
    RETURNING id INTO v_id;

    RETURN QUERY SELECT * FROM public.category_household WHERE id = v_id;
END;
$$;

-- Keep the old signature safe during rolling deploys: callers may still send
-- grams and a unit, but those values can no longer override the fixed catalog.
CREATE OR REPLACE FUNCTION public.fn_set_category_household(
    p_user_id uuid, p_category public.food_category, p_portion_unit text,
    p_portion_grams numeric, p_portion_count numeric, p_source text)
RETURNS SETOF public.category_household
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT * FROM public.fn_set_category_household_count(
        p_user_id, p_category, p_portion_count, p_source);
$$;

REVOKE ALL ON FUNCTION public.fn_set_category_household_count(
    uuid, public.food_category, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_category_household_count(
    uuid, public.food_category, numeric, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_set_category_household(
    uuid, public.food_category, text, numeric, numeric, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_category_household(
    uuid, public.food_category, text, numeric, numeric, text) TO service_role;
