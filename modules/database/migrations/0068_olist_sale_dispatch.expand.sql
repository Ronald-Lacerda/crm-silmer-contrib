-- OLIST-T08: freeze the verified resource mapping and sale readback.
-- No account, worker or remote effect is enabled by this expand migration.
ALTER TABLE crm.olist_exports
  ADD COLUMN observed_sale_id text CHECK (observed_sale_id ~ '^[1-9][0-9]{0,18}$'),
  ADD COLUMN observed_sale_number text CHECK (octet_length(observed_sale_number) BETWEEN 1 AND 64),
  ADD COLUMN last_error_code text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ADD COLUMN resource_mapping_hash text CHECK (resource_mapping_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN resource_mapping_envelope jsonb CHECK (resource_mapping_envelope IS NULL OR crm.olist_envelope_valid(resource_mapping_envelope)),
  ADD COLUMN readback_envelope jsonb CHECK (readback_envelope IS NULL OR crm.olist_envelope_valid(readback_envelope)),
  ADD CONSTRAINT olist_sale_mapping_complete CHECK ((resource_mapping_hash IS NULL) = (resource_mapping_envelope IS NULL));
ALTER TABLE crm.olist_attempts ADD COLUMN observed_remote_number text CHECK (octet_length(observed_remote_number) BETWEEN 1 AND 64);
CREATE FUNCTION crm.protect_olist_sale_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.observed_sale_id IS NOT NULL AND NEW.observed_sale_id IS DISTINCT FROM OLD.observed_sale_id)
   OR (OLD.observed_sale_number IS NOT NULL AND NEW.observed_sale_number IS DISTINCT FROM OLD.observed_sale_number)
   OR (OLD.resource_mapping_hash IS NOT NULL AND (NEW.resource_mapping_hash,NEW.resource_mapping_envelope) IS DISTINCT FROM (OLD.resource_mapping_hash,OLD.resource_mapping_envelope))
   OR (OLD.readback_envelope IS NOT NULL AND NEW.readback_envelope IS DISTINCT FROM OLD.readback_envelope) THEN
   RAISE EXCEPTION 'olist sale evidence is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_sale_evidence_immutable BEFORE UPDATE ON crm.olist_exports FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_sale_evidence();
CREATE OR REPLACE FUNCTION crm.protect_olist_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'olist effect reservation is durable'; END IF;
 IF OLD.outcome<>'reserved' OR (OLD.observed_remote_id IS NOT NULL AND NEW.observed_remote_id IS DISTINCT FROM OLD.observed_remote_id)
   OR (OLD.observed_remote_number IS NOT NULL AND NEW.observed_remote_number IS DISTINCT FROM OLD.observed_remote_number)
   OR (NEW.id,NEW.account_key,NEW.export_id,NEW.resource_id,NEW.stage,NEW.fence,NEW.generation,NEW.created_at,NEW.request_hash,NEW.request_envelope,NEW.parent_attempt_id)
   IS DISTINCT FROM (OLD.id,OLD.account_key,OLD.export_id,OLD.resource_id,OLD.stage,OLD.fence,OLD.generation,OLD.created_at,OLD.request_hash,OLD.request_envelope,OLD.parent_attempt_id) THEN
   RAISE EXCEPTION 'olist effect reservation is immutable';
 END IF;
 RETURN NEW;
END;
$$;
