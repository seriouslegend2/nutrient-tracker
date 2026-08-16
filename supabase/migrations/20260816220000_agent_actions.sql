-- Durable, user-confirmed agent actions.
--
-- Identity and arguments never change after proposal. Lifecycle mutations are
-- fenced behind service-role RPCs so concurrent confirmations cannot execute
-- the same claim and stale workers cannot complete a reclaimed action.

CREATE TYPE public.agent_action_status AS ENUM (
    'proposed',
    'confirmed',
    'executing',
    'completed',
    'failed',
    'expired',
    'discarded'
);

CREATE TABLE public.agent_actions (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
    action_type                text NOT NULL,
    arguments                  jsonb NOT NULL,
    summary                    text NOT NULL,
    idempotency_key            text NOT NULL,
    status                     public.agent_action_status NOT NULL DEFAULT 'proposed',
    expires_at                 timestamptz NOT NULL,
    confirmed_at               timestamptz,
    execution_started_at       timestamptz,
    execution_lease_expires_at timestamptz,
    execution_token            uuid,
    execution_attempt          integer NOT NULL DEFAULT 0,
    completed_at               timestamptz,
    failed_at                  timestamptz,
    discarded_at               timestamptz,
    result                     jsonb,
    error                      jsonb,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agent_actions_action_type_valid CHECK (
        action_type = btrim(action_type)
        AND action_type ~ '^[a-z][a-z0-9_.-]{0,99}$'
    ),
    CONSTRAINT agent_actions_arguments_object CHECK (jsonb_typeof(arguments) = 'object'),
    CONSTRAINT agent_actions_summary_valid CHECK (
        summary = btrim(summary) AND length(summary) BETWEEN 1 AND 500
    ),
    CONSTRAINT agent_actions_idempotency_key_valid CHECK (
        idempotency_key = btrim(idempotency_key)
        AND length(idempotency_key) BETWEEN 1 AND 200
    ),
    CONSTRAINT agent_actions_expiry_valid CHECK (expires_at > created_at),
    CONSTRAINT agent_actions_attempt_valid CHECK (execution_attempt >= 0),
    CONSTRAINT agent_actions_result_object CHECK (
        result IS NULL OR jsonb_typeof(result) = 'object'
    ),
    CONSTRAINT agent_actions_error_object CHECK (
        error IS NULL OR jsonb_typeof(error) = 'object'
    ),
    CONSTRAINT agent_actions_completed_shape CHECK (
        (status = 'completed') = (completed_at IS NOT NULL)
        AND (status = 'completed') = (result IS NOT NULL)
    ),
    CONSTRAINT agent_actions_failed_shape CHECK (
        (status = 'failed') = (failed_at IS NOT NULL)
        AND (status = 'failed') = (error IS NOT NULL)
    ),
    CONSTRAINT agent_actions_discarded_shape CHECK (
        (status = 'discarded') = (discarded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_agent_actions_user_idempotency
    ON public.agent_actions (user_id, idempotency_key);
CREATE INDEX idx_agent_actions_user_created
    ON public.agent_actions (user_id, created_at DESC, id DESC);
CREATE INDEX idx_agent_actions_expirable
    ON public.agent_actions (expires_at)
    WHERE status IN ('proposed', 'confirmed');
CREATE INDEX idx_agent_actions_reclaimable
    ON public.agent_actions (execution_lease_expires_at)
    WHERE status = 'executing';

CREATE OR REPLACE FUNCTION public.trg_agent_actions_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.action_type IS DISTINCT FROM OLD.action_type
       OR NEW.arguments IS DISTINCT FROM OLD.arguments
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Agent action identity, arguments, and expiry are immutable'
            USING ERRCODE = '22023', HINT = 'agent_action_immutable';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'proposed' AND NEW.status IN ('confirmed', 'expired', 'discarded'))
        OR (OLD.status = 'confirmed' AND NEW.status IN ('executing', 'expired', 'discarded'))
        OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'Invalid agent action transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'PT409', HINT = 'agent_action_transition';
    END IF;

    IF OLD.status IN ('completed', 'failed', 'expired', 'discarded')
       AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminal agent actions are immutable'
            USING ERRCODE = 'PT409', HINT = 'agent_action_terminal';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_actions_guard ON public.agent_actions;
CREATE TRIGGER agent_actions_guard
    BEFORE UPDATE ON public.agent_actions
    FOR EACH ROW EXECUTE FUNCTION public.trg_agent_actions_guard();

CREATE OR REPLACE FUNCTION public.fn_create_agent_action(
    p_user_id uuid,
    p_action_type text,
    p_arguments jsonb,
    p_summary text,
    p_idempotency_key text,
    p_expires_at timestamptz)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
BEGIN
    p_action_type := btrim(p_action_type);
    p_summary := btrim(p_summary);
    p_idempotency_key := btrim(p_idempotency_key);
    IF p_action_type !~ '^[a-z][a-z0-9_.-]{0,99}$' THEN
        RAISE EXCEPTION 'Invalid agent action type' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_arguments) <> 'object' THEN
        RAISE EXCEPTION 'Agent action arguments must be an object' USING ERRCODE = '22023';
    END IF;
    IF length(p_summary) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Invalid agent action summary' USING ERRCODE = '22023';
    END IF;
    IF length(p_idempotency_key) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Invalid agent action idempotency key' USING ERRCODE = '22023';
    END IF;
    IF p_expires_at <= now() THEN
        RAISE EXCEPTION 'Agent action expiry must be in the future' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.agent_actions (
        user_id, action_type, arguments, summary, idempotency_key, expires_at)
    VALUES (
        p_user_id, p_action_type, p_arguments, p_summary, p_idempotency_key, p_expires_at)
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING * INTO v_action;

    IF NOT FOUND THEN
        SELECT * INTO v_action
          FROM public.agent_actions
         WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
         FOR UPDATE;
        IF v_action.action_type IS DISTINCT FROM p_action_type
           OR v_action.arguments IS DISTINCT FROM p_arguments
           OR v_action.summary IS DISTINCT FROM p_summary THEN
            RAISE EXCEPTION 'Idempotency key is already used by another agent action'
                USING ERRCODE = 'PT409', HINT = 'agent_action_idempotency_conflict';
        END IF;
    END IF;

    RETURN NEXT v_action;
END;
$$;

-- Reading through this RPC durably materializes time-based expiry.
CREATE OR REPLACE FUNCTION public.fn_get_agent_action(p_user_id uuid, p_action_id uuid)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
BEGIN
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status IN ('proposed', 'confirmed') AND v_action.expires_at <= now() THEN
        UPDATE public.agent_actions
           SET status = 'expired', updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    ELSIF v_action.status = 'executing'
       AND v_action.execution_lease_expires_at <= now() THEN
        UPDATE public.agent_actions
           SET status = 'failed', failed_at = now(), updated_at = now(),
               execution_lease_expires_at = NULL,
               error = jsonb_build_object(
                   'code', 'EXECUTION_INTERRUPTED',
                   'message', 'The operation was interrupted. Check your records before trying again.')
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    END IF;
    RETURN NEXT v_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_confirm_agent_action(p_user_id uuid, p_action_id uuid)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
BEGIN
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status IN ('proposed', 'confirmed') AND v_action.expires_at <= now() THEN
        UPDATE public.agent_actions
           SET status = 'expired', updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    ELSIF v_action.status = 'proposed' THEN
        UPDATE public.agent_actions
           SET status = 'confirmed', confirmed_at = now(), updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    END IF;
    RETURN NEXT v_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_discard_agent_action(p_user_id uuid, p_action_id uuid)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
BEGIN
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status IN ('proposed', 'confirmed') AND v_action.expires_at <= now() THEN
        UPDATE public.agent_actions
           SET status = 'expired', updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    ELSIF v_action.status IN ('proposed', 'confirmed') THEN
        UPDATE public.agent_actions
           SET status = 'discarded', discarded_at = now(), updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
    END IF;
    RETURN NEXT v_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_claim_agent_action(
    p_user_id uuid, p_action_id uuid, p_lease_seconds integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
    v_token uuid;
BEGIN
    IF p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'Execution lease must be between 1 and 3600 seconds'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status = 'confirmed' AND v_action.expires_at <= now() THEN
        UPDATE public.agent_actions
           SET status = 'expired', updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
        RETURN jsonb_build_object('claimed', false, 'claim_token', NULL, 'action', to_jsonb(v_action));
    END IF;

    IF v_action.status = 'confirmed' THEN
        v_token := gen_random_uuid();
        UPDATE public.agent_actions
           SET status = 'executing',
               execution_token = v_token,
               execution_started_at = now(),
               execution_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
               execution_attempt = execution_attempt + 1,
               updated_at = now()
         WHERE id = v_action.id
         RETURNING * INTO v_action;
        RETURN jsonb_build_object(
            'claimed', true, 'claim_token', v_token, 'action', to_jsonb(v_action));
    END IF;

    RETURN jsonb_build_object('claimed', false, 'claim_token', NULL, 'action', to_jsonb(v_action));
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_complete_agent_action(
    p_user_id uuid, p_action_id uuid, p_execution_token uuid, p_result jsonb)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
    v_result jsonb := coalesce(p_result, '{}'::jsonb);
BEGIN
    IF jsonb_typeof(v_result) <> 'object' THEN
        RAISE EXCEPTION 'Agent action result must be an object' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status = 'completed'
       AND v_action.execution_token = p_execution_token
       AND v_action.result = v_result THEN
        RETURN NEXT v_action;
        RETURN;
    END IF;
    IF v_action.status <> 'executing' OR v_action.execution_token <> p_execution_token THEN
        RAISE EXCEPTION 'Agent action execution claim is stale'
            USING ERRCODE = 'PT409', HINT = 'agent_action_stale_claim';
    END IF;

    UPDATE public.agent_actions
       SET status = 'completed', result = v_result, completed_at = now(),
           execution_lease_expires_at = NULL, updated_at = now()
     WHERE id = v_action.id
     RETURNING * INTO v_action;
    RETURN NEXT v_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_fail_agent_action(
    p_user_id uuid, p_action_id uuid, p_execution_token uuid, p_error jsonb)
RETURNS SETOF public.agent_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_action public.agent_actions%ROWTYPE;
BEGIN
    IF jsonb_typeof(p_error) <> 'object' THEN
        RAISE EXCEPTION 'Agent action error must be an object' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_action
      FROM public.agent_actions
     WHERE id = p_action_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent action not found'
            USING ERRCODE = 'PT404', HINT = 'agent_action_not_found';
    END IF;

    IF v_action.status = 'failed'
       AND v_action.execution_token = p_execution_token
       AND v_action.error = p_error THEN
        RETURN NEXT v_action;
        RETURN;
    END IF;
    IF v_action.status <> 'executing' OR v_action.execution_token <> p_execution_token THEN
        RAISE EXCEPTION 'Agent action execution claim is stale'
            USING ERRCODE = 'PT409', HINT = 'agent_action_stale_claim';
    END IF;

    UPDATE public.agent_actions
       SET status = 'failed', error = p_error, failed_at = now(),
           execution_lease_expires_at = NULL, updated_at = now()
     WHERE id = v_action.id
     RETURNING * INTO v_action;
    RETURN NEXT v_action;
END;
$$;

-- Confirm a reviewed media draft and insert every prepared meal row as one
-- idempotent transaction. The message payload retains the resulting IDs so a
-- lost HTTP response can be replayed without duplicating meals.
CREATE OR REPLACE FUNCTION public.fn_confirm_media_meal_draft(
    p_user_id uuid,
    p_message_id uuid,
    p_meal_date date,
    p_meal_type public.meal_type,
    p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_message public.communication_master%ROWTYPE;
    v_item jsonb;
    v_meal public.meals%ROWTYPE;
    v_meals jsonb := '[]'::jsonb;
    v_ids jsonb := '[]'::jsonb;
    v_version integer;
BEGIN
    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'A media draft requires at least one prepared item'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_message
      FROM public.communication_master
     WHERE id = p_message_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Message not found'
            USING ERRCODE = 'PT404', HINT = 'message_not_found';
    END IF;

    IF v_message.status = 'confirmed'
       AND v_message.payload ? 'confirmation_result' THEN
        RETURN v_message.payload->'confirmation_result';
    END IF;
    IF v_message.status <> 'needs_confirmation' THEN
        RAISE EXCEPTION 'Message is not confirmable'
            USING ERRCODE = 'PT409', HINT = 'message_not_confirmable';
    END IF;

    PERFORM 1 FROM public.app_users WHERE id = p_user_id FOR UPDATE;

    SELECT max(version) INTO v_version
      FROM public.meals
     WHERE user_id = p_user_id AND meal_date = p_meal_date AND is_active;
    IF v_version IS NULL THEN
        SELECT coalesce(max(version) + 1, 1) INTO v_version
          FROM public.meals
         WHERE user_id = p_user_id AND meal_date = p_meal_date;
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        IF coalesce(v_item->>'dish_name', '') = ''
           OR coalesce((v_item->>'portions')::numeric, 0) <= 0
           OR coalesce(v_item->>'portion_unit', '') = '' THEN
            RAISE EXCEPTION 'Prepared media item is invalid' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.meals (
            user_id, meal_date, meal_type, version, is_active,
            dish_name, food_id, category, portions, portion_unit, grams,
            nutrients, resolved_from, confidence, source, note)
        VALUES (
            p_user_id, p_meal_date, p_meal_type, v_version, true,
            v_item->>'dish_name', nullif(v_item->>'food_id', '')::uuid,
            nullif(v_item->>'category', '')::public.food_category,
            (v_item->>'portions')::numeric, v_item->>'portion_unit',
            nullif(v_item->>'grams', '')::numeric,
            coalesce(v_item->'nutrients', '{}'::jsonb),
            (v_item->>'resolved_from')::public.resolved_from,
            nullif(v_item->>'confidence', ''),
            (v_item->>'source')::public.entry_source,
            nullif(v_item->>'note', ''))
        RETURNING * INTO v_meal;
        v_meals := v_meals || jsonb_build_array(to_jsonb(v_meal));
        v_ids := v_ids || jsonb_build_array(v_meal.id);
    END LOOP;

    UPDATE public.communication_master
       SET status = 'confirmed',
           payload = payload || jsonb_build_object(
               'confirmation_result',
               jsonb_build_object('created', jsonb_array_length(v_meals), 'meals', v_meals))
     WHERE id = v_message.id;

    INSERT INTO public.audit_log (
        entity, entity_id, user_id, action, new_value, actor, source)
    VALUES (
        'meal', (v_ids->>0)::uuid, p_user_id, 'CREATE',
        jsonb_build_object(
            'message_id', p_message_id,
            'meal_date', p_meal_date,
            'meal_type', p_meal_type,
            'meal_ids', v_ids,
            'item_count', jsonb_array_length(v_meals)),
        p_user_id::text, 'api');

    RETURN jsonb_build_object('created', jsonb_array_length(v_meals), 'meals', v_meals);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_discard_media_meal_draft(
    p_user_id uuid, p_message_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_status public.message_status;
BEGIN
    SELECT status INTO v_status
      FROM public.communication_master
     WHERE id = p_message_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Message not found'
            USING ERRCODE = 'PT404', HINT = 'message_not_found';
    END IF;
    IF v_status = 'confirmed' THEN
        RAISE EXCEPTION 'This draft has already been logged'
            USING ERRCODE = 'PT409', HINT = 'message_already_confirmed';
    END IF;
    IF v_status = 'needs_confirmation' THEN
        UPDATE public.communication_master
           SET status = 'not_applicable'
         WHERE id = p_message_id;
    END IF;
END;
$$;

ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.agent_actions;
CREATE POLICY service_role_full_access ON public.agent_actions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS admin_read_all ON public.agent_actions;
CREATE POLICY admin_read_all ON public.agent_actions
    FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS own_rows ON public.agent_actions;
CREATE POLICY own_rows ON public.agent_actions
    FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.agent_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.agent_actions TO authenticated;
GRANT ALL ON TABLE public.agent_actions TO service_role;

REVOKE ALL ON FUNCTION public.fn_create_agent_action(uuid, text, jsonb, text, text, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_agent_action(uuid, text, jsonb, text, text, timestamptz)
    TO service_role;
REVOKE ALL ON FUNCTION public.fn_get_agent_action(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_agent_action(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_confirm_agent_action(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_agent_action(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_discard_agent_action(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_discard_agent_action(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_claim_agent_action(uuid, uuid, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_agent_action(uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_agent_action(uuid, uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_agent_action(uuid, uuid, uuid, jsonb)
    TO service_role;
REVOKE ALL ON FUNCTION public.fn_fail_agent_action(uuid, uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_fail_agent_action(uuid, uuid, uuid, jsonb)
    TO service_role;
REVOKE ALL ON FUNCTION public.fn_confirm_media_meal_draft(
    uuid, uuid, date, public.meal_type, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_media_meal_draft(
    uuid, uuid, date, public.meal_type, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_discard_media_meal_draft(uuid, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_discard_media_meal_draft(uuid, uuid) TO service_role;
