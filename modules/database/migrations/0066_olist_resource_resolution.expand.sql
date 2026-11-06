-- OLIST-T22: freeze the shared entity base separately from a composed request.
-- No account, permission or effect is enabled by this expand migration.
ALTER TABLE crm.olist_resources
  ADD COLUMN payload_hash text CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN snapshot_envelope jsonb CHECK (snapshot_envelope IS NULL OR crm.olist_envelope_valid(snapshot_envelope)),
  ADD CONSTRAINT olist_resource_base_complete CHECK ((payload_hash IS NULL) = (snapshot_envelope IS NULL));
ALTER TABLE crm.olist_attempts
  ADD COLUMN request_hash text CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN request_envelope jsonb CHECK (request_envelope IS NULL OR crm.olist_envelope_valid(request_envelope)),
  ADD COLUMN parent_attempt_id uuid,
  ADD CONSTRAINT olist_attempt_account_identity UNIQUE(id,account_key),
  ADD CONSTRAINT olist_composite_same_account FOREIGN KEY(parent_attempt_id,account_key) REFERENCES crm.olist_attempts(id,account_key),
  ADD COLUMN observed_remote_id text CHECK (observed_remote_id ~ '^[1-9][0-9]{0,18}$'),
  ADD CONSTRAINT olist_resource_request_complete CHECK ((request_hash IS NULL) = (request_envelope IS NULL)),
  ADD CONSTRAINT olist_resource_composite_child CHECK (parent_attempt_id IS NULL OR (stage='variation' AND resource_id IS NOT NULL AND request_hash IS NULL AND parent_attempt_id<>id));
CREATE FUNCTION crm.protect_olist_resource_base() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.account_key,NEW.kind,NEW.identity_hash,NEW.reference,NEW.parent_id)
   IS DISTINCT FROM (OLD.id,OLD.account_key,OLD.kind,OLD.identity_hash,OLD.reference,OLD.parent_id)
   OR (OLD.payload_hash IS NOT NULL AND (NEW.payload_hash,NEW.snapshot_envelope) IS DISTINCT FROM (OLD.payload_hash,OLD.snapshot_envelope)) THEN
   RAISE EXCEPTION 'olist resource identity and base are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_resources_base_immutable BEFORE UPDATE ON crm.olist_resources FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_resource_base();
CREATE OR REPLACE FUNCTION crm.protect_olist_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'olist effect reservation is durable'; END IF;
 IF OLD.outcome<>'reserved' OR (OLD.observed_remote_id IS NOT NULL AND NEW.observed_remote_id IS DISTINCT FROM OLD.observed_remote_id) OR (NEW.id,NEW.account_key,NEW.export_id,NEW.resource_id,NEW.stage,NEW.fence,NEW.generation,NEW.created_at,NEW.request_hash,NEW.request_envelope,NEW.parent_attempt_id)
   IS DISTINCT FROM (OLD.id,OLD.account_key,OLD.export_id,OLD.resource_id,OLD.stage,OLD.fence,OLD.generation,OLD.created_at,OLD.request_hash,OLD.request_envelope,OLD.parent_attempt_id) THEN
   RAISE EXCEPTION 'olist effect reservation is immutable';
 END IF;
 RETURN NEW;
END;
$$;

CREATE INDEX olist_attempts_resource_history ON crm.olist_attempts(resource_id,created_at DESC,id DESC) WHERE resource_id IS NOT NULL;
CREATE INDEX olist_attempts_composite_children ON crm.olist_attempts(parent_attempt_id) WHERE parent_attempt_id IS NOT NULL;
