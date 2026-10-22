-- FINQ-T01: Financeiro is distinct from Vendedor; Admin remains an orthogonal capability.
ALTER TABLE crm.user_functions
  DROP CONSTRAINT user_functions_function_name_check,
  ADD CONSTRAINT user_functions_function_name_check
    CHECK (function_name IN ('Vendedor', 'Financeiro'));

-- Financial history is created in the following expansion. Keep account reads
-- compatible while migrations are applied in sequence, without deleting history.
CREATE FUNCTION crm.identity_has_finance_history(target_user_id text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE has_history boolean;
BEGIN
  IF to_regclass('crm.order_finance_events') IS NULL THEN RETURN false; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM crm.order_finance_events WHERE actor_id = $1)'
    INTO has_history USING target_user_id;
  RETURN has_history;
END;
$$;

CREATE FUNCTION crm.require_seller_for_admin_capability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'user_capabilities' THEN
    IF NOT EXISTS (
      SELECT 1 FROM crm.user_functions WHERE user_id = NEW.user_id AND function_name = 'Vendedor'
    ) THEN
      RAISE EXCEPTION 'Administrative capability requires Vendedor function' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.function_name = 'Financeiro' AND EXISTS (
    SELECT 1 FROM crm.user_capabilities WHERE user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Financeiro cannot inherit administrative capabilities' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_capabilities_require_seller
BEFORE INSERT OR UPDATE ON crm.user_capabilities
FOR EACH ROW EXECUTE FUNCTION crm.require_seller_for_admin_capability();

CREATE TRIGGER user_functions_no_finance_capabilities
BEFORE INSERT OR UPDATE ON crm.user_functions
FOR EACH ROW EXECUTE FUNCTION crm.require_seller_for_admin_capability();
