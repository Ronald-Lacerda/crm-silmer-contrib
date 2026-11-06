-- The SKU observed by administrative linking is frozen with the confirmed ID.
ALTER TABLE crm.olist_resources ADD COLUMN verified_remote_sku text
  CHECK (verified_remote_sku IS NULL OR (kind='product' AND state='confirmed' AND octet_length(verified_remote_sku) BETWEEN 1 AND 400));
CREATE FUNCTION crm.protect_olist_verified_sku() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.verified_remote_sku IS NOT NULL AND
   (NEW.verified_remote_sku,NEW.remote_id) IS DISTINCT FROM (OLD.verified_remote_sku,OLD.remote_id) THEN
   RAISE EXCEPTION 'olist verified remote identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_verified_sku_immutable BEFORE UPDATE ON crm.olist_resources FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_verified_sku();
-- OLIST-T09: durable administrative read requests; no ERP write is enabled.
CREATE TABLE crm.olist_read_requests (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  context_key text NOT NULL,
  export_id uuid NOT NULL,
  resource_id uuid,
  actor_id text NOT NULL REFERENCES crm.users(id),
  authorization_version integer NOT NULL CHECK (authorization_version >= 0),
  connection_generation integer NOT NULL CHECK (connection_generation >= 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  stage text NOT NULL CHECK (stage IN ('customer','product','variation','sale')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','succeeded','blocked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  request_envelope jsonb NOT NULL CHECK (crm.olist_envelope_valid(request_envelope)),
  result_envelope jsonb CHECK (result_envelope IS NULL OR crm.olist_envelope_valid(result_envelope)),
  safe_code text CHECK (safe_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(context_key,account_key) REFERENCES crm.olist_connections(context_key,account_key),
  FOREIGN KEY(export_id,account_key) REFERENCES crm.olist_exports(id,account_key),
  FOREIGN KEY(resource_id,account_key) REFERENCES crm.olist_resources(id,account_key),
  CHECK ((stage='sale') = (resource_id IS NULL)),
  CHECK ((status='queued') = (completed_at IS NULL)),
  CHECK ((status='queued') = (result_envelope IS NULL))
);
CREATE INDEX olist_reads_export_history ON crm.olist_read_requests(export_id,created_at DESC,id DESC);
CREATE FUNCTION crm.protect_olist_read_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'olist administrative reads are durable'; END IF;
 IF OLD.status<>'queued' OR NEW.status='queued'
   OR (NEW.id,NEW.account_key,NEW.context_key,NEW.export_id,NEW.resource_id,NEW.actor_id,NEW.authorization_version,NEW.connection_generation,NEW.expected_version,NEW.stage,NEW.request_envelope,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.account_key,OLD.context_key,OLD.export_id,OLD.resource_id,OLD.actor_id,OLD.authorization_version,OLD.connection_generation,OLD.expected_version,OLD.stage,OLD.request_envelope,OLD.created_at) THEN
   RAISE EXCEPTION 'olist administrative read is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_reads_durable BEFORE UPDATE OR DELETE ON crm.olist_read_requests FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_read_request();
DO $olist_reads_outbox$
DECLARE previous_type text; previous_target text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_type FROM pg_constraint WHERE conrelid='crm.outbox_jobs'::regclass AND conname='outbox_jobs_type_check' AND contype='c';
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_target FROM pg_constraint WHERE conrelid='crm.outbox_jobs'::regclass AND conname='outbox_jobs_target_check' AND contype='c';
 EXECUTE format($checks$
 ALTER TABLE crm.outbox_jobs DROP CONSTRAINT outbox_jobs_type_check,DROP CONSTRAINT outbox_jobs_target_check,
 ADD CONSTRAINT outbox_jobs_type_check CHECK ((%s) OR job_type='olist.reconcile'),
 ADD CONSTRAINT outbox_jobs_target_check CHECK ((%s) OR (job_type='olist.reconcile' AND olist_export_id IS NOT NULL
 AND channel_event_id IS NULL AND transient_media_id IS NULL AND message_id IS NULL AND n8n_command_id IS NULL
 AND chat_media_id IS NULL AND deletion_reason IS NULL AND queue='olist_reconcile' AND effect_policy='internal'))
 $checks$,previous_type,previous_target);
END;
$olist_reads_outbox$;
