-- Atomic mutation RPCs, goal safety reconciliation, and trigger corrections.
-- This is forward-only: shipped migrations remain unchanged.

-- Clear stale derived values when required inputs disappear, as well as
-- recomputing when all inputs are present.
CREATE OR REPLACE FUNCTION public.fn_refresh_user_profile(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_weight numeric;
    v_prof   public.user_profiles%ROWTYPE;
    v_age    integer;
BEGIN
    SELECT * INTO v_prof
      FROM public.user_profiles
     WHERE user_id = p_user_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT weight_kg INTO v_weight
      FROM public.body_metrics
     WHERE user_id = p_user_id
     ORDER BY measured_on DESC, created_at DESC
     LIMIT 1;

    IF v_weight IS NULL OR v_prof.height_cm IS NULL
       OR v_prof.date_of_birth IS NULL OR v_prof.sex IS NULL THEN
        UPDATE public.user_profiles
           SET bmi = NULL,
               bmr_kcal = NULL,
               tdee_kcal = NULL,
               computed_at = NULL,
               updated_at = now()
         WHERE user_id = p_user_id;
        RETURN;
    END IF;

    v_age := extract(year FROM age(v_prof.date_of_birth))::integer;

    UPDATE public.user_profiles
       SET bmi = public.fn_bmi(v_weight, height_cm),
           bmr_kcal = public.fn_bmr_mifflin(v_weight, height_cm, v_age, sex),
           tdee_kcal = public.fn_tdee(
               public.fn_bmr_mifflin(v_weight, height_cm, v_age, sex), activity),
           computed_at = now(),
           updated_at = now()
     WHERE user_id = p_user_id;
END;
$$;

-- Resolve all five documented goal kinds. Preview always returns the safe,
-- floored alternative for an aggressive calorie request; hard refusal remains
-- for demographic/clinical gates that cannot be made safe by arithmetic.
CREATE OR REPLACE FUNCTION public.fn_resolve_goal_targets(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date)
RETURNS TABLE (daily_targets jsonb, derivation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_prof             public.user_profiles%ROWTYPE;
    v_weight           numeric;
    v_weeks            numeric;
    v_req_rate         numeric;
    v_max_rate         numeric;
    v_rate             numeric;
    v_deficit          numeric;
    v_floor            numeric;
    v_intake           numeric;
    v_requested_intake numeric;
    v_protein          numeric;
    v_fat              numeric;
    v_carbs            numeric;
    v_water            numeric;
    v_clamped          boolean := false;
    v_floored          boolean := false;
    v_targets          jsonb := '[]'::jsonb;
    v_deriv            jsonb := '{}'::jsonb;
    v_dir              text;
    v_amount           numeric;
    v_key              text;
    v_text_value       text;
    v_value            numeric;
    v_applied_intake   numeric;
    v_days             integer;
    v_target_weight    numeric;
    v_target_bmi       numeric;
BEGIN
    SELECT * INTO v_prof
      FROM public.user_profiles
     WHERE user_id = p_user_id;
    SELECT weight_kg INTO v_weight
      FROM public.body_metrics
     WHERE user_id = p_user_id
     ORDER BY measured_on DESC, created_at DESC
     LIMIT 1;

    IF v_prof.date_of_birth IS NOT NULL
       AND extract(year FROM age(v_prof.date_of_birth)) < 18 THEN
        RAISE EXCEPTION 'Goal targets are not available for users under 18'
            USING ERRCODE = 'PT409', HINT = 'under_18';
    END IF;
    IF v_prof.is_pregnant_or_nursing THEN
        RAISE EXCEPTION 'Weight goals require clinical supervision during pregnancy or nursing'
            USING ERRCODE = 'PT409', HINT = 'pregnant_or_nursing';
    END IF;

    IF p_kind = 'nutrient' THEN
        v_dir := coalesce(p_spec->>'direction', 'at_least');
        v_floor := public.fn_calorie_floor(v_prof.sex, v_prof.bmr_kcal);
        FOR v_key, v_text_value IN
            SELECT key, value FROM jsonb_each_text(coalesce(p_spec->'nutrients', '{}'::jsonb))
        LOOP
            v_value := v_text_value::numeric;
            IF v_key = 'calories_kcal' AND v_dir IN ('at_most', 'around')
               AND v_value < greatest(v_floor, 800) THEN
                v_requested_intake := v_value;
                v_value := greatest(v_floor, 800);
                v_applied_intake := v_value;
                v_clamped := true;
                v_floored := true;
            END IF;
            v_targets := v_targets || jsonb_build_object(
                'metric', v_key, 'scope', 'total', 'direction', v_dir,
                'value', v_value,
                'unit', CASE WHEN v_key = 'calories_kcal' THEN 'kcal' ELSE 'g' END);
        END LOOP;
        v_deriv := jsonb_build_object(
            'method', 'stated', 'clamp_fired', v_clamped, 'floor_applied', v_floored,
            'requested_intake_kcal', v_requested_intake,
            'applied_intake_kcal', v_applied_intake,
            'calorie_floor_kcal', CASE WHEN v_requested_intake IS NOT NULL THEN v_floor END);

    ELSIF p_kind = 'item' THEN
        v_targets := jsonb_build_array(jsonb_build_object(
            'metric', 'grams', 'scope', 'dish',
            'food_id', p_spec->>'food_id', 'label', p_spec->>'label',
            'direction', coalesce(p_spec->>'direction', 'at_least'),
            'value', (p_spec->>'amount')::numeric,
            'unit', coalesce(p_spec->>'unit', 'g')));
        v_deriv := jsonb_build_object('method', 'stated', 'clamp_fired', false);

    ELSIF p_kind = 'hydration' THEN
        v_water := public.fn_hydration_ml(v_weight, v_prof.sex, v_prof.activity);
        v_targets := jsonb_build_array(jsonb_build_object(
            'metric', 'water_ml', 'scope', 'total', 'direction', 'at_least',
            'value', round(v_water * 0.80, 0), 'unit', 'ml'));
        v_deriv := jsonb_build_object(
            'method', 'icmr_per_kg', 'total_water_ml', v_water,
            'beverage_fraction', 0.80, 'clamp_fired', false);

    ELSIF p_kind = 'behaviour' THEN
        IF coalesce(p_spec->>'metric', 'days_logged') <> 'days_logged' THEN
            RAISE EXCEPTION 'Unsupported behaviour metric'
                USING ERRCODE = 'PT409', HINT = 'unsupported_behaviour';
        END IF;
        v_days := greatest(p_ends_on - p_starts_on + 1, 1);
        v_amount := least(coalesce((p_spec->>'target')::numeric, v_days), v_days);
        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'Behaviour target must be positive'
                USING ERRCODE = 'PT409', HINT = 'invalid_goal_spec';
        END IF;
        v_targets := jsonb_build_array(jsonb_build_object(
            'metric', 'days_logged', 'scope', 'count', 'direction', 'at_least',
            'value', round(v_amount / v_days, 4), 'unit', 'days'));
        v_deriv := jsonb_build_object(
            'method', 'distinct_logged_days', 'target_days', v_amount,
            'period_days', v_days, 'clamp_fired', false);

    ELSIF p_kind = 'body_weight' THEN
        IF v_prof.has_medical_condition THEN
            RAISE EXCEPTION 'Weight goals require clinical review for disclosed medical conditions'
                USING ERRCODE = 'PT409', HINT = 'medical_condition';
        END IF;
        IF v_weight IS NULL OR v_prof.tdee_kcal IS NULL THEN
            RAISE EXCEPTION 'Need height, weight and date of birth before a weight goal'
                USING ERRCODE = 'PT409', HINT = 'incomplete_profile';
        END IF;

        v_dir := coalesce(p_spec->>'direction', 'lose');
        v_amount := coalesce((p_spec->>'amount_kg')::numeric, 0);
        IF v_dir NOT IN ('lose', 'gain') OR v_amount <= 0 THEN
            RAISE EXCEPTION 'Weight goal direction and amount are invalid'
                USING ERRCODE = 'PT409', HINT = 'invalid_goal_spec';
        END IF;

        IF v_dir = 'lose' THEN
            v_target_weight := coalesce(
                (p_spec->>'target_weight_kg')::numeric, v_weight - v_amount);
            v_target_bmi := public.fn_bmi(v_target_weight, v_prof.height_cm);
            IF v_target_weight <= 0 OR v_target_bmi < 18.5 THEN
                RAISE EXCEPTION 'Requested target weight would produce a BMI below 18.5'
                    USING ERRCODE = 'PT409', HINT = 'target_bmi';
            END IF;
        ELSE
            v_target_weight := coalesce(
                (p_spec->>'target_weight_kg')::numeric, v_weight + v_amount);
            v_target_bmi := public.fn_bmi(v_target_weight, v_prof.height_cm);
        END IF;

        v_weeks := greatest((p_ends_on - p_starts_on)::numeric / 7.0, 0.5);
        v_req_rate := v_amount / v_weeks;
        v_max_rate := public.fn_safe_rate_kg_per_week(v_weight);
        v_rate := least(v_req_rate, v_max_rate);
        v_clamped := v_rate < v_req_rate;

        v_deficit := v_rate * 1100;
        v_requested_intake := CASE WHEN v_dir = 'gain'
            THEN v_prof.tdee_kcal + least(v_req_rate * 1100, 400)
            ELSE v_prof.tdee_kcal - v_req_rate * 1100 END;
        v_intake := CASE WHEN v_dir = 'gain'
            THEN v_prof.tdee_kcal + least(v_deficit, 400)
            ELSE v_prof.tdee_kcal - v_deficit END;

        v_floor := public.fn_calorie_floor(v_prof.sex, v_prof.bmr_kcal);
        IF v_dir = 'lose' AND v_intake < v_floor THEN
            v_intake := v_floor;
            v_deficit := greatest(v_prof.tdee_kcal - v_floor, 0);
            v_rate := v_deficit / 1100.0;
            v_floored := true;
        END IF;

        v_protein := public.fn_protein_target_g(v_weight, v_dir, v_prof.diet);
        v_fat := round(v_intake * 0.27 / 9.0, 0);
        v_carbs := greatest(round((v_intake - v_protein * 4 - v_fat * 9) / 4.0, 0), 0);
        v_water := public.fn_hydration_ml(v_weight, v_prof.sex, v_prof.activity);

        v_targets := jsonb_build_array(
            jsonb_build_object(
                'metric', 'calories_kcal', 'scope', 'total',
                'direction', CASE WHEN v_dir = 'gain' THEN 'at_least' ELSE 'at_most' END,
                'value', round(v_intake), 'unit', 'kcal'),
            jsonb_build_object(
                'metric', 'protein_g', 'scope', 'total', 'direction', 'at_least',
                'value', v_protein, 'unit', 'g'),
            jsonb_build_object(
                'metric', 'carbs_g', 'scope', 'total', 'direction', 'around',
                'value', v_carbs, 'unit', 'g'),
            jsonb_build_object(
                'metric', 'fat_g', 'scope', 'total', 'direction', 'around',
                'value', v_fat, 'unit', 'g'),
            jsonb_build_object(
                'metric', 'water_ml', 'scope', 'total', 'direction', 'at_least',
                'value', round(v_water * 0.80), 'unit', 'ml'));

        v_deriv := jsonb_build_object(
            'method', 'mifflin_tdee_deficit',
            'weight_kg', v_weight, 'target_weight_kg', v_target_weight,
            'target_bmi', v_target_bmi,
            'bmr_kcal', v_prof.bmr_kcal, 'tdee_kcal', v_prof.tdee_kcal,
            'requested_rate_kg_per_week', round(v_req_rate, 3),
            'max_safe_rate_kg_per_week', v_max_rate,
            'applied_rate_kg_per_week', round(v_rate, 3),
            'requested_intake_kcal', round(v_requested_intake),
            'applied_intake_kcal', round(v_intake),
            'calorie_floor_kcal', v_floor,
            'clamp_fired', v_clamped,
            'floor_applied', v_floored,
            'achievable_end_date', CASE WHEN v_rate > 0
                THEN p_starts_on + (ceil(v_amount / v_rate) * 7)::integer
                ELSE NULL END,
            'note', 'Projection flattens: BMR falls as weight falls (Hall & Chow 2013). '
                    'Recalculate every 2-4 weeks or 2-3 kg.');
    END IF;

    RETURN QUERY SELECT
        jsonb_build_object('targets', coalesce(v_targets, '[]'::jsonb)), v_deriv;
END;
$$;

-- Profile edits that alter formula inputs must recompute and force a visible
-- goal version. Derived-column updates recurse into this trigger and are ignored.
CREATE OR REPLACE FUNCTION public.trg_user_profile_after_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_reason text;
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

    IF TG_OP = 'INSERT'
       OR NEW.sex IS DISTINCT FROM OLD.sex
       OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
       OR NEW.height_cm IS DISTINCT FROM OLD.height_cm
       OR NEW.activity IS DISTINCT FROM OLD.activity THEN
        v_reason := CASE
            WHEN TG_OP = 'UPDATE' AND NEW.activity IS DISTINCT FROM OLD.activity
                THEN 'activity_change'
            ELSE 'profile_change'
        END;
        PERFORM public.fn_refresh_user_profile(NEW.user_id);
        PERFORM public.fn_reresolve_active_goal(NEW.user_id, v_reason);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profile_au ON public.user_profiles;
CREATE TRIGGER user_profile_aiu
    AFTER INSERT OR UPDATE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.trg_user_profile_after_update();

-- Structural profile edits bypass the weight/noise guard.
CREATE OR REPLACE FUNCTION public.fn_reresolve_active_goal(p_user_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_goal      public.goals%ROWTYPE;
    v_weight    numeric;
    v_last_w    numeric;
    v_days      integer;
    v_targets   jsonb;
    v_deriv     jsonb;
    v_new_id    uuid;
BEGIN
    SELECT * INTO v_goal FROM public.goals
     WHERE user_id = p_user_id AND is_active AND status = 'active'
     FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT weight_kg INTO v_weight FROM public.body_metrics
     WHERE user_id = p_user_id ORDER BY measured_on DESC, created_at DESC LIMIT 1;

    v_last_w := (v_goal.derivation->>'weight_kg')::numeric;
    v_days := extract(day FROM now() - v_goal.created_at)::integer;
    IF NOT (
        (v_last_w IS NOT NULL AND v_weight IS NOT NULL AND abs(v_weight - v_last_w) >= 2.0)
        OR v_days >= 14
        OR p_reason IN ('user_edit', 'activity_change', 'profile_change')
    ) THEN
        RETURN NULL;
    END IF;

    BEGIN
        SELECT t.daily_targets, t.derivation INTO v_targets, v_deriv
          FROM public.fn_resolve_goal_targets(
              p_user_id, v_goal.kind, v_goal.spec, v_goal.starts_on, v_goal.ends_on) t;

        UPDATE public.goals SET is_active = false WHERE id = v_goal.id;
        INSERT INTO public.goals (
            goal_id, user_id, kind, spec, starts_on, ends_on, daily_targets,
            derivation, status, version, is_active)
        VALUES (
            v_goal.goal_id, p_user_id, v_goal.kind, v_goal.spec,
            v_goal.starts_on, v_goal.ends_on, v_targets,
            v_deriv || jsonb_build_object('trigger_reason', p_reason),
            v_goal.status, v_goal.version + 1, true)
        RETURNING id INTO v_new_id;

        INSERT INTO public.audit_log (
            entity, entity_id, user_id, action, old_value, new_value, actor, source)
        VALUES (
            'goal', v_goal.goal_id, p_user_id, 'VERSION',
            v_goal.daily_targets, v_targets, 'system', 'trigger');
        RETURN v_new_id;
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.audit_log (
            entity, entity_id, user_id, action, new_value, actor, source)
        VALUES (
            'goal', v_goal.goal_id, p_user_id, 'RERESOLVE_FAILED',
            jsonb_build_object('error', SQLERRM, 'reason', p_reason),
            'system', 'trigger');
        RETURN NULL;
    END;
END;
$$;

-- Create and activate goals under a per-user row lock. The final target guard
-- is intentionally in the writer as defense in depth against future resolvers.
CREATE OR REPLACE FUNCTION public.fn_create_goal(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_targets jsonb;
    v_deriv   jsonb;
    v_id      uuid;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
      FROM public.fn_resolve_goal_targets(
          p_user_id, p_kind, p_spec, p_starts_on, p_ends_on) r;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_targets->'targets') target
         WHERE target->>'metric' = 'calories_kcal'
           AND coalesce(target->>'direction', 'around') IN ('at_most', 'around')
           AND (target->>'value')::numeric < 800
    ) THEN
        RAISE EXCEPTION 'Final calorie target cannot be below 800 kcal/day'
            USING ERRCODE = 'PT409', HINT = 'vlcd_refused';
    END IF;

    UPDATE public.goals
       SET is_active = false
     WHERE user_id = p_user_id AND is_active;

    INSERT INTO public.goals (
        user_id, kind, spec, starts_on, ends_on, daily_targets,
        derivation, status, version, is_active)
    VALUES (
        p_user_id, p_kind, p_spec, p_starts_on, p_ends_on, v_targets,
        v_deriv, 'active', 1, true)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    SELECT 'goal', goal_id, p_user_id, 'CREATE', to_jsonb(goals),
           p_user_id::text, 'api'
      FROM public.goals WHERE id = v_id;

    RETURN QUERY SELECT * FROM public.goals WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_goal_active(
    p_user_id uuid, p_goal_id uuid, p_active boolean)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_goal public.goals%ROWTYPE;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_goal
      FROM public.goals
     WHERE user_id = p_user_id AND goal_id = p_goal_id
     ORDER BY version DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Goal not found' USING ERRCODE = 'PT404', HINT = 'goal_not_found';
    END IF;

    IF p_active AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_goal.daily_targets->'targets') target
         WHERE target->>'metric' = 'calories_kcal'
           AND coalesce(target->>'direction', 'around') IN ('at_most', 'around')
           AND (target->>'value')::numeric < 800
    ) THEN
        RAISE EXCEPTION 'Final calorie target cannot be below 800 kcal/day'
            USING ERRCODE = 'PT409', HINT = 'vlcd_refused';
    END IF;

    IF p_active THEN
        UPDATE public.goals SET is_active = false
         WHERE user_id = p_user_id AND is_active;
    END IF;
    UPDATE public.goals
       SET is_active = p_active,
           status = CASE WHEN p_active THEN 'active'::goal_status ELSE 'abandoned'::goal_status END,
           updated_at = now()
     WHERE id = v_goal.id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    VALUES (
        'goal', p_goal_id, p_user_id,
        CASE WHEN p_active THEN 'ACTIVATE' ELSE 'DEACTIVATE' END,
        to_jsonb(v_goal),
        (SELECT to_jsonb(g) FROM public.goals g WHERE id = v_goal.id),
        p_user_id::text, 'api');

    RETURN QUERY SELECT * FROM public.goals WHERE id = v_goal.id;
END;
$$;

-- Replace a day as one transaction. Items are fully resolved by the domain
-- layer first, then inserted together at one new version.
CREATE OR REPLACE FUNCTION public.fn_replace_meal_day(
    p_user_id uuid, p_meal_date date, p_items jsonb)
RETURNS SETOF public.meals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_version integer;
    v_item    jsonb;
BEGIN
    IF jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'Meal items must be an array' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT coalesce(max(version), 0) + 1 INTO v_version
      FROM public.meals
     WHERE user_id = p_user_id AND meal_date = p_meal_date;

    UPDATE public.meals SET is_active = false, updated_at = now()
     WHERE user_id = p_user_id AND meal_date = p_meal_date AND is_active;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        INSERT INTO public.meals (
            user_id, meal_date, meal_type, slot_time, version, is_active,
            dish_name, food_id, category, portions, portion_unit, grams,
            nutrients, resolved_from, confidence, source, note)
        VALUES (
            p_user_id, p_meal_date, (v_item->>'meal_type')::meal_type,
            nullif(v_item->>'slot_time', '')::time, v_version, true,
            v_item->>'dish_name', nullif(v_item->>'food_id', '')::uuid,
            nullif(v_item->>'category', '')::food_category,
            coalesce((v_item->>'portions')::numeric, 1), v_item->>'portion_unit',
            (v_item->>'grams')::numeric, coalesce(v_item->'nutrients', '{}'::jsonb),
            (v_item->>'resolved_from')::resolved_from, v_item->>'confidence',
            coalesce((v_item->>'source')::entry_source, 'manual'), v_item->>'note');
    END LOOP;

    INSERT INTO public.audit_log (
        entity, user_id, action, new_value, actor, source)
    VALUES (
        'meal', p_user_id, 'VERSION',
        jsonb_build_object('meal_date', p_meal_date, 'version', v_version,
                           'item_count', jsonb_array_length(p_items)),
        p_user_id::text, 'api');

    RETURN QUERY
        SELECT * FROM public.meals
         WHERE user_id = p_user_id AND meal_date = p_meal_date
           AND version = v_version AND is_active
         ORDER BY meal_type, created_at, id;
END;
$$;

-- PATCH and DELETE clone the complete active day into version+1 rather than
-- mutating one row in a shared historical version.
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
            v_version, true, v_row.dish_name, v_row.food_id, v_row.category,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'portions'
                THEN (p_patch->>'portions')::numeric ELSE v_row.portions END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'portion_unit'
                THEN p_patch->>'portion_unit' ELSE v_row.portion_unit END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'grams'
                THEN (p_patch->>'grams')::numeric ELSE v_row.grams END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'nutrients'
                THEN p_patch->'nutrients' ELSE v_row.nutrients END,
            CASE WHEN v_row.id = p_meal_id AND p_patch ? 'resolved_from'
                THEN (p_patch->>'resolved_from')::resolved_from ELSE v_row.resolved_from END,
            v_row.confidence, v_row.source, v_row.note)
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

CREATE OR REPLACE FUNCTION public.fn_upsert_preference(
    p_user_id uuid, p_topic_title text, p_content text, p_type text,
    p_source text, p_expires_on date)
RETURNS SETOF public.user_preferences
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_old     public.user_preferences%ROWTYPE;
    v_id      uuid;
    v_pref_id uuid := gen_random_uuid();
    v_version integer := 1;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_old FROM public.user_preferences
     WHERE user_id = p_user_id AND topic_title = p_topic_title AND is_active
     ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        v_pref_id := v_old.pref_id;
        v_version := v_old.version + 1;
        UPDATE public.user_preferences SET is_active = false, updated_at = now()
         WHERE user_id = p_user_id AND topic_title = p_topic_title AND is_active;
    END IF;

    INSERT INTO public.user_preferences (
        pref_id, user_id, topic_title, content, type, expires_on,
        source, version, is_active)
    VALUES (
        v_pref_id, p_user_id, p_topic_title, p_content, p_type,
        p_expires_on, p_source, v_version, true)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    SELECT 'preference', v_pref_id, p_user_id,
           CASE WHEN v_version = 1 THEN 'CREATE' ELSE 'VERSION' END,
           CASE WHEN v_version = 1 THEN NULL ELSE to_jsonb(v_old) END,
           to_jsonb(p), p_user_id::text, 'api'
      FROM public.user_preferences p WHERE id = v_id;

    RETURN QUERY SELECT * FROM public.user_preferences WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_dish_household(
    p_user_id uuid, p_dish_id uuid, p_portion_unit text,
    p_portion_grams numeric, p_per_100g jsonb, p_note text)
RETURNS SETOF public.dish_household
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_old     public.dish_household%ROWTYPE;
    v_id      uuid;
    v_version integer := 1;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_old FROM public.dish_household
     WHERE user_id = p_user_id AND dish_id = p_dish_id AND is_active
     FOR UPDATE;
    IF FOUND THEN
        v_version := v_old.version + 1;
        UPDATE public.dish_household SET is_active = false WHERE id = v_old.id;
    END IF;

    INSERT INTO public.dish_household (
        user_id, dish_id, portion_unit, portion_grams, per_100g,
        note, version, is_active)
    VALUES (
        p_user_id, p_dish_id, p_portion_unit, p_portion_grams, p_per_100g,
        p_note, v_version, true)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    SELECT 'portion', p_dish_id, p_user_id,
           CASE WHEN v_version = 1 THEN 'CREATE' ELSE 'VERSION' END,
           CASE WHEN v_version = 1 THEN NULL ELSE to_jsonb(v_old) END,
           to_jsonb(d), p_user_id::text, 'api'
      FROM public.dish_household d WHERE id = v_id;

    RETURN QUERY SELECT * FROM public.dish_household WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_category_household(
    p_user_id uuid, p_category food_category, p_portion_unit text,
    p_portion_grams numeric, p_portion_count numeric, p_source text)
RETURNS SETOF public.category_household
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_old     public.category_household%ROWTYPE;
    v_id      uuid;
    v_version integer := 1;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_old FROM public.category_household
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
        p_user_id, p_category, p_portion_unit, p_portion_grams, p_portion_count,
        p_source, v_version, true)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, old_value, new_value, actor, source)
    SELECT 'portion', id, p_user_id,
           CASE WHEN v_version = 1 THEN 'CREATE' ELSE 'VERSION' END,
           CASE WHEN v_version = 1 THEN NULL ELSE to_jsonb(v_old) END,
           to_jsonb(c), p_user_id::text, 'api'
      FROM public.category_household c WHERE id = v_id;

    RETURN QUERY SELECT * FROM public.category_household WHERE id = v_id;
END;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Sweep every privileged
-- function after all replacements/creations so no old or new SECURITY DEFINER
-- entry point remains callable by PUBLIC, anon, or authenticated.
DO $$
DECLARE
    v_function regprocedure;
BEGIN
    FOR v_function IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
        EXECUTE format(
            'GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
    END LOOP;
END;
$$;
