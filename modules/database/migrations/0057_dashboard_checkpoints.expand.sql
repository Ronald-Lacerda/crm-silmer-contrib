-- CHK-01..08: immutable encrypted report; one transport authorization per destination.
CREATE TABLE crm.dashboard_checkpoint_snapshots (
  id uuid PRIMARY KEY,
  report_day date NOT NULL UNIQUE,
  schema_version text NOT NULL CHECK (schema_version = 'daily-sales-v1'),
  generated_at timestamptz NOT NULL,
  content_envelope jsonb NOT NULL CHECK (jsonb_typeof(content_envelope) = 'object'),
  report_hash text NOT NULL CHECK (report_hash ~ '^[a-f0-9]{64}$'),
  sold_amount_cents bigint NOT NULL CHECK (sold_amount_cents >= 0),
  confirmed_count integer NOT NULL CHECK (confirmed_count >= 0)
);

CREATE TABLE crm.dashboard_checkpoint_deliveries (
  checkpoint_id uuid NOT NULL REFERENCES crm.dashboard_checkpoint_snapshots(id) ON DELETE RESTRICT,
  recipient_id text NOT NULL CHECK (recipient_id ~ '^[a-z0-9_-]{1,48}$'),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','sent','failed','outcome_unknown')),
  reservation_id uuid UNIQUE,
  reserved_at timestamptz,
  completed_at timestamptz,
  provider_message_id text CHECK (octet_length(provider_message_id) BETWEEN 1 AND 200),
  result_code text CHECK (result_code IN ('PROVIDER_ACCEPTED','PROVIDER_OUTCOME_UNKNOWN','RECIPIENT_UNREGISTERED','RECIPIENT_LOOKUP_UNAVAILABLE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (checkpoint_id, recipient_id),
  CHECK ((status IN ('pending','reserved')) = (result_code IS NULL)),
  CHECK ((status = 'pending' AND reservation_id IS NULL AND reserved_at IS NULL AND completed_at IS NULL)
    OR (status = 'reserved' AND reservation_id IS NOT NULL AND reserved_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('sent','failed','outcome_unknown') AND reservation_id IS NOT NULL AND reserved_at IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK ((status = 'sent' AND provider_message_id IS NOT NULL AND result_code = 'PROVIDER_ACCEPTED')
    OR (status <> 'sent' AND provider_message_id IS NULL)),
  CHECK ((status IN ('pending','reserved') AND result_code IS NULL)
    OR (status = 'sent' AND result_code = 'PROVIDER_ACCEPTED')
    OR (status = 'failed' AND result_code IN ('RECIPIENT_UNREGISTERED','RECIPIENT_LOOKUP_UNAVAILABLE'))
    OR (status = 'outcome_unknown' AND result_code = 'PROVIDER_OUTCOME_UNKNOWN')),
  CHECK (completed_at IS NULL OR completed_at >= reserved_at)
);

CREATE INDEX dashboard_checkpoint_delivery_status
  ON crm.dashboard_checkpoint_deliveries(status, reserved_at);

CREATE FUNCTION crm.guard_dashboard_checkpoint_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'checkpoint snapshot is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER guard_dashboard_checkpoint_snapshot
  BEFORE UPDATE OR DELETE ON crm.dashboard_checkpoint_snapshots
  FOR EACH ROW EXECUTE FUNCTION crm.guard_dashboard_checkpoint_snapshot();
