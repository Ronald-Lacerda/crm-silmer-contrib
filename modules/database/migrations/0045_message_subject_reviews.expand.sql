-- ADR 032 / CP-12, CP-14, CP-16: the agent records the subject of the inbound
-- messages a turn answered; the seller is asked only where the agent was
-- unsure. A review row marks an inbound message that needs a human subject
-- decision. It is resolved when a person saves the message's subjects,
-- including "no subject", so later agent turns never overwrite that choice.
-- No message text, summary or PII is stored here: only ids and codes.
CREATE TABLE crm.message_subject_reviews (
  message_id text PRIMARY KEY,
  conversation_id text NOT NULL,
  handoff_id text REFERENCES crm.handoffs(id),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  reason text NOT NULL CHECK (reason IN ('subject_ambiguous', 'human_review')),
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  CONSTRAINT message_subject_review_resolution CHECK (
    (resolved_at IS NULL) = (resolved_by IS NULL)
  ),
  FOREIGN KEY (message_id, conversation_id)
    REFERENCES crm.messages(id, conversation_id)
);

CREATE INDEX message_subject_reviews_open
  ON crm.message_subject_reviews(conversation_id) WHERE resolved_at IS NULL;
