-- FINQ-T02: operational financial check; never another commercial order status.
ALTER TABLE crm.orders ADD COLUMN finance_payment_review_required boolean NOT NULL DEFAULT false;

-- Legacy manual dates were not a declaration of full settlement. Preserve them,
-- but require the seller/Admin to explicitly review and save the payment again.
UPDATE crm.orders SET finance_payment_review_required = true
WHERE origin <> 'loja' AND paid_on IS NOT NULL;

CREATE TABLE crm.order_finance (
  order_id text PRIMARY KEY REFERENCES crm.orders(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  completed_at timestamptz,
  completed_by text REFERENCES crm.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);

CREATE TABLE crm.order_finance_events (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES crm.orders(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  order_version bigint NOT NULL CHECK (order_version > 0),
  action text NOT NULL CHECK (action IN ('completed','reopened','invalidated')),
  actor_id text REFERENCES crm.users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id text NOT NULL,
  UNIQUE (order_id, version),
  CHECK (actor_id IS NOT NULL OR action = 'invalidated')
);
CREATE INDEX order_finance_completed_idx ON crm.order_finance(completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX order_finance_events_actor_idx ON crm.order_finance_events(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX orders_finance_payment_idx ON crm.orders(paid_on, number_sequence, id)
WHERE status = 'confirmado' AND paid_on IS NOT NULL AND NOT is_test AND NOT finance_payment_review_required;

CREATE TRIGGER order_finance_events_immutable BEFORE UPDATE OR DELETE ON crm.order_finance_events
FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();

CREATE FUNCTION crm.invalidate_finance_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE finance_version bigint;
BEGIN
  IF OLD.final_amount_cents IS NOT NULL AND NEW.final_amount_cents IS DISTINCT FROM OLD.final_amount_cents THEN
    -- Covers reconfirmation AND the separate administrative store correction.
    -- A new explicit settlement command is required, even on the same date.
    IF NEW.origin <> 'loja' THEN
      NEW.paid_on := NULL;
    END IF;
    NEW.finance_payment_review_required := false;
    UPDATE crm.order_finance SET completed_at = NULL, completed_by = NULL,
      version = version + 1, updated_at = NEW.updated_at
    WHERE order_id = NEW.id AND completed_at IS NOT NULL RETURNING version INTO finance_version;
    IF finance_version IS NOT NULL THEN
      INSERT INTO crm.order_finance_events
        (id, order_id, version, order_version, action, reason, occurred_at, correlation_id)
      VALUES ('finance-invalidated:' || NEW.id || ':' || finance_version,
        NEW.id, finance_version, NEW.version, 'invalidated', 'ORDER_AMOUNT_CHANGED',
        NEW.updated_at, 'finance-amount:' || NEW.id || ':' || NEW.version);
      INSERT INTO crm.audit_events
        (id, actor_id, action, target_type, target_id, version, reason, correlation_id, occurred_at)
      VALUES ('finance-invalidation-audit:' || NEW.id || ':' || finance_version,
        'system:financeiro', 'finance.invalidated', 'order', NEW.id, finance_version::text,
        'ORDER_AMOUNT_CHANGED', 'finance-amount:' || NEW.id || ':' || NEW.version, NEW.updated_at);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_finance_amount_changed BEFORE UPDATE OF final_amount_cents ON crm.orders
FOR EACH ROW EXECUTE FUNCTION crm.invalidate_finance_amount();
