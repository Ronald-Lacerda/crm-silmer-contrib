-- OLIST-T07: one stable command fingerprint per immutable export snapshot.
-- Existing snapshots are not reinterpreted or backfilled; creators stay off.
ALTER TABLE crm.olist_exports ADD COLUMN command_fingerprint text
  CHECK (command_fingerprint ~ '^[a-f0-9]{64}$');
CREATE OR REPLACE FUNCTION crm.protect_olist_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_key,NEW.context_key,NEW.connection_generation,NEW.order_id,NEW.order_version,NEW.settings_version,NEW.actor_id,NEW.authorization_version,NEW.reference,NEW.snapshot_envelope,NEW.command_fingerprint)
    IS DISTINCT FROM (OLD.account_key,OLD.context_key,OLD.connection_generation,OLD.order_id,OLD.order_version,OLD.settings_version,OLD.actor_id,OLD.authorization_version,OLD.reference,OLD.snapshot_envelope,OLD.command_fingerprint) THEN
    RAISE EXCEPTION 'olist export snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
