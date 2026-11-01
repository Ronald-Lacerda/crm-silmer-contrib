-- T138 / MEV-13: server-owned OAuth credentials. No recipient or quote is stored.
-- Context separates sandbox, production, application id and callback URL.
CREATE TABLE crm.shipping_connections (
  context_key text PRIMARY KEY CHECK (context_key ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  token_envelope jsonb,
  expires_at timestamptz,
  reconnect_required boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  refresh_started_at timestamptz,
  connected_by text REFERENCES crm.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_envelope IS NULL AND expires_at IS NULL)
    OR (jsonb_typeof(token_envelope) = 'object'
      AND token_envelope ->> 'algorithm' = 'AES-256-GCM'
      AND token_envelope ->> 'version' = '1' AND expires_at IS NOT NULL))
);

CREATE TABLE crm.shipping_oauth_states (
  context_key text NOT NULL REFERENCES crm.shipping_connections(context_key),
  actor_id text NOT NULL REFERENCES crm.users(id),
  connection_version bigint NOT NULL CHECK (connection_version >= 0),
  session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (context_key, actor_id, session_hash)
);
CREATE INDEX shipping_oauth_states_expiry ON crm.shipping_oauth_states(expires_at);
