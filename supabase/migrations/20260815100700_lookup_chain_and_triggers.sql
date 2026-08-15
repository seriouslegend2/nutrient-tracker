-- The lookup chain as a function, plus the trigger cascade.

-- ---------------------------------------------------------------------------
-- THE CHAIN. Household before global, dish before category. Returns the
-- portion AND the nutrition AND which level answered.
--
--   ② dish_household      (user, dish)     "for THIS house, THIS dish"
--   ③ category_household  (user, category) "for THIS house, dal is 1.5 katori"
--   ④ dish_global         (dish)           "in general, Dal Tadka is 200 g"
--   ⑤ category_global     (category)       "in general, any dal is 200 g"
--
-- ③ outranks ④ because the house talking about itself is better evidence than
-- a population default for a specific dish.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_resolve_portion(
    p_user_id uuid, p_food_id uuid, p_category food_category)
RETURNS TABLE (
    portion_unit text, portion_grams numeric,
    per_100g jsonb, resolved_from resolved_from)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_cat food_category := p_category;
    r     record;
BEGIN
    -- resolve the category from the dish if it was not supplied
    IF v_cat IS NULL AND p_food_id IS NOT NULL THEN
        SELECT dg.category INTO v_cat FROM public.dish_global dg
         WHERE dg.dish_id = p_food_id AND dg.is_active;
    END IF;

    -- ② this house's version of THIS dish
    IF p_food_id IS NOT NULL THEN
        SELECT dh.portion_unit, dh.portion_grams,
               coalesce(dh.per_100g, dg.per_100g, '{}'::jsonb) AS per_100g
          INTO r
          FROM public.dish_household dh
          LEFT JOIN public.dish_global dg
                 ON dg.dish_id = dh.dish_id AND dg.is_active
         WHERE dh.user_id = p_user_id AND dh.dish_id = p_food_id AND dh.is_active;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams, r.per_100g,
                                'dish_household'::resolved_from;
            RETURN;
        END IF;
    END IF;

    -- ③ this house's portion for the CATEGORY
    IF v_cat IS NOT NULL THEN
        SELECT ch.portion_unit,
               ch.portion_grams * ch.portion_count AS portion_grams,
               coalesce(dg.per_100g, '{}'::jsonb) AS per_100g
          INTO r
          FROM public.category_household ch
          LEFT JOIN public.dish_global dg
                 ON dg.dish_id = p_food_id AND dg.is_active
         WHERE ch.user_id = p_user_id AND ch.category = v_cat AND ch.is_active;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams, r.per_100g,
                                'category_household'::resolved_from;
            RETURN;
        END IF;
    END IF;

    -- ④ the dish universe default
    IF p_food_id IS NOT NULL THEN
        SELECT dg.portion_unit, dg.portion_grams, dg.per_100g
          INTO r
          FROM public.dish_global dg
         WHERE dg.dish_id = p_food_id AND dg.is_active;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams, r.per_100g,
                                'dish_global'::resolved_from;
            RETURN;
        END IF;
    END IF;

    -- ⑤ the global category default. ALWAYS answers - a log is never blocked.
    IF v_cat IS NOT NULL THEN
        SELECT cg.portion_unit,
               cg.portion_grams * cg.portion_count AS portion_grams,
               '{}'::jsonb AS per_100g
          INTO r
          FROM public.category_global cg
         WHERE cg.category = v_cat AND cg.is_active;
        IF FOUND THEN
            RETURN QUERY SELECT r.portion_unit, r.portion_grams, r.per_100g,
                                'category_global'::resolved_from;
            RETURN;
        END IF;
    END IF;

    -- nothing matched: a free-text item with no category. Still logs, with
    -- nutrition '{}' shown honestly as unknown rather than counted as zero.
    RETURN QUERY SELECT 'g'::text, NULL::numeric, '{}'::jsonb, 'unknown'::resolved_from;
END;
$$;

-- ---------------------------------------------------------------------------
-- Progress. The SUM over meals compared to daily_targets. One evaluator for
-- every goal kind, because all targets share one shape - `scope` selects the
-- aggregate: total sums a nutrient, dish filters to one food_id, count counts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_goal_progress(
    p_goal_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_goal    public.goals%ROWTYPE;
    v_target  jsonb;
    v_out     jsonb := '[]'::jsonb;
    v_days    integer;
    v_logged  integer;
    v_actual  numeric;
    v_metric  text;
    v_scope   text;
BEGIN
    SELECT * INTO v_goal FROM public.goals WHERE goal_id = p_goal_id AND is_active;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'goal_not_found'); END IF;

    v_days := greatest((least(p_to, v_goal.ends_on) - greatest(p_from, v_goal.starts_on))::int + 1, 1);

    SELECT count(DISTINCT meal_date) INTO v_logged
      FROM public.meals
     WHERE user_id = v_goal.user_id AND is_active
       AND meal_date BETWEEN p_from AND p_to;

    FOR v_target IN SELECT * FROM jsonb_array_elements(v_goal.daily_targets->'targets')
    LOOP
        v_metric := v_target->>'metric';
        v_scope  := coalesce(v_target->>'scope', 'total');

        IF v_scope = 'dish' THEN
            SELECT coalesce(sum(grams), 0) INTO v_actual
              FROM public.meals
             WHERE user_id = v_goal.user_id AND is_active
               AND meal_date BETWEEN p_from AND p_to
               AND food_id = (v_target->>'food_id')::uuid;
        ELSIF v_scope = 'count' THEN
            v_actual := v_logged;
        ELSIF v_metric = 'water_ml' THEN
            SELECT coalesce(sum(volume_ml), 0) INTO v_actual
              FROM public.water_logs
             WHERE user_id = v_goal.user_id AND logged_on BETWEEN p_from AND p_to;
        ELSE
            EXECUTE format(
                'SELECT coalesce(sum((nutrients->>%L)::numeric), 0) FROM public.meals
                  WHERE user_id = $1 AND is_active AND meal_date BETWEEN $2 AND $3',
                v_metric)
            INTO v_actual USING v_goal.user_id, p_from, p_to;
        END IF;

        v_out := v_out || jsonb_build_object(
            'metric', v_metric,
            'scope', v_scope,
            'direction', v_target->>'direction',
            'target_per_day', (v_target->>'value')::numeric,
            'target_to_date', (v_target->>'value')::numeric * v_days,
            'actual_to_date', v_actual,
            'unit', v_target->>'unit');
    END LOOP;

    RETURN jsonb_build_object(
        'goal_id', v_goal.goal_id, 'version', v_goal.version,
        'from', p_from, 'to', p_to,
        'days_elapsed', v_days, 'days_logged', v_logged,
        'adherence', round(v_logged::numeric / v_days, 3),
        'targets', v_out,
        -- honest reporting: unknown-nutrition rows are a stated gap, not zero
        'unaccounted_items', (
            SELECT count(*) FROM public.meals
             WHERE user_id = v_goal.user_id AND is_active
               AND meal_date BETWEEN p_from AND p_to
               AND nutrients = '{}'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- THE CASCADE
--   body_metrics INSERT -> refresh profile -> maybe re-resolve the active goal
--
-- pg_trigger_depth() guards against recursion; the goals trigger never writes
-- back to user_profiles, so the cascade is acyclic by construction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_body_metrics_after_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
    PERFORM public.fn_refresh_user_profile(NEW.user_id);
    PERFORM public.fn_reresolve_active_goal(NEW.user_id, 'weight_change');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS body_metrics_ai ON body_metrics;
CREATE TRIGGER body_metrics_ai
    AFTER INSERT ON body_metrics
    FOR EACH ROW EXECUTE FUNCTION trg_body_metrics_after_insert();

CREATE OR REPLACE FUNCTION trg_user_profile_after_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
    -- only a STRUCTURAL change re-resolves; a derived-column refresh must not
    IF NEW.activity IS DISTINCT FROM OLD.activity THEN
        PERFORM public.fn_refresh_user_profile(NEW.user_id);
        PERFORM public.fn_reresolve_active_goal(NEW.user_id, 'activity_change');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profile_au ON user_profiles;
CREATE TRIGGER user_profile_au
    AFTER UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION trg_user_profile_after_update();

GRANT EXECUTE ON FUNCTION fn_resolve_portion(uuid, uuid, food_category) TO service_role;
GRANT EXECUTE ON FUNCTION fn_goal_progress(uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION fn_resolve_goal_targets(uuid, goal_kind, jsonb, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION fn_refresh_user_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION fn_reresolve_active_goal(uuid, text) TO service_role;
