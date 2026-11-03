-- OA-T01: encrypted commercial suggestions, never an autonomous order command.
CREATE TABLE crm.order_assistance_evaluations (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES crm.conversations(id),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  automation_epoch bigint NOT NULL CHECK (automation_epoch >= 0),
  signal text NOT NULL CHECK (signal IN ('purchase_confirmed', 'not_ready', 'withdrawn', 'unsupported', 'uncertain', 'analysis_failed')),
  blocked_reason text CHECK (blocked_reason IN ('pending_order_exists','subject_target_required')),
  evidence_message_id text,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (evidence_message_id, conversation_id) REFERENCES crm.messages(id, conversation_id),
  UNIQUE (conversation_id, source_revision)
);
CREATE TABLE crm.order_assistance_suggestions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES crm.conversations(id),
  evaluation_id text NOT NULL UNIQUE REFERENCES crm.order_assistance_evaluations(id),
  evidence_message_id text NOT NULL,
  subject_id text,
  subject_version integer CHECK (subject_version > 0),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  automation_epoch bigint NOT NULL CHECK (automation_epoch >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'deferred', 'rejected', 'obsolete')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  details_envelope jsonb NOT NULL CHECK (jsonb_typeof(details_envelope) = 'object' AND details_envelope ->> 'algorithm' = 'AES-256-GCM'),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  FOREIGN KEY (evidence_message_id, conversation_id) REFERENCES crm.messages(id, conversation_id),
  FOREIGN KEY (subject_id, conversation_id) REFERENCES crm.conversation_subjects(id, conversation_id),
  UNIQUE (conversation_id, evidence_message_id)
);
CREATE UNIQUE INDEX order_assistance_one_pending ON crm.order_assistance_suggestions(conversation_id) WHERE status = 'pending';
CREATE INDEX order_assistance_suggestions_created ON crm.order_assistance_suggestions(created_at);
CREATE TABLE crm.order_assistance_decisions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES crm.conversations(id),
  suggestion_id text REFERENCES crm.order_assistance_suggestions(id),
  source_message_id text,
  actor_id text NOT NULL REFERENCES crm.users(id),
  decision text NOT NULL CHECK (decision IN ('accept', 'defer', 'reject', 'missed')),
  reason text NOT NULL CHECK (reason IN ('not_ready', 'withdrawn', 'unsupported', 'wrong_product', 'other', 'ready')),
  order_id text REFERENCES crm.orders(id),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (source_message_id, conversation_id) REFERENCES crm.messages(id, conversation_id),
  CHECK ((decision = 'missed' AND suggestion_id IS NULL AND source_message_id IS NOT NULL AND order_id IS NULL)
      OR (decision <> 'missed' AND suggestion_id IS NOT NULL)),
  CHECK (decision <> 'accept' OR (reason = 'ready' AND order_id IS NOT NULL))
);
CREATE UNIQUE INDEX order_assistance_decision_once ON crm.order_assistance_decisions(suggestion_id) WHERE suggestion_id IS NOT NULL;
CREATE UNIQUE INDEX order_assistance_missed_once ON crm.order_assistance_decisions(conversation_id, source_message_id) WHERE decision = 'missed';
CREATE TABLE crm.order_assistance_commands (
  actor_id text NOT NULL REFERENCES crm.users(id),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  decision_id text NOT NULL REFERENCES crm.order_assistance_decisions(id),
  PRIMARY KEY (actor_id, idempotency_key)
);
