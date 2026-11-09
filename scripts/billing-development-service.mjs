import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresAuditTrail } from '../modules/audit-privacy/src/index.js';
import { createAutomationAuthRuntime } from '../apps/api/src/automation-auth-runtime.js';
import { createOrderBillingRuntime } from '../apps/api/src/order-billing-runtime.js';
import { createOrderBillingChatRuntime } from '../apps/api/src/order-billing-chat-runtime.js';
import { registerOrderBillingRoutes } from '../apps/api/src/order-billing-routes.js';
import { registerOrderBillingChatRoutes } from '../apps/api/src/order-billing-chat-routes.js';
import {
  createBillingWorkerRuntime,
  createWorkerRuntime,
} from '../apps/worker/src/worker.js';
import {
  PostgresN8nCommandOutbox,
  PostgresN8nCommandStore,
  PostgresN8nIntegrationRepository,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';
import { registerN8nRoutes } from '../apps/api/src/n8n-routes.js';
import { registerN8nBillingPreflightRoutes } from '../apps/api/src/n8n-billing-preflight-routes.js';
import {
  seed,
  KEY,
  SELLER,
} from '../test/support/order-billing-chat-fixture.js';

export const DEVELOPMENT_CREDENTIALS = Object.freeze({
  workerUser: 'synthetic-billing-worker',
  workerPassword: 'synthetic-billing-worker-secret-local-only-32',
  crmUser: 'synthetic-billing-n8n',
  crmPassword: 'synthetic-billing-n8n-secret-local-only-32',
  gatewayKey: 'synthetic-billing-gateway-local-only',
});

/** Stateful HTTP simulator: payments must be explicitly confirmed by a test.
 * It never calls a provider, follows a checkout URL, or sends a message.
 */
export function createBillingDevelopmentSimulator() {
  const charges = new Map();
  const counts = { links: 0, checks: 0 };
  return {
    counts,
    charges,
    /** @param {any} body */
    create(body) {
      assert.equal(body.handle, 'synthetic-billing');
      assert.equal(body.options.single_payment, true);
      assert.deepEqual(body.options.payment_methods_enabled, [
        'pix',
        'credit_card',
      ]);
      const amount = body.items.reduce(
        (/** @type {number} */ total, /** @type {any} */ item) =>
          total + item.price * item.quantity,
        0,
      );
      assert.ok(Number.isSafeInteger(amount) && amount > 0);
      const id = body.order_nsu;
      assert.match(id, /^[a-f0-9-]{36}$/u);
      assert.equal(
        charges.has(id),
        false,
        'a second gateway effect is a failure',
      );
      counts.links++;
      charges.set(id, { amount, paid: false, method: 'pix', installments: 1 });
      return { url: `https://checkout.infinitepay.io/synthetic-${id}` };
    },
    /** @param {string} id @param {Record<string,any>} [options] */
    confirm(id, options = {}) {
      const charge = charges.get(id);
      assert.ok(
        charge,
        'only a previously created synthetic checkout can be paid',
      );
      Object.assign(charge, { paid: true }, options);
      return {
        order_nsu: id,
        invoice_slug: `synthetic-${id}`,
        transaction_nsu: `synthetic-transaction-${id}`,
        receipt_url: `https://receipt.infinitepay.io/synthetic-${id}`,
      };
    },
    /** @param {any} body */
    check(body) {
      assert.equal(body.handle, 'synthetic-billing');
      counts.checks++;
      const id = String(body.slug).replace(/^synthetic-/u, '');
      const charge = charges.get(id);
      if (
        !charge ||
        body.order_nsu !== id ||
        body.transaction_nsu !== `synthetic-transaction-${id}`
      )
        return { success: false, paid: false };
      return {
        success: true,
        paid: charge.paid,
        amount: charge.amount,
        paid_amount: charge.amount,
        capture_method: charge.method,
        installments: charge.installments,
      };
    },
  };
}

export async function startBillingDevelopmentService() {
  if (
    process.env.RUN_BILLING_LOCAL_SMOKE !== 'yes' ||
    process.env.APP_ENV !== 'development'
  )
    throw new Error('EXPLICIT_SYNTHETIC_DEVELOPMENT_REQUIRED');
  const connectionString = process.env.TEST_DATABASE_URL;
  const target = new URL(connectionString ?? 'http://invalid');
  if (
    target.hostname !== 'billing-postgres' ||
    target.pathname !== '/crm_silmer_test'
  )
    throw new Error('DEDICATED_BILLING_DATABASE_REQUIRED');
  const pool = new Pool({ connectionString, max: 8 });
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
  await migrate(pool, { migrations: await loadMigrations() });
  await pool.query(
    "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,'billing-synthetic@example.test','$argon2id$synthetic','Synthetic billing')",
    [SELLER.id],
  );
  await pool.query(
    "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
    [SELLER.id],
  );
  const environment = {
    APP_ENV: 'development',
    ORDER_BILLING_ENABLED: 'true',
    ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
    N8N_COMMAND_ALLOW_INSECURE_LOCAL: 'true',
    N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
    IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
    INBOX_MESSAGE_ENVELOPE_KEY: KEY.toString('base64'),
    ORDER_BILLING_N8N_URL:
      'http://127.0.0.1:5678/webhook/silmer/order-billing-dev/create',
    N8N_COMMAND_CLIENT_ID: DEVELOPMENT_CREDENTIALS.workerUser,
    N8N_COMMAND_CLIENT_SECRET: DEVELOPMENT_CREDENTIALS.workerPassword,
  };
  const access = {
    // Synthetic session adapter only. Domain ACL/ownership are rechecked by the
    // real runtime against PostgreSQL. This smoke does not certify login/CSRF.
    async authorizeRead() {
      return { actor: SELLER };
    },
    async authorizeWrite() {
      return { actor: SELLER };
    },
  };
  let clockOffset = 0;
  const clock = () => new Date(Date.now() + clockOffset);
  let sendEnabled = true;
  const buildChat = () =>
    createOrderBillingChatRuntime(database, {
      access,
      clock,
      environment: {
        ...environment,
        ORDER_BILLING_CHAT_SEND_ENABLED: sendEnabled ? 'true' : 'false',
      },
      outboundMessageOutbox: new PostgresN8nCommandOutbox({ envelopeKey: KEY }),
    });
  let activeChat = buildChat();
  const chat = /** @type {any} */ (
    new Proxy(
      {},
      {
        get(_target, key) {
          return /** @type {any} */ (activeChat)[key];
        },
      },
    )
  );
  const billing = createOrderBillingRuntime(database, {
    access,
    clock,
    environment,
    billingChat: chat,
  });
  const worker = createBillingWorkerRuntime({
    database,
    environment,
    logger: {
      debug() {
        return {};
      },
      info() {
        return {};
      },
      warn() {
        return {};
      },
      error() {
        return {};
      },
    },
    // Only the Docker-internal alias changes. Production transport validation
    // remains untouched and the isolated network has no external gateway.
    fetchImpl: (/** @type {URL} */ _url, /** @type {RequestInit} */ options) =>
      globalThis.fetch(
        'http://n8n:5678/webhook/silmer/order-billing-dev/create',
        options,
      ),
  });
  worker.now = () => clock().getTime();
  const repository = new PostgresN8nIntegrationRepository({
    database,
    envelopeKey: KEY,
    billingSendEnabled: true,
  });
  const integration = createN8nIntegrationService({ repository, clock });
  const commandStore = new PostgresN8nCommandStore({
    database,
    envelopeKey: KEY,
    billingSendEnabled: true,
  });
  const timedCommandStore = Object.fromEntries(
    [
      'loadForDelivery',
      'markProcessing',
      'markDelivered',
      'markFailed',
      'markOutcomeUnknown',
    ].map((name) => [
      name,
      (/** @type {string} */ id, /** @type {any} */ context) =>
        /** @type {any} */ (commandStore)[name](id, {
          ...context,
          now: clock(),
        }),
    ]),
  );
  const commandWorker = createWorkerRuntime({
    database,
    commandStore: /** @type {any} */ (timedCommandStore),
    logger: worker.logger,
    environment: {
      ...environment,
      N8N_COMMAND_URL:
        'http://127.0.0.1:5678/webhook/silmer/order-billing-dev/send',
    },
    fetchImpl: (_url, options) =>
      globalThis.fetch(
        'http://n8n:5678/webhook/silmer/order-billing-dev/send',
        options,
      ),
  });
  commandWorker.now = () => clock().getTime();
  const api = Fastify({ logger: false });
  api.decorate(
    'automationAuth',
    createAutomationAuthRuntime({
      auditPort: new PostgresAuditTrail(database),
      environment: {
        CRM_AUTOMATION_CLIENT_ID: DEVELOPMENT_CREDENTIALS.crmUser,
        CRM_AUTOMATION_CLIENT_SECRET: DEVELOPMENT_CREDENTIALS.crmPassword,
      },
    }),
  );
  const contextFor = (
    /** @type {import('fastify').FastifyRequest} */ request,
  ) => ({
    correlationId: String(request.headers['x-correlation-id'] ?? randomUUID()),
    requestId: randomUUID(),
  });
  registerOrderBillingRoutes(api, billing, contextFor);
  registerOrderBillingChatRoutes(api, chat, contextFor, { enabled: true });
  registerN8nRoutes(
    api,
    {
      ...integration,
      async receiveInbound() {
        throw new Error('SYNTHETIC_ROUTE_UNUSED');
      },
      async storeAttachment() {
        throw new Error('SYNTHETIC_ROUTE_UNUSED');
      },
      async recordOrderIntent() {
        throw new Error('SYNTHETIC_ROUTE_UNUSED');
      },
    },
    contextFor,
  );
  registerN8nBillingPreflightRoutes(
    api,
    {
      readReservedSend: (/** @type {any} */ input) =>
        repository.readReservedSend({ ...input, now: clock() }),
    },
    contextFor,
  );
  const transportEffects = new Map();
  const transportFaults = new Map();
  const simulator = createBillingDevelopmentSimulator();
  const gateway = Fastify({ logger: false });
  gateway.addHook('onRequest', async (request, reply) => {
    if (request.headers['x-api-key'] !== DEVELOPMENT_CREDENTIALS.gatewayKey)
      return reply.code(401).send({ error: 'SYNTHETIC_KEY_REQUIRED' });
  });
  gateway.post('/links', async (request) => simulator.create(request.body));
  gateway.post('/payment_check', async (request) =>
    simulator.check(request.body),
  );
  let failCallback = '';
  api.addHook('onRequest', async (request, reply) => {
    if (failCallback && request.url.endsWith('/' + failCallback)) {
      failCallback = '';
      return reply.code(503).send({ code: 'SYNTHETIC_CALLBACK_UNAVAILABLE' });
    }
    if (request.url.endsWith('/preflight')) {
      const commandId = decodeURIComponent(request.url.split('/').at(-2) ?? '');
      const fault = transportFaults.get(commandId);
      if (fault === 'before_send') {
        transportFaults.delete(commandId);
        return reply.code(503).send({ valid: false });
      }
      if (fault === 'owner') {
        transportFaults.delete(commandId);
        await pool.query(
          'UPDATE crm.conversations SET assigned_user_id=NULL WHERE id=(SELECT conversation_id FROM crm.n8n_commands WHERE command_id=$1)',
          [commandId],
        );
      }
    }
  });
  api.get('/__billing-development/health', async () => ({ synthetic: true }));
  api.post('/__billing-development/seed', async () => {
    const orderId = await seed(pool, { conversation: true, amount: 10000 });
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='em_atendimento',inbound_revision=1 WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)",
      [orderId],
    );
    return { orderId };
  });
  api.post('/__billing-development/submit', async (request, reply) => {
    const {
      orderId,
      action = 'issue',
      percent = 30,
      ...fields
    } = /** @type {any} */ (request.body);
    const row = (
      await pool.query(
        'SELECT o.version,o.conversation_id,c.version AS conversation_version,p.version AS billing_version FROM crm.orders o JOIN crm.conversations c ON c.id=o.conversation_id LEFT JOIN crm.order_billing_plans p ON p.order_id=o.id WHERE o.id=$1',
        [orderId],
      )
    ).rows[0];
    const response = await api.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/billing/send-intents`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        action,
        conversationId: row.conversation_id,
        expectedVersion: Number(row.version),
        expectedConversationVersion: Number(row.conversation_version),
        expectedBillingVersion: Number(row.billing_version ?? 0),
        ...(action === 'issue' ? { percent } : {}),
        ...fields,
      },
    });
    return reply.code(response.statusCode).send(response.json());
  });
  api.post('/__billing-development/confirm', async (request) => {
    const { chargeId, ...options } = /** @type {any} */ (request.body);
    return simulator.confirm(chargeId, options);
  });
  api.post('/__billing-development/fail-callback', async (request) => {
    const operation = /** @type {any} */ (request.body).operation ?? 'payment';
    assert.ok(['payment', 'created'].includes(operation));
    failCallback = operation;
    return { armed: true };
  });
  api.post('/__billing-development/run-worker', async () => {
    await worker.runOnce();
    return { ran: true };
  });
  api.post('/__billing-development/legacy-issue', async (request) => {
    const orderId = /** @type {any} */ (request.body).orderId;
    const view = await billing.get({ actor: SELLER, orderId });
    const result = await billing.issue({
      actor: SELLER,
      orderId,
      percent: 30,
      expectedVersion: view.billing.orderVersion,
      expectedBillingVersion: view.billing.version,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    return { chargeId: result.billing.charges.at(-1).id };
  });
  api.post('/__billing-development/run-transport', async () => {
    let ran = 0;
    for (let n = 0; n < 30; n++) {
      const processed = await commandWorker.runOnce();
      ran += processed;
      if (!processed) break;
    }
    return { ran };
  });
  api.post('/__billing-development/transport/fault', async (request) => {
    const { intentId, fault } = /** @type {any} */ (request.body);
    assert.ok(['before_send', 'unknown', 'owner'].includes(fault));
    const row = (
      await pool.query(
        'SELECT command_id FROM crm.order_billing_send_intents WHERE id=$1',
        [intentId],
      )
    ).rows[0];
    assert.ok(row?.command_id);
    transportFaults.set(row.command_id, fault);
    return { armed: true };
  });
  api.post('/__billing-development/transport/send', async (request, reply) => {
    const body = /** @type {any} */ (request.body);
    assert.equal(body.message?.type, 'text');
    assert.ok(
      typeof body.message.text === 'string' && body.message.text.length > 0,
    );
    const count = transportEffects.get(body.command_id) ?? 0;
    assert.equal(
      count,
      0,
      'A command cannot produce a second transport effect',
    );
    transportEffects.set(body.command_id, count + 1);
    if (transportFaults.get(body.command_id) === 'unknown') {
      transportFaults.delete(body.command_id);
      return reply.code(503).send({ code: 'SYNTHETIC_OUTCOME_UNKNOWN' });
    }
    return {
      id: `synthetic-message-${body.command_id}`,
      messages: [{ id: `synthetic-message-${body.command_id}` }],
      simulated: true,
    };
  });
  api.post('/__billing-development/advance-clock', async (request) => {
    const hours = Number(/** @type {any} */ (request.body).hours);
    assert.ok(Number.isInteger(hours) && hours >= 0 && hours <= 72);
    clockOffset += hours * 3600000;
    return { advanced: true };
  });
  api.post('/__billing-development/send-enabled', async (request) => {
    const enabled = /** @type {any} */ (request.body).enabled;
    assert.equal(typeof enabled, 'boolean');
    sendEnabled = enabled;
    activeChat = buildChat();
    repository.billingSendEnabled = enabled;
    commandStore.billingSendEnabled = enabled;
    return { enabled };
  });
  api.post('/__billing-development/close-unpaid', async (request) => {
    const orderId = /** @type {any} */ (request.body).orderId;
    const data = await billing.get({ actor: SELLER, orderId });
    return billing.reconcile({
      actor: SELLER,
      orderId,
      expectedVersion: data.billing.orderVersion,
      expectedBillingVersion: data.billing.version,
      decision: 'close_unpaid',
      confirmedProviderReview: true,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
  });
  api.get('/__billing-development/state/:orderId', async (request) => {
    const orderId = /** @type {any} */ (request.params).orderId;
    const view = await billing.get({ actor: SELLER, orderId });
    const payments = (
      await pool.query(
        'SELECT count(*)::int AS n FROM crm.order_billing_payments p JOIN crm.order_billing_charges c ON c.id=p.charge_id WHERE c.order_id=$1',
        [orderId],
      )
    ).rows[0].n;
    const messages = (
      await pool.query(
        'SELECT count(*)::int AS n FROM crm.order_billing_send_intents WHERE order_id=$1 AND message_id IS NOT NULL',
        [orderId],
      )
    ).rows[0].n;
    const paidOn = (
      await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [orderId])
    ).rows[0].paid_on;
    const intents = (
      await pool.query(
        'SELECT id,action,state,version,charge_id,message_id,command_id,blocked_reason FROM crm.order_billing_send_intents WHERE order_id=$1 ORDER BY created_at,id',
        [orderId],
      )
    ).rows;
    return {
      view,
      payments,
      messages,
      paidOn,
      intents,
      transportEffects: Object.fromEntries(transportEffects),
      effects: simulator.counts,
    };
  });
  await gateway.listen({ host: '0.0.0.0', port: 8080 });
  await api.listen({ host: '0.0.0.0', port: 3000 });
  process.stdout.write('SYNTHETIC_BILLING_SERVICE_READY\n');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, async () => {
      await gateway.close();
      await api.close();
      await pool.end();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await startBillingDevelopmentService();
