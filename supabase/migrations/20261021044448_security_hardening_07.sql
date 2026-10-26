-- Requested change: password-based administrative access without a TOTP challenge.
-- Requires the previous six security migrations. Membership and session checks remain.
CREATE OR REPLACE FUNCTION nova_private.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT nova_private.admin_session_valid()
    AND EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=auth.uid() AND role='admin')
$$;

REVOKE EXECUTE ON FUNCTION nova_private.is_admin() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION nova_private.is_admin() TO authenticated;

NOTIFY pgrst,'reload schema';
