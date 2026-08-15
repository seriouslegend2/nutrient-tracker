-- Row Level Security.
--
-- IMPORTANT, and stated so nobody mistakes it for the primary control:
-- the backend runs as service_role, which BYPASSES RLS. So RLS protects a
-- direct-to-Postgres attempt, not an API bug. The primary control is the
-- repository layer scoping every query by the acting user context supplied by
-- a caller authenticated with the shared backend bearer.
--
-- Pattern is KookarCore's 3-policy shape: service_role full, admin read-all,
-- own-rows read. Every CREATE POLICY is preceded by DROP POLICY IF EXISTS,
-- which is a CI-enforced rule there and a good one.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles
         WHERE user_id = auth.uid() AND role = 'admin'
    );
$$;
COMMENT ON FUNCTION public.is_admin IS
  'Reads user_roles, NEVER auth.jwt() metadata - a user can edit their own
   user_metadata, so a role stored there is self-assignable.';

DO $$
DECLARE
    t text;
    owned text[] := ARRAY[
        'app_users','user_profiles','body_metrics','user_preferences',
        'meals','goals','water_logs','communication_master',
        'dish_household','category_household','agent_runs'
    ];
BEGIN
    FOREACH t IN ARRAY owned LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY service_role_full_access ON public.%I
                 FOR ALL TO service_role USING (true) WITH CHECK (true)', t);

        EXECUTE format('DROP POLICY IF EXISTS admin_read_all ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY admin_read_all ON public.%I
                 FOR SELECT TO authenticated USING (public.is_admin())', t);

        IF t = 'app_users' THEN
            EXECUTE 'DROP POLICY IF EXISTS own_rows ON public.app_users';
            EXECUTE 'CREATE POLICY own_rows ON public.app_users
                         FOR SELECT TO authenticated USING (id = auth.uid())';
        ELSE
            EXECUTE format('DROP POLICY IF EXISTS own_rows ON public.%I', t);
            EXECUTE format(
                'CREATE POLICY own_rows ON public.%I
                     FOR SELECT TO authenticated USING (user_id = auth.uid())', t);
        END IF;
    END LOOP;
END $$;

-- Reference data: readable by any signed-in user, writable only by service_role.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['dish_global','category_global'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY service_role_full_access ON public.%I
                 FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
        EXECUTE format('DROP POLICY IF EXISTS read_active ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY read_active ON public.%I
                 FOR SELECT TO authenticated USING (is_active)', t);
    END LOOP;
END $$;

-- user_roles: readable by the owner and admins, writable ONLY by service_role.
-- This is the privilege boundary, so it gets no authenticated write policy.
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.user_roles;
CREATE POLICY service_role_full_access ON public.user_roles
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS own_roles ON public.user_roles;
CREATE POLICY own_roles ON public.user_roles
    FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

-- audit_log: admins read, service_role writes. Never client-writable.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.audit_log;
CREATE POLICY service_role_full_access ON public.audit_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS admin_read_audit ON public.audit_log;
CREATE POLICY admin_read_audit ON public.audit_log
    FOR SELECT TO authenticated USING (public.is_admin());
