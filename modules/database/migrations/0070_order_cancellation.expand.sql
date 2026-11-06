-- OLIST-T23: a terminal local marker; the two commercial statuses stay intact.
ALTER TABLE crm.orders
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by text REFERENCES crm.users(id),
  ADD COLUMN cancellation_reason_envelope jsonb,
  ADD CONSTRAINT order_cancellation_complete CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason_envelope IS NULL)
    OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
      AND cancellation_reason_envelope IS NOT NULL
      AND crm.olist_envelope_valid(cancellation_reason_envelope)));

CREATE FUNCTION crm.protect_cancelled_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'cancelled order is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL AND
    (to_jsonb(NEW) - ARRAY['cancelled_at','cancelled_by','cancellation_reason_envelope','version','updated_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['cancelled_at','cancelled_by','cancellation_reason_envelope','version','updated_at']) THEN
    RAISE EXCEPTION 'cancellation preserves commercial and payment history';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_cancellation_terminal BEFORE UPDATE OR DELETE ON crm.orders
FOR EACH ROW EXECUTE FUNCTION crm.protect_cancelled_order();
CREATE INDEX orders_active_updated ON crm.orders(updated_at DESC,id DESC) WHERE cancelled_at IS NULL;
-- A later explicit human creation may replace a cancelled draft. This migration
-- never creates a replacement order or changes its conversation/subject.
DROP INDEX crm.orders_one_pending_per_conversation;
CREATE UNIQUE INDEX orders_one_pending_per_conversation ON crm.orders(conversation_id)
WHERE status='pendente' AND cancelled_at IS NULL;
