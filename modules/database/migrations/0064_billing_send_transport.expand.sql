ALTER TABLE crm.order_billing_send_intents ADD COLUMN queued_source_revision bigint CHECK(queued_source_revision >= 0);
CREATE OR REPLACE FUNCTION crm.guard_billing_send_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c crm.order_billing_charges%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILLING_SEND_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['version','state','blocked_reason','failure_stage','message_id','command_id','updated_at','queued_source_revision'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','state','blocked_reason','failure_stage','message_id','command_id','updated_at','queued_source_revision'])
        OR NEW.version <> OLD.version+1
        OR (OLD.queued_source_revision IS NOT NULL AND NEW.queued_source_revision IS DISTINCT FROM OLD.queued_source_revision)
        OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id)
        OR (OLD.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id) THEN
      RAISE EXCEPTION 'BILLING_SEND_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO c FROM crm.order_billing_charges WHERE id=NEW.charge_id;
    IF c.order_id IS DISTINCT FROM NEW.order_id OR c.amount_cents IS DISTINCT FROM NEW.amount_cents
       OR c.confirmed_at IS DISTINCT FROM NEW.confirmed_at OR c.order_amount_cents IS DISTINCT FROM NEW.order_amount_cents
       OR c.payment_condition IS DISTINCT FROM NEW.payment_condition THEN
      RAISE EXCEPTION 'BILLING_SEND_CHARGE_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- All callback/worker writers update messages. This also captures lease expiry
-- and lost acknowledgements, without inventing a delivery or safe retry.
CREATE FUNCTION crm.sync_billing_send_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i crm.order_billing_send_intents%ROWTYPE; next_state text; proof boolean; at_time timestamptz;
BEGIN
  SELECT * INTO i FROM crm.order_billing_send_intents WHERE message_id=NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  proof := current_setting('crm.billing_before_send_proven',true)=NEW.command_id;
  at_time := coalesce(NEW.delivery_status_at,NEW.sent_at,clock_timestamp());
  IF NEW.delivery_status IN ('delivered','read') THEN next_state := 'delivered';
  ELSIF NEW.status='sent' THEN next_state := 'sent';
  ELSIF i.state='blocked' THEN RETURN NEW;
  ELSIF NEW.status='outcome_unknown' THEN next_state := 'unknown';
  ELSIF NEW.status='failed' THEN
    next_state := CASE WHEN NEW.external_message_id IS NOT NULL OR OLD.status='queued' OR proof THEN 'failed' ELSE 'unknown' END;
  ELSIF NEW.status='sending' THEN next_state := 'sending';
  ELSE RETURN NEW; END IF;
  IF i.state='delivered' AND next_state<>'delivered' THEN RETURN NEW; END IF;
  IF i.state='sent' AND next_state IN ('sending','unknown') THEN RETURN NEW; END IF;
  IF next_state=i.state THEN RETURN NEW; END IF;
  UPDATE crm.order_billing_send_intents SET state=next_state,blocked_reason=NULL,
    failure_stage=CASE WHEN next_state='failed' AND NEW.external_message_id IS NULL AND (OLD.status='queued' OR proof) THEN 'before_send' ELSE NULL END,
    version=version+1,updated_at=at_time WHERE id=i.id;
  INSERT INTO crm.order_billing_send_events(id,intent_id,state,occurred_at) VALUES(gen_random_uuid(),i.id,next_state,at_time);
  INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
    VALUES(gen_random_uuid()::text,'system:billing-send','billing.send.transport','billing-intent',i.id::text,(i.version+1)::text,'BILLING_TRANSPORT_'||upper(next_state),NEW.command_id,at_time);
  RETURN NEW;
END $$;
CREATE TRIGGER billing_send_message_state AFTER UPDATE OF status,delivery_status,external_message_id ON crm.messages
FOR EACH ROW EXECUTE FUNCTION crm.sync_billing_send_message();
