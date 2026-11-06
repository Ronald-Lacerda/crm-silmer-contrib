-- ACT-T04 / RFC 048 / ADR 061 (MET-06..08): a lost lead is an explicit human
-- declaration, never inferred. It lives in its own immutable, per-conversation
-- versioned log: it does not change the conversation state or closure, the
-- order status, nor the retired Negócio tables (ADR 004).
--
-- `outro` carries a 1-140 character note, stored only as an AES-256-GCM
-- envelope bound to the event id. Logs, audit, idempotency and aggregations
-- never see it. A manual `reopened` event corrects the previous loss; a new
-- customer message reopens it by derivation, without any write here.
CREATE TABLE crm.lead_outcome_events (
  id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 255),
  conversation_id text NOT NULL
    REFERENCES crm.conversations (id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  outcome text NOT NULL CHECK (outcome IN ('lost', 'reopened')),
  reason_code text CHECK (reason_code IN (
    'preco', 'prazo', 'concorrente', 'silencio', 'indisponivel', 'outro'
  )),
  note_envelope jsonb,
  owner_id text NOT NULL REFERENCES crm.users (id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES crm.users (id) ON DELETE RESTRICT,
  -- The customer message the loss was declared over. While it is still the
  -- conversation's last customer message, the loss is active.
  last_inbound_message_id text REFERENCES crm.messages (id) ON DELETE RESTRICT,
  correlation_id text NOT NULL CHECK (correlation_id <> ''),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT lead_outcome_events_version_key UNIQUE (conversation_id, version),
  CONSTRAINT lead_outcome_events_shape CHECK (
    (outcome = 'lost' AND reason_code IS NOT NULL
      AND (reason_code = 'outro') = (note_envelope IS NOT NULL))
    OR (outcome = 'reopened' AND reason_code IS NULL AND note_envelope IS NULL
      AND last_inbound_message_id IS NULL)
  ),
  CONSTRAINT lead_outcome_events_note_envelope CHECK (
    note_envelope IS NULL OR (
      jsonb_typeof(note_envelope) = 'object'
      AND note_envelope ->> 'algorithm' = 'AES-256-GCM'
      AND note_envelope ->> 'version' = '1'
      AND note_envelope ->> 'keyVersion' = '1'
      AND note_envelope ? 'ciphertext'
      AND note_envelope ? 'iv'
      AND note_envelope ? 'tag'
      AND NOT note_envelope ? 'text'
    )
  )
);

-- Loss reads per owner and window (GET /dashboard/metrics/losses).
CREATE INDEX lead_outcome_events_lost_owner_idx
  ON crm.lead_outcome_events (owner_id, occurred_at)
  WHERE outcome = 'lost';
CREATE INDEX lead_outcome_events_lost_window_idx
  ON crm.lead_outcome_events (occurred_at)
  WHERE outcome = 'lost';

CREATE TRIGGER lead_outcome_events_immutable_rows
  BEFORE UPDATE OR DELETE ON crm.lead_outcome_events
  FOR EACH ROW EXECUTE FUNCTION crm_meta.reject_immutable_change();
CREATE TRIGGER lead_outcome_events_immutable_truncate
  BEFORE TRUNCATE ON crm.lead_outcome_events
  FOR EACH STATEMENT EXECUTE FUNCTION crm_meta.reject_immutable_change();
