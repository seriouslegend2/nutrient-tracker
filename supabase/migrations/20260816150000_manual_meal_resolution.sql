-- Atomic catalog creation and complete meal identity relinking for the
-- servings-only manual meal resolver.

CREATE UNIQUE INDEX IF NOT EXISTS uq_dish_global_active_normalized_name
    ON public.dish_global (name_normalized) WHERE is_active;

CREATE OR REPLACE FUNCTION public.fn_create_global_dish(
    p_name text,
    p_name_normalized text,
    p_category public.food_category,
    p_per_100g jsonb,
    p_source text,
    p_actor_user_id uuid,
    p_actor text,
    p_aliases text[] DEFAULT '{}')
RETURNS SETOF public.dish_global
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_existing public.dish_global%ROWTYPE;
    v_category public.category_global%ROWTYPE;
    v_created public.dish_global%ROWTYPE;
    v_nutrients jsonb := coalesce(p_per_100g, '{}'::jsonb) - 'calories_kcal';
BEGIN
    p_name := btrim(p_name);
    p_name_normalized := btrim(lower(p_name_normalized));
    p_source := btrim(p_source);

    IF p_name = '' OR p_name_normalized = '' THEN
        RAISE EXCEPTION 'Dish name is required' USING ERRCODE = '22023';
    END IF;
    IF p_actor NOT IN ('manual_meal_resolver', 'media_meal_resolver') THEN
        RAISE EXCEPTION 'Unknown dish resolver actor: %', p_actor USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_nutrients) <> 'object' OR v_nutrients = '{}'::jsonb THEN
        RAISE EXCEPTION 'Per-100g nutrition is required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_each_text(v_nutrients) nutrient
         WHERE nutrient.value !~ '^[0-9]+([.][0-9]+)?$'
            OR nutrient.value::numeric < 0
    ) THEN
        RAISE EXCEPTION 'Nutrients must be nonnegative numbers' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_name_normalized, 0));

    SELECT * INTO v_existing
      FROM public.dish_global
     WHERE name_normalized = p_name_normalized AND is_active
     LIMIT 1;
    IF FOUND THEN
        RETURN NEXT v_existing;
        RETURN;
    END IF;

    SELECT * INTO v_category
      FROM public.category_global
     WHERE category = p_category AND is_active
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown active food category: %', p_category
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.dish_global (
        name, name_normalized, aliases, category, portion_unit,
        portion_grams, per_100g, source, version, is_active)
    VALUES (
        p_name,
        p_name_normalized,
        coalesce(p_aliases, '{}'),
        p_category,
        'serving',
        v_category.portion_grams * v_category.portion_count,
        v_nutrients,
        p_source,
        1,
        true)
    RETURNING * INTO v_created;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    VALUES (
        'dish_global', v_created.dish_id, p_actor_user_id, 'CREATE',
        to_jsonb(v_created), p_actor, 'agent');

    RETURN NEXT v_created;
END;
$$;

-- PATCH and DELETE clone the complete active day into version+1. Identity
-- fields are patchable so an unresolved meal can be linked in one version.
CREATE OR REPLACE FUNCTION public.fn_version_meal_item(
    p_user_id uuid, p_meal_id uuid, p_patch jsonb, p_delete boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_target     public.meals%ROWTYPE;
    v_row        public.meals%ROWTYPE;
    v_inserted   public.meals%ROWTYPE;
    v_new_target public.meals%ROWTYPE;
    v_version    integer;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_target FROM public.meals
     WHERE id = p_meal_id AND user_id = p_user_id AND is_active
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Meal item not found'
            USING ERRCODE = 'PT404', HINT = 'meal_not_found';
    END IF;

    SELECT coalesce(max(version), 0) + 1 INTO v_version
      FROM public.meals
     WHERE user_id = p_user_id AND meal_date = v_target.meal_date;

    UPDATE public.meals SET is_active = false, updated_at = now()
     WHERE user_id = p_user_id AND meal_date = v_target.meal_date AND is_active;

    FOR v_row IN
        SELECT * FROM public.meals
         WHERE user_id = p_user_id AND meal_date = v_target.meal_date
           AND version = v_target.version
         ORDER BY created_at, id
    LOOP
        IF p_delete AND v_row.id = p_meal_id THEN CONTINUE; END IF;

        INSERT INTO public.meals (
            user_id, meal_date, meal_type, slot_time, version, is_active,
            dish_name, food_id, category, portions, portion_unit, grams,
            nutrients, resolved_from, confidence, source, note)
        VALUES (
            v_row.user_id, v_row.meal_date, v_row.meal_type, v_row.slot_time,
            v_version, true,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'dish_name'
                THEN p_patch->>'dish_name' ELSE v_row.dish_name END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'food_id'
                THEN nullif(p_patch->>'food_id', '')::uuid ELSE v_row.food_id END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'category'
                THEN nullif(p_patch->>'category', '')::public.food_category ELSE v_row.category END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'portions'
                THEN (p_patch->>'portions')::numeric ELSE v_row.portions END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'portion_unit'
                THEN p_patch->>'portion_unit' ELSE v_row.portion_unit END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'grams'
                THEN (p_patch->>'grams')::numeric ELSE v_row.grams END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'nutrients'
                THEN p_patch->'nutrients' ELSE v_row.nutrients END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'resolved_from'
                THEN (p_patch->>'resolved_from')::public.resolved_from ELSE v_row.resolved_from END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'confidence'
                THEN nullif(p_patch->>'confidence', '') ELSE v_row.confidence END,
            v_row.source,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'note'
                THEN nullif(p_patch->>'note', '') ELSE v_row.note END)
        RETURNING * INTO v_inserted;

        IF v_row.id = p_meal_id THEN v_new_target := v_inserted; END IF;
    END LOOP;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    VALUES (
        'meal', p_meal_id, p_user_id,
        CASE WHEN p_delete THEN 'DELETE' ELSE 'VERSION' END,
        to_jsonb(v_target),
        CASE WHEN p_delete THEN NULL ELSE to_jsonb(v_new_target) END,
        p_user_id::text, 'api');

    IF p_delete THEN
        RETURN jsonb_build_object('deleted', true, 'version', v_version);
    END IF;
    RETURN to_jsonb(v_new_target);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_global_dish(
    text, text, public.food_category, jsonb, text, uuid, text, text[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_global_dish(
    text, text, public.food_category, jsonb, text, uuid, text, text[])
    TO service_role;

REVOKE ALL ON FUNCTION public.fn_version_meal_item(uuid, uuid, jsonb, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_version_meal_item(uuid, uuid, jsonb, boolean)
    TO service_role;
