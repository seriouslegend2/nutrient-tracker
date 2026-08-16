-- Serialize all meal appends with day-version edits, and execute confirmed meal
-- actions in the same transaction that marks their ledger row completed.

CREATE OR REPLACE FUNCTION public.fn_append_meal_item(
    p_user_id uuid,
    p_meal_date date,
    p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_active_versions integer;
    v_version integer;
    v_row public.meals%ROWTYPE;
    v_nutrient record;
BEGIN
    IF jsonb_typeof(p_item) <> 'object'
       OR coalesce(btrim(p_item->>'dish_name'), '') = ''
       OR coalesce((p_item->>'portions')::numeric, 0) <= 0
       OR coalesce(btrim(p_item->>'portion_unit'), '') = ''
       OR jsonb_typeof(coalesce(p_item->'nutrients', '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'Prepared meal item is invalid' USING ERRCODE = '22023';
    END IF;
    IF nullif(p_item->>'grams', '')::numeric < 0 THEN
        RAISE EXCEPTION 'Prepared meal grams cannot be negative' USING ERRCODE = '22023';
    END IF;
    FOR v_nutrient IN
        SELECT key, value FROM jsonb_each(coalesce(p_item->'nutrients', '{}'::jsonb))
    LOOP
        IF jsonb_typeof(v_nutrient.value) <> 'number'
           OR (v_nutrient.value #>> '{}')::numeric < 0 THEN
            RAISE EXCEPTION 'Prepared meal nutrients must be nonnegative numbers'
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found' USING ERRCODE = 'PT404', HINT = 'user_not_found';
    END IF;
    SELECT count(DISTINCT version), max(version)
      INTO v_active_versions, v_version
      FROM public.meals
     WHERE user_id = p_user_id AND meal_date = p_meal_date AND is_active;
    IF v_active_versions > 1 THEN
        RAISE EXCEPTION 'Meal day has inconsistent active versions'
            USING ERRCODE = 'PT409', HINT = 'meal_day_incoherent';
    END IF;
    IF v_version IS NULL THEN
        SELECT coalesce(max(version) + 1, 1) INTO v_version
          FROM public.meals
         WHERE user_id = p_user_id AND meal_date = p_meal_date;
    END IF;

    INSERT INTO public.meals (
        user_id, meal_date, meal_type, slot_time, version, is_active,
        dish_name, food_id, category, portions, portion_unit, grams,
        nutrients, resolved_from, confidence, source, note)
    VALUES (
        p_user_id, p_meal_date, (p_item->>'meal_type')::public.meal_type,
        nullif(p_item->>'slot_time', '')::time, v_version, true,
        btrim(p_item->>'dish_name'), nullif(p_item->>'food_id', '')::uuid,
        nullif(p_item->>'category', '')::public.food_category,
        (p_item->>'portions')::numeric, p_item->>'portion_unit',
        nullif(p_item->>'grams', '')::numeric,
        coalesce(p_item->'nutrients', '{}'::jsonb),
        (p_item->>'resolved_from')::public.resolved_from,
        nullif(p_item->>'confidence', ''),
        coalesce(nullif(p_item->>'source', ''), 'manual')::public.entry_source,
        nullif(p_item->>'note', ''))
    RETURNING * INTO v_row;
    RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_execute_meal_agent_action(
    p_user_id uuid,
    p_action_id uuid,
    p_execution_token uuid,
    p_prepared jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
    v_args jsonb;
    v_item jsonb;
    v_patch jsonb;
    v_effect jsonb;
    v_result jsonb;
BEGIN
    IF jsonb_typeof(p_prepared) <> 'object' THEN
        RAISE EXCEPTION 'Prepared meal action must be an object' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;
    IF v_action.status = 'completed' AND v_action.execution_token = p_execution_token THEN
        RETURN NEXT v_action;
        RETURN;
    END IF;
    IF v_action.status <> 'executing' OR v_action.execution_token <> p_execution_token THEN
        RAISE EXCEPTION 'Agent action execution claim is stale'
            USING ERRCODE = 'PT409', HINT = 'agent_action_stale_claim';
    END IF;
    IF v_action.action_type NOT IN (
        'log_meal', 'log_nutrition_entry', 'edit_meal', 'remove_meal',
        'identify_unknown_item') THEN
        RAISE EXCEPTION 'Unsupported meal action' USING ERRCODE = '22023';
    END IF;

    v_args := v_action.arguments;
    IF v_action.action_type IN ('log_meal', 'log_nutrition_entry') THEN
        v_item := p_prepared->'item';
        IF jsonb_typeof(v_item) <> 'object'
           OR v_item->>'meal_type' IS DISTINCT FROM v_args->>'meal_type'
           OR v_item->>'dish_name' IS DISTINCT FROM
              coalesce(nullif(v_args->>'dish_name', ''), nullif(v_args->>'label', ''),
                       initcap(v_args->>'meal_type') || ' item')
           OR (v_item->>'portions')::numeric IS DISTINCT FROM
              coalesce(nullif(v_args->>'portions', '')::numeric, 1)
           OR (v_args->'grams' <> 'null'::jsonb AND
               (v_item->>'grams')::numeric IS DISTINCT FROM (v_args->>'grams')::numeric)
           OR (v_args->'food_id' <> 'null'::jsonb AND
               v_item->>'food_id' IS DISTINCT FROM v_args->>'food_id') THEN
            RAISE EXCEPTION 'Prepared meal does not match proposed arguments'
                USING ERRCODE = '22023';
        END IF;
        IF v_action.action_type = 'log_nutrition_entry' THEN
            IF v_item->>'resolved_from' <> 'meals' OR v_item->>'source' <> 'chat' THEN
                RAISE EXCEPTION 'Prepared nutrition entry has invalid provenance'
                    USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM jsonb_each(v_args) AS supplied(key, value)
                 WHERE key IN ('calories_kcal','protein_g','carbs_g','fat_g','fiber_g')
                   AND value <> 'null'::jsonb) THEN
                RAISE EXCEPTION 'Nutrition action does not contain a stated nutrient'
                    USING ERRCODE = '22023';
            END IF;
            IF EXISTS (
                SELECT 1 FROM jsonb_each(v_args) AS supplied(key, value)
                 WHERE key IN ('calories_kcal','protein_g','carbs_g','fat_g','fiber_g')
                   AND value <> 'null'::jsonb
                   AND v_item->'nutrients'->key IS DISTINCT FROM value) THEN
                RAISE EXCEPTION 'Prepared nutrition differs from stated nutrients'
                    USING ERRCODE = '22023';
            END IF;
        END IF;
        v_effect := public.fn_append_meal_item(
            p_user_id, (v_args->>'meal_date')::date, v_item);
        v_result := jsonb_build_object(
            'meal_id', v_effect->>'id',
            'version', (v_effect->>'version')::integer,
            'resolved_from', v_effect->>'resolved_from');
    ELSIF v_action.action_type = 'remove_meal' THEN
        v_effect := public.fn_version_meal_item(
            p_user_id, (v_args->>'meal_id')::uuid, '{}'::jsonb, true);
        v_result := v_effect || jsonb_build_object('meal_id', v_args->>'meal_id');
    ELSE
        v_patch := p_prepared->'patch';
        IF jsonb_typeof(v_patch) <> 'object' THEN
            RAISE EXCEPTION 'Prepared meal patch is invalid' USING ERRCODE = '22023';
        END IF;
        IF v_action.action_type = 'edit_meal' THEN
            IF (v_args->'portions' <> 'null'::jsonb AND
                v_patch->'portions' IS DISTINCT FROM v_args->'portions')
               OR (v_args->'grams' <> 'null'::jsonb AND
                   v_patch->'grams' IS DISTINCT FROM v_args->'grams') THEN
                RAISE EXCEPTION 'Prepared quantity differs from proposed quantity'
                    USING ERRCODE = '22023';
            END IF;
        ELSIF v_patch->>'food_id' IS DISTINCT FROM v_args->>'food_id' THEN
            RAISE EXCEPTION 'Prepared food identity differs from proposed identity'
                USING ERRCODE = '22023';
        END IF;
        v_effect := public.fn_version_meal_item(
            p_user_id, (v_args->>'meal_id')::uuid, v_patch, false);
        v_result := jsonb_build_object(
            'meal_id', v_effect->>'id',
            'version', (v_effect->>'version')::integer,
            'food_id', v_effect->>'food_id',
            'resolved_from', v_effect->>'resolved_from');
    END IF;

    SELECT * INTO v_action
      FROM public.fn_complete_agent_action(
          p_user_id, p_action_id, p_execution_token, v_result);
    RETURN NEXT v_action;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_append_meal_item(uuid, date, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_append_meal_item(uuid, date, jsonb)
    TO service_role;
REVOKE ALL ON FUNCTION public.fn_execute_meal_agent_action(uuid, uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_execute_meal_agent_action(uuid, uuid, uuid, jsonb)
    TO service_role;
