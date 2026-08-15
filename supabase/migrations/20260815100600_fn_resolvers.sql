-- Resolvers. These read and write tables, so they are STABLE/VOLATILE and
-- SECURITY DEFINER with an explicit empty search_path (without that pin they
-- are a privilege-escalation vector).

-- ---------------------------------------------------------------------------
-- Recompute BMI/BMR/TDEE from the LATEST body metrics. Idempotent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_refresh_user_profile(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_weight numeric;
    v_prof   public.user_profiles%ROWTYPE;
    v_age    integer;
BEGIN
    SELECT * INTO v_prof FROM public.user_profiles WHERE user_id = p_user_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT weight_kg INTO v_weight
      FROM public.body_metrics
     WHERE user_id = p_user_id
     ORDER BY measured_on DESC, created_at DESC
     LIMIT 1;

    IF v_weight IS NULL OR v_prof.height_cm IS NULL OR v_prof.date_of_birth IS NULL THEN
        RETURN;  -- not enough data yet; leave the derived columns NULL
    END IF;

    v_age := extract(year FROM age(v_prof.date_of_birth))::integer;

    UPDATE public.user_profiles
       SET bmi         = public.fn_bmi(v_weight, height_cm),
           bmr_kcal    = public.fn_bmr_mifflin(v_weight, height_cm, v_age, sex),
           tdee_kcal   = public.fn_tdee(
                            public.fn_bmr_mifflin(v_weight, height_cm, v_age, sex),
                            activity),
           computed_at = now(),
           updated_at  = now()
     WHERE user_id = p_user_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- THE SAFETY LADDER. Returns resolved targets + the full derivation.
-- Does NOT write - so it also powers POST /goals/preview, which is what makes
-- a clamp feel like guidance rather than rejection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_resolve_goal_targets(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date)
RETURNS TABLE (daily_targets jsonb, derivation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_prof     public.user_profiles%ROWTYPE;
    v_weight   numeric;
    v_weeks    numeric;
    v_req_rate numeric;
    v_max_rate numeric;
    v_rate     numeric;
    v_deficit  numeric;
    v_floor    numeric;
    v_intake   numeric;
    v_protein  numeric;
    v_fat      numeric;
    v_carbs    numeric;
    v_water    numeric;
    v_clamped  boolean := false;
    v_floored  boolean := false;
    v_targets  jsonb   := '[]'::jsonb;
    v_deriv    jsonb   := '{}'::jsonb;
    v_dir      text;
    v_amount   numeric;
BEGIN
    SELECT * INTO v_prof FROM public.user_profiles WHERE user_id = p_user_id;
    SELECT weight_kg INTO v_weight FROM public.body_metrics
     WHERE user_id = p_user_id ORDER BY measured_on DESC, created_at DESC LIMIT 1;

    -- ---- REFUSALS. Show a referral, not a plan. -----------------------------
    IF v_prof.date_of_birth IS NOT NULL
       AND extract(year FROM age(v_prof.date_of_birth)) < 18 THEN
        RAISE EXCEPTION 'Goal targets are not available for users under 18'
            USING ERRCODE = 'PT409', HINT = 'under_18';
    END IF;
    IF v_prof.is_pregnant_or_nursing THEN
        RAISE EXCEPTION 'Weight goals require clinical supervision during pregnancy or nursing'
            USING ERRCODE = 'PT409', HINT = 'pregnant_or_nursing';
    END IF;

    -- ---- EXPLICIT NUTRIENT: take the stated values ---------------------------
    IF p_kind = 'nutrient' THEN
        SELECT jsonb_agg(jsonb_build_object(
                   'metric', key, 'scope', 'total',
                   'direction', coalesce(p_spec->>'direction', 'at_least'),
                   'value', value::numeric,
                   'unit', CASE WHEN key = 'calories_kcal' THEN 'kcal' ELSE 'g' END))
          INTO v_targets
          FROM jsonb_each_text(p_spec->'nutrients');
        v_deriv := jsonb_build_object('method', 'stated', 'clamp_fired', false);

    -- ---- ITEM: "30 g of paneer daily" ---------------------------------------
    ELSIF p_kind = 'item' THEN
        v_targets := jsonb_build_array(jsonb_build_object(
            'metric', 'grams', 'scope', 'dish',
            'food_id', p_spec->>'food_id', 'label', p_spec->>'label',
            'direction', coalesce(p_spec->>'direction', 'at_least'),
            'value', (p_spec->>'amount')::numeric, 'unit', coalesce(p_spec->>'unit','g')));
        v_deriv := jsonb_build_object('method', 'stated', 'clamp_fired', false);

    -- ---- HYDRATION -----------------------------------------------------------
    ELSIF p_kind = 'hydration' THEN
        v_water := public.fn_hydration_ml(v_weight, v_prof.sex, v_prof.activity);
        v_targets := jsonb_build_array(jsonb_build_object(
            'metric','water_ml','scope','total','direction','at_least',
            'value', round(v_water * 0.80, 0),   -- beverage-only: ~80% of total
            'unit','ml'));
        v_deriv := jsonb_build_object('method','icmr_per_kg','total_water_ml',v_water,
                                      'beverage_fraction',0.80);

    -- ---- BODY WEIGHT: the full ladder ---------------------------------------
    ELSIF p_kind = 'body_weight' THEN
        IF v_weight IS NULL OR v_prof.tdee_kcal IS NULL THEN
            RAISE EXCEPTION 'Need height, weight and date of birth before a weight goal'
                USING ERRCODE = 'PT409', HINT = 'incomplete_profile';
        END IF;

        v_dir    := coalesce(p_spec->>'direction', 'lose');
        v_amount := coalesce((p_spec->>'amount_kg')::numeric, 0);
        v_weeks  := greatest((p_ends_on - p_starts_on)::numeric / 7.0, 0.5);

        v_req_rate := v_amount / v_weeks;
        v_max_rate := public.fn_safe_rate_kg_per_week(v_weight);

        -- 2. CLAMP THE RATE
        v_rate := least(v_req_rate, v_max_rate);
        v_clamped := v_rate < v_req_rate;

        v_deficit := v_rate * 1100;   -- the identity
        v_intake  := CASE WHEN v_dir = 'gain'
                          THEN v_prof.tdee_kcal + least(v_deficit, 400)
                          ELSE v_prof.tdee_kcal - v_deficit END;

        -- 3. CLAMP THE FLOOR - the RATE gives way, never the floor
        v_floor := public.fn_calorie_floor(v_prof.sex, v_prof.bmr_kcal);
        IF v_dir = 'lose' AND v_intake < v_floor THEN
            IF v_intake < 800 THEN
                RAISE EXCEPTION
                    'Target intake %s kcal/day is a very-low-calorie diet requiring medical supervision',
                    round(v_intake)
                    USING ERRCODE = 'PT409', HINT = 'vlcd_refused';
            END IF;
            v_intake  := v_floor;
            v_deficit := v_prof.tdee_kcal - v_floor;
            v_rate    := v_deficit / 1100.0;      -- re-derive the ACHIEVABLE rate
            v_floored := true;
        END IF;

        v_protein := public.fn_protein_target_g(v_weight, v_dir, v_prof.diet);
        v_fat     := round(v_intake * 0.27 / 9.0, 0);          -- ICMR 25-30% of energy
        v_carbs   := round((v_intake - v_protein*4 - v_fat*9) / 4.0, 0);
        v_water   := public.fn_hydration_ml(v_weight, v_prof.sex, v_prof.activity);

        v_targets := jsonb_build_array(
            jsonb_build_object('metric','calories_kcal','scope','total',
                'direction', CASE WHEN v_dir='gain' THEN 'at_least' ELSE 'at_most' END,
                'value', round(v_intake), 'unit','kcal'),
            jsonb_build_object('metric','protein_g','scope','total',
                'direction','at_least','value',v_protein,'unit','g'),
            jsonb_build_object('metric','carbs_g','scope','total',
                'direction','around','value',v_carbs,'unit','g'),
            jsonb_build_object('metric','fat_g','scope','total',
                'direction','around','value',v_fat,'unit','g'),
            jsonb_build_object('metric','water_ml','scope','total',
                'direction','at_least','value',round(v_water*0.80),'unit','ml'));

        v_deriv := jsonb_build_object(
            'method','mifflin_tdee_deficit',
            'weight_kg', v_weight, 'bmr_kcal', v_prof.bmr_kcal, 'tdee_kcal', v_prof.tdee_kcal,
            'requested_rate_kg_per_week', round(v_req_rate, 3),
            'max_safe_rate_kg_per_week',  v_max_rate,
            'applied_rate_kg_per_week',   round(v_rate, 3),
            'requested_intake_kcal',      round(v_prof.tdee_kcal - v_req_rate * 1100),
            'applied_intake_kcal',        round(v_intake),
            'calorie_floor_kcal',         v_floor,
            'clamp_fired',  v_clamped,
            'floor_applied', v_floored,
            -- 4. the achievable date, so the UI can show both
            'achievable_end_date',
                CASE WHEN v_rate > 0
                     THEN (p_starts_on + (ceil(v_amount / v_rate) * 7)::integer)
                     ELSE NULL END,
            'note', 'Projection flattens: BMR falls as weight falls (Hall & Chow 2013). '
                    'Recalculate every 2-4 weeks or 2-3 kg.');
    ELSE
        v_deriv := jsonb_build_object('method','none');
    END IF;

    RETURN QUERY SELECT jsonb_build_object('targets', coalesce(v_targets, '[]'::jsonb)), v_deriv;
END;
$$;

-- ---------------------------------------------------------------------------
-- Mint version+1 of the active goal IF re-resolution is warranted.
--
-- THE GUARD is the whole difficulty: a naive trigger re-resolves on every
-- weight log, so the user sees a different target each morning moving on scale
-- noise. The trigger always fires; this FUNCTION decides.
--
-- It also must NEVER RAISE - it runs inside the caller's transaction, so an
-- error here would kill the weight insert. A stale target is recoverable;
-- a lost weight entry is not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reresolve_active_goal(p_user_id uuid, p_reason text)
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
     WHERE user_id = p_user_id AND is_active AND status = 'active';
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT weight_kg INTO v_weight FROM public.body_metrics
     WHERE user_id = p_user_id ORDER BY measured_on DESC, created_at DESC LIMIT 1;

    v_last_w := (v_goal.derivation->>'weight_kg')::numeric;
    v_days   := extract(day FROM now() - v_goal.created_at)::integer;

    -- The guard. Day-to-day weight swings 1-2 kg on water and glycogen alone
    -- and must NOT move a target. The science section already says recalculate
    -- every 2-4 weeks or every 2-3 kg.
    IF NOT (
        (v_last_w IS NOT NULL AND v_weight IS NOT NULL AND abs(v_weight - v_last_w) >= 2.0)
        OR v_days >= 14
        OR p_reason IN ('user_edit', 'activity_change')
    ) THEN
        RETURN NULL;   -- declined, and that is the common path
    END IF;

    BEGIN
        SELECT t.daily_targets, t.derivation INTO v_targets, v_deriv
          FROM public.fn_resolve_goal_targets(
                 p_user_id, v_goal.kind, v_goal.spec, v_goal.starts_on, v_goal.ends_on) t;

        UPDATE public.goals SET is_active = false WHERE id = v_goal.id;

        INSERT INTO public.goals (goal_id, user_id, kind, spec, starts_on, ends_on,
                                  daily_targets, derivation, status, version, is_active)
        VALUES (v_goal.goal_id, p_user_id, v_goal.kind, v_goal.spec,
                v_goal.starts_on, v_goal.ends_on,
                v_targets, v_deriv || jsonb_build_object('trigger_reason', p_reason),
                v_goal.status, v_goal.version + 1, true)
        RETURNING id INTO v_new_id;

        INSERT INTO public.audit_log (entity, entity_id, user_id, action,
                                      old_value, new_value, actor, source)
        VALUES ('goal', v_goal.goal_id, p_user_id, 'VERSION',
                v_goal.daily_targets, v_targets, 'system', 'trigger');

        RETURN v_new_id;
    EXCEPTION WHEN OTHERS THEN
        -- NEVER let a re-resolution failure kill the parent write.
        INSERT INTO public.audit_log (entity, entity_id, user_id, action, new_value,
                                      actor, source)
        VALUES ('goal', v_goal.goal_id, p_user_id, 'RERESOLVE_FAILED',
                jsonb_build_object('error', SQLERRM, 'reason', p_reason),
                'system', 'trigger');
        RETURN NULL;
    END;
END;
$$;
