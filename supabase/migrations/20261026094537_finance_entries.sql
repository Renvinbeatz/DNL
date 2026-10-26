-- Incremental update after admin_finances. Preserve the previous ad expense as
-- one opening entry; future income/expenses are append-only ledger entries.
CREATE TABLE nova_private.finance_entries (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('advertising','non_participant')),
  amount numeric(12,2), quantity integer,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=160),
  created_at timestamptz NOT NULL DEFAULT now(), actor uuid,
  CHECK((kind='advertising' AND amount IS NOT NULL AND amount>0 AND amount<=1000000000 AND quantity IS NULL)
    OR (kind='non_participant' AND amount IS NULL AND quantity IS NOT NULL AND quantity BETWEEN 1 AND 1000000))
);
ALTER TABLE nova_private.finance_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nova_private.finance_entries FROM PUBLIC,anon,authenticated;
CREATE INDEX finance_entries_created_idx ON nova_private.finance_entries(created_at DESC,id);
INSERT INTO nova_private.finance_entries(id,kind,amount,note)
  SELECT gen_random_uuid(),'advertising',advertising_total,'Total de anúncios anterior à atualização'
  FROM nova_private.finance_settings WHERE id=true AND advertising_total>0;

CREATE OR REPLACE FUNCTION nova_private.get_admin_finances()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_participations bigint; v_absent bigint; v_payout numeric; v_gross numeric; v_ads numeric;
  v_version integer; v_entries jsonb; v_count bigint;
BEGIN
  IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(sum("matchesCount"),0),round(COALESCE(sum(earnings),0),2)
    INTO v_participations,v_payout FROM public.jogadores;
  SELECT COALESCE(sum(quantity) FILTER(WHERE kind='non_participant'),0),
    round(COALESCE(sum(amount) FILTER(WHERE kind='advertising'),0),2),count(*)
    INTO v_absent,v_ads,v_count FROM nova_private.finance_entries;
  SELECT version INTO STRICT v_version FROM nova_private.finance_settings WHERE id=true;
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC,e.id),'[]'::jsonb) INTO v_entries FROM (
    SELECT id,kind,amount::text AS amount,quantity,note,created_at
      FROM nova_private.finance_entries ORDER BY created_at DESC,id LIMIT 50
  ) e;
  v_gross=round((v_participations::numeric+v_absent::numeric)*6.00,2);
  RETURN jsonb_build_object('participations',v_participations::text,'registration_fee','6.00',
    'non_participants',v_absent::text,'non_participant_revenue',round(v_absent*6.00,2)::text,
    'accumulated_total',v_gross::text,'payout_total',v_payout::text,'advertising_total',v_ads::text,
    'balance',round(v_gross-v_payout-v_ads,2)::text,'version',v_version,
    'entries',v_entries,'entries_count',v_count::text);
END $$;

CREATE FUNCTION nova_private.add_admin_finance_entry(p_request_id uuid,p_kind text,p_amount numeric,p_quantity integer,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_existing nova_private.finance_entries%ROWTYPE; v_note text=COALESCE(btrim(p_note),'');
BEGIN
  PERFORM nova_private.require_admin();
  IF p_request_id IS NULL OR p_kind IS NULL OR length(v_note)>160 THEN RAISE EXCEPTION 'Lançamento inválido' USING ERRCODE='22023'; END IF;
  IF p_kind='advertising' THEN
    IF p_amount IS NULL OR p_amount<=0 OR p_amount>1000000000 OR p_amount<>round(p_amount,2) OR p_quantity IS NOT NULL THEN
      RAISE EXCEPTION 'Valor inválido' USING ERRCODE='22023'; END IF;
  ELSIF p_kind='non_participant' THEN
    IF p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 1000000 OR p_amount IS NOT NULL THEN
      RAISE EXCEPTION 'Quantidade inválida' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'Lançamento inválido' USING ERRCODE='22023'; END IF;
  -- Repeating the same submission after a network failure cannot charge twice.
  PERFORM pg_advisory_xact_lock(hashtextextended('finance:'||p_request_id::text,0));
  SELECT * INTO v_existing FROM nova_private.finance_entries WHERE id=p_request_id;
  IF FOUND THEN
    IF v_existing.kind IS DISTINCT FROM p_kind OR v_existing.amount IS DISTINCT FROM p_amount
      OR v_existing.quantity IS DISTINCT FROM p_quantity OR v_existing.note IS DISTINCT FROM v_note
      OR v_existing.actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Identificador de envio já utilizado' USING ERRCODE='22023'; END IF;
    RETURN nova_private.get_admin_finances();
  END IF;
  INSERT INTO nova_private.finance_entries(id,kind,amount,quantity,note,actor)
    VALUES(p_request_id,p_kind,p_amount,p_quantity,v_note,auth.uid());
  UPDATE nova_private.finance_settings SET version=version+1,updated_at=now(),updated_by=auth.uid() WHERE id=true;
  INSERT INTO nova_private.audit_log(actor,entity,entity_id,operation)
    VALUES(auth.uid(),'finance_entries',p_request_id::text,'INSERT');
  RETURN nova_private.get_admin_finances();
END $$;

CREATE FUNCTION public.add_admin_finance_entry(p_request_id uuid,p_kind text,p_amount numeric,p_quantity integer,p_note text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT nova_private.add_admin_finance_entry(p_request_id,p_kind,p_amount,p_quantity,p_note)
$$;
REVOKE EXECUTE ON FUNCTION nova_private.add_admin_finance_entry(uuid,text,numeric,integer,text),
  public.add_admin_finance_entry(uuid,text,numeric,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nova_private.add_admin_finance_entry(uuid,text,numeric,integer,text),
  public.add_admin_finance_entry(uuid,text,numeric,integer,text) TO authenticated;
-- Retire the overwrite endpoint so an old client cannot replace the totals.
REVOKE EXECUTE ON FUNCTION public.save_admin_ad_spend(numeric,integer),
  nova_private.save_admin_ad_spend(numeric,integer) FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
