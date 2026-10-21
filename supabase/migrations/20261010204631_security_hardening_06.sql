
CREATE TRIGGER validate_secure_write BEFORE INSERT OR UPDATE OR DELETE ON public.jogadores FOR EACH ROW EXECUTE FUNCTION nova_private.validate_admin_row();

CREATE TRIGGER audit_secure_write AFTER INSERT OR UPDATE OR DELETE ON public.jogadores FOR EACH ROW EXECUTE FUNCTION nova_private.audit_admin_row();

CREATE TRIGGER validate_secure_write BEFORE INSERT OR UPDATE OR DELETE ON public.partidas FOR EACH ROW EXECUTE FUNCTION nova_private.validate_admin_row();

CREATE TRIGGER audit_secure_write AFTER INSERT OR UPDATE OR DELETE ON public.partidas FOR EACH ROW EXECUTE FUNCTION nova_private.audit_admin_row();

CREATE TRIGGER validate_secure_write BEFORE INSERT OR UPDATE OR DELETE ON public.cupons FOR EACH ROW EXECUTE FUNCTION nova_private.validate_admin_row();

CREATE TRIGGER audit_secure_write AFTER INSERT OR UPDATE OR DELETE ON public.cupons FOR EACH ROW EXECUTE FUNCTION nova_private.audit_admin_row();

CREATE TRIGGER validate_secure_write BEFORE INSERT OR UPDATE OR DELETE ON public.mensagens FOR EACH ROW EXECUTE FUNCTION nova_private.validate_admin_row();

CREATE TRIGGER audit_secure_write AFTER INSERT OR UPDATE OR DELETE ON public.mensagens FOR EACH ROW EXECUTE FUNCTION nova_private.audit_admin_row();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nova_private FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.is_admin(),nova_private.is_admin(),nova_private.admin_session_valid() TO authenticated;

GRANT EXECUTE ON FUNCTION public.player_login(text),nova_private.player_login(text) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.player_session_login(text),nova_private.player_session_login(text) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.player_session_logout(text),nova_private.player_session_logout(text) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.get_my_messages(text),nova_private.get_my_messages(text) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.mark_message_read(uuid,text),nova_private.mark_message_read(uuid,text) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_players(integer,integer),nova_private.get_public_players(integer,integer) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_matches(text,integer,integer),nova_private.get_public_matches(text,integer,integer) TO anon,authenticated;

GRANT EXECUTE ON FUNCTION public.add_match_with_players(text,text,jsonb),nova_private.add_match_with_players(text,text,jsonb) TO authenticated;

GRANT EXECUTE ON FUNCTION public.bulk_import_matches(text,text,numeric,numeric,numeric,jsonb),nova_private.bulk_import_matches(text,text,numeric,numeric,numeric,jsonb) TO authenticated;

GRANT EXECUTE ON FUNCTION public.edit_match_group(text,text,jsonb),nova_private.edit_match_group(text,text,jsonb) TO authenticated;

GRANT EXECUTE ON FUNCTION public.delete_match_group(text,text),nova_private.delete_match_group(text,text) TO authenticated;

NOTIFY pgrst,'reload schema';


UPDATE public.player_sessions SET expires_at=LEAST(expires_at,now());
