
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
