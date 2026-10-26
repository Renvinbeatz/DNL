-- Requires the existing nova_private admin/session guards (security 01-07).
-- Registration: BRL 6.00 per recorded player participation.
CREATE TABLE nova_private.finance_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  advertising_total numeric(12,2) NOT NULL DEFAULT 0 CHECK(advertising_total BETWEEN 0 AND 1000000000),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE nova_private.finance_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nova_private.finance_settings FROM PUBLIC,anon,authenticated;
INSERT INTO nova_private.finance_settings(id) VALUES(true);

CREATE FUNCTION nova_private.get_admin_finances()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_participations bigint; v_payout numeric; v_gross numeric; v_settings nova_private.finance_settings%ROWTYPE;
BEGIN
  IF NOT nova_private.is_admin() THEN RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501'; END IF;
  -- Use the same aggregates as the existing admin panel, including the history
  -- of banned players; a new registration with zero matches does not generate income.
  SELECT COALESCE(sum("matchesCount"),0),round(COALESCE(sum(earnings),0),2)
    INTO v_participations,v_payout FROM public.jogadores;
  SELECT * INTO STRICT v_settings FROM nova_private.finance_settings WHERE id=true;
  v_gross=round(v_participations*6.00,2);
  RETURN jsonb_build_object(
    'participations',v_participations::text,'registration_fee','6.00',
    'accumulated_total',v_gross::text,'payout_total',v_payout::text,
    'advertising_total',v_settings.advertising_total::text,
    'balance',round(v_gross-v_payout-v_settings.advertising_total,2)::text,
    'version',v_settings.version
  );
END $$;

CREATE FUNCTION nova_private.save_admin_ad_spend(p_advertising_total numeric,p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM nova_private.require_admin();
  IF p_advertising_total IS NULL OR p_advertising_total NOT BETWEEN 0 AND 1000000000
    OR p_advertising_total<>round(p_advertising_total,2) OR p_expected_version IS NULL OR p_expected_version<0 THEN
    RAISE EXCEPTION 'Valor inválido' USING ERRCODE='22023';
  END IF;
  UPDATE nova_private.finance_settings
    SET advertising_total=p_advertising_total,version=version+1,updated_at=now(),updated_by=auth.uid()
    WHERE id=true AND version=p_expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Os valores foram atualizados. Confira e salve novamente.' USING ERRCODE='40001'; END IF;
  INSERT INTO nova_private.audit_log(actor,entity,entity_id,operation)
    VALUES(auth.uid(),'finance_settings','league','UPDATE');
  RETURN nova_private.get_admin_finances();
END $$;

CREATE FUNCTION public.get_admin_finances()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.get_admin_finances() $$;
CREATE FUNCTION public.save_admin_ad_spend(p_advertising_total numeric,p_expected_version integer)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT nova_private.save_admin_ad_spend(p_advertising_total,p_expected_version) $$;

REVOKE EXECUTE ON FUNCTION nova_private.get_admin_finances(),nova_private.save_admin_ad_spend(numeric,integer),
  public.get_admin_finances(),public.save_admin_ad_spend(numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION nova_private.get_admin_finances(),nova_private.save_admin_ad_spend(numeric,integer),
  public.get_admin_finances(),public.save_admin_ad_spend(numeric,integer) TO authenticated;
NOTIFY pgrst,'reload schema';
