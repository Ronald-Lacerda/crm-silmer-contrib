-- A local withdrawal never forgets the known remote sale or frees the order
-- for a creator. Encrypted legacy modes are authenticated by the application;
-- this independent database fence verifies the recorded origin and zero effects.
ALTER TABLE crm.olist_exports DROP CONSTRAINT olist_exports_state_check;
ALTER TABLE crm.olist_exports ADD CONSTRAINT olist_exports_state_check CHECK
  (state IN ('queued','resolving','ready','reserved','confirmed','linked','uncertain','rejected','invalidated','legacy_review_required'));
ALTER TABLE crm.olist_exports DROP CONSTRAINT olist_exports_check;
ALTER TABLE crm.olist_exports ADD CONSTRAINT olist_exports_check CHECK
  ((state IN ('confirmed','linked','legacy_review_required')) = (remote_id IS NOT NULL));

CREATE FUNCTION crm.olist_legacy_withdrawal_clear(p_export uuid,p_account text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM crm.olist_events WHERE export_id=p_export AND account_key=p_account AND event_code='OLIST_LEGACY_SALE_LINKED')
   AND NOT EXISTS(SELECT 1 FROM crm.olist_export_resources WHERE export_id=p_export)
   AND NOT EXISTS(SELECT 1 FROM crm.olist_attempts WHERE export_id=p_export)
   AND NOT EXISTS(SELECT 1 FROM crm.outbox_jobs WHERE olist_export_id=p_export AND
     (job_type<>'olist.reconcile' OR status<>'completed' OR locked_by IS NOT NULL OR locked_until IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM crm.olist_read_requests WHERE export_id=p_export AND status='queued');
$$;
CREATE FUNCTION crm.protect_olist_legacy_review_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job record;
BEGIN
 IF TG_OP='INSERT' AND NEW.state='legacy_review_required' THEN
   RAISE EXCEPTION 'legacy review hold requires a recorded link';
 END IF;
 IF TG_OP='UPDATE' AND OLD.state='legacy_review_required' AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'legacy review hold is terminal';
 END IF;
 IF TG_OP='UPDATE' AND NEW.state='legacy_review_required' AND OLD.state<>'legacy_review_required' THEN
   -- A status claim already holds its job row. It never waits for this export:
   -- wait for that claim here, then re-read its committed state with VOLATILE.
   FOR job IN SELECT * FROM crm.outbox_jobs WHERE olist_export_id=OLD.id ORDER BY id FOR UPDATE LOOP
     IF job.job_type<>'olist.reconcile' OR job.status<>'completed' OR job.locked_by IS NOT NULL OR job.locked_until IS NOT NULL THEN
       RAISE EXCEPTION 'legacy withdrawal requires isolated recorded evidence';
     END IF;
   END LOOP;
   IF OLD.state<>'linked' OR OLD.remote_id IS NULL OR OLD.remote_number IS NULL
     OR OLD.observed_sale_id IS DISTINCT FROM OLD.remote_id
     OR OLD.observed_sale_number IS DISTINCT FROM OLD.remote_number
     OR (NEW.remote_id,NEW.remote_number,NEW.observed_sale_id,NEW.observed_sale_number)
        IS DISTINCT FROM (OLD.remote_id,OLD.remote_number,OLD.observed_sale_id,OLD.observed_sale_number)
     OR NOT crm.olist_legacy_withdrawal_clear(OLD.id,OLD.account_key) THEN
     RAISE EXCEPTION 'legacy withdrawal requires isolated recorded evidence';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_legacy_review_hold BEFORE INSERT OR UPDATE ON crm.olist_exports
FOR EACH ROW EXECUTE FUNCTION crm.protect_olist_legacy_review_hold();

CREATE OR REPLACE FUNCTION crm.guard_olist_export_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target crm.olist_exports%ROWTYPE;
BEGIN
 SELECT * INTO target FROM crm.olist_exports WHERE id=NEW.export_id AND account_key=NEW.account_key FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'olist invalidation requires an export'; END IF;
 IF target.state='legacy_review_required' THEN
   IF target.remote_id IS NULL OR target.observed_sale_id IS DISTINCT FROM target.remote_id
      OR NOT crm.olist_legacy_withdrawal_clear(target.id,target.account_key) THEN
     RAISE EXCEPTION 'legacy withdrawal requires isolated recorded evidence';
   END IF;
 ELSIF target.state<>'invalidated' THEN
   RAISE EXCEPTION 'olist invalidation requires an invalidated export';
 ELSIF target.remote_id IS NOT NULL OR target.observed_sale_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM crm.olist_attempts WHERE export_id=NEW.export_id AND stage='sale') THEN
   RAISE EXCEPTION 'olist export with a sale attempt cannot be invalidated';
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION crm.reject_olist_sale_for_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE export_state text;
BEGIN
 IF NEW.export_id IS NOT NULL THEN
   SELECT state INTO export_state FROM crm.olist_exports WHERE id=NEW.export_id AND account_key=NEW.account_key FOR SHARE;
   IF export_state='legacy_review_required' THEN RAISE EXCEPTION 'legacy review hold cannot start an effect'; END IF;
   IF NEW.stage='sale' AND export_state='invalidated' THEN RAISE EXCEPTION 'olist invalidated export cannot start a sale'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
-- Block even new dependencies and administrative read claims on the hold.
CREATE FUNCTION crm.reject_olist_legacy_hold_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE export_state text;
BEGIN
 SELECT state INTO export_state FROM crm.olist_exports WHERE id=NEW.export_id AND account_key=NEW.account_key FOR SHARE;
 IF export_state='legacy_review_required' THEN RAISE EXCEPTION 'legacy review hold cannot gain claims'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_legacy_hold_no_bindings BEFORE INSERT OR UPDATE ON crm.olist_export_resources
FOR EACH ROW EXECUTE FUNCTION crm.reject_olist_legacy_hold_claim();
CREATE TRIGGER olist_legacy_hold_no_reads BEFORE INSERT OR UPDATE ON crm.olist_read_requests
FOR EACH ROW EXECUTE FUNCTION crm.reject_olist_legacy_hold_claim();
CREATE FUNCTION crm.reject_olist_legacy_hold_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE export_state text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.olist_export_id IS NOT DISTINCT FROM OLD.olist_export_id THEN RETURN NEW; END IF;
 IF NEW.olist_export_id IS NOT NULL THEN
   SELECT state INTO export_state FROM crm.olist_exports WHERE id=NEW.olist_export_id FOR SHARE;
   IF export_state='legacy_review_required' THEN RAISE EXCEPTION 'legacy review hold cannot gain jobs'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_legacy_hold_no_jobs BEFORE INSERT OR UPDATE OF olist_export_id ON crm.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION crm.reject_olist_legacy_hold_job();
CREATE FUNCTION crm.reject_olist_legacy_hold_job_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.job_type='olist.reconcile' AND OLD.olist_export_id IS NOT NULL AND OLD.status='completed'
   AND (NEW.status,NEW.job_type,NEW.olist_export_id) IS DISTINCT FROM (OLD.status,OLD.job_type,OLD.olist_export_id) THEN
   RAISE EXCEPTION 'completed Olist read job is terminal';
 END IF;
 -- No export lock after the worker has locked a job: ordinary invalidation
 -- locks in the opposite order. Withdrawal locks completed jobs before its
 -- final clear check; whichever transaction wins leaves a visible terminal state.
 IF EXISTS(SELECT 1 FROM crm.olist_exports WHERE id=NEW.olist_export_id AND state='legacy_review_required') THEN
   RAISE EXCEPTION 'legacy review hold cannot update jobs';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER olist_legacy_hold_job_updates BEFORE UPDATE ON crm.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION crm.reject_olist_legacy_hold_job_update();
