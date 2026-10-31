-- AGENTE-OBS-01: one row per assistant turn the CRM accepted (a reply
-- reservation or a handoff), for the "Desempenho do Vendedor" panel.
--
-- Privacy: codes, counts and times only. No customer text, name, phone,
-- briefing value or message content is ever stored here; every free value is
-- bounded by a CHECK so a template that leaks text fails instead of storing it.
--
-- One row per n8n receipt: an idempotent replay never adds a second row.
-- Expand-only: the previous release neither reads nor writes this table.
CREATE TABLE crm.automation_turns (
  id text PRIMARY KEY,
  n8n_event_id text NOT NULL UNIQUE
    REFERENCES crm.n8n_events (id) ON DELETE RESTRICT,
  conversation_id text NOT NULL
    REFERENCES crm.conversations (id) ON DELETE RESTRICT,
  event_type text NOT NULL
    CHECK (event_type IN ('message.send.requested', 'handoff.requested')),
  asked_field text CHECK (asked_field ~ '^[a-z_]{1,48}$'),
  answer_status text CHECK (answer_status IN (
    'answered', 'unclear', 'undecided', 'question', 'deferred', 'other', 'none'
  )),
  ficha_filled smallint NOT NULL CHECK (ficha_filled BETWEEN 0 AND 64),
  ficha_total smallint NOT NULL CHECK (ficha_total BETWEEN 0 AND 64),
  trigger text CHECK (trigger ~ '^[a-z0-9_]{1,64}$'),
  model text CHECK (model ~ '^[a-z0-9._-]{1,64}$'),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 600000),
  media_kind text CHECK (media_kind IN ('text', 'image', 'audio', 'sticker')),
  workflow_key text NOT NULL CHECK (octet_length(workflow_key) BETWEEN 1 AND 128),
  workflow_version text NOT NULL
    CHECK (octet_length(workflow_version) BETWEEN 1 AND 128),
  handoff_reason text CHECK (handoff_reason ~ '^[a-z_]{1,64}$'),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT automation_turns_ficha_progress CHECK (ficha_filled <= ficha_total),
  CONSTRAINT automation_turns_handoff_reason CHECK (
    (event_type = 'handoff.requested') = (handoff_reason IS NOT NULL)
  )
);

CREATE INDEX automation_turns_occurred
  ON crm.automation_turns (occurred_at);
CREATE INDEX automation_turns_conversation
  ON crm.automation_turns (conversation_id, occurred_at DESC);

-- A reply or handoff refused by the automation fence leaves no receipt; the
-- panel counts those refusals from this audit code.
CREATE INDEX audit_events_stale_fence
  ON crm.audit_events (occurred_at)
  WHERE action = 'integration.n8n.stale_fence';
