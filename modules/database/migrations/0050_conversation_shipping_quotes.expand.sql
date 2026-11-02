-- T139 / MEVQ: frete estimado is independent from the confirmed order amount.
-- CEPs, package inputs and provider results exist only in authenticated envelopes.
CREATE TABLE crm.shipping_quotes (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  subject_id text NOT NULL,
  order_id text NOT NULL REFERENCES crm.orders(id),
  order_version integer NOT NULL CHECK (order_version > 0),
  total_pieces integer NOT NULL CHECK (total_pieces >= 0),
  quote_envelope jsonb NOT NULL CHECK (
    jsonb_typeof(quote_envelope) = 'object'
    AND quote_envelope ->> 'algorithm' = 'AES-256-GCM'
    AND quote_envelope ->> 'version' = '1'),
  created_by text NOT NULL REFERENCES crm.users(id),
  created_at timestamptz NOT NULL,
  selected_service_id integer CHECK (selected_service_id > 0),
  selected_by text REFERENCES crm.users(id),
  selected_at timestamptz,
  superseded_at timestamptz,
  FOREIGN KEY (subject_id, conversation_id)
    REFERENCES crm.conversation_subjects(id, conversation_id),
  CHECK ((selected_service_id IS NULL AND selected_by IS NULL AND selected_at IS NULL)
    OR (selected_service_id IS NOT NULL AND selected_by IS NOT NULL AND selected_at IS NOT NULL))
);
CREATE INDEX shipping_quotes_order ON crm.shipping_quotes(order_id, created_at DESC, id);

CREATE TABLE crm.shipping_quote_commands (
  operation text NOT NULL CHECK (operation IN ('quote', 'select')),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  quote_id text NOT NULL REFERENCES crm.shipping_quotes(id),
  actor_id text NOT NULL REFERENCES crm.users(id),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (operation, idempotency_key)
);
