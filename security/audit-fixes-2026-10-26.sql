-- Incremental audit fixes: use only after security migrations 01 through 07.
-- Publish the updated frontend first; it is compatible with both database versions.
BEGIN;
-- Incremental audit fixes. Requires security migrations 01 through 07.
-- No existing results, balances, accounts or sessions are modified.

-- All match mutations must use the atomic, admin-authorized RPCs. Browser
-- clients cannot manufacture initial balances or edit aggregate fields.
REVOKE INSERT,UPDATE,DELETE ON public.partidas FROM anon,authenticated;
REVOKE INSERT(id,number,"playerId","playerGameId","playerNick",date,kills,pos,total,created_at),
  UPDATE(id,number,"playerId","playerGameId","playerNick",date,kills,pos,total,created_at)
  ON public.partidas FROM anon,authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.jogadores FROM anon,authenticated;
REVOKE INSERT(id,nick,"gameId",status,kills,"matchesCount",earnings,is_honra,is_verificado,created_at),
  UPDATE(id,nick,"gameId",status,kills,"matchesCount",earnings,is_honra,is_verificado,created_at)
  ON public.jogadores FROM anon,authenticated;
GRANT INSERT(nick,"gameId"),UPDATE(nick,status,is_honra,is_verificado) ON public.jogadores TO authenticated;

CREATE OR REPLACE FUNCTION nova_private.get_public_players(p_offset integer,p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (
    SELECT md5('ranking:'||j.id::text)::uuid AS id,j.nick,
      CASE WHEN length(j."gameId")<=4 THEN repeat('*',length(j."gameId"))
        ELSE left(j."gameId",4)||repeat('*',length(j."gameId")-4) END AS "gameId",
      j.kills,j."matchesCount",j.earnings,j.is_honra,j.is_verificado
    FROM public.jogadores j WHERE j.status<>'banned' ORDER BY j.kills DESC,j.created_at,j.id
    LIMIT LEAST(greatest(p_limit,1),200) OFFSET LEAST(greatest(p_offset,0),100000)
  ) p
$$;

CREATE OR REPLACE FUNCTION nova_private.get_public_matches(p_token text,p_offset integer,p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM (
    SELECT md5('match:'||m.id::text)::uuid AS id,m.number,m.date,m."playerNick",m.kills,m.pos,m.total,m.created_at,
      md5('ranking:'||m."playerId"::text)::uuid AS "playerId",
      CASE WHEN m."playerId"=nova_private.token_player(p_token) THEN m."playerGameId"
        WHEN length(m."playerGameId")<=4 THEN repeat('*',length(m."playerGameId"))
        ELSE left(m."playerGameId",4)||repeat('*',length(m."playerGameId")-4) END AS "playerGameId"
    FROM public.partidas m ORDER BY m.created_at DESC,m.id
    LIMIT LEAST(greatest(p_limit,1),200) OFFSET LEAST(greatest(p_offset,0),100000)
  ) p
$$;

NOTIFY pgrst,'reload schema';

COMMIT;
