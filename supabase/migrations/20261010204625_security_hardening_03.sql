

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
