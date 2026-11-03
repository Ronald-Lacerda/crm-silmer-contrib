-- OPS-ERR-01..08: technical metadata only; no payload, user message or stack.
-- Versions survive deletion/recreation of a grouped incident, so an old tab
-- cannot triage a new incarnation using a recycled version number.
CREATE SEQUENCE crm.operational_incident_version AS integer;
CREATE TABLE crm.operational_incidents (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('api', 'worker', 'n8n')),
  code text NOT NULL CHECK (code IN (
    'API_5XX', 'API_NOT_READY', 'WORKER_RETRY', 'WORKER_DEAD_LETTER',
    'WORKER_OUTCOME_UNKNOWN', 'N8N_FAILED', 'N8N_OUTCOME_UNKNOWN',
    'N8N_PROCESSING_EXPIRED')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'investigating', 'resolved')),
  occurrences bigint NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT nextval('crm.operational_incident_version') CHECK (version > 0),
  request_id uuid,
  correlation_id uuid,
  UNIQUE (source, code),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX operational_incidents_retention ON crm.operational_incidents(last_seen_at);

CREATE TABLE crm.operational_incident_receipts (
  event_key text PRIMARY KEY CHECK (event_key ~ '^[a-f0-9]{64}$'),
  incident_id text NOT NULL REFERENCES crm.operational_incidents(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL
);
CREATE INDEX operational_incident_receipts_retention ON crm.operational_incident_receipts(observed_at);

CREATE TABLE crm.operational_incident_history (
  id text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES crm.operational_incidents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('new', 'investigating', 'resolved')),
  occurred_at timestamptz NOT NULL,
  actor_id text REFERENCES crm.users(id) ON DELETE SET NULL,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (incident_id, version)
);
CREATE INDEX operational_incident_history_retention ON crm.operational_incident_history(occurred_at);
