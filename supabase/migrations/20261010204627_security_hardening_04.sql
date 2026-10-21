

CREATE OR REPLACE FUNCTION nova_private.edit_match_group(p_new_number text, p_new_date text, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_entry jsonb;
  v_old public.partidas%rowtype;
  v_new_kills int;
  v_new_pos int;
  v_new_total numeric;
  v_count int := 0;
begin

  perform nova_private.require_admin();
  perform pg_advisory_xact_lock(hashtextextended('nova_match_write',0));
  perform nova_private.validate_match_entries(p_entries,'edit');
  if p_new_number is null or length(btrim(p_new_number)) not between 1 and 80 or p_new_date is null or length(btrim(p_new_date)) not between 1 and 120 then raise exception 'Dados inválidos'; end if;
  if (select count(distinct (m.number,m.date)) from public.partidas m where m.id in (select (e->>'matchId')::uuid from jsonb_array_elements(p_entries) e)) <> 1 then raise exception 'Partidas incompatíveis'; end if;
  if not public.is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    select * into v_old from public.partidas where id = (v_entry->>'matchId')::uuid for update;
    if not found then
      continue;
    end if;

    v_new_kills := (v_entry->>'kills')::int;
    v_new_pos := (v_entry->>'pos')::int;
    v_new_total := (v_entry->>'total')::numeric;

    -- reverte o valor antigo desse jogador
    update public.jogadores
    set kills = greatest(0, kills - v_old.kills),
        earnings = greatest(0, round((earnings - v_old.total)::numeric, 2))
    where id = v_old."playerId";

    -- aplica o valor novo
    update public.jogadores
    set kills = kills + v_new_kills,
        earnings = round((earnings + v_new_total)::numeric, 2)
    where id = v_old."playerId";

    update public.partidas
    set number = p_new_number,
        date = p_new_date,
        kills = v_new_kills,
        pos = v_new_pos,
        total = v_new_total
    where id = v_old.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.edit_match_group(p_new_number text, p_new_date text, p_entries jsonb) RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.edit_match_group(p_new_number,p_new_date,p_entries) $$;


CREATE OR REPLACE FUNCTION nova_private.delete_match_group(p_number text, p_date text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.partidas%rowtype;
  v_count int := 0;
begin

  perform nova_private.require_admin();
  perform pg_advisory_xact_lock(hashtextextended('nova_match_write',0));
  if not public.is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_row in
    select * from public.partidas
    where number = p_number and date IS NOT DISTINCT FROM p_date for update
  loop
    update public.jogadores
    set kills = greatest(0, kills - v_row.kills),
        "matchesCount" = greatest(0, "matchesCount" - 1),
        earnings = greatest(0, round((earnings - v_row.total)::numeric, 2))
    where id = v_row."playerId";

    delete from public.partidas where id = v_row.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_match_group(p_number text, p_date text) RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.delete_match_group(p_number,p_date) $$;


-- Disable all legacy player endpoints, including the IDOR overload.
DROP FUNCTION public.player_login(text);

DROP FUNCTION public.player_session_login(text);

DROP FUNCTION public.player_session_logout(text);

DROP FUNCTION public.get_my_messages(text);

DROP FUNCTION public.mark_message_read(uuid,uuid);

DROP FUNCTION public.mark_message_read(uuid,text);

CREATE FUNCTION public.player_login(p_game_id text) RETURNS TABLE(id uuid,nick text,"gameId" text,status text,kills integer,"matchesCount" integer,earnings numeric,session_token text,error text,"rankingId" uuid) LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.player_login(p_game_id) $$;

CREATE FUNCTION public.player_session_login(p_token text) RETURNS TABLE(id uuid,nick text,"gameId" text,status text,kills integer,"matchesCount" integer,earnings numeric,error text,"rankingId" uuid) LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.player_session_login(p_token) $$;

CREATE FUNCTION public.player_session_logout(p_token text) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.player_session_logout(p_token) $$;

CREATE FUNCTION public.get_my_messages(p_token text) RETURNS TABLE(id uuid,"recipientId" text,text text,date text,"readBy" jsonb,created_at timestamptz) LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.get_my_messages(p_token) $$;

CREATE FUNCTION public.mark_message_read(p_message_id uuid,p_token text) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.mark_message_read(p_message_id,p_token) $$;

CREATE FUNCTION public.get_public_players(p_offset integer DEFAULT 0,p_limit integer DEFAULT 200) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.get_public_players(p_offset,p_limit) $$;

CREATE FUNCTION public.get_public_matches(p_token text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 200) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.get_public_matches(p_token,p_offset,p_limit) $$;


REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,anon,authenticated;

REVOKE SELECT("id","kills","matchesCount","earnings","created_at","is_honra","is_verificado","status","nick","gameId") ON public.jogadores FROM PUBLIC,anon,authenticated;

REVOKE INSERT("id","kills","matchesCount","earnings","created_at","is_honra","is_verificado","status","nick","gameId") ON public.jogadores FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("id","kills","matchesCount","earnings","created_at","is_honra","is_verificado","status","nick","gameId") ON public.jogadores FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("id","kills","matchesCount","earnings","created_at","is_honra","is_verificado","status","nick","gameId") ON public.jogadores FROM PUBLIC,anon,authenticated;
