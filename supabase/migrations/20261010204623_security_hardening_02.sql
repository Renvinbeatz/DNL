
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
