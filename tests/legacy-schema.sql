
-- Test-only reconstruction of the legacy schema. Never deploy this fixture.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(auth.jwt()->>'sub','')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(auth.jwt()->>'role','service_role') $$;
GRANT USAGE ON SCHEMA auth,extensions TO anon,authenticated;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz DEFAULT now(),not_after timestamptz);
CREATE TABLE auth.mfa_factors(user_id uuid,status text);
CREATE TABLE public.admin_users(user_id uuid PRIMARY KEY REFERENCES auth.users(id),role text NOT NULL DEFAULT 'admin',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.jogadores(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),nick text NOT NULL,"gameId" text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'normal',kills integer NOT NULL DEFAULT 0,"matchesCount" integer NOT NULL DEFAULT 0,earnings numeric NOT NULL DEFAULT 0,is_honra boolean NOT NULL DEFAULT false,is_verificado boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.partidas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number text NOT NULL,"playerId" uuid REFERENCES public.jogadores(id) ON DELETE SET NULL,"playerGameId" text NOT NULL,"playerNick" text NOT NULL,date text,kills integer NOT NULL DEFAULT 0,pos integer NOT NULL DEFAULT 1,total numeric NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cupons(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL,discount text NOT NULL,valid text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mensagens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"recipientId" text NOT NULL,text text NOT NULL,date text,"readBy" jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.player_sessions(token text PRIMARY KEY,player_id uuid NOT NULL REFERENCES public.jogadores(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE VIEW public.public_jogadores WITH(security_invoker=true) AS SELECT id,nick,"gameId",status,kills,"matchesCount",earnings,is_honra,is_verificado FROM public.jogadores;
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid()
      and (
        (auth.jwt() ->> 'aal') = 'aal2'
        or not exists (
          select 1 from auth.mfa_factors f
          where f.user_id = a.user_id and f.status = 'verified'
        )
      )
  );
$function$
;
CREATE OR REPLACE FUNCTION public.mark_message_read(p_message_id uuid, p_player_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update mensagens
  set "readBy" = "readBy" || to_jsonb(p_player_id::text)
  where id = p_message_id
    and not ("readBy" @> to_jsonb(p_player_id::text));
end;
$function$
;
CREATE OR REPLACE FUNCTION public.add_match_with_players(p_match_number text, p_match_date text, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_entry jsonb;
  v_total numeric;
  v_count int := 0;
begin
  if not is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    v_total := ((v_entry->>'kills')::int * (v_entry->>'killValue')::numeric) + (v_entry->>'bonus')::numeric;

    insert into partidas (number, "playerId", "playerGameId", "playerNick", date, kills, pos, total)
    select p_match_number, j.id, j."gameId", j.nick, p_match_date,
           (v_entry->>'kills')::int, (v_entry->>'pos')::int, v_total
    from jogadores j where j.id = (v_entry->>'playerId')::uuid;

    update jogadores
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
CREATE OR REPLACE FUNCTION public.player_login(p_game_id text)
 RETURNS TABLE(id uuid, nick text, "gameId" text, status text, kills integer, "matchesCount" integer, earnings numeric, session_token text, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v jogadores%rowtype;
  v_new_token text;
begin
  select * into v from jogadores where jogadores."gameId" = btrim(p_game_id);

  if not found then
    return query select null::uuid, null::text, null::text, null::text, null::int, null::int, null::numeric, null::text, 'ID não encontrado. Confira o número ou fale com a organização.'::text;
    return;
  end if;

  -- limpa as sessões vencidas desse jogador (evita acumular lixo)
  delete from player_sessions
  where player_sessions.player_id = v.id and player_sessions.expires_at < now();

  v_new_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into player_sessions (token, player_id, expires_at, created_at)
  values (v_new_token, v.id, now() + interval '7 days', clock_timestamp());

  -- teto de 20 sessões por ID (as mais antigas saem): impede que alguém
  -- fique repetindo o login só pra encher a tabela
  delete from player_sessions
  where player_sessions.player_id = v.id
    and player_sessions.token not in (
      select s.token from player_sessions s
      where s.player_id = v.id
      order by s.created_at desc
      limit 20
    );

  return query select v.id, v.nick, v."gameId", v.status, v.kills, v."matchesCount", v.earnings, v_new_token, null::text;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.player_session_logout(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from player_sessions where player_sessions.token = p_token;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.player_session_login(p_token text)
 RETURNS TABLE(id uuid, nick text, "gameId" text, status text, kills integer, "matchesCount" integer, earnings numeric, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_player_id uuid;
  v_expires timestamptz;
  v jogadores%rowtype;
begin
  if p_token is null or p_token = '' then
    return query select null::uuid, null::text, null::text, null::text, null::int, null::int, null::numeric, 'Sessão inválida.'::text;
    return;
  end if;

  select s.player_id, s.expires_at into v_player_id, v_expires
  from player_sessions s
  where s.token = p_token;

  if not found then
    return query select null::uuid, null::text, null::text, null::text, null::int, null::int, null::numeric, 'Sessão inválida.'::text;
    return;
  end if;

  if v_expires < now() then
    delete from player_sessions where player_sessions.token = p_token;
    return query select null::uuid, null::text, null::text, null::text, null::int, null::int, null::numeric, 'Sessão expirada.'::text;
    return;
  end if;

  select * into v from jogadores where jogadores.id = v_player_id;

  if not found then
    return query select null::uuid, null::text, null::text, null::text, null::int, null::int, null::numeric, 'Sessão inválida.'::text;
    return;
  end if;

  update player_sessions
  set expires_at = now() + interval '7 days'
  where player_sessions.token = p_token;

  return query select v.id, v.nick, v."gameId", v.status, v.kills, v."matchesCount", v.earnings, null::text;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.bulk_import_matches(p_match_number text, p_match_date text, p_kill_value numeric, p_top1_value numeric, p_top2_value numeric, p_entries jsonb)
 RETURNS TABLE(imported_count integer, not_found jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_entry jsonb;
  v_player jogadores%rowtype;
  v_bonus numeric;
  v_total numeric;
  v_imported int := 0;
  v_not_found jsonb := '[]'::jsonb;
begin
  if not is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    select * into v_player from jogadores where "gameId" = (v_entry->>'gameId');

    if not found then
      v_not_found := v_not_found || jsonb_build_array(v_entry->>'gameId');
      continue;
    end if;

    v_bonus := 0;
    if (v_entry->>'pos')::int = 1 then v_bonus := p_top1_value;
    elsif (v_entry->>'pos')::int = 2 then v_bonus := p_top2_value;
    end if;

    v_total := ((v_entry->>'kills')::int * p_kill_value) + v_bonus;

    insert into partidas (number, "playerId", "playerGameId", "playerNick", date, kills, pos, total)
    values (p_match_number, v_player.id, v_player."gameId", v_player.nick, p_match_date,
            (v_entry->>'kills')::int, (v_entry->>'pos')::int, v_total);

    update jogadores
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
CREATE OR REPLACE FUNCTION public.delete_match_group(p_number text, p_date text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_row partidas%rowtype;
  v_count int := 0;
begin
  if not is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_row in
    select * from partidas
    where number = p_number and coalesce(date, 'sem_data') = coalesce(p_date, 'sem_data')
  loop
    update jogadores
    set kills = greatest(0, kills - v_row.kills),
        "matchesCount" = greatest(0, "matchesCount" - 1),
        earnings = greatest(0, round((earnings - v_row.total)::numeric, 2))
    where id = v_row."playerId";

    delete from partidas where id = v_row.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.edit_match_group(p_new_number text, p_new_date text, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_entry jsonb;
  v_old partidas%rowtype;
  v_new_kills int;
  v_new_pos int;
  v_new_total numeric;
  v_count int := 0;
begin
  if not is_admin() then
    raise exception 'Não autorizado';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    select * into v_old from partidas where id = (v_entry->>'matchId')::uuid;
    if not found then
      continue;
    end if;

    v_new_kills := (v_entry->>'kills')::int;
    v_new_pos := (v_entry->>'pos')::int;
    v_new_total := (v_entry->>'total')::numeric;

    -- reverte o valor antigo desse jogador
    update jogadores
    set kills = greatest(0, kills - v_old.kills),
        earnings = greatest(0, round((earnings - v_old.total)::numeric, 2))
    where id = v_old."playerId";

    -- aplica o valor novo
    update jogadores
    set kills = kills + v_new_kills,
        earnings = round((earnings + v_new_total)::numeric, 2)
    where id = v_old."playerId";

    update partidas
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
CREATE OR REPLACE FUNCTION public.get_my_messages(p_token text)
 RETURNS TABLE(id uuid, "recipientId" text, text text, date text, "readBy" jsonb, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.id, m."recipientId", m.text, m.date,
         case when m."readBy" @> to_jsonb(s.player_id::text)
              then jsonb_build_array(s.player_id::text)
              else '[]'::jsonb end,
         m.created_at
  from public.player_sessions s
  join public.mensagens m
    on (m."recipientId" = 'all' or m."recipientId" = s.player_id::text)
  where s.token = p_token and s.expires_at > now()
  order by m.created_at desc;
$function$
;
CREATE OR REPLACE FUNCTION public.mark_message_read(p_message_id uuid, p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_player uuid;
begin
  select s.player_id into v_player
  from public.player_sessions s
  where s.token = p_token and s.expires_at > now();

  if v_player is null then
    return;
  end if;

  update public.mensagens m
  set "readBy" = m."readBy" || to_jsonb(v_player::text)
  where m.id = p_message_id
    and (m."recipientId" = 'all' or m."recipientId" = v_player::text)
    and not (m."readBy" @> to_jsonb(v_player::text));
end;
$function$
;
ALTER TABLE public.jogadores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read jogadores" ON public.jogadores FOR SELECT TO anon,authenticated USING(true);
ALTER TABLE public.player_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sem acesso direto" ON public.player_sessions FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
ALTER TABLE public.jogadores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin full access jogadores" ON public.jogadores FOR ALL TO public USING(is_admin()) WITH CHECK(is_admin());
ALTER TABLE public.partidas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read partidas" ON public.partidas FOR SELECT TO public USING(true);
ALTER TABLE public.partidas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin write partidas" ON public.partidas FOR ALL TO public USING(is_admin()) WITH CHECK(is_admin());
ALTER TABLE public.cupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read cupons" ON public.cupons FOR SELECT TO public USING(true);
ALTER TABLE public.cupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin write cupons" ON public.cupons FOR ALL TO public USING(is_admin()) WITH CHECK(is_admin());
ALTER TABLE public.mensagens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read mensagens" ON public.mensagens FOR SELECT TO public USING(true);
ALTER TABLE public.mensagens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin write mensagens" ON public.mensagens FOR ALL TO public USING(is_admin()) WITH CHECK(is_admin());
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read admin_users" ON public.admin_users FOR SELECT TO public USING(is_admin());
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated;
INSERT INTO public.jogadores(id,nick,"gameId") VALUES('11111111-1111-4111-8111-111111111111','QA One','99999001'),('22222222-2222-4222-8222-222222222222','QA Two','99999002');
INSERT INTO public.mensagens(id,"recipientId",text) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Only One'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','Only Two'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','all','General');

