-- OLIST envelopes are mandatory complete authenticated envelopes, never bare JSON.
CREATE FUNCTION crm.olist_envelope_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value)='object'
    AND value->>'algorithm'='AES-256-GCM' AND value->'keyVersion'='1'::jsonb AND value->'version'='1'::jsonb
    AND value->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    AND value->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    AND value->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',false);
$$;
-- OLIST-T03/T04/T05: additive foundation; no account, user or effect is enabled.
CREATE TABLE crm.olist_accounts (
  account_key text PRIMARY KEY CHECK (account_key ~ '^[a-f0-9]{64}$'),
  creation_enabled boolean NOT NULL DEFAULT false,
  recovery_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crm.olist_settings (
  account_key text PRIMARY KEY REFERENCES crm.olist_accounts(account_key),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  settings_envelope jsonb,
  updated_by text REFERENCES crm.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (settings_envelope IS NULL OR (crm.olist_envelope_valid(settings_envelope)))
);
CREATE TABLE crm.olist_connections (
  context_key text PRIMARY KEY CHECK (context_key ~ '^[a-f0-9]{64}$'),
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  token_envelope jsonb,
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  reconnect_required boolean NOT NULL DEFAULT false,
  refresh_nonce uuid,
  refresh_started_at timestamptz,
  exchange_nonce uuid,
  connected_by text REFERENCES crm.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(context_key, account_key),
  CHECK ((token_envelope IS NULL AND expires_at IS NULL) OR
    (token_envelope IS NOT NULL AND crm.olist_envelope_valid(token_envelope) AND expires_at IS NOT NULL)),
  CHECK ((refresh_nonce IS NULL) = (refresh_started_at IS NULL))
);
CREATE TABLE crm.olist_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  context_key text NOT NULL REFERENCES crm.olist_connections(context_key),
  actor_id text NOT NULL REFERENCES crm.users(id),
  session_hash text NOT NULL REFERENCES crm.sessions(token_hash) ON DELETE CASCADE,
  connection_version integer NOT NULL CHECK (connection_version >= 0),
  expires_at timestamptz NOT NULL,
  UNIQUE(context_key, actor_id, session_hash)
);
CREATE INDEX olist_oauth_states_expiry ON crm.olist_oauth_states(expires_at);
CREATE TABLE crm.olist_quotas (
  account_key text PRIMARY KEY REFERENCES crm.olist_accounts(account_key),
  window_started_at timestamptz NOT NULL DEFAULT date_trunc('minute',now()),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  remaining integer CHECK (remaining >= 0),
  blocked_until timestamptz
);
CREATE TABLE crm.olist_resources (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  kind text NOT NULL CHECK (kind IN ('customer','product','variation')),
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  reference text NOT NULL CHECK (reference ~ '^CRM-[A-Za-z0-9-]{1,100}$'),
  parent_id uuid,
  parent_kind text GENERATED ALWAYS AS (CASE WHEN kind='variation' THEN 'product' ELSE NULL END) STORED,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reserved','confirmed','uncertain','rejected')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  remote_id text CHECK (remote_id ~ '^[1-9][0-9]{0,18}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_key,kind,identity_hash),
  UNIQUE(account_key,kind,reference),
  UNIQUE(id,account_key),
  UNIQUE(id,account_key,kind),
  FOREIGN KEY(parent_id,account_key,parent_kind) REFERENCES crm.olist_resources(id,account_key,kind),
  CHECK ((kind='variation') = (parent_id IS NOT NULL)),
  CHECK ((state='confirmed') = (remote_id IS NOT NULL))
);
CREATE UNIQUE INDEX olist_resources_remote_key ON crm.olist_resources(account_key,kind,remote_id) WHERE remote_id IS NOT NULL;
CREATE TABLE crm.olist_exports (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  context_key text NOT NULL,
  connection_generation integer NOT NULL CHECK (connection_generation >= 0),
  order_id text NOT NULL REFERENCES crm.orders(id),
  order_version integer NOT NULL CHECK (order_version > 0),
  settings_version integer NOT NULL CHECK (settings_version >= 0),
  actor_id text NOT NULL REFERENCES crm.users(id),
  authorization_version integer NOT NULL CHECK (authorization_version >= 0),
  reference text NOT NULL CHECK (reference ~ '^CRM-[A-Za-z0-9-]{1,100}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','resolving','ready','reserved','confirmed','linked','uncertain','rejected','invalidated')),
  stage text NOT NULL DEFAULT 'customer' CHECK (stage IN ('customer','product','variation','sale','complete')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot_envelope jsonb NOT NULL CHECK (crm.olist_envelope_valid(snapshot_envelope)),
  remote_id text CHECK (remote_id ~ '^[1-9][0-9]{0,18}$'),
  remote_number text CHECK (octet_length(remote_number) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_key,order_id),
  UNIQUE(account_key,reference),
  UNIQUE(id,account_key),
  FOREIGN KEY(context_key,account_key) REFERENCES crm.olist_connections(context_key,account_key),
  CHECK ((state IN ('confirmed','linked')) = (remote_id IS NOT NULL))
);
CREATE UNIQUE INDEX olist_exports_remote_key ON crm.olist_exports(account_key,remote_id) WHERE remote_id IS NOT NULL;
CREATE TABLE crm.olist_export_resources (
  export_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  account_key text NOT NULL,
  PRIMARY KEY(export_id,resource_id),
  FOREIGN KEY(export_id,account_key) REFERENCES crm.olist_exports(id,account_key),
  FOREIGN KEY(resource_id,account_key) REFERENCES crm.olist_resources(id,account_key)
);
CREATE TABLE crm.olist_attempts (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  export_id uuid,
  resource_id uuid,
  stage text NOT NULL CHECK (stage IN ('customer','product','variation','sale')),
  fence uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation >= 0),
  outcome text NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved','confirmed','uncertain','rejected')),
  response_envelope jsonb,
  safe_code text CHECK (safe_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((export_id IS NULL) <> (resource_id IS NULL)),
  CHECK ((outcome='reserved') = (finished_at IS NULL)),
  CHECK (response_envelope IS NULL OR (crm.olist_envelope_valid(response_envelope))),
  FOREIGN KEY(export_id,account_key) REFERENCES crm.olist_exports(id,account_key),
  FOREIGN KEY(resource_id,account_key) REFERENCES crm.olist_resources(id,account_key)
);
CREATE UNIQUE INDEX olist_attempts_resource_effect ON crm.olist_attempts(resource_id) WHERE outcome IN ('reserved','uncertain','confirmed');
CREATE UNIQUE INDEX olist_attempts_sale_effect ON crm.olist_attempts(export_id) WHERE outcome IN ('reserved','uncertain','confirmed');
CREATE TABLE crm.olist_events (
  id uuid PRIMARY KEY,
  account_key text NOT NULL REFERENCES crm.olist_accounts(account_key),
  export_id uuid,
  resource_id uuid,
  actor_id text REFERENCES crm.users(id),
  event_code text NOT NULL CHECK (event_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  version integer NOT NULL CHECK (version >= 0),
  correlation_id text NOT NULL CHECK (octet_length(correlation_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(export_id,account_key) REFERENCES crm.olist_exports(id,account_key),
  FOREIGN KEY(resource_id,account_key) REFERENCES crm.olist_resources(id,account_key)
);
CREATE FUNCTION crm.protect_olist_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'olist history is append only';
END;
$$;
CREATE TRIGGER olist_events_append_only BEFORE UPDATE OR DELETE ON crm.olist_events FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_history();
CREATE FUNCTION crm.protect_olist_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_key,NEW.context_key,NEW.connection_generation,NEW.order_id,NEW.order_version,NEW.settings_version,NEW.actor_id,NEW.authorization_version,NEW.reference,NEW.snapshot_envelope)
    IS DISTINCT FROM (OLD.account_key,OLD.context_key,OLD.connection_generation,OLD.order_id,OLD.order_version,OLD.settings_version,OLD.actor_id,OLD.authorization_version,OLD.reference,OLD.snapshot_envelope) THEN
    RAISE EXCEPTION 'olist export snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER olist_exports_snapshot_immutable BEFORE UPDATE ON crm.olist_exports FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_snapshot();
ALTER TABLE crm.outbox_jobs ADD COLUMN olist_export_id uuid REFERENCES crm.olist_exports(id) ON DELETE RESTRICT;
-- Compose the installed contracts instead of rebuilding a stale type list.
-- Other additive features (for example billing) may already own outbox types.
-- These expressions come only from PostgreSQL's trusted constraint catalog.
DO $olist_outbox$
DECLARE
  previous_type_check text;
  previous_target_check text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_type_check
    FROM pg_constraint
    WHERE conrelid='crm.outbox_jobs'::regclass
      AND conname='outbox_jobs_type_check' AND contype='c';
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_target_check
    FROM pg_constraint
    WHERE conrelid='crm.outbox_jobs'::regclass
      AND conname='outbox_jobs_target_check' AND contype='c';
  EXECUTE format($olist_constraints$
    ALTER TABLE crm.outbox_jobs
      DROP CONSTRAINT outbox_jobs_type_check,
      DROP CONSTRAINT outbox_jobs_target_check,
      ADD CONSTRAINT outbox_jobs_type_check CHECK ((%s) OR job_type='olist.export'),
      ADD CONSTRAINT outbox_jobs_target_check CHECK (
        (olist_export_id IS NULL AND (%s))
        OR (job_type='olist.export' AND olist_export_id IS NOT NULL
          AND channel_event_id IS NULL AND transient_media_id IS NULL
          AND message_id IS NULL AND n8n_command_id IS NULL
          AND chat_media_id IS NULL AND deletion_reason IS NULL
          AND queue='olist' AND effect_policy='queryable'))
    $olist_constraints$,previous_type_check,previous_target_check);
END;
$olist_outbox$;
CREATE UNIQUE INDEX outbox_jobs_olist_export_key ON crm.outbox_jobs(olist_export_id) WHERE job_type='olist.export';

CREATE FUNCTION crm.protect_olist_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'olist effect reservation is durable'; END IF;
 IF OLD.outcome<>'reserved' OR (NEW.id,NEW.account_key,NEW.export_id,NEW.resource_id,NEW.stage,NEW.fence,NEW.generation,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.account_key,OLD.export_id,OLD.resource_id,OLD.stage,OLD.fence,OLD.generation,OLD.created_at) THEN
   RAISE EXCEPTION 'olist effect reservation is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_attempts_durable BEFORE UPDATE OR DELETE ON crm.olist_attempts FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_attempt();
