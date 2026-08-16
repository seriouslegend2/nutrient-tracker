-- Multiple concurrent goals, cadence-aware targets, and explicit activity logs.

CREATE TYPE goal_cadence AS ENUM ('daily', 'weekly', 'monthly', 'period');

ALTER TABLE public.goals
    ADD COLUMN cadence goal_cadence NOT NULL DEFAULT 'daily',
    ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE public.goals ADD CONSTRAINT goal_period_is_bounded
    CHECK (ends_on >= starts_on AND ends_on - starts_on + 1 <= 1830) NOT VALID;

-- The old model had at most one active row, so it is safe to make that row primary.
UPDATE public.goals SET is_primary = true WHERE is_active;

DROP INDEX IF EXISTS public.uq_goal_active_per_user;

CREATE UNIQUE INDEX uq_goal_active_primary_per_user
    ON public.goals (user_id) WHERE is_active AND is_primary;
CREATE INDEX idx_goals_user_active
    ON public.goals (user_id, created_at DESC) WHERE is_active;

CREATE TABLE public.activity_logs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
    activity_date date NOT NULL DEFAULT CURRENT_DATE,
    activity_type text NOT NULL DEFAULT 'training'
                  CHECK (activity_type IN ('training')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_activity_user_date_type
        UNIQUE (user_id, activity_date, activity_type)
);
CREATE INDEX idx_activity_user_date
    ON public.activity_logs (user_id, activity_date DESC);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.activity_logs;
CREATE POLICY service_role_full_access ON public.activity_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS admin_read_all ON public.activity_logs;
CREATE POLICY admin_read_all ON public.activity_logs
    FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS own_rows ON public.activity_logs;
CREATE POLICY own_rows ON public.activity_logs
    FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Extends the shipped resolver without changing its signature or existing
-- body-weight safety behavior.
CREATE OR REPLACE FUNCTION public.fn_resolve_goal_targets_v2(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date)
RETURNS TABLE (daily_targets jsonb, derivation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_targets          jsonb;
    v_deriv            jsonb;
    v_target           jsonb;
    v_rebuilt          jsonb := '[]'::jsonb;
    v_weight           numeric;
    v_estimated_water  numeric;
    v_requested_water  numeric;
    v_applied_water    numeric;
    v_requested_protein numeric;
    v_protein_floor    numeric;
    v_protein_clamped  boolean := false;
    v_behaviour_target numeric;
    v_date_of_birth    date;
BEGIN
    SELECT date_of_birth INTO v_date_of_birth
      FROM public.user_profiles WHERE user_id = p_user_id;
    IF v_date_of_birth IS NOT NULL
       AND extract(year FROM age(v_date_of_birth)) < 18 THEN
        RAISE EXCEPTION 'Goal targets are not available for users under 18'
            USING ERRCODE = 'PT409', HINT = 'under_18';
    END IF;
    IF p_kind IN ('behaviour', 'hydration') THEN
        v_targets := '{"targets":[]}'::jsonb;
        v_deriv := '{}'::jsonb;
    ELSIF p_kind = 'nutrient'
          AND coalesce(p_spec->'nutrients', '{}'::jsonb) ? 'protein_g'
          AND (SELECT count(*) FROM jsonb_object_keys(
              coalesce(p_spec->'nutrients', '{}'::jsonb))) = 1 THEN
        v_targets := jsonb_build_object('targets', jsonb_build_array(jsonb_build_object(
            'metric', 'protein_g', 'scope', 'total',
            'direction', coalesce(p_spec->>'direction', 'at_least'),
            'value', (p_spec->'nutrients'->>'protein_g')::numeric, 'unit', 'g')));
        v_deriv := '{}'::jsonb;
    ELSE
        SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
          FROM public.fn_resolve_goal_targets(
              p_user_id, p_kind, p_spec, p_starts_on, p_ends_on) r;
    END IF;

    SELECT weight_kg INTO v_weight
      FROM public.body_metrics
     WHERE user_id = p_user_id
     ORDER BY measured_on DESC, created_at DESC
     LIMIT 1;

    IF p_kind = 'nutrient' AND coalesce(p_spec->'nutrients', '{}'::jsonb) ? 'protein_g' THEN
        IF v_weight IS NULL THEN
            RAISE EXCEPTION 'Need profile weight before setting a protein goal'
                USING ERRCODE = 'PT409', HINT = 'incomplete_profile';
        END IF;
        v_requested_protein := (p_spec->'nutrients'->>'protein_g')::numeric;
        v_protein_floor := round(v_weight * 0.8, 1);
        v_protein_clamped := v_requested_protein < v_protein_floor;

        FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets->'targets')
        LOOP
            IF v_target->>'metric' = 'protein_g' AND v_protein_clamped THEN
                v_target := jsonb_set(v_target, '{value}', to_jsonb(v_protein_floor));
            END IF;
            v_rebuilt := v_rebuilt || v_target;
        END LOOP;
        v_targets := jsonb_build_object('targets', v_rebuilt);
        v_deriv := v_deriv || jsonb_build_object(
            'requested_protein_g', v_requested_protein,
            'applied_protein_g', greatest(v_requested_protein, v_protein_floor),
            'protein_floor_g', v_protein_floor,
            'protein_floor_applied', v_protein_clamped,
            'weight_kg', v_weight,
            'clamp_fired', coalesce((v_deriv->>'clamp_fired')::boolean, false)
                           OR v_protein_clamped);

    ELSIF p_kind = 'hydration' THEN
        SELECT public.fn_hydration_ml(bm.weight_kg, up.sex, up.activity) * 0.8
          INTO v_estimated_water
          FROM public.user_profiles up
          LEFT JOIN LATERAL (
              SELECT weight_kg FROM public.body_metrics
               WHERE user_id = p_user_id
               ORDER BY measured_on DESC, created_at DESC LIMIT 1
          ) bm ON true
         WHERE up.user_id = p_user_id;
        v_estimated_water := round(v_estimated_water);
        v_requested_water := (p_spec->>'target_ml')::numeric;
        v_applied_water := coalesce(v_requested_water, v_estimated_water);

        IF v_requested_water IS NOT NULL
           AND (v_requested_water >= 10000
                OR (v_estimated_water IS NOT NULL
                    AND v_requested_water > v_estimated_water * 2)) THEN
            RAISE EXCEPTION 'Requested hydration minimum is extreme'
                USING ERRCODE = 'PT409', HINT = 'hydration_extreme';
        END IF;
        IF v_applied_water IS NULL OR v_applied_water <= 0 THEN
            RAISE EXCEPTION 'Need profile weight or a positive requested hydration target'
                USING ERRCODE = 'PT409', HINT = 'incomplete_profile';
        END IF;
        v_targets := jsonb_build_object('targets', jsonb_build_array(jsonb_build_object(
            'metric', 'water_ml', 'scope', 'total', 'direction', 'at_least',
            'value', v_applied_water, 'unit', 'ml')));
        v_deriv := jsonb_build_object(
            'method', CASE WHEN v_requested_water IS NULL THEN 'icmr_per_kg' ELSE 'stated' END,
            'requested_target_ml', v_requested_water,
            'estimated_target_ml', v_estimated_water,
            'applied_target_ml', v_applied_water,
            'weight_kg', v_weight,
            'clamp_fired', false);

    ELSIF p_kind = 'behaviour' THEN
        IF coalesce(p_spec->>'metric', '') <> 'training_days' THEN
            RAISE EXCEPTION 'Unsupported behaviour metric'
                USING ERRCODE = 'PT409', HINT = 'unsupported_behaviour';
        END IF;
        v_behaviour_target := (p_spec->>'target')::numeric;
        IF v_behaviour_target IS NULL OR v_behaviour_target <= 0 THEN
            RAISE EXCEPTION 'Behaviour target must be positive'
                USING ERRCODE = 'PT409', HINT = 'invalid_goal_spec';
        END IF;
        v_targets := jsonb_build_object('targets', jsonb_build_array(jsonb_build_object(
            'metric', 'training_days', 'scope', 'activity', 'direction', 'at_least',
            'value', v_behaviour_target, 'unit', 'days')));
        v_deriv := jsonb_build_object(
            'method', 'explicit_activity_dates', 'target_days', v_behaviour_target,
            'clamp_fired', false);
    END IF;

    RETURN QUERY SELECT v_targets, v_deriv;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_create_goal_v2(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date,
    p_cadence goal_cadence DEFAULT 'daily', p_make_primary boolean DEFAULT false)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_targets jsonb;
    v_deriv   jsonb;
    v_id      uuid;
    v_primary boolean;
    v_cadence goal_cadence;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    IF p_ends_on < p_starts_on THEN
        RAISE EXCEPTION 'Goal end date must be on or after its start date'
            USING ERRCODE = 'PT409', HINT = 'invalid_goal_dates';
    END IF;
    IF p_ends_on - p_starts_on + 1 > 1830 THEN
        RAISE EXCEPTION 'Goal period cannot exceed 1830 days'
            USING ERRCODE = 'PT409', HINT = 'invalid_goal_dates';
    END IF;
    IF p_kind = 'nutrient'
       AND (SELECT count(*) FROM jsonb_object_keys(
           coalesce(p_spec->'nutrients', '{}'::jsonb))) <> 1 THEN
        RAISE EXCEPTION 'Exactly one nutrient target is supported'
            USING ERRCODE = 'PT409', HINT = 'invalid_goal_spec';
    END IF;
    SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
      FROM public.fn_resolve_goal_targets_v2(
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

    v_primary := EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_targets->'targets') target
         WHERE target->>'metric' = 'calories_kcal')
        AND (p_make_primary OR NOT EXISTS (
            SELECT 1 FROM public.goals
             WHERE user_id = p_user_id AND is_active AND is_primary));
    IF v_primary THEN
        UPDATE public.goals SET is_primary = false, updated_at = now()
         WHERE user_id = p_user_id AND is_active AND is_primary;
    END IF;
    v_cadence := CASE
        WHEN p_kind IN ('nutrient', 'hydration', 'item') THEN 'daily'::goal_cadence
        WHEN p_kind = 'body_weight' THEN 'period'::goal_cadence
        ELSE p_cadence
    END;
    IF p_kind = 'behaviour' AND (
        v_cadence NOT IN ('weekly', 'monthly', 'period')
        OR trunc((p_spec->>'target')::numeric) <> (p_spec->>'target')::numeric
        OR (v_cadence = 'weekly' AND (p_spec->>'target')::numeric > 7)
        OR (v_cadence = 'monthly' AND (p_spec->>'target')::numeric > 31)
        OR (v_cadence = 'period' AND (p_spec->>'target')::numeric > p_ends_on - p_starts_on + 1)
    ) THEN
        RAISE EXCEPTION 'Invalid training target for cadence'
            USING ERRCODE = 'PT409', HINT = 'invalid_goal_spec';
    END IF;

    INSERT INTO public.goals (
        user_id, kind, spec, starts_on, ends_on, daily_targets,
        derivation, status, version, is_active, cadence, is_primary)
    VALUES (
        p_user_id, p_kind, p_spec, p_starts_on, p_ends_on, v_targets,
        v_deriv, 'active', 1, true, v_cadence, v_primary)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    SELECT 'goal', goal_id, p_user_id, 'CREATE', to_jsonb(g), p_user_id::text, 'api'
      FROM public.goals g WHERE id = v_id;

    RETURN QUERY SELECT * FROM public.goals WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_goal_active_v2(
    p_user_id uuid, p_goal_id uuid, p_active boolean)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_goal        public.goals%ROWTYPE;
    v_was_primary boolean;
    v_targets     jsonb;
    v_deriv       jsonb;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT * INTO v_goal
      FROM public.goals
     WHERE user_id = p_user_id AND goal_id = p_goal_id
     ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Goal not found' USING ERRCODE = 'PT404', HINT = 'goal_not_found';
    END IF;

    v_was_primary := v_goal.is_primary AND v_goal.is_active;
    IF p_active THEN
        IF v_goal.kind = 'behaviour'
           AND coalesce(v_goal.spec->>'metric', '') <> 'training_days' THEN
            SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
              FROM public.fn_resolve_goal_targets(
                  p_user_id, v_goal.kind, v_goal.spec,
                  v_goal.starts_on, v_goal.ends_on) r;
        ELSE
            SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
              FROM public.fn_resolve_goal_targets_v2(
                  p_user_id, v_goal.kind, v_goal.spec,
                  v_goal.starts_on, v_goal.ends_on) r;
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_targets->'targets') target
             WHERE target->>'metric' = 'calories_kcal'
               AND coalesce(target->>'direction', 'around') IN ('at_most', 'around')
               AND (target->>'value')::numeric < 800
        ) THEN
            RAISE EXCEPTION 'Final calorie target cannot be below 800 kcal/day'
                USING ERRCODE = 'PT409', HINT = 'vlcd_refused';
        END IF;
    END IF;
    UPDATE public.goals
       SET is_active = p_active,
           is_primary = CASE
               WHEN NOT p_active THEN false
                WHEN NOT EXISTS (
                    SELECT 1 FROM public.goals g
                     WHERE g.user_id = p_user_id AND g.is_active AND g.is_primary
                       AND g.id <> v_goal.id)
                    AND EXISTS (
                        SELECT 1 FROM jsonb_array_elements(v_targets->'targets') target
                         WHERE target->>'metric' = 'calories_kcal')
                    THEN true
               ELSE is_primary END,
            status = CASE WHEN p_active THEN 'active'::goal_status ELSE 'abandoned'::goal_status END,
            daily_targets = CASE WHEN p_active THEN v_targets ELSE daily_targets END,
            derivation = CASE WHEN p_active THEN v_deriv ELSE derivation END,
            updated_at = now()
     WHERE id = v_goal.id;

    IF NOT p_active AND v_was_primary THEN
        UPDATE public.goals SET is_primary = true, updated_at = now()
         WHERE id = (
              SELECT id FROM public.goals
               WHERE user_id = p_user_id AND is_active
                 AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(daily_targets->'targets') target
                      WHERE target->>'metric' = 'calories_kcal')
               ORDER BY created_at, id LIMIT 1);
    END IF;

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

CREATE OR REPLACE FUNCTION public.fn_set_goal_primary(p_user_id uuid, p_goal_id uuid)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    SELECT id INTO v_id
      FROM public.goals
     WHERE user_id = p_user_id AND goal_id = p_goal_id AND is_active
     ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active goal not found'
            USING ERRCODE = 'PT404', HINT = 'goal_not_found';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.goals g,
             LATERAL jsonb_array_elements(g.daily_targets->'targets') target
         WHERE g.id = v_id AND target->>'metric' = 'calories_kcal'
    ) THEN
        RAISE EXCEPTION 'Only a calorie-bearing goal can be primary'
            USING ERRCODE = 'PT409', HINT = 'primary_requires_calories';
    END IF;

    UPDATE public.goals SET is_primary = false, updated_at = now()
     WHERE user_id = p_user_id AND is_active AND is_primary;
    UPDATE public.goals SET is_primary = true, updated_at = now() WHERE id = v_id;
    RETURN QUERY SELECT * FROM public.goals WHERE id = v_id;
END;
$$;

-- Keep old application instances safe during a rolling deployment. These
-- compatibility signatures adopt multi-goal semantics instead of deactivating
-- every existing goal.
CREATE OR REPLACE FUNCTION public.fn_create_goal(
    p_user_id uuid, p_kind goal_kind, p_spec jsonb,
    p_starts_on date, p_ends_on date)
RETURNS SETOF public.goals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_targets jsonb;
    v_deriv   jsonb;
    v_id      uuid;
    v_primary boolean;
BEGIN
    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;
    IF p_ends_on < p_starts_on OR p_ends_on - p_starts_on + 1 > 1830 THEN
        RAISE EXCEPTION 'Invalid goal period'
            USING ERRCODE = 'PT409', HINT = 'invalid_goal_dates';
    END IF;
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
    v_primary := EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_targets->'targets') target
         WHERE target->>'metric' = 'calories_kcal')
        AND NOT EXISTS (
            SELECT 1 FROM public.goals
             WHERE user_id = p_user_id AND is_active AND is_primary);
    INSERT INTO public.goals (
        user_id, kind, spec, starts_on, ends_on, daily_targets,
        derivation, status, version, is_active, cadence, is_primary)
    VALUES (
        p_user_id, p_kind, p_spec, p_starts_on, p_ends_on, v_targets,
        v_deriv, 'active', 1, true,
        CASE WHEN p_kind = 'body_weight' THEN 'period'::goal_cadence
             ELSE 'daily'::goal_cadence END,
        v_primary)
    RETURNING id INTO v_id;
    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    SELECT 'goal', goal_id, p_user_id, 'CREATE', to_jsonb(g), p_user_id::text, 'api'
      FROM public.goals g WHERE id = v_id;
    RETURN QUERY SELECT * FROM public.goals WHERE id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_goal_active(
    p_user_id uuid, p_goal_id uuid, p_active boolean)
RETURNS SETOF public.goals
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT * FROM public.fn_set_goal_active_v2(p_user_id, p_goal_id, p_active);
$$;

-- Re-resolve every active profile-dependent logical goal, not an arbitrary row.
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
    v_last_id   uuid;
BEGIN
    SELECT weight_kg INTO v_weight FROM public.body_metrics
     WHERE user_id = p_user_id ORDER BY measured_on DESC, created_at DESC LIMIT 1;

    FOR v_goal IN
        SELECT * FROM public.goals
         WHERE user_id = p_user_id AND is_active AND status = 'active'
           AND (kind IN ('body_weight', 'hydration')
                OR (kind = 'nutrient' AND coalesce(spec->'nutrients', '{}'::jsonb) ? 'protein_g'))
         ORDER BY created_at FOR UPDATE
    LOOP
        v_last_w := (v_goal.derivation->>'weight_kg')::numeric;
        v_days := extract(day FROM now() - v_goal.created_at)::integer;
        IF (v_last_w IS NOT NULL AND v_weight IS NOT NULL AND abs(v_weight - v_last_w) >= 2.0)
           OR v_days >= 14
           OR p_reason IN ('user_edit', 'activity_change', 'profile_change') THEN
            BEGIN
                SELECT r.daily_targets, r.derivation INTO v_targets, v_deriv
                  FROM public.fn_resolve_goal_targets_v2(
                      p_user_id, v_goal.kind, v_goal.spec,
                      v_goal.starts_on, v_goal.ends_on) r;

                UPDATE public.goals SET is_active = false, is_primary = false
                 WHERE id = v_goal.id;
                INSERT INTO public.goals (
                    goal_id, user_id, kind, spec, starts_on, ends_on, daily_targets,
                    derivation, status, version, is_active, cadence, is_primary)
                VALUES (
                    v_goal.goal_id, p_user_id, v_goal.kind, v_goal.spec,
                    v_goal.starts_on, v_goal.ends_on, v_targets,
                    v_deriv || jsonb_build_object('trigger_reason', p_reason),
                    v_goal.status, v_goal.version + 1, true,
                    v_goal.cadence, v_goal.is_primary)
                RETURNING id INTO v_new_id;

                INSERT INTO public.audit_log (
                    entity, entity_id, user_id, action, old_value, new_value, actor, source)
                VALUES (
                    'goal', v_goal.goal_id, p_user_id, 'VERSION',
                    v_goal.daily_targets, v_targets, 'system', 'trigger');
                v_last_id := v_new_id;
            EXCEPTION WHEN OTHERS THEN
                INSERT INTO public.audit_log (
                    entity, entity_id, user_id, action, new_value, actor, source)
                VALUES (
                    'goal', v_goal.goal_id, p_user_id, 'RERESOLVE_FAILED',
                    jsonb_build_object('error', SQLERRM, 'reason', p_reason),
                    'system', 'trigger');
            END;
        END IF;
    END LOOP;
    RETURN v_last_id;
END;
$$;

-- Preserve the individual endpoint while clipping both its denominator and all
-- source queries to the goal's historical date range.
CREATE OR REPLACE FUNCTION public.fn_goal_progress(
    p_goal_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_goal    public.goals%ROWTYPE;
    v_target  jsonb;
    v_out     jsonb := '[]'::jsonb;
    v_from    date;
    v_to      date;
    v_days    integer;
    v_logged  integer;
    v_actual  numeric;
    v_metric  text;
    v_scope   text;
    v_target_to_date numeric;
BEGIN
    SELECT * INTO v_goal FROM public.goals
     WHERE goal_id = p_goal_id AND is_active;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'goal_not_found'); END IF;

    v_from := greatest(p_from, v_goal.starts_on);
    v_to := least(p_to, v_goal.ends_on);
    IF v_to < v_from THEN
        RETURN jsonb_build_object(
            'goal_id', v_goal.goal_id, 'version', v_goal.version,
            'from', v_from, 'to', v_to, 'days_elapsed', 0,
            'days_logged', 0, 'adherence', NULL, 'targets', '[]'::jsonb,
            'unaccounted_items', 0);
    END IF;
    v_days := v_to - v_from + 1;

    SELECT count(DISTINCT meal_date) INTO v_logged
      FROM public.meals
     WHERE user_id = v_goal.user_id AND is_active
       AND meal_date BETWEEN v_from AND v_to;

    FOR v_target IN SELECT * FROM jsonb_array_elements(v_goal.daily_targets->'targets')
    LOOP
        v_metric := v_target->>'metric';
        v_scope := coalesce(v_target->>'scope', 'total');
        IF v_scope = 'dish' THEN
            SELECT coalesce(sum(grams), 0) INTO v_actual FROM public.meals
             WHERE user_id = v_goal.user_id AND is_active
               AND meal_date BETWEEN v_from AND v_to
               AND food_id = (v_target->>'food_id')::uuid;
        ELSIF v_scope = 'activity' THEN
            SELECT count(DISTINCT activity_date) INTO v_actual FROM public.activity_logs
             WHERE user_id = v_goal.user_id AND activity_type = 'training'
               AND activity_date BETWEEN v_from AND v_to;
        ELSIF v_scope = 'count' THEN
            v_actual := v_logged;
        ELSIF v_metric = 'water_ml' THEN
            SELECT coalesce(sum(volume_ml), 0) INTO v_actual FROM public.water_logs
             WHERE user_id = v_goal.user_id AND logged_on BETWEEN v_from AND v_to;
        ELSE
            EXECUTE format(
                'SELECT coalesce(sum((nutrients->>%L)::numeric), 0) FROM public.meals
                  WHERE user_id = $1 AND is_active AND meal_date BETWEEN $2 AND $3',
                v_metric)
            INTO v_actual USING v_goal.user_id, v_from, v_to;
        END IF;
        IF v_scope = 'activity' AND v_goal.cadence = 'period' THEN
            v_target_to_date := (v_target->>'value')::numeric;
        ELSIF v_scope = 'activity' AND v_goal.cadence = 'weekly' THEN
            SELECT coalesce(sum(least(bucket_days, ceil(
                       (v_target->>'value')::numeric * bucket_days / 7.0))), 0)
              INTO v_target_to_date
              FROM (
                  SELECT count(*)::numeric AS bucket_days
                    FROM generate_series(v_from, v_to, interval '1 day') AS series(day)
                   GROUP BY date_trunc('week', day)
              ) buckets;
        ELSIF v_scope = 'activity' AND v_goal.cadence = 'monthly' THEN
            SELECT coalesce(sum(least(bucket_days, ceil(
                       (v_target->>'value')::numeric * bucket_days / month_days))), 0)
              INTO v_target_to_date
              FROM (
                  SELECT count(*)::numeric AS bucket_days,
                         extract(day FROM date_trunc('month', day)
                             + interval '1 month - 1 day')::numeric AS month_days
                    FROM generate_series(v_from, v_to, interval '1 day') AS series(day)
                   GROUP BY date_trunc('month', day)
              ) buckets;
        ELSE
            v_target_to_date := (v_target->>'value')::numeric * v_days;
        END IF;
        v_out := v_out || jsonb_build_object(
            'metric', v_metric, 'scope', v_scope,
            'direction', v_target->>'direction',
            'target_per_day', (v_target->>'value')::numeric,
            'target_to_date', v_target_to_date,
            'actual_to_date', v_actual, 'unit', v_target->>'unit');
    END LOOP;

    RETURN jsonb_build_object(
        'goal_id', v_goal.goal_id, 'version', v_goal.version,
        'cadence', v_goal.cadence,
        'from', v_from, 'to', v_to, 'days_elapsed', v_days,
        'days_logged', v_logged,
        'adherence', round(v_logged::numeric / v_days, 3),
        'targets', v_out,
        'unaccounted_items', (
            SELECT count(*) FROM public.meals
             WHERE user_id = v_goal.user_id AND is_active
               AND meal_date BETWEEN v_from AND v_to AND nutrients = '{}'::jsonb));
END;
$$;

-- PostgreSQL grants new functions to PUBLIC by default.
DO $$
DECLARE v_function regprocedure;
BEGIN
    FOR v_function IN
        SELECT p.oid::regprocedure
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
    END LOOP;
END;
$$;
