-- Generated from supabase/migrations; run as migration owner after backup.
BEGIN;
-- 20261010204621_security_hardening_01.sql
-- Execute only as a migration owner. No player/message content is removed.
CREATE SCHEMA IF NOT EXISTS nova_private;

REVOKE ALL ON SCHEMA nova_private FROM PUBLIC;

GRANT USAGE ON SCHEMA nova_private TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA nova_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


CREATE TABLE nova_private.rate_limits (
  scope text NOT NULL, subject text NOT NULL, window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits BETWEEN 0 AND 1000000), PRIMARY KEY(scope,subject)
);

CREATE TABLE nova_private.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor uuid,
  entity text NOT NULL, entity_id text, operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limits_window_idx ON nova_private.rate_limits(window_start);

ALTER TABLE nova_private.rate_limits ENABLE ROW LEVEL SECURITY;

ALTER TABLE nova_private.audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA nova_private FROM PUBLIC, anon, authenticated;


CREATE FUNCTION nova_private.consume_budget(p_scope text,p_subject text,p_limit integer,p_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_hits integer;
BEGIN
  DELETE FROM nova_private.rate_limits WHERE (scope,subject) IN (
    SELECT r.scope,r.subject FROM nova_private.rate_limits r
    WHERE r.window_start<clock_timestamp()-interval '2 days' LIMIT 128
  );
  INSERT INTO nova_private.rate_limits(scope,subject,window_start,hits)
  VALUES(p_scope,p_subject,clock_timestamp(),1)
  ON CONFLICT(scope,subject) DO UPDATE
  SET hits=CASE WHEN nova_private.rate_limits.window_start < clock_timestamp()-make_interval(secs=>p_seconds)
       THEN 1 ELSE LEAST(nova_private.rate_limits.hits+1,p_limit+1) END,
      window_start=CASE WHEN nova_private.rate_limits.window_start < clock_timestamp()-make_interval(secs=>p_seconds)
       THEN clock_timestamp() ELSE nova_private.rate_limits.window_start END
  RETURNING hits INTO v_hits;
  RETURN v_hits<=p_limit;
END $$;


CREATE FUNCTION nova_private.admin_session_valid()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM auth.sessions s
    WHERE s.user_id=auth.uid() AND s.id::text=auth.jwt()->>'session_id'
      AND (s.not_after IS NULL OR s.not_after>now()) AND s.created_at>now()-interval '8 hours')
$$;

CREATE FUNCTION nova_private.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT nova_private.admin_session_valid() AND auth.jwt()->>'aal'='aal2'
    AND EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=auth.uid() AND role='admin')
$$;

CREATE FUNCTION nova_private.require_admin()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
  IF NOT nova_private.consume_budget('admin_write',auth.uid()::text,5000,60) THEN
    RAISE EXCEPTION 'Limite de operações atingido' USING ERRCODE='P0001';
  END IF;
END $$;


ALTER TABLE public.player_sessions ADD COLUMN absolute_expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 days');

-- Old bearer tokens cannot be used after this hardening deployment.

CREATE FUNCTION nova_private.token_player(p_token text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT s.player_id FROM public.player_sessions s
  JOIN public.jogadores j ON j.id=s.player_id
  WHERE p_token ~ '^[a-f0-9]{64}$'
    AND s.token=encode(extensions.digest(p_token,'sha256'),'hex')
    AND s.expires_at>now() AND s.absolute_expires_at>now() AND j.status<>'banned'
$$;

CREATE FUNCTION nova_private.player_login(p_game_id text)
RETURNS TABLE(id uuid,nick text,"gameId" text,status text,kills integer,"matchesCount" integer,earnings numeric,session_token text,error text,"rankingId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.jogadores%ROWTYPE; v_token text; v_key text; v_allowed boolean;
BEGIN
  -- Persistent endpoint budget: requests for random IDs cannot create unlimited keys.
  IF NOT nova_private.consume_budget('login_global','endpoint',600,60) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,NULL::text,'Aguarde antes de tentar novamente.'::text,NULL::uuid; RETURN;
  END IF;
  IF p_game_id IS NULL OR p_game_id !~ '^[0-9]{3,20}$' THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,NULL::text,'Não foi possível acessar. Confira seu ID ou fale com a organização.'::text,NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v FROM public.jogadores j WHERE j."gameId"=p_game_id AND j.status<>'banned';
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,NULL::text,'Não foi possível acessar. Confira seu ID ou fale com a organização.'::text,NULL::uuid; RETURN;
  END IF;
  v_key=encode(extensions.digest(p_game_id,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
  v_allowed=nova_private.consume_budget('player_login_minute',v_key,5,60);
  v_allowed=nova_private.consume_budget('player_login_hour',v_key,30,3600) AND v_allowed;
  IF NOT v_allowed THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,NULL::text,'Aguarde antes de tentar novamente.'::text,NULL::uuid; RETURN;
  END IF;
  DELETE FROM public.player_sessions s WHERE s.player_id=v.id AND (s.expires_at<=now() OR s.absolute_expires_at<=now());
  IF (SELECT count(*) FROM public.player_sessions s WHERE s.player_id=v.id)>=20 THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,NULL::text,'Limite de sessões atingido. Fale com a organização.'::text,NULL::uuid; RETURN;
  END IF;
  v_token=encode(extensions.gen_random_bytes(32),'hex');
  INSERT INTO public.player_sessions(token,player_id,expires_at,absolute_expires_at)
  VALUES(encode(extensions.digest(v_token,'sha256'),'hex'),v.id,now()+interval '7 days',now()+interval '30 days');
  RETURN QUERY SELECT v.id,v.nick,v."gameId",v.status,v.kills,v."matchesCount",v.earnings,v_token,NULL::text,md5('ranking:'||v.id::text)::uuid;
END $$;


-- 20261010204623_security_hardening_02.sql

CREATE FUNCTION nova_private.player_session_login(p_token text)
RETURNS TABLE(id uuid,nick text,"gameId" text,status text,kills integer,"matchesCount" integer,earnings numeric,error text,"rankingId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  v_id=nova_private.token_player(p_token);
  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,'Sessão inválida ou expirada.'::text,NULL::uuid; RETURN;
  END IF;
  IF NOT nova_private.consume_budget('session_read',encode(extensions.digest(p_token,'sha256'),'hex'),120,60) THEN
    RETURN QUERY SELECT NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::numeric,'Aguarde antes de atualizar.'::text,NULL::uuid; RETURN;
  END IF;
  UPDATE public.player_sessions s SET expires_at=LEAST(now()+interval '7 days',s.absolute_expires_at)
  WHERE s.token=encode(extensions.digest(p_token,'sha256'),'hex') AND s.expires_at<now()+interval '6 days';
  RETURN QUERY SELECT j.id,j.nick,j."gameId",j.status,j.kills,j."matchesCount",j.earnings,NULL::text,md5('ranking:'||j.id::text)::uuid FROM public.jogadores j WHERE j.id=v_id;
END $$;

CREATE FUNCTION nova_private.player_session_logout(p_token text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  DELETE FROM public.player_sessions WHERE p_token ~ '^[a-f0-9]{64}$' AND token=encode(extensions.digest(p_token,'sha256'),'hex')
$$;

CREATE FUNCTION nova_private.get_my_messages(p_token text)
RETURNS TABLE(id uuid,"recipientId" text,text text,date text,"readBy" jsonb,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  v_id=nova_private.token_player(p_token);
  IF v_id IS NULL THEN RETURN; END IF;
  IF NOT nova_private.consume_budget('messages_read',v_id::text,120,60) THEN RAISE EXCEPTION 'Aguarde antes de atualizar.'; END IF;
  RETURN QUERY SELECT m.id,m."recipientId",m.text,m.date,
    CASE WHEN m."readBy" @> to_jsonb(v_id::text) THEN jsonb_build_array(v_id::text) ELSE '[]'::jsonb END,m.created_at
  FROM public.mensagens m WHERE m."recipientId" IN ('all',v_id::text) ORDER BY m.created_at DESC LIMIT 500;
END $$;

CREATE FUNCTION nova_private.mark_message_read(p_message_id uuid,p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_count integer;
BEGIN
  v_id=nova_private.token_player(p_token);
  IF v_id IS NULL OR NOT nova_private.consume_budget('messages_write',COALESCE(v_id::text,'invalid'),60,60) THEN RETURN false; END IF;
  UPDATE public.mensagens m SET "readBy"=m."readBy" || jsonb_build_array(v_id::text)
  WHERE m.id=p_message_id AND m."recipientId" IN ('all',v_id::text) AND NOT m."readBy" @> to_jsonb(v_id::text);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1 OR EXISTS(SELECT 1 FROM public.mensagens m WHERE m.id=p_message_id AND m."recipientId" IN ('all',v_id::text));
END $$;

CREATE FUNCTION nova_private.get_public_players(p_offset integer,p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (
    SELECT md5('ranking:'||j.id::text)::uuid AS id,j.nick,
      left(j."gameId",4)||repeat('*',greatest(0,length(j."gameId")-4)) AS "gameId",
      j.kills,j."matchesCount",j.earnings,j.is_honra,j.is_verificado
    FROM public.jogadores j WHERE j.status<>'banned' ORDER BY j.kills DESC,j.created_at,j.id
    LIMIT LEAST(greatest(p_limit,1),200) OFFSET LEAST(greatest(p_offset,0),100000)
  ) p
$$;

CREATE FUNCTION nova_private.get_public_matches(p_token text,p_offset integer,p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (
    SELECT md5('match:'||m.id::text)::uuid AS id,m.number,m.date,m."playerNick",m.kills,m.pos,m.total,m.created_at,
      md5('ranking:'||m."playerId"::text)::uuid AS "playerId",
      CASE WHEN m."playerId"=nova_private.token_player(p_token) THEN m."playerGameId"
        ELSE left(m."playerGameId",4)||repeat('*',greatest(0,length(m."playerGameId")-4)) END AS "playerGameId"
    FROM public.partidas m ORDER BY m.created_at DESC,m.id
    LIMIT LEAST(greatest(p_limit,1),200) OFFSET LEAST(greatest(p_offset,0),100000)
  ) p
$$;


CREATE FUNCTION nova_private.validate_match_entries(p_entries jsonb,p_mode text)
RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE e jsonb; k text; seen text[]='{}';
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    IF jsonb_typeof(e)<>'object' OR NOT (e ?& ARRAY['kills','pos']) THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
    k=CASE p_mode WHEN 'bulk' THEN e->>'gameId' WHEN 'edit' THEN e->>'matchId' ELSE e->>'playerId' END;
    IF k IS NULL OR k=ANY(seen) THEN RAISE EXCEPTION 'Participante repetido ou inválido'; END IF;
    seen=array_append(seen,k);
    IF (p_mode='bulk' AND k !~ '^[0-9]{3,20}$') OR (p_mode<>'bulk' AND k !~ '^[a-fA-F0-9-]{36}$') THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
    IF jsonb_typeof(e->'kills')<>'number' OR (e->>'kills') !~ '^[0-9]+$' OR (e->>'kills')::numeric NOT BETWEEN 0 AND 10000
      OR jsonb_typeof(e->'pos')<>'number' OR (e->>'pos') !~ '^[0-9]+$' OR (e->>'pos')::numeric NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
    IF p_mode='add' THEN
      IF NOT (e ?& ARRAY['killValue','bonus']) OR jsonb_typeof(e->'killValue')<>'number' OR jsonb_typeof(e->'bonus')<>'number' OR (e->>'killValue')::numeric NOT BETWEEN 0 AND 100000 OR (e->>'bonus')::numeric NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.jogadores WHERE id=k::uuid AND status<>'banned') THEN RAISE EXCEPTION 'Participante inválido'; END IF;
    ELSIF p_mode='edit' THEN
      IF NOT (e ? 'total') OR jsonb_typeof(e->'total')<>'number' OR (e->>'total')::numeric NOT BETWEEN 0 AND 1000000000 OR NOT EXISTS(SELECT 1 FROM public.partidas WHERE id=k::uuid) THEN RAISE EXCEPTION 'Dados inválidos'; END IF;
    END IF;
  END LOOP;
END $$;


-- 20261010204625_security_hardening_03.sql


CREATE FUNCTION nova_private.validate_admin_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Player acknowledgements only change readBy, through the token-checked RPC.
  IF TG_TABLE_NAME='mensagens' AND TG_OP='UPDATE' AND (to_jsonb(NEW)-'readBy')=(to_jsonb(OLD)-'readBy') THEN RETURN NEW; END IF;
  IF auth.role() IN ('anon','authenticated') THEN PERFORM nova_private.require_admin(); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='mensagens' THEN
    IF NEW."recipientId"<>'all' AND NOT EXISTS(SELECT 1 FROM public.jogadores WHERE id::text=NEW."recipientId") THEN RAISE EXCEPTION 'Destinatário inválido'; END IF;
  END IF;
  IF TG_TABLE_NAME='partidas' THEN
    IF TG_OP='INSERT' OR ROW(NEW.number,NEW.date,NEW."playerId") IS DISTINCT FROM ROW(OLD.number,OLD.date,OLD."playerId") THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('nova_match_write',0));
      IF EXISTS(SELECT 1 FROM public.partidas m WHERE m.number=NEW.number AND m.date IS NOT DISTINCT FROM NEW.date AND m."playerId"=NEW."playerId" AND m.id<>NEW.id) THEN RAISE EXCEPTION 'Resultado já registrado'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION nova_private.audit_admin_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO nova_private.audit_log(actor,entity,entity_id,operation)
  VALUES(auth.uid(),TG_TABLE_NAME,COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id'),TG_OP);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.is_admin() $$;


CREATE OR REPLACE FUNCTION nova_private.add_match_with_players(p_match_number text, p_match_date text, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_entry jsonb;
  v_total numeric;
  v_count int := 0;
begin

  perform nova_private.require_admin();
  perform pg_advisory_xact_lock(hashtextextended('nova_match_write',0));
  perform nova_private.validate_match_entries(p_entries,'add');
  if p_match_number is null or length(btrim(p_match_number)) not between 1 and 80 or p_match_date is null or length(btrim(p_match_date)) not between 1 and 120 then raise exception 'Dados inválidos'; end if;
  if not public.is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    v_total := round((((v_entry->>'kills')::int * (v_entry->>'killValue')::numeric) + (v_entry->>'bonus')::numeric)::numeric,2);

    insert into public.partidas (number, "playerId", "playerGameId", "playerNick", date, kills, pos, total)
    select p_match_number, j.id, j."gameId", j.nick, p_match_date,
           (v_entry->>'kills')::int, (v_entry->>'pos')::int, v_total
    from public.jogadores j where j.id = (v_entry->>'playerId')::uuid;

    update public.jogadores
    set kills = kills + (v_entry->>'kills')::int,
        "matchesCount" = "matchesCount" + 1,
        earnings = earnings + v_total
    where id = (v_entry->>'playerId')::uuid;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.add_match_with_players(p_match_number text, p_match_date text, p_entries jsonb) RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.add_match_with_players(p_match_number,p_match_date,p_entries) $$;


CREATE OR REPLACE FUNCTION nova_private.bulk_import_matches(p_match_number text, p_match_date text, p_kill_value numeric, p_top1_value numeric, p_top2_value numeric, p_entries jsonb)
 RETURNS TABLE(imported_count integer, not_found jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_entry jsonb;
  v_player public.jogadores%rowtype;
  v_bonus numeric;
  v_total numeric;
  v_imported int := 0;
  v_not_found jsonb := '[]'::jsonb;
begin

  perform nova_private.require_admin();
  perform pg_advisory_xact_lock(hashtextextended('nova_match_write',0));
  perform nova_private.validate_match_entries(p_entries,'bulk');
  if p_match_number is null or length(btrim(p_match_number)) not between 1 and 80 or p_match_date is null or length(btrim(p_match_date)) not between 1 and 120 then raise exception 'Dados inválidos'; end if;
  if p_kill_value is null or p_top1_value is null or p_top2_value is null or p_kill_value not between 0 and 100000 or p_top1_value not between 0 and 100000 or p_top2_value not between 0 and 100000 then raise exception 'Dados inválidos'; end if;
  if not public.is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    select * into v_player from public.jogadores where "gameId" = (v_entry->>'gameId') and status<>'banned';

    if not found then
      v_not_found := v_not_found || jsonb_build_array(v_entry->>'gameId');
      continue;
    end if;

    v_bonus := 0;
    if (v_entry->>'pos')::int = 1 then v_bonus := p_top1_value;
    elsif (v_entry->>'pos')::int = 2 then v_bonus := p_top2_value;
    end if;

    v_total := round((((v_entry->>'kills')::int * p_kill_value) + v_bonus)::numeric,2);

    insert into public.partidas (number, "playerId", "playerGameId", "playerNick", date, kills, pos, total)
    values (p_match_number, v_player.id, v_player."gameId", v_player.nick, p_match_date,
            (v_entry->>'kills')::int, (v_entry->>'pos')::int, v_total);

    update public.jogadores
    set kills = kills + (v_entry->>'kills')::int,
        "matchesCount" = "matchesCount" + 1,
        earnings = earnings + v_total
    where id = v_player.id;

    v_imported := v_imported + 1;
  end loop;

  return query select v_imported, v_not_found;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.bulk_import_matches(p_match_number text, p_match_date text, p_kill_value numeric, p_top1_value numeric, p_top2_value numeric, p_entries jsonb) RETURNS TABLE(imported_count integer, not_found jsonb) LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM nova_private.bulk_import_matches(p_match_number,p_match_date,p_kill_value,p_top1_value,p_top2_value,p_entries) $$;


-- 20261010204627_security_hardening_04.sql


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


-- 20261010204629_security_hardening_05.sql

REVOKE SELECT("id","playerId","kills","pos","total","created_at","playerNick","date","number","playerGameId") ON public.partidas FROM PUBLIC,anon,authenticated;

REVOKE INSERT("id","playerId","kills","pos","total","created_at","playerNick","date","number","playerGameId") ON public.partidas FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("id","playerId","kills","pos","total","created_at","playerNick","date","number","playerGameId") ON public.partidas FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("id","playerId","kills","pos","total","created_at","playerNick","date","number","playerGameId") ON public.partidas FROM PUBLIC,anon,authenticated;

REVOKE SELECT("created_at","id","readBy","text","date","recipientId") ON public.mensagens FROM PUBLIC,anon,authenticated;

REVOKE INSERT("created_at","id","readBy","text","date","recipientId") ON public.mensagens FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("created_at","id","readBy","text","date","recipientId") ON public.mensagens FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("created_at","id","readBy","text","date","recipientId") ON public.mensagens FROM PUBLIC,anon,authenticated;

REVOKE SELECT("id","created_at","discount","valid","code") ON public.cupons FROM PUBLIC,anon,authenticated;

REVOKE INSERT("id","created_at","discount","valid","code") ON public.cupons FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("id","created_at","discount","valid","code") ON public.cupons FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("id","created_at","discount","valid","code") ON public.cupons FROM PUBLIC,anon,authenticated;

REVOKE SELECT("user_id","created_at","role") ON public.admin_users FROM PUBLIC,anon,authenticated;

REVOKE INSERT("user_id","created_at","role") ON public.admin_users FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("user_id","created_at","role") ON public.admin_users FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("user_id","created_at","role") ON public.admin_users FROM PUBLIC,anon,authenticated;

REVOKE SELECT("player_id","expires_at","created_at","token") ON public.player_sessions FROM PUBLIC,anon,authenticated;

REVOKE INSERT("player_id","expires_at","created_at","token") ON public.player_sessions FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("player_id","expires_at","created_at","token") ON public.player_sessions FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("player_id","expires_at","created_at","token") ON public.player_sessions FROM PUBLIC,anon,authenticated;

REVOKE SELECT("id","kills","matchesCount","earnings","is_honra","is_verificado","nick","gameId","status") ON public.public_jogadores FROM PUBLIC,anon,authenticated;

REVOKE INSERT("id","kills","matchesCount","earnings","is_honra","is_verificado","nick","gameId","status") ON public.public_jogadores FROM PUBLIC,anon,authenticated;

REVOKE UPDATE("id","kills","matchesCount","earnings","is_honra","is_verificado","nick","gameId","status") ON public.public_jogadores FROM PUBLIC,anon,authenticated;

REVOKE REFERENCES("id","kills","matchesCount","earnings","is_honra","is_verificado","nick","gameId","status") ON public.public_jogadores FROM PUBLIC,anon,authenticated;

DROP POLICY IF EXISTS "public read jogadores" ON public.jogadores;

DROP POLICY IF EXISTS "sem acesso direto" ON public.player_sessions;

DROP POLICY IF EXISTS "admin full access jogadores" ON public.jogadores;

DROP POLICY IF EXISTS "public read partidas" ON public.partidas;

DROP POLICY IF EXISTS "admin write partidas" ON public.partidas;

DROP POLICY IF EXISTS "public read cupons" ON public.cupons;

DROP POLICY IF EXISTS "admin write cupons" ON public.cupons;

DROP POLICY IF EXISTS "public read mensagens" ON public.mensagens;

DROP POLICY IF EXISTS "admin write mensagens" ON public.mensagens;

DROP POLICY IF EXISTS "admin read admin_users" ON public.admin_users;

GRANT SELECT,INSERT,UPDATE,DELETE ON public.jogadores,public.partidas,public.mensagens,public.cupons TO authenticated;

GRANT SELECT ON public.admin_users TO authenticated;

GRANT SELECT ON public.cupons TO anon;

CREATE POLICY admin_membership_read ON public.admin_users FOR SELECT TO authenticated USING(user_id=(select auth.uid()) AND nova_private.admin_session_valid());

CREATE POLICY admin_players ON public.jogadores FOR ALL TO authenticated USING((select public.is_admin())) WITH CHECK((select public.is_admin()));

CREATE POLICY admin_matches ON public.partidas FOR ALL TO authenticated USING((select public.is_admin())) WITH CHECK((select public.is_admin()));

CREATE POLICY admin_messages ON public.mensagens FOR ALL TO authenticated USING((select public.is_admin())) WITH CHECK((select public.is_admin()));

CREATE POLICY admin_coupons ON public.cupons FOR ALL TO authenticated USING((select public.is_admin())) WITH CHECK((select public.is_admin()));

CREATE POLICY public_coupons ON public.cupons FOR SELECT TO anon,authenticated USING(true);

CREATE POLICY no_direct_player_sessions ON public.player_sessions FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

ALTER TABLE public.jogadores ADD CONSTRAINT player_input_valid CHECK(length(btrim(nick)) BETWEEN 1 AND 80 AND "gameId" ~ '^[0-9]{3,20}$' AND kills BETWEEN 0 AND 1000000000 AND "matchesCount" BETWEEN 0 AND 1000000000 AND earnings BETWEEN 0 AND 1000000000000 AND status IN ('normal','warning1','warning2','banned')) NOT VALID;

ALTER TABLE public.partidas ADD CONSTRAINT match_input_valid CHECK(length(btrim(number)) BETWEEN 1 AND 80 AND length("playerNick") BETWEEN 1 AND 80 AND "playerGameId" ~ '^[0-9]{3,20}$' AND kills BETWEEN 0 AND 10000 AND pos BETWEEN 1 AND 100000 AND total BETWEEN 0 AND 1000000000 AND (date IS NULL OR length(date)<=120)) NOT VALID;

ALTER TABLE public.cupons ADD CONSTRAINT coupon_input_valid CHECK(code ~ '^[A-Za-z0-9_-]{1,40}$' AND length(btrim(discount)) BETWEEN 1 AND 160 AND (valid IS NULL OR length(valid)<=80)) NOT VALID;

ALTER TABLE public.mensagens ADD CONSTRAINT message_input_valid CHECK(length(btrim(text)) BETWEEN 1 AND 4000 AND (date IS NULL OR length(date)<=120) AND jsonb_typeof("readBy")='array' AND ("recipientId"='all' OR "recipientId" ~ '^[a-fA-F0-9-]{36}$')) NOT VALID;

ALTER TABLE public.jogadores VALIDATE CONSTRAINT player_input_valid;

ALTER TABLE public.partidas VALIDATE CONSTRAINT match_input_valid;

ALTER TABLE public.cupons VALIDATE CONSTRAINT coupon_input_valid;

ALTER TABLE public.mensagens VALIDATE CONSTRAINT message_input_valid;

CREATE INDEX IF NOT EXISTS partidas_player_created_idx ON public.partidas("playerId",created_at DESC);

CREATE INDEX IF NOT EXISTS partidas_group_idx ON public.partidas(number,date);

CREATE INDEX IF NOT EXISTS mensagens_recipient_created_idx ON public.mensagens("recipientId",created_at DESC);


-- 20261010204631_security_hardening_06.sql

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

COMMIT;
