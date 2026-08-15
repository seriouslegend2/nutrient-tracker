-- Keep application identities synchronized with Supabase Auth. FastAPI still
-- owns all application data access through its service-role client.
CREATE OR REPLACE FUNCTION public.handle_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.app_users (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name')
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        updated_at = now();

    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'customer'::public.app_role)
    ON CONFLICT (user_id, role) DO NOTHING;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_auth_user_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS app_user_after_auth_insert ON auth.users;
CREATE TRIGGER app_user_after_auth_insert
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_created();

INSERT INTO public.app_users (id, email, display_name)
SELECT id, email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name')
FROM auth.users
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = now();

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'customer'::public.app_role FROM auth.users
ON CONFLICT (user_id, role) DO NOTHING;
