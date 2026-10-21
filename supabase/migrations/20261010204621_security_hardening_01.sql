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
