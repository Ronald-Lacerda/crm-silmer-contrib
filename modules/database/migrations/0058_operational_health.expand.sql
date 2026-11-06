-- OPSH-01..04: bounded technical state only, one row per operational queue.
-- Fail instead of waiting on production writers or building unbounded indexes.
SET LOCAL lock_timeout = '100ms';
SET LOCAL statement_timeout = '1s';
CREATE TABLE crm.operational_worker_health (
  queue text PRIMARY KEY CHECK (queue IN ('external_effects','media-retention','chat_media')),
  heartbeat_at timestamptz NOT NULL,
  poll_completed_at timestamptz
);
CREATE INDEX outbox_jobs_operational_due
  ON crm.outbox_jobs(available_at) WHERE status IN ('pending','retry');
CREATE INDEX outbox_jobs_operational_queue_due
  ON crm.outbox_jobs(queue, available_at) WHERE status IN ('pending','retry');
CREATE INDEX n8n_commands_operational_processing
  ON crm.n8n_commands(locked_until) WHERE status='processing';
CREATE INDEX operational_receipts_incident_time
  ON crm.operational_incident_receipts(incident_id, observed_at);
CREATE INDEX operational_history_incident_time
  ON crm.operational_incident_history(incident_id, occurred_at);
