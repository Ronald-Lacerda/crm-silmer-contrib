-- BFIN: external money is a receipt, never a fabricated InfinitePay transaction.
CREATE TABLE crm.order_billing_external_receipts (
  id uuid PRIMARY KEY,
  order_id text NOT NULL REFERENCES crm.order_billing_plans(order_id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  received_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','pix_external','bank_transfer','card_external')),
  note_envelope jsonb NOT NULL,
  application_valid boolean NOT NULL DEFAULT true,
  recorded_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX billing_external_receipts_order ON crm.order_billing_external_receipts(order_id,recorded_at,id);
CREATE TABLE crm.order_billing_external_reversals (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL UNIQUE REFERENCES crm.order_billing_external_receipts(id) ON DELETE RESTRICT,
  reason_envelope jsonb NOT NULL,
  recorded_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL
);
CREATE TRIGGER billing_external_reversals_immutable BEFORE UPDATE OR DELETE ON crm.order_billing_external_reversals
  FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();
CREATE FUNCTION crm.guard_external_receipt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.amount_cents,NEW.received_on,NEW.method,NEW.note_envelope,NEW.recorded_by,NEW.recorded_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.amount_cents,OLD.received_on,OLD.method,OLD.note_envelope,OLD.recorded_by,OLD.recorded_at)
  THEN RAISE EXCEPTION 'BILLING_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_external_receipts_identity BEFORE UPDATE OR DELETE ON crm.order_billing_external_receipts
  FOR EACH ROW EXECUTE FUNCTION crm.guard_external_receipt_identity();

CREATE VIEW crm.order_billing_receipt_ledger AS
  SELECT p.id,c.order_id,p.charge_id,'infinitepay'::text AS source,p.principal_amount_cents,
    p.applied_amount_cents,p.refunded_amount_cents,p.application_valid,p.method,p.installments,
    p.verified_at,(p.verified_at AT TIME ZONE 'America/Sao_Paulo')::date AS received_on,
    p.transaction_nsu,p.receipt_envelope,NULL::text AS recorded_by
  FROM crm.order_billing_payments p JOIN crm.order_billing_charges c ON c.id=p.charge_id
  UNION ALL
  SELECT e.id,e.order_id,NULL::uuid,'external',e.amount_cents,
    CASE WHEN r.id IS NULL THEN e.amount_cents ELSE 0 END,
    0::bigint,e.application_valid,e.method,1,e.recorded_at,e.received_on,NULL::text,NULL::jsonb,e.recorded_by
  FROM crm.order_billing_external_receipts e LEFT JOIN crm.order_billing_external_reversals r ON r.receipt_id=e.id;

CREATE OR REPLACE FUNCTION crm.guard_managed_billing_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan crm.order_billing_plans%ROWTYPE; covered bigint; canonical_day date;
BEGIN
  SELECT * INTO plan FROM crm.order_billing_plans WHERE order_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (NEW.status,NEW.final_amount_cents,NEW.confirmed_at,NEW.payment_condition)
       IS DISTINCT FROM (OLD.status,OLD.final_amount_cents,OLD.confirmed_at,OLD.payment_condition) THEN
    UPDATE crm.order_billing_plans SET review_required=true,version=version+1,updated_at=NEW.updated_at WHERE order_id=NEW.id;
    UPDATE crm.order_billing_payments p SET application_valid=false
      FROM crm.order_billing_charges c WHERE p.charge_id=c.id AND c.order_id=NEW.id;
    UPDATE crm.order_billing_external_receipts SET application_valid=false WHERE order_id=NEW.id;
    UPDATE crm.order_billing_charges SET status='review',updated_at=NEW.updated_at WHERE order_id=NEW.id AND status <> 'closed';
    NEW.paid_on := NULL; NEW.finance_payment_review_required := true;
    PERFORM crm.invalidate_billing_finance(NEW.id,NEW.version,NEW.updated_at,'BILLING_AGREEMENT_CHANGED');
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(greatest(0,p.applied_amount_cents-p.refunded_amount_cents)),0),max(p.received_on)
  INTO covered,canonical_day FROM crm.order_billing_receipt_ledger p
  WHERE p.order_id=NEW.id AND p.application_valid AND p.applied_amount_cents>p.refunded_amount_cents;
  IF plan.review_required OR NEW.status <> 'confirmado' OR covered < NEW.final_amount_cents THEN canonical_day := NULL; END IF;
  IF NEW.paid_on IS DISTINCT FROM OLD.paid_on AND NEW.paid_on IS DISTINCT FROM canonical_day THEN
    RAISE EXCEPTION 'BILLING_PAYMENT_MANAGED' USING ERRCODE='23514',CONSTRAINT='billing_payment_managed';
  END IF;
  NEW.paid_on := canonical_day; NEW.finance_payment_review_required := plan.review_required;
  IF canonical_day IS NULL AND OLD.paid_on IS NOT NULL THEN
    PERFORM crm.invalidate_billing_finance(NEW.id,NEW.version,NEW.updated_at,'BILLING_SETTLEMENT_INVALIDATED');
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE crm.order_billing_payment_checks (
  id uuid PRIMARY KEY,
  charge_id uuid NOT NULL REFERENCES crm.order_billing_charges(id) ON DELETE RESTRICT,
  candidate_envelope jsonb NOT NULL,
  candidate_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','paid','not_paid')),
  requested_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL,
  checked_at timestamptz,
  next_check_at timestamptz,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 6)
);
CREATE INDEX billing_payment_checks_candidate ON crm.order_billing_payment_checks(charge_id,candidate_hash,requested_at DESC);
CREATE INDEX billing_payment_checks_due ON crm.order_billing_payment_checks(next_check_at,id)
  WHERE status='not_paid' AND attempts<6;
CREATE TABLE crm.order_billing_payment_check_events (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES crm.order_billing_payment_checks(id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 6),
  status text NOT NULL CHECK (status IN ('paid','not_paid')),
  occurred_at timestamptz NOT NULL,
  UNIQUE(check_id,attempt,status)
);
CREATE INDEX billing_payment_check_events_check ON crm.order_billing_payment_check_events(check_id,occurred_at,id);
CREATE TRIGGER billing_payment_check_events_immutable BEFORE UPDATE OR DELETE ON crm.order_billing_payment_check_events
  FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();
-- Extend the installed contracts: Olist already owns export/reconcile targets.
-- Trusted catalog expressions preserve existing queue/effect/target invariants.
DO $billing_check_outbox$
DECLARE previous_type text; previous_target text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_type
    FROM pg_constraint WHERE conrelid='crm.outbox_jobs'::regclass
    AND conname='outbox_jobs_type_check' AND contype='c';
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_target
    FROM pg_constraint WHERE conrelid='crm.outbox_jobs'::regclass
    AND conname='outbox_jobs_target_check' AND contype='c';
  EXECUTE format($checks$
    ALTER TABLE crm.outbox_jobs DROP CONSTRAINT outbox_jobs_type_check,DROP CONSTRAINT outbox_jobs_target_check,
      ADD CONSTRAINT outbox_jobs_type_check CHECK ((%s) OR job_type='billing.payment.check'),
      ADD CONSTRAINT outbox_jobs_target_check CHECK ((%s)
        OR (job_type='billing.payment.check' AND channel_event_id IS NULL
          AND transient_media_id IS NULL AND message_id IS NULL AND n8n_command_id IS NULL
          AND chat_media_id IS NULL AND olist_export_id IS NULL AND deletion_reason IS NULL
          AND queue='billing' AND effect_policy='queryable'))
  $checks$,previous_type,previous_target);
END;
$billing_check_outbox$;
