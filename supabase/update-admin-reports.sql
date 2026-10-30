-- Requires both previous finance migrations. Apply once as owner.
BEGIN;
ALTER TABLE nova_private.finance_entries ADD COLUMN reversed_at timestamptz,
 ADD COLUMN reversed_by uuid, ADD COLUMN reversal_reason text;
ALTER TABLE nova_private.audit_log ADD COLUMN actor_label text, ADD COLUMN details jsonb;

CREATE OR REPLACE FUNCTION nova_private.get_admin_finances()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_p bigint; v_n bigint; v_prize numeric; v_ads numeric; v_gross numeric; v_version int; v_rows jsonb; v_count bigint;
BEGIN
 IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
 SELECT COALESCE(sum("matchesCount"),0),round(COALESCE(sum(earnings),0),2) INTO v_p,v_prize FROM public.jogadores;
 SELECT COALESCE(sum(quantity) FILTER(WHERE kind='non_participant' AND reversed_at IS NULL),0),
 round(COALESCE(sum(amount) FILTER(WHERE kind='advertising' AND reversed_at IS NULL),0),2),count(*) INTO v_n,v_ads,v_count FROM nova_private.finance_entries;
 SELECT version INTO v_version FROM nova_private.finance_settings WHERE id=true;
 SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC,e.id),'[]') INTO v_rows FROM (
 SELECT id,kind,amount::text,quantity,note,created_at,reversed_at,reversal_reason FROM nova_private.finance_entries ORDER BY created_at DESC,id LIMIT 50) e;
 v_gross=round((v_p::numeric+v_n)*6,2);
 RETURN jsonb_build_object('participations',v_p::text,'registration_fee','6.00','non_participants',v_n::text,
 'non_participant_revenue',round(v_n*6.00,2)::text,'accumulated_total',v_gross::text,'payout_total',v_prize::text,
 'advertising_total',v_ads::text,'balance',round(v_gross-v_prize-v_ads,2)::text,'version',v_version,'entries',v_rows,'entries_count',v_count::text);
END $$;

CREATE FUNCTION nova_private.reverse_finance_entry(p_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v nova_private.finance_entries%ROWTYPE;
BEGIN
 PERFORM nova_private.require_admin();
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'Informe um motivo de 3 a 300 caracteres' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM nova_private.finance_entries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado' USING ERRCODE='22023'; END IF;
 IF v.reversed_at IS NULL THEN
 UPDATE nova_private.finance_entries SET reversed_at=now(),reversed_by=auth.uid(),reversal_reason=btrim(p_reason) WHERE id=p_id;
 UPDATE nova_private.finance_settings SET version=version+1,updated_at=now(),updated_by=auth.uid() WHERE id=true;
 INSERT INTO nova_private.audit_log(actor,actor_label,entity,entity_id,operation,details)
 VALUES(auth.uid(),(SELECT to_jsonb(u)->>'email' FROM auth.users u WHERE id=auth.uid()),'finance_entries',p_id::text,'REVERSE',jsonb_build_object('reason',btrim(p_reason)));
 END IF;
 RETURN nova_private.get_admin_finances();
END $$;
CREATE FUNCTION public.reverse_finance_entry(p_id uuid,p_reason text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.reverse_finance_entry(p_id,p_reason) $$;

CREATE OR REPLACE FUNCTION nova_private.audit_admin_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_old jsonb=to_jsonb(OLD); v_new jsonb=to_jsonb(NEW); v_fields jsonb;
BEGIN
 SELECT COALESCE(jsonb_agg(k),'[]') INTO v_fields FROM jsonb_object_keys(COALESCE(v_new,v_old)) k
 WHERE TG_OP<>'UPDATE' OR v_new->k IS DISTINCT FROM v_old->k;
 INSERT INTO nova_private.audit_log(actor,actor_label,entity,entity_id,operation,details)
 VALUES(auth.uid(),(SELECT to_jsonb(u)->>'email' FROM auth.users u WHERE id=auth.uid()),TG_TABLE_NAME,
 COALESCE(v_new->>'id',v_old->>'id'),TG_OP,jsonb_build_object('fields',v_fields,
 'label',CASE WHEN TG_TABLE_NAME='mensagens' THEN 'Comunicado' ELSE COALESCE(v_new->>'nick',v_old->>'nick',v_new->>'number',v_old->>'number',v_new->>'code',v_old->>'code') END));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE FUNCTION nova_private.get_admin_audit(p_before bigint,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
 RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id::bigint DESC),'[]') FROM (
 SELECT a.id::text AS id,a.created_at,a.entity,a.entity_id,a.operation,a.details,
 COALESCE(a.actor_label,to_jsonb(u)->>'email',a.actor::text,'Sistema / acesso de jogador') AS administrator
 FROM nova_private.audit_log a LEFT JOIN auth.users u ON u.id=a.actor
 WHERE p_before IS NULL OR a.id<p_before ORDER BY a.id DESC LIMIT LEAST(GREATEST(p_limit,1),200)) r);
END $$;
CREATE FUNCTION public.get_admin_audit(p_before bigint DEFAULT NULL,p_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.get_admin_audit(p_before,p_limit) $$;

-- Reports use registration timestamps, with inclusive calendar dates in Brazil.
CREATE FUNCTION nova_private.get_admin_report(p_kind text,p_start date,p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows jsonb; v_start timestamptz; v_end timestamptz;
BEGIN
 IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
 IF p_start IS NOT NULL AND p_end IS NOT NULL AND p_start>p_end THEN RAISE EXCEPTION 'Período inválido' USING ERRCODE='22023'; END IF;
 v_start=p_start::timestamp AT TIME ZONE 'America/Sao_Paulo'; v_end=(p_end+1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
 IF p_kind='finance' THEN
 SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]') INTO v_rows FROM (
 SELECT id,created_at,kind,amount::text,quantity,note,actor::text,reversed_at,reversed_by::text,reversal_reason,
 CASE WHEN kind='non_participant' THEN (quantity*6.00)::text END AS registration_revenue,
 CASE WHEN kind='advertising' AND reversed_at IS NULL THEN amount ELSE 0 END::text AS effective_expense,
 CASE WHEN kind='non_participant' AND reversed_at IS NULL THEN quantity*6.00 ELSE 0 END::text AS effective_revenue
 FROM nova_private.finance_entries WHERE (v_start IS NULL OR created_at>=v_start) AND (v_end IS NULL OR created_at<v_end) ORDER BY created_at,id LIMIT 20001) r;
 ELSIF p_kind='results' THEN
 SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]') INTO v_rows FROM (
 SELECT id,created_at,number,date,"playerNick","playerGameId",kills,pos,total::text,'6.00'::text AS registration_revenue FROM public.partidas
 WHERE (v_start IS NULL OR created_at>=v_start) AND (v_end IS NULL OR created_at<v_end) ORDER BY created_at,id LIMIT 20001) r;
 ELSE RAISE EXCEPTION 'Relatório inválido' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(v_rows)>20000 THEN RAISE EXCEPTION 'Escolha um período menor (limite de 20.000 registros)' USING ERRCODE='22023'; END IF;
 RETURN v_rows;
END $$;
CREATE FUNCTION public.get_admin_report(p_kind text,p_start date DEFAULT NULL,p_end date DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.get_admin_report(p_kind,p_start,p_end) $$;

REVOKE EXECUTE ON FUNCTION nova_private.reverse_finance_entry(uuid,text),public.reverse_finance_entry(uuid,text),
 nova_private.get_admin_audit(bigint,integer),public.get_admin_audit(bigint,integer),
 nova_private.get_admin_report(text,date,date),public.get_admin_report(text,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nova_private.reverse_finance_entry(uuid,text),public.reverse_finance_entry(uuid,text),
 nova_private.get_admin_audit(bigint,integer),public.get_admin_audit(bigint,integer),
 nova_private.get_admin_report(text,date,date),public.get_admin_report(text,date,date) TO authenticated;
NOTIFY pgrst,'reload schema';

COMMIT;
