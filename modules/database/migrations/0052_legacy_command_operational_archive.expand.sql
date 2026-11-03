-- OPS-INBOX-ACK-04: operational disposition is separate from delivery outcome.
-- The marker follows the command lifecycle; 30-day incident retention never
-- removes it and cannot cause an uncertain retired-transport send to reappear.
CREATE TABLE crm.n8n_command_operational_archives (
  command_id text PRIMARY KEY REFERENCES crm.n8n_commands(command_id) ON DELETE RESTRICT,
  archived_at timestamptz NOT NULL,
  archived_by text REFERENCES crm.users(id) ON DELETE SET NULL,
  reason_code text NOT NULL CHECK (reason_code = 'legacy_transport_retired_outcome_unknown'),
  workflow_version text NOT NULL CHECK (workflow_version = 'waha-webjs-1'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
