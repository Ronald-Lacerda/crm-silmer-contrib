-- OLIST-LIVENESS L1: an administrator may archive a pre-sale export generation
-- as `invalidated` so a new generation can be prepared. Expand-only: it relaxes
-- one uniqueness rule and adds an append-only receipt table plus three guards.
-- Nothing in the ERP is deleted, no account/worker/remote effect is enabled, and
-- the previous generation row stays as history (never reused or reopened).

-- "One operation per order/account" becomes "one ACTIVE operation per
-- order/account". The constraint name is the one PostgreSQL derived from
-- crm.olist_exports UNIQUE(account_key,order_id) in 0064; it is dropped without
-- IF EXISTS so a different installed shape fails the migration loudly instead of
-- silently keeping the old rule. unique(account_key,reference) and
-- olist_exports_remote_key stay untouched (references and ERP IDs are global).
ALTER TABLE crm.olist_exports DROP CONSTRAINT olist_exports_account_key_order_id_key;
CREATE UNIQUE INDEX olist_exports_active_order_key
  ON crm.olist_exports(account_key,order_id) WHERE state<>'invalidated';

-- Receipt of an administrative invalidation. The reason exists only inside the
-- authenticated envelope; no column carries free text or PII.
CREATE TABLE crm.olist_export_invalidations (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  export_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES crm.users(id),
  authorization_version integer NOT NULL CHECK (authorization_version >= 0),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  reason_envelope jsonb NOT NULL CHECK (crm.olist_envelope_valid(reason_envelope)),
  correlation_id text NOT NULL CHECK (octet_length(correlation_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(export_id),
  FOREIGN KEY(export_id,account_key) REFERENCES crm.olist_exports(id,account_key)
);
CREATE TRIGGER olist_export_invalidations_append_only
  BEFORE UPDATE OR DELETE ON crm.olist_export_invalidations
  FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_history();

-- (a) A receipt is only valid for an export that is already invalidated and
-- never reached a sale: no sale attempt of any outcome, no remote/observed ID.
-- The row lock makes the check race-safe against a concurrent sale reservation.
CREATE FUNCTION crm.guard_olist_export_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target crm.olist_exports%ROWTYPE;
BEGIN
  SELECT * INTO target FROM crm.olist_exports
    WHERE id=NEW.export_id AND account_key=NEW.account_key FOR SHARE;
  IF NOT FOUND OR target.state<>'invalidated' THEN
    RAISE EXCEPTION 'olist invalidation requires an invalidated export';
  END IF;
  IF target.remote_id IS NOT NULL OR target.observed_sale_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM crm.olist_attempts
      WHERE export_id=NEW.export_id AND stage='sale') THEN
    RAISE EXCEPTION 'olist export with a sale attempt cannot be invalidated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER olist_export_invalidations_guard BEFORE INSERT ON crm.olist_export_invalidations
  FOR EACH ROW EXECUTE FUNCTION crm.guard_olist_export_invalidation();

-- (b) `invalidated` is terminal for the row: administrators and order
-- cancellation both end here, and a new generation is always a new row.
CREATE FUNCTION crm.protect_olist_export_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='invalidated' AND NEW.state<>'invalidated' THEN
    RAISE EXCEPTION 'olist invalidated export is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER olist_exports_invalidated_terminal BEFORE UPDATE ON crm.olist_exports
  FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_export_invalidated();

-- (c) No sale attempt can be recorded for an invalidated export, even by an old
-- job or a direct writer. The row is locked FIRST (FOR SHARE, regardless of its
-- visible state) so an uncommitted invalidation is waited for and its result is
-- what gets checked: exactly one of the two paths wins.
CREATE FUNCTION crm.reject_olist_sale_for_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  export_state text;
BEGIN
  IF NEW.stage='sale' AND NEW.export_id IS NOT NULL THEN
    SELECT state INTO export_state FROM crm.olist_exports
      WHERE id=NEW.export_id AND account_key=NEW.account_key FOR SHARE;
    IF export_state='invalidated' THEN
      RAISE EXCEPTION 'olist invalidated export cannot start a sale';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER olist_attempts_no_sale_after_invalidation BEFORE INSERT ON crm.olist_attempts
  FOR EACH ROW EXECUTE FUNCTION crm.reject_olist_sale_for_invalidated();
