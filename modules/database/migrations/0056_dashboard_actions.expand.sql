-- ACT-T01 / PERF-01: action decisions are independent of commercial status.
-- No historical ownership is inferred from the conversation's current owner.
-- PostgreSQL lpad truncates values wider than the requested length. Preserve
-- the domain's minimum-two-digit format after the ninety-ninth order too.
ALTER TABLE crm.orders DROP CONSTRAINT orders_number_format,
  ADD CONSTRAINT orders_number_format CHECK (
    number = lpad(number_sequence::text, greatest(2,length(number_sequence::text)), '0') || '-CRM'
  );
ALTER TABLE crm.orders
  ADD COLUMN sales_owner_id text REFERENCES crm.users(id) ON DELETE RESTRICT,
  ADD COLUMN sales_owner_captured_at timestamptz,
  ADD COLUMN sales_owner_capture_attempted boolean NOT NULL DEFAULT false;

-- A historical confirmation stays unknown even if reopened and reconfirmed.
-- Preserve the absence of attribution instead of reading its present owner.
UPDATE crm.orders SET sales_owner_capture_attempted = true
  WHERE status = 'confirmado' OR confirmed_at IS NOT NULL OR reopened_at IS NOT NULL;

CREATE FUNCTION crm.capture_order_sales_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin = 'atendimento' AND NEW.status = 'confirmado' THEN
      NEW.sales_owner_id := NEW.manual_owner_id;
      IF NEW.conversation_id IS NOT NULL THEN
        SELECT assigned_user_id INTO NEW.sales_owner_id
        FROM crm.conversations WHERE id = NEW.conversation_id;
      END IF;
      NEW.sales_owner_captured_at := NEW.confirmed_at;
      NEW.sales_owner_capture_attempted := true;
    ELSIF NEW.sales_owner_id IS NOT NULL OR NEW.sales_owner_captured_at IS NOT NULL OR NEW.sales_owner_capture_attempted THEN
      RAISE EXCEPTION 'sales attribution requires confirmation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.sales_owner_capture_attempted THEN
    IF NEW.sales_owner_id IS DISTINCT FROM OLD.sales_owner_id
       OR NEW.sales_owner_captured_at IS DISTINCT FROM OLD.sales_owner_captured_at
       OR NEW.sales_owner_capture_attempted IS DISTINCT FROM OLD.sales_owner_capture_attempted THEN
      RAISE EXCEPTION 'sales attribution is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'pendente' AND NEW.status = 'confirmado'
        AND NEW.origin = 'atendimento' THEN
    NEW.sales_owner_id := NEW.manual_owner_id;
    IF NEW.conversation_id IS NOT NULL THEN
      SELECT assigned_user_id INTO NEW.sales_owner_id
      FROM crm.conversations WHERE id = NEW.conversation_id;
    END IF;
    NEW.sales_owner_captured_at := NEW.confirmed_at;
    NEW.sales_owner_capture_attempted := true;
  ELSIF NEW.sales_owner_id IS DISTINCT FROM OLD.sales_owner_id
        OR NEW.sales_owner_captured_at IS DISTINCT FROM OLD.sales_owner_captured_at
        OR NEW.sales_owner_capture_attempted IS DISTINCT FROM OLD.sales_owner_capture_attempted THEN
    RAISE EXCEPTION 'sales attribution requires confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_order_sales_owner
  BEFORE INSERT OR UPDATE ON crm.orders
  FOR EACH ROW EXECUTE FUNCTION crm.capture_order_sales_owner();

CREATE INDEX orders_sales_owner_date
  ON crm.orders (sales_owner_id, order_date)
  WHERE status = 'confirmado' AND NOT is_test;

CREATE TABLE crm.dashboard_action_decisions (
  user_id text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (octet_length(action_id) BETWEEN 1 AND 300),
  target_type text NOT NULL CHECK (target_type IN ('order','conversation')),
  target_id text NOT NULL,
  target_version bigint NOT NULL CHECK (target_version > 0),
  source_revision text NOT NULL CHECK (octet_length(source_revision) BETWEEN 1 AND 600),
  decision text NOT NULL CHECK (decision IN ('snooze','resume','dismiss','schedule')),
  remind_at timestamptz,
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, action_id),
  CHECK ((decision IN ('snooze','schedule') AND remind_at IS NOT NULL)
      OR (decision IN ('resume','dismiss') AND remind_at IS NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX dashboard_action_decisions_due
  ON crm.dashboard_action_decisions(user_id, remind_at)
  WHERE decision IN ('snooze','schedule');
