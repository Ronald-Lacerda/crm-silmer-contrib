-- OLIST-T26: additive enrichment; never rewrite historical ficha or amounts.
CREATE TABLE crm.order_olist_source_revisions (
  order_id text NOT NULL REFERENCES crm.orders(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  order_version bigint NOT NULL CHECK (order_version > 0),
  source_hmac text NOT NULL CHECK (source_hmac ~ '^[a-f0-9]{64}$'),
  data_envelope jsonb NOT NULL CHECK (crm.olist_envelope_valid(data_envelope)),
  updated_by text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(order_id, revision)
);
CREATE TRIGGER order_olist_sources_append_only
BEFORE UPDATE OR DELETE ON crm.order_olist_source_revisions
FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_history();
