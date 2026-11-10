import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOrderBillingChatRuntime } from '../apps/api/src/order-billing-chat-runtime.js';
import { createOrderBillingRuntime } from '../apps/api/src/order-billing-runtime.js';
import { decryptOrderPrivateJson } from '../modules/orders/src/index.js';
import {
  PostgresN8nCommandOutbox,
  PostgresN8nCommandStore,
  PostgresN8nIntegrationRepository,
  createN8nIntegrationService,
  decryptJson,
} from '../modules/n8n-integration/src/index.js';
import {
  seed,
  KEY,
  SELLER,
  NOW,
  cancelOrder,
} from './support/order-billing-chat-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const OTHER = { id: 'billing-other', kind: 'human' };
const ENV = {
  ORDER_BILLING_ENABLED: 'true',
  ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
  N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
  INBOX_MESSAGE_ENVELOPE_KEY: KEY.toString('base64'),
};
let now = NOW;
/** @param {string} id @param {string} executionId */
const technical = (id, executionId) => ({
  actor: 'AUTOMATION_EXECUTOR',
  correlationId: `correlation-${id}`,
  credentialVersion: 'current',
  executionId,
  idempotencyKey: id,
  requestId: `request-${id}`,
  workflowKey: 'whatsapp-mvp',
  workflowVersion: 'evolution-billing-test-1',
});

if (!url) {
  test(
    'Billing send transport requires dedicated TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(
    new URL(url).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9_]+)?$/u,
    'Only dedicated synthetic databases may be reset',
  );
  const pool = new Pool({ connectionString: url, max: 10 });
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
  const outboundMessageOutbox = new PostgresN8nCommandOutbox({
    envelopeKey: KEY,
  });
  const options = {
    access: {
      authorizeRead: async () => ({ actor: SELLER }),
      authorizeWrite: async () => ({ actor: SELLER }),
    },
    clock: () => now,
    environment: ENV,
    outboundMessageOutbox,
  };
  const chat = createOrderBillingChatRuntime(database, options);
  const legacy = createOrderBillingRuntime(database, {
    ...options,
    billingChat: chat,
  });
  const repository = new PostgresN8nIntegrationRepository({
    database,
    envelopeKey: KEY,
    billingSendEnabled: true,
  });
  const service = createN8nIntegrationService({
    repository,
    clock: () => now,
    idFactory: (kind) => `${kind}-${randomUUID()}`,
  });
  const store = new PostgresN8nCommandStore({
    database,
    envelopeKey: KEY,
    billingSendEnabled: true,
  });

  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    for (const actor of [SELLER, OTHER]) {
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic','Pessoa sintética')",
        [actor.id, `${actor.id}@example.test`],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
        [actor.id],
      );
    }
  });
  beforeEach(() => {
    now = NOW;
  });
  after(() => pool.end());

  /** @param {string} orderId @param {any} [fields] */
  async function input(orderId, fields = {}) {
    const row = (
      await pool.query(
        'SELECT o.version,o.conversation_id,c.version AS conversation_version,p.version AS billing_version FROM crm.orders o JOIN crm.conversations c ON c.id=o.conversation_id LEFT JOIN crm.order_billing_plans p ON p.order_id=o.id WHERE o.id=$1',
        [orderId],
      )
    ).rows[0];
    return {
      actor: SELLER,
      orderId,
      conversationId: row.conversation_id,
      expectedVersion: Number(row.version),
      expectedConversationVersion: Number(row.conversation_version),
      expectedBillingVersion: Number(row.billing_version ?? 0),
      action: 'issue',
      percent: 30,
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...fields,
    };
  }
  async function issue() {
    const orderId = await seed(pool, { conversation: true, amount: 120000 });
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='em_atendimento',inbound_revision=1 WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)",
      [orderId],
    );
    const intent = await chat.submit(await input(orderId));
    assert.equal(intent.state, 'waiting_link');
    return { orderId, intent };
  }
  /** @param {string} intentId */
  const intentRow = async (intentId) =>
    (
      await pool.query(
        'SELECT * FROM crm.order_billing_send_intents WHERE id=$1',
        [intentId],
      )
    ).rows[0];
  /** @param {any} intent */
  async function checkout(intent) {
    const executionId = randomUUID();
    assert.equal(
      (
        await legacy.reserve({
          chargeId: intent.chargeId,
          executionId,
          correlationId: randomUUID(),
        })
      ).allowed,
      true,
    );
    return {
      chargeId: intent.chargeId,
      executionId,
      checkoutUrl: `https://pay.infinitepay.io/synthetic/${intent.chargeId}`,
      correlationId: randomUUID(),
    };
  }
  /** @param {any} intent */
  async function ready(intent) {
    const callback = await checkout(intent);
    await legacy.created(callback);
    return intentRow(intent.id);
  }
  /** @param {any} row */
  async function reserve(row) {
    const delivery = await store.loadForDelivery(row.command_id, { now });
    assert.ok(delivery);
    assert.equal(delivery.payload.billing_send, true);
    const attemptId = randomUUID(),
      executionId = randomUUID();
    assert.equal(
      await store.markProcessing(row.command_id, {
        attemptId,
        now,
        payloadHash: delivery.payloadHash,
      }),
      true,
    );
    const id = randomUUID();
    assert.equal(
      (
        await service.recordEvent({
          ...delivery.payload,
          event_id: id,
          event_type: 'message.send.requested',
          occurred_at: now.toISOString(),
          technical: technical(id, executionId),
        })
      ).send_authorized,
      true,
    );
    return { row, delivery, attemptId, executionId };
  }
  /** @param {any} reserved @param {string} eventType @param {any} [fields] */
  function event(reserved, eventType, fields = {}) {
    const id = randomUUID();
    return {
      command_id: reserved.row.command_id,
      conversation_id: reserved.row.conversation_id,
      automation_epoch: Number(reserved.row.automation_epoch),
      source_revision: Number(reserved.row.queued_source_revision),
      schema_version: '1.0',
      event_id: id,
      event_type: eventType,
      occurred_at: now.toISOString(),
      technical: technical(id, reserved.executionId),
      ...fields,
    };
  }
  /** @param {any} reserved */
  const preflight = (reserved) =>
    repository.readReservedSend({
      commandId: reserved.row.command_id,
      technical: technical(randomUUID(), reserved.executionId),
      now,
    });
  /** @param {any} intent */
  const payment = (intent) =>
    legacy.payment({
      chargeId: intent.chargeId,
      transactionNsu: randomUUID(),
      invoiceSlug: randomUUID(),
      amountCents: intent.amountCents,
      paidAmountCents: intent.amountCents,
      method: 'pix',
      installments: 1,
      receiptUrl: null,
      correlationId: randomUUID(),
    });
  /** @param {string} orderId @param {any} prior */
  async function retryInput(orderId, prior) {
    const request = await input(orderId, {
      action: 'retry',
      intentId: prior.id,
      expectedIntentVersion: Number(prior.version),
    });
    delete request.percent;
    return request;
  }

  test('COB-REL-01: cancellation before checkout reservation blocks the waiting intent without creating a message', async () => {
    const { orderId, intent } = await issue();
    await cancelOrder(pool, orderId);
    assert.equal(
      (
        await legacy.reserve({
          chargeId: intent.chargeId,
          executionId: randomUUID(),
          correlationId: randomUUID(),
        })
      ).allowed,
      false,
    );
    const row = await intentRow(intent.id);
    assert.equal(row.state, 'blocked');
    assert.equal(row.blocked_reason, 'AGREEMENT_CHANGED');
    assert.equal(row.message_id, null);
    assert.equal(
      (
        await pool.query(
          'SELECT execution_id FROM crm.order_billing_charges WHERE id=$1',
          [intent.chargeId],
        )
      ).rows[0].execution_id,
      null,
    );
  });

  test('COB-REL-01: cancellation after transport reservation fails the final preflight and preserves terminal order history', async () => {
    const { orderId, intent } = await issue();
    const reserved = await reserve(await ready(intent));
    assert.equal((await preflight(reserved)).valid, true);
    await cancelOrder(pool, orderId);
    const before = (
      await pool.query('SELECT * FROM crm.orders WHERE id=$1', [orderId])
    ).rows[0];
    assert.equal((await preflight(reserved)).valid, false);
    const row = await intentRow(intent.id);
    assert.equal(row.state, 'blocked');
    assert.equal(row.blocked_reason, 'AGREEMENT_CHANGED');
    assert.equal(
      (
        await pool.query(
          'SELECT status,external_message_id FROM crm.messages WHERE id=$1',
          [row.message_id],
        )
      ).rows[0].external_message_id,
      null,
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM crm.orders WHERE id=$1', [orderId]))
        .rows[0],
      before,
    );
  });

  test('COB-REL-01: a late payment on a cancelled order remains unapplied and still invalidates the queued message', async () => {
    const { orderId, intent } = await issue();
    const row = await ready(intent);
    await cancelOrder(pool, orderId);
    const before = (
      await pool.query('SELECT * FROM crm.orders WHERE id=$1', [orderId])
    ).rows[0];
    const result = await payment(intent);
    assert.equal(result.reviewRequired, true);
    assert.deepEqual(
      (await pool.query('SELECT * FROM crm.orders WHERE id=$1', [orderId]))
        .rows[0],
      before,
    );
    const receipt = (
      await pool.query(
        'SELECT application_valid,applied_amount_cents FROM crm.order_billing_payments WHERE charge_id=$1',
        [intent.chargeId],
      )
    ).rows[0];
    assert.equal(receipt.application_valid, false);
    assert.equal(Number(receipt.applied_amount_cents), 0);
    assert.equal((await intentRow(intent.id)).state, 'blocked');
    assert.equal(
      (await intentRow(intent.id)).blocked_reason,
      'AGREEMENT_CHANGED',
    );
    assert.equal(
      (
        await pool.query('SELECT status FROM crm.messages WHERE id=$1', [
          row.message_id,
        ])
      ).rows[0].status,
      'failed',
    );
  });

  test('BAPI-07: concurrent link callbacks compose exactly one encrypted Inbox message and command', async () => {
    const { orderId, intent } = await issue();
    const callback = await checkout(intent);
    await Promise.all([
      legacy.created(callback),
      legacy.created(callback),
      legacy.created(callback),
    ]);
    const row = await intentRow(intent.id);
    assert.equal(row.state, 'queued');
    const messages = (
      await pool.query('SELECT * FROM crm.messages WHERE id=$1', [
        row.message_id,
      ])
    ).rows;
    const commands = (
      await pool.query('SELECT * FROM crm.n8n_commands WHERE command_id=$1', [
        row.command_id,
      ])
    ).rows;
    assert.equal(messages.length, 1);
    assert.equal(commands.length, 1);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_send_intents WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM crm.outbox_jobs WHERE job_type='n8n.command.deliver' AND idempotency_key=$1",
          [row.command_id],
        )
      ).rows[0].n,
      1,
    );
    const decoded = decryptJson(
      messages[0].content_envelope,
      `message:${row.message_id}`,
      KEY,
    );
    assert.ok(decoded.text.includes(callback.checkoutUrl));
    const delivered = await store.loadForDelivery(row.command_id, { now });
    assert.ok(delivered.payload.message.text.includes(callback.checkoutUrl));
    const charge = (
      await pool.query('SELECT * FROM crm.order_billing_charges WHERE id=$1', [
        intent.chargeId,
      ])
    ).rows[0];
    const events = (
      await pool.query(
        'SELECT * FROM crm.order_billing_send_events WHERE intent_id=$1',
        [intent.id],
      )
    ).rows;
    const audits = (
      await pool.query('SELECT * FROM crm.audit_events WHERE target_id=$1', [
        intent.id,
      ])
    ).rows;
    assert.equal(
      JSON.stringify([
        messages,
        commands,
        charge,
        events,
        audits,
        row,
      ]).includes(callback.checkoutUrl),
      false,
    );
  });

  test('BAPI-07/10: real reservation and receipts advance waiting to delivered; late uncertainty cannot regress', async () => {
    const { intent } = await issue();
    const reserved = await reserve(await ready(intent));
    assert.equal((await intentRow(intent.id)).state, 'sending');
    assert.equal((await preflight(reserved)).valid, true);
    const sent = event(reserved, 'message.sent', {
      external_message_id: `synthetic-${randomUUID()}`,
    });
    await service.recordEvent(sent);
    assert.equal((await intentRow(intent.id)).state, 'sent');
    const delivered = event(reserved, 'message.delivered', {
      external_message_id: sent.external_message_id,
    });
    await Promise.all([
      service.recordEvent(delivered),
      service.recordEvent(delivered),
    ]);
    assert.equal((await intentRow(intent.id)).state, 'delivered');
    try {
      await service.recordEvent(event(reserved, 'message.send.unknown'));
    } catch (error) {
      assert.ok(
        error !== null &&
          typeof error === 'object' &&
          'statusCode' in error &&
          [404, 409].includes(Number(error.statusCode)),
        'Late uncertainty may be refused by the settled reservation',
      );
    }
    assert.equal((await intentRow(intent.id)).state, 'delivered');
    assert.equal(
      await store.markOutcomeUnknown(reserved.row.command_id, {
        attemptId: reserved.attemptId,
        now,
        errorCode: 'N8N_COMMAND_TIMEOUT',
      }),
      false,
    );
    const states = (
      await pool.query(
        'SELECT state FROM crm.order_billing_send_events WHERE intent_id=$1 ORDER BY occurred_at,id',
        [intent.id],
      )
    ).rows.map((/** @type {any} */ row) => row.state);
    for (const state of [
      'waiting_link',
      'queued',
      'sending',
      'sent',
      'delivered',
    ])
      assert.ok(states.includes(state));
  });

  test('BAPI-07: a changed owner before checkout callback retains the encrypted link and queues no message', async () => {
    const { intent } = await issue();
    const callback = await checkout(intent);
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2 WHERE id=$1',
      [intent.conversationId, OTHER.id],
    );
    await Promise.all([legacy.created(callback), legacy.created(callback)]);
    const blocked = await intentRow(intent.id);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blocked_reason, 'OWNER_CHANGED');
    assert.equal(blocked.message_id, null);
    assert.equal(blocked.command_id, null);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='conversation.message_delivery_changed'",
          [intent.conversationId],
        )
      ).rows[0].n,
      0,
    );
    const charge = (
      await pool.query(
        'SELECT checkout_envelope FROM crm.order_billing_charges WHERE id=$1',
        [intent.chargeId],
      )
    ).rows[0];
    assert.equal(
      decryptOrderPrivateJson(
        charge.checkout_envelope,
        `billing-checkout:${intent.chargeId}`,
        KEY,
      ).url,
      callback.checkoutUrl,
    );
    assert.equal(JSON.stringify(charge).includes(callback.checkoutUrl), false);
  });

  for (const scenario of ['payment', 'owner', 'agreement', 'expiry']) {
    test(`BAPI-07: ${scenario} after reservation blocks the final send preflight`, async () => {
      const { orderId, intent } = await issue();
      const reserved = await reserve(await ready(intent));
      if (scenario === 'payment') await payment(intent);
      if (scenario === 'owner')
        await pool.query(
          'UPDATE crm.conversations SET assigned_user_id=$2 WHERE id=$1',
          [reserved.row.conversation_id, OTHER.id],
        );
      if (scenario === 'agreement')
        await pool.query(
          "UPDATE crm.orders SET payment_condition='cartao_credito' WHERE id=$1",
          [orderId],
        );
      if (scenario === 'expiry') now = new Date(NOW.getTime() + 86400001);
      assert.equal((await preflight(reserved)).valid, false);
      const blocked = await intentRow(intent.id);
      assert.equal(blocked.state, 'blocked');
      assert.equal(
        blocked.blocked_reason,
        {
          payment: 'PAYMENT_CONFIRMED',
          owner: 'OWNER_CHANGED',
          agreement: 'AGREEMENT_CHANGED',
          expiry: 'CHARGE_EXPIRED',
        }[scenario],
      );
      assert.equal(
        (
          await pool.query(
            'SELECT external_message_id FROM crm.messages WHERE id=$1',
            [blocked.message_id],
          )
        ).rows[0].external_message_id,
        null,
      );
    });
  }

  test('BAPI-07/10: payment after final preflight preserves an in-flight send and accepts its sent callback', async () => {
    const { intent } = await issue();
    const reserved = await reserve(await ready(intent));
    assert.equal((await preflight(reserved)).valid, true);
    await payment(intent);
    assert.equal((await intentRow(intent.id)).state, 'sending');
    await service.recordEvent(
      event(reserved, 'message.sent', {
        external_message_id: `synthetic-${randomUUID()}`,
      }),
    );
    assert.equal((await intentRow(intent.id)).state, 'sent');
    assert.equal(
      (
        await pool.query(
          'SELECT status FROM crm.order_billing_charges WHERE id=$1',
          [intent.chargeId],
        )
      ).rows[0].status,
      'paid',
    );
  });

  test('BAPI-07/10: blocking a queued message publishes one private Inbox invalidation in the same transaction', async () => {
    const { intent } = await issue();
    const queued = await ready(intent);
    await payment(intent);
    const blocked = await intentRow(intent.id);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blocked_reason, 'PAYMENT_CONFIRMED');
    const stream = await pool.query(
      "SELECT payload,event_type FROM crm.domain_events WHERE aggregate_type='conversation' AND aggregate_id=$1 AND event_type='conversation.message_delivery_changed'",
      [queued.conversation_id],
    );
    assert.equal(stream.rows.length, 1);
    assert.deepEqual(stream.rows[0].payload, {
      conversationId: queued.conversation_id,
    });
    const persisted = (
      await pool.query('SELECT status FROM crm.messages WHERE id=$1', [
        queued.message_id,
      ])
    ).rows[0];
    assert.equal(persisted.status, 'failed');
    await database.transaction((/** @type {any} */ client) =>
      chat.paymentRecorded(client, intent.chargeId, randomUUID()),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='conversation.message_delivery_changed'",
          [queued.conversation_id],
        )
      ).rows[0].n,
      1,
    );
  });

  test('BAPI-06/07: a failed Inbox invalidation rolls back payment, message and intent for callback re-delivery', async () => {
    const { intent } = await issue();
    const queued = await ready(intent);
    await pool.query(`CREATE FUNCTION crm.reject_billing_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='conversation.message_delivery_changed' THEN RAISE EXCEPTION 'SYNTHETIC_INVALIDATION_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_billing_invalidation BEFORE INSERT ON crm.domain_events FOR EACH ROW EXECUTE FUNCTION crm.reject_billing_invalidation()`);
    try {
      await assert.rejects(payment(intent), /SYNTHETIC_INVALIDATION_FAILURE/);
      assert.equal((await intentRow(intent.id)).state, 'queued');
      assert.equal(
        (
          await pool.query('SELECT status FROM crm.messages WHERE id=$1', [
            queued.message_id,
          ])
        ).rows[0].status,
        'queued',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM crm.order_billing_payments WHERE charge_id=$1',
            [intent.chargeId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(
        'DROP TRIGGER reject_billing_invalidation ON crm.domain_events; DROP FUNCTION crm.reject_billing_invalidation()',
      );
    }
    await payment(intent);
    assert.equal((await intentRow(intent.id)).state, 'blocked');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_payments WHERE charge_id=$1',
          [intent.chargeId],
        )
      ).rows[0].n,
      1,
    );
  });

  test('BAPI-08/10: a partial receipt queues only the server-calculated balance and full settlement prevents further billing', async () => {
    const { orderId, intent } = await issue();
    await ready(intent);
    await payment(intent);
    const request = await input(orderId, { action: 'balance' });
    delete request.percent;
    const balance = await chat.submit(request);
    assert.equal(balance.amountCents, 84000);
    const queued = await ready(balance);
    assert.equal(queued.state, 'queued');
    assert.notEqual(queued.message_id, (await intentRow(intent.id)).message_id);
    await payment(balance);
    const history = await chat.getHistory({ actor: SELLER, orderId });
    assert.equal(history.receivedAmountCents, 120000);
    assert.equal(history.balanceAmountCents, 0);
    const settledRequest = await input(orderId, { action: 'balance' });
    delete settledRequest.percent;
    await assert.rejects(chat.submit(settledRequest), {
      code: 'BILLING_ALREADY_PAID',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_charges WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].n,
      2,
    );
  });

  test('BAPI-09: proven before-send failure permits exactly one new human intent and command for the same valid link', async () => {
    const { orderId, intent } = await issue();
    const reserved = await reserve(await ready(intent));
    await service.recordEvent(
      event(reserved, 'workflow.failed', {
        failure: {
          phase: 'before_message_send',
          code: 'MEDIA_PREFLIGHT_REJECTED',
        },
      }),
    );
    const failed = await intentRow(intent.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure_stage, 'before_send');
    const request = await retryInput(orderId, failed);
    const [first, replay] = await Promise.all([
      chat.submit(request),
      chat.submit(request),
    ]);
    assert.deepEqual(first, replay);
    assert.equal(first.state, 'queued');
    assert.equal(first.chargeId, intent.chargeId);
    assert.notEqual(first.messageId, failed.message_id);
    assert.notEqual(first.commandId, failed.command_id);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_charges WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await store.loadForDelivery(first.commandId, { now })).payload.message
        .text,
      reserved.delivery.payload.message.text,
    );
    await assert.rejects(chat.submit(await retryInput(orderId, failed)), {
      code: 'BILLING_RETRY_UNSAFE',
    });
  });

  test('BAPI-09: uncertain transport never authorizes a second command or blind retry', async () => {
    const { orderId, intent } = await issue();
    const reserved = await reserve(await ready(intent));
    assert.equal(
      await store.markOutcomeUnknown(reserved.row.command_id, {
        attemptId: reserved.attemptId,
        now,
        errorCode: 'N8N_COMMAND_TIMEOUT',
      }),
      true,
    );
    const unknown = await intentRow(intent.id);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.failure_stage, null);
    assert.equal(
      await store.loadForDelivery(unknown.command_id, { now }),
      null,
    );
    await assert.rejects(chat.submit(await retryInput(orderId, unknown)), {
      code: 'BILLING_RETRY_UNSAFE',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_send_intents WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].n,
      1,
    );
  });

  test('BAPI-10: disabling integrated sends blocks new intents and reservations while financial callbacks remain active', async () => {
    const { orderId, intent } = await issue();
    const row = await ready(intent);
    const disabledChat = createOrderBillingChatRuntime(database, {
      ...options,
      environment: { ...ENV, ORDER_BILLING_CHAT_SEND_ENABLED: 'false' },
    });
    await assert.rejects(disabledChat.submit(await input(orderId)), {
      code: 'BILLING_DISABLED',
    });
    const disabledStore = new PostgresN8nCommandStore({
      database,
      envelopeKey: KEY,
      billingSendEnabled: false,
    });
    const delivery = await disabledStore.loadForDelivery(row.command_id, {
      now,
    });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='conversation.message_delivery_changed'",
          [row.conversation_id],
        )
      ).rows[0].n,
      1,
    );
    if (delivery)
      assert.equal(
        await disabledStore.markProcessing(row.command_id, {
          attemptId: randomUUID(),
          now,
          payloadHash: delivery.payloadHash,
        }),
        false,
      );
    const receiving = createOrderBillingRuntime(database, {
      ...options,
      environment: { ...ENV, ORDER_BILLING_CHAT_SEND_ENABLED: 'false' },
      billingChat: disabledChat,
    });
    await receiving.payment({
      chargeId: intent.chargeId,
      transactionNsu: randomUUID(),
      invoiceSlug: randomUUID(),
      amountCents: intent.amountCents,
      paidAmountCents: intent.amountCents,
      method: 'pix',
      installments: 1,
      receiptUrl: null,
      correlationId: randomUUID(),
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.order_billing_payments WHERE charge_id=$1',
          [intent.chargeId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await disabledChat.getIntent({
          actor: SELLER,
          orderId,
          intentId: intent.id,
        })
      ).state,
      'blocked',
    );
  });

  test(
    'BAPI-07/08: zero-intent payment callback serializes concurrent send_existing admission before acquiring order locks',
    { timeout: 10000 },
    async () => {
      const orderId = await seed(pool, { conversation: true, amount: 120000 });
      await pool.query(
        "UPDATE crm.conversations SET automation_state='human',state='em_atendimento',inbound_revision=1 WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)",
        [orderId],
      );
      const original = await legacy.get({ actor: SELLER, orderId });
      const issued = await legacy.issue({
        actor: SELLER,
        orderId,
        expectedVersion: original.billing.orderVersion,
        expectedBillingVersion: original.billing.version,
        percent: 30,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const charge = issued.billing.charges.at(-1);
      const callback = await checkout({ chargeId: charge.id });
      await legacy.created(callback);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM crm.order_billing_send_intents WHERE order_id=$1',
            [orderId],
          )
        ).rows[0].n,
        0,
      );

      const callbackPaused = Promise.withResolvers();
      const releaseCallback = Promise.withResolvers();
      let observedZeroIntents = false;
      let admissionPid = 0;
      /** @param {any} observe */
      const wrappedDatabase = (observe) => ({
        query: database.query,
        transaction: (/** @type {any} */ work) =>
          withTransaction(pool, (client) =>
            work({
              query: async (
                /** @type {string} */ sql,
                /** @type {any[]} */ values,
              ) => {
                await observe(sql, client);
                const result = await client.query(sql, values);
                if (
                  sql.startsWith(
                    'SELECT i.*,o.conversation_id AS primary_conversation_id',
                  )
                ) {
                  assert.equal(result.rows.length, 0);
                  observedZeroIntents = true;
                }
                return result;
              },
            }),
          ),
      });
      const callbackDatabase = wrappedDatabase(
        async (/** @type {string} */ sql) => {
          if (
            sql === 'SELECT order_id FROM crm.order_billing_charges WHERE id=$1'
          ) {
            assert.equal(observedZeroIntents, true);
            callbackPaused.resolve(undefined);
            await releaseCallback.promise;
          }
        },
      );
      const admissionDatabase = wrappedDatabase(
        async (/** @type {string} */ sql, /** @type {any} */ client) => {
          if (
            sql.includes(
              "pg_advisory_xact_lock(hashtextextended('billing-send-order:'",
            )
          )
            admissionPid = client.processID;
        },
      );
      const callbackRuntime = createOrderBillingRuntime(callbackDatabase, {
        ...options,
        billingChat: chat,
      });
      const admissionRuntime = createOrderBillingChatRuntime(
        admissionDatabase,
        options,
      );
      const request = await input(orderId, {
        action: 'send_existing',
        chargeId: charge.id,
      });
      delete request.percent;
      const paymentResult = callbackRuntime
        .payment({
          chargeId: charge.id,
          transactionNsu: randomUUID(),
          invoiceSlug: randomUUID(),
          amountCents: 36000,
          paidAmountCents: 36000,
          method: 'pix',
          installments: 1,
          receiptUrl: null,
          correlationId: randomUUID(),
        })
        .then(
          () => null,
          (/** @type {any} */ error) => error,
        );
      /** @type {Promise<any>|undefined} */ let admission;
      let settled = false;
      try {
        await Promise.race([
          callbackPaused.promise,
          delay(2000).then(() => {
            throw new Error(
              'Callback did not reach the zero-intent lock window',
            );
          }),
        ]);
        admission = admissionRuntime.submit(request).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
        let waiting = false;
        for (
          let attempt = 0;
          attempt < 100 && !waiting && !settled;
          attempt += 1
        ) {
          if (admissionPid)
            waiting = (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",
                [admissionPid],
              )
            ).rows[0].waiting;
          if (!waiting) await delay(10);
        }
        assert.equal(
          waiting,
          true,
          'Admission must wait on the order advisory fence while callback still sees zero intents',
        );
        assert.equal(settled, false);
      } finally {
        releaseCallback.resolve(undefined);
      }
      assert.equal(
        await paymentResult,
        null,
        'Financial callback must finish without a lock-order deadlock',
      );
      assert.ok(admission);
      const outcome = await admission;
      assert.equal(outcome.error?.code, 'VERSION_CONFLICT');
      assert.equal(
        (
          await pool.query(
            'SELECT status FROM crm.order_billing_charges WHERE id=$1',
            [charge.id],
          )
        ).rows[0].status,
        'paid',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM crm.order_billing_send_intents WHERE order_id=$1',
            [orderId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM crm.messages WHERE conversation_id=$1',
            [request.conversationId],
          )
        ).rows[0].n,
        0,
      );
    },
  );
}
