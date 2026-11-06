-- COB-T02: managed billing is independent of commercial order status.
CREATE TABLE crm.order_billing_plans (
  order_id text PRIMARY KEY REFERENCES crm.orders(id) ON DELETE RESTRICT,
  percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  confirmed_at timestamptz NOT NULL,
  final_amount_cents bigint NOT NULL CHECK (final_amount_cents >= 100),
  payment_condition text NOT NULL,
  review_required boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE crm.order_billing_charges (
  id uuid PRIMARY KEY,
  created_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id text NOT NULL REFERENCES crm.order_billing_plans(order_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('signal','balance','full')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 100),
  confirmed_at timestamptz NOT NULL,
  order_amount_cents bigint NOT NULL CHECK (order_amount_cents >= 100),
  payment_condition text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','creating','waiting','unknown','paid','review','closed')),
  execution_id text,
  checkout_envelope jsonb,
  valid_until timestamptz NOT NULL,
  reserved_at timestamptz,
  created_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (valid_until > created_at),
  CHECK (execution_id IS NULL OR octet_length(execution_id) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX order_billing_one_active_charge ON crm.order_billing_charges(order_id)
  WHERE status IN ('queued','creating','waiting','unknown');
CREATE INDEX order_billing_charges_order ON crm.order_billing_charges(order_id,created_at,id);

-- Single global consumption namespace shared with the existing site checkout.
-- UUID identity is case independent; opaque legacy identifiers stay exact.
CREATE FUNCTION crm.infinitepay_transaction_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN lower(value) ELSE value END;
$$;
CREATE TABLE crm.infinitepay_transactions (
  transaction_nsu text PRIMARY KEY CHECK (octet_length(transaction_nsu) BETWEEN 1 AND 128),
  owner_kind text NOT NULL CHECK (owner_kind IN ('store','billing')),
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX infinitepay_transactions_identity
  ON crm.infinitepay_transactions(crm.infinitepay_transaction_key(transaction_nsu));
INSERT INTO crm.infinitepay_transactions(transaction_nsu,owner_kind,owner_id,created_at)
SELECT payment_transaction_nsu,'store',id,payment_confirmed_at FROM crm.orders
WHERE payment_source='infinitepay' AND payment_transaction_nsu IS NOT NULL;
CREATE TRIGGER infinitepay_transactions_immutable BEFORE UPDATE OR DELETE ON crm.infinitepay_transactions
FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();

CREATE TABLE crm.order_billing_payments (
  id uuid PRIMARY KEY,
  charge_id uuid NOT NULL REFERENCES crm.order_billing_charges(id) ON DELETE RESTRICT,
  transaction_nsu text NOT NULL UNIQUE REFERENCES crm.infinitepay_transactions(transaction_nsu) ON DELETE RESTRICT,
  invoice_slug text NOT NULL CHECK (octet_length(invoice_slug) BETWEEN 1 AND 128),
  principal_amount_cents bigint NOT NULL CHECK (principal_amount_cents >= 100),
  paid_amount_cents bigint NOT NULL CHECK (paid_amount_cents >= principal_amount_cents),
  applied_amount_cents bigint NOT NULL CHECK (applied_amount_cents >= 0 AND applied_amount_cents <= principal_amount_cents),
  refunded_amount_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= principal_amount_cents),
  application_valid boolean NOT NULL,
  method text NOT NULL CHECK (method IN ('pix','credit_card')),
  installments integer NOT NULL CHECK (installments BETWEEN 1 AND 12),
  receipt_envelope jsonb,
  verified_at timestamptz NOT NULL
);
CREATE INDEX order_billing_payments_charge ON crm.order_billing_payments(charge_id,verified_at,id);

CREATE TABLE crm.order_billing_refunds (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES crm.order_billing_payments(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  actor_id text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TRIGGER order_billing_refunds_immutable BEFORE UPDATE OR DELETE ON crm.order_billing_refunds
FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();

CREATE FUNCTION crm.claim_store_infinitepay_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claimed crm.infinitepay_transactions%ROWTYPE;
BEGIN
  IF NEW.payment_source='infinitepay' AND NEW.payment_transaction_nsu IS NOT NULL THEN
    INSERT INTO crm.infinitepay_transactions(transaction_nsu,owner_kind,owner_id,created_at)
    VALUES (NEW.payment_transaction_nsu,'store',NEW.id,NEW.payment_confirmed_at)
    ON CONFLICT DO NOTHING;
    SELECT * INTO claimed FROM crm.infinitepay_transactions
    WHERE crm.infinitepay_transaction_key(transaction_nsu)=crm.infinitepay_transaction_key(NEW.payment_transaction_nsu);
    IF claimed.owner_kind <> 'store' OR claimed.owner_id <> NEW.id THEN
      RAISE EXCEPTION 'BILLING_TRANSACTION_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_claim_infinitepay BEFORE INSERT OR UPDATE OF payment_transaction_nsu,payment_source ON crm.orders
FOR EACH ROW EXECUTE FUNCTION crm.claim_store_infinitepay_transaction();

CREATE FUNCTION crm.invalidate_billing_finance(p_order_id text,p_order_version bigint,p_at timestamptz,p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE finance_version bigint;
BEGIN
  UPDATE crm.order_finance SET completed_at=NULL,completed_by=NULL,version=version+1,updated_at=p_at
  WHERE order_id=p_order_id AND completed_at IS NOT NULL RETURNING version INTO finance_version;
  IF finance_version IS NOT NULL THEN
    INSERT INTO crm.order_finance_events(id,order_id,version,order_version,action,reason,occurred_at,correlation_id)
    VALUES ('billing-finance:'||p_order_id||':'||finance_version,p_order_id,finance_version,p_order_version,'invalidated',p_reason,p_at,'billing-finance:'||p_order_id||':'||finance_version);
    INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
    VALUES ('billing-finance-audit:'||p_order_id||':'||finance_version,'system:billing','finance.invalidated','order',p_order_id,finance_version::text,p_reason,'billing-finance:'||p_order_id||':'||finance_version,p_at);
  END IF;
END $$;

-- Legacy milestone APIs cannot declare a managed order paid without coverage.
-- Reopening/reconfirming changes the commercial agreement, never the history.
CREATE FUNCTION crm.guard_managed_billing_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan crm.order_billing_plans%ROWTYPE; covered bigint; canonical_day date;
BEGIN
  SELECT * INTO plan FROM crm.order_billing_plans WHERE order_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (NEW.status,NEW.final_amount_cents,NEW.confirmed_at,NEW.payment_condition)
       IS DISTINCT FROM (OLD.status,OLD.final_amount_cents,OLD.confirmed_at,OLD.payment_condition) THEN
    UPDATE crm.order_billing_plans SET review_required=true,version=version+1,updated_at=NEW.updated_at WHERE order_id=NEW.id;
    UPDATE crm.order_billing_payments p SET application_valid=false
      FROM crm.order_billing_charges c WHERE p.charge_id=c.id AND c.order_id=NEW.id;
    UPDATE crm.order_billing_charges SET status='review',updated_at=NEW.updated_at WHERE order_id=NEW.id AND status <> 'closed';
    NEW.paid_on := NULL;
    NEW.finance_payment_review_required := true;
    PERFORM crm.invalidate_billing_finance(NEW.id,NEW.version,NEW.updated_at,'BILLING_AGREEMENT_CHANGED');
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(greatest(0,p.applied_amount_cents-p.refunded_amount_cents)),0),
         (max(p.verified_at) AT TIME ZONE 'America/Sao_Paulo')::date
  INTO covered,canonical_day FROM crm.order_billing_payments p
  JOIN crm.order_billing_charges c ON c.id=p.charge_id
  WHERE c.order_id=NEW.id AND p.application_valid;
  IF plan.review_required OR NEW.status <> 'confirmado' OR covered < NEW.final_amount_cents THEN canonical_day := NULL; END IF;
  IF NEW.paid_on IS DISTINCT FROM OLD.paid_on AND NEW.paid_on IS DISTINCT FROM canonical_day THEN
    RAISE EXCEPTION 'BILLING_PAYMENT_MANAGED' USING ERRCODE='23514',CONSTRAINT='billing_payment_managed';
  END IF;
  NEW.paid_on := canonical_day;
  NEW.finance_payment_review_required := plan.review_required;
  IF canonical_day IS NULL AND OLD.paid_on IS NOT NULL THEN
    PERFORM crm.invalidate_billing_finance(NEW.id,NEW.version,NEW.updated_at,'BILLING_SETTLEMENT_INVALIDATED');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_managed_billing_guard BEFORE UPDATE ON crm.orders
FOR EACH ROW EXECUTE FUNCTION crm.guard_managed_billing_order();

ALTER TABLE crm.outbox_jobs DROP CONSTRAINT outbox_jobs_type_check,DROP CONSTRAINT outbox_jobs_target_check,
  ADD CONSTRAINT outbox_jobs_type_check CHECK (job_type IN ('channel_event.process','media.delete','channel_message.send','n8n.command.deliver','chat_media.process','billing.checkout.create')),
  ADD CONSTRAINT outbox_jobs_target_check CHECK (
    (job_type='channel_event.process' AND channel_event_id IS NOT NULL AND transient_media_id IS NULL AND message_id IS NULL AND n8n_command_id IS NULL AND chat_media_id IS NULL AND deletion_reason IS NULL)
    OR (job_type='media.delete' AND channel_event_id IS NULL AND transient_media_id IS NOT NULL AND message_id IS NULL AND n8n_command_id IS NULL AND chat_media_id IS NULL AND deletion_reason IN ('expired','journey_terminal'))
    OR (job_type='channel_message.send' AND channel_event_id IS NULL AND transient_media_id IS NULL AND message_id IS NOT NULL AND n8n_command_id IS NULL AND chat_media_id IS NULL AND deletion_reason IS NULL)
    OR (job_type='n8n.command.deliver' AND channel_event_id IS NULL AND transient_media_id IS NULL AND n8n_command_id IS NOT NULL AND chat_media_id IS NULL AND deletion_reason IS NULL)
    OR (job_type='chat_media.process' AND channel_event_id IS NULL AND transient_media_id IS NULL AND message_id IS NULL AND n8n_command_id IS NULL AND chat_media_id IS NOT NULL AND deletion_reason IS NULL)
    OR (job_type='billing.checkout.create' AND channel_event_id IS NULL AND transient_media_id IS NULL AND message_id IS NULL AND n8n_command_id IS NULL AND chat_media_id IS NULL AND deletion_reason IS NULL)
  );
