-- COB-CHAT-B02: durable human intent; no transport or production flag enabled.
ALTER TABLE crm.order_billing_charges ADD CONSTRAINT billing_charge_order_identity UNIQUE(id,order_id);

CREATE TABLE crm.order_billing_send_intents (
  id uuid PRIMARY KEY,
  order_id text NOT NULL,
  charge_id uuid NOT NULL,
  conversation_id text NOT NULL REFERENCES crm.conversations(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES crm.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('issue','send_existing','balance','correct','retry')),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  state text NOT NULL DEFAULT 'waiting_link' CHECK(state IN ('waiting_link','queued','sending','sent','delivered','failed','unknown','blocked')),
  blocked_reason text CHECK(blocked_reason IN ('OWNER_CHANGED','ACTOR_DISABLED','CONVERSATION_CLOSED','AGREEMENT_CHANGED','CHARGE_EXPIRED','PAYMENT_CONFIRMED','INBOUND_CHANGED','SENDING_DISABLED')),
  failure_stage text CHECK(failure_stage = 'before_send'),
  retry_of_intent_id uuid,
  supersedes_charge_id uuid,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 100 AND 9007199254740991),
  order_version bigint NOT NULL CHECK(order_version > 0),
  billing_version bigint NOT NULL CHECK(billing_version > 0),
  conversation_version bigint NOT NULL CHECK(conversation_version > 0),
  owner_id text,
  order_owner_id text,
  cycle_number integer NOT NULL CHECK(cycle_number > 0),
  automation_epoch bigint NOT NULL CHECK(automation_epoch >= 0),
  inbound_revision bigint NOT NULL CHECK(inbound_revision >= 0),
  confirmed_at timestamptz NOT NULL,
  order_amount_cents bigint NOT NULL CHECK(order_amount_cents >= 100),
  payment_condition text NOT NULL,
  message_id text REFERENCES crm.messages(id) ON DELETE RESTRICT,
  command_id text REFERENCES crm.n8n_commands(command_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(id,charge_id),
  FOREIGN KEY(charge_id,order_id) REFERENCES crm.order_billing_charges(id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(supersedes_charge_id,order_id) REFERENCES crm.order_billing_charges(id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(retry_of_intent_id,charge_id) REFERENCES crm.order_billing_send_intents(id,charge_id) ON DELETE RESTRICT,
  CHECK((action='retry') = (retry_of_intent_id IS NOT NULL)),
  CHECK((action='correct') = (supersedes_charge_id IS NOT NULL)),
  CHECK(failure_stage IS NULL OR state='failed'),
  CHECK((state='blocked') = (blocked_reason IS NOT NULL))
);
CREATE UNIQUE INDEX billing_send_one_root ON crm.order_billing_send_intents(charge_id) WHERE retry_of_intent_id IS NULL;
CREATE UNIQUE INDEX billing_send_one_retry ON crm.order_billing_send_intents(retry_of_intent_id) WHERE retry_of_intent_id IS NOT NULL;
CREATE UNIQUE INDEX billing_send_one_correction ON crm.order_billing_send_intents(supersedes_charge_id) WHERE supersedes_charge_id IS NOT NULL;
CREATE UNIQUE INDEX billing_send_message_identity ON crm.order_billing_send_intents(message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX billing_send_command_identity ON crm.order_billing_send_intents(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX billing_send_order ON crm.order_billing_send_intents(order_id,created_at,id);
CREATE INDEX billing_send_pending ON crm.order_billing_send_intents(charge_id) WHERE state IN ('waiting_link','queued','sending','unknown');

CREATE FUNCTION crm.guard_billing_send_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c crm.order_billing_charges%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILLING_SEND_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['version','state','blocked_reason','failure_stage','message_id','command_id','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','state','blocked_reason','failure_stage','message_id','command_id','updated_at'])
        OR NEW.version <> OLD.version+1 THEN
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
CREATE TRIGGER billing_send_identity BEFORE INSERT OR UPDATE OR DELETE ON crm.order_billing_send_intents
FOR EACH ROW EXECUTE FUNCTION crm.guard_billing_send_identity();

CREATE TABLE crm.order_billing_send_events (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES crm.order_billing_send_intents(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK(state IN ('waiting_link','queued','sending','sent','delivered','failed','unknown','blocked')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX billing_send_events_intent ON crm.order_billing_send_events(intent_id,occurred_at,id);
CREATE TRIGGER billing_send_events_immutable BEFORE UPDATE OR DELETE ON crm.order_billing_send_events
FOR EACH ROW EXECUTE FUNCTION crm.reject_deal_history_mutation();
