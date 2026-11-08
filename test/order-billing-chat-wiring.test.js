import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServerApi } from '../apps/api/src/server.js';
import { createApi } from '../apps/api/src/app.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const PREFIX = '/api/v1/orders/order-synthetic/billing';
const LOGGER = createSafeLogger({ service: 'crm-silmer-api', sink: () => {} });
// The operational sampler has its own integration tests. Keep this billing
// boundary's database assertions independent from background health queries.
const OPERATIONAL_HEALTH = {
  start() {},
  async stop() {},
  async refresh() {},
  read: () => ({ statusCode: 200, body: { status: 'ok' } }),
};
const HEADERS = {
  cookie: 'crm_session=synthetic',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic',
  'idempotency-key': 'synthetic-send',
};
const COMMAND = {
  action: 'balance',
  conversationId: 'conversation-synthetic',
  expectedVersion: 1,
  expectedBillingVersion: 2,
  expectedConversationVersion: 1,
};
const INTENT = {
  id: 'intent-synthetic',
  version: 1,
  action: 'balance',
  chargeId: 'charge-synthetic',
  conversationId: COMMAND.conversationId,
  state: 'queued',
  blockedReason: null,
  messageId: 'message-synthetic',
  commandId: 'command-synthetic',
  amountCents: 84000,
};
const HISTORY = {
  orderId: 'order-synthetic',
  orderVersion: 1,
  billingVersion: 2,
  totalAmountCents: 120000,
  receivedAmountCents: 36000,
  balanceAmountCents: 84000,
  items: [],
  nextCursor: null,
};
const KEY = Buffer.alloc(32, 101).toString('base64url');
const KEYS = Object.fromEntries(
  [
    'N8N_INTEGRATION_ENVELOPE_KEY',
    'IDEMPOTENCY_ENVELOPE_KEY',
    'INBOX_MESSAGE_ENVELOPE_KEY',
    'CONTACT_IDENTITY_ENVELOPE_KEY',
    'CONTACT_IDENTITY_LOOKUP_KEY',
    'HANDOFF_ENVELOPE_KEY',
    'OPERATION_CURSOR_HMAC_KEY',
  ].map((name) => [name, KEY]),
);

function injectedChat() {
  /** @type {any[]} */ const calls = [];
  const source = Object.freeze({
    enabled: true,
    marker: 'private-bound-receiver',
    async authorizeRead() {
      assert.equal(this.marker, 'private-bound-receiver');
      return { actor: { id: 'seller', kind: 'human' } };
    },
    async authorizeWrite() {
      assert.equal(this.marker, 'private-bound-receiver');
      return { actor: { id: 'seller', kind: 'human' } };
    },
    async getIntent(/** @type {any} */ input) {
      assert.equal(this.marker, 'private-bound-receiver');
      calls.push(input);
      return INTENT;
    },
    async getHistory(/** @type {any} */ input) {
      assert.equal(this.marker, 'private-bound-receiver');
      calls.push(input);
      return HISTORY;
    },
    async submit(/** @type {any} */ input) {
      assert.equal(this.marker, 'private-bound-receiver');
      calls.push(input);
      return INTENT;
    },
    async checkoutCreated() {},
    async paymentRecorded() {},
    async lockCharge() {},
  });
  return { source, calls };
}

test('BAPI-10/B04: missing, empty and false server flag close injected writes without losing private reads or mutating the port', async (t) => {
  for (const flag of [undefined, '', 'false']) {
    const { source, calls } = injectedChat();
    const api = createServerApi(
      /** @type {any} */ ({
        environment: { ORDER_BILLING_CHAT_SEND_ENABLED: flag },
        billingChat: source,
        logger: LOGGER,
      }),
    );
    t.after(() => api.close());
    const denied = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: HEADERS,
      payload: COMMAND,
    });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().code, 'BILLING_DISABLED');
    assert.equal(calls.length, 0);
    const intent = await api.inject({
      url: `${PREFIX}/send-intents/intent-synthetic`,
      headers: HEADERS,
    });
    assert.equal(intent.statusCode, 200);
    assert.deepEqual(intent.json(), INTENT);
    const history = await api.inject({
      url: `${PREFIX}/history`,
      headers: HEADERS,
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json(), HISTORY);
    assert.equal(history.headers['cache-control'], 'private, no-store');
    assert.equal(
      source.enabled,
      true,
      'server wrapper must not mutate the injected port',
    );
  }
});

test('BAPI-10/B04: malformed server flags and incomplete send configuration fail startup', () => {
  for (const value of ['TRUE', 'yes', '1', ' false '])
    assert.throws(
      () =>
        createServerApi({
          environment: { ORDER_BILLING_CHAT_SEND_ENABLED: value },
          logger: LOGGER,
        }),
      /ORDER_BILLING_CHAT_SEND_ENABLED must be true or false/,
    );
  assert.throws(
    () =>
      createServerApi({
        environment: { ORDER_BILLING_CHAT_SEND_ENABLED: 'true' },
        logger: LOGGER,
      }),
    /ORDER_BILLING_CHAT_SEND_ENABLED requires ORDER_BILLING_ENABLED/,
  );
  assert.throws(
    () =>
      createServerApi({
        environment: {
          ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
          ORDER_BILLING_ENABLED: 'true',
        },
        logger: LOGGER,
      }),
    /database, operational access and n8n command outbox/,
  );
});

test('BAPI-01/B04: low-level API registers the explicitly injected chat service and carries request correlation', async (t) => {
  const { source, calls } = injectedChat();
  const boundPort = Object.fromEntries(
    Object.entries(source).map(([name, value]) => [
      name,
      typeof value === 'function' ? value.bind(source) : value,
    ]),
  );
  const api = createApi({}, { billingChat: boundPort, logger: LOGGER });
  t.after(() => api.close());
  const correlationId = '77377a11-5c6a-46a2-b925-4f680462f001';
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: { ...HEADERS, 'x-correlation-id': correlationId },
    payload: COMMAND,
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), INTENT);
  assert.equal(calls[0].correlationId, correlationId);
  assert.equal(calls[0].orderId, 'order-synthetic');
});

test('BAPI-10/B04: enabled server needs all dependencies and does not invent a transport', async (t) => {
  const { source, calls } = injectedChat();
  /** @type {any} */ const database = {
    async query() {
      assert.fail('injected route must not use database');
    },
    async transaction() {
      assert.fail('injected route must not use database');
    },
  };
  const operations = {
    async authorizeRead() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
    async authorizeWrite() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
  };
  const commandOutbox = {
    async enqueueChannelMessage() {
      assert.fail('wiring must not send externally');
    },
  };
  const dependencies = {
    environment: {
      ...KEYS,
      ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
      ORDER_BILLING_ENABLED: 'true',
    },
    database,
    operations,
    n8n: {
      commandOutbox,
      async receiveInbound() {
        assert.fail('no inbound effect');
      },
      async recordEvent() {
        assert.fail('no transport effect');
      },
      async recordOrderIntent() {
        assert.fail('no commercial effect');
      },
      async storeAttachment() {
        assert.fail('no storage effect');
      },
    },
    billingChat: source,
    billing: {},
    // Keep the unrelated Inbox constructor from consuming the intentionally
    // incomplete n8n port before the billing configuration check runs.
    conversations: {},
    operationalHealth: OPERATIONAL_HEALTH,
    logger: LOGGER,
  };
  for (const missing of ['database', 'operations', 'n8n']) {
    // A fully configured server can now construct operations automatically;
    // an empty injected port represents missing authorization capabilities.
    const bad = {
      ...dependencies,
      [missing]: missing === 'operations' ? {} : undefined,
    };
    assert.throws(
      () => createServerApi(/** @type {any} */ (bad)),
      /ORDER_BILLING_CHAT_SEND_ENABLED requires/,
    );
  }
  assert.throws(
    () =>
      createServerApi(
        /** @type {any} */ ({ ...dependencies, n8n: { commandOutbox: {} } }),
      ),
    /ORDER_BILLING_CHAT_SEND_ENABLED requires/,
  );
  const api = createServerApi(/** @type {any} */ (dependencies));
  t.after(() => api.close());
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMAND,
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), INTENT);
  assert.equal(calls.length, 1);
});

test('BAPI-10/B04: production composition keeps receive-only chat routes available with no message outbox', async (t) => {
  let queries = 0;
  /** @type {any} */ const database = {
    async query() {
      queries++;
      throw new Error('synthetic database offline');
    },
    async transaction(/** @type {any} */ work) {
      return work(this);
    },
  };
  const operations = {
    async authorizeRead() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
    async authorizeWrite() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
  };
  const api = createServerApi(
    /** @type {any} */ ({
      environment: { ...KEYS, ORDER_BILLING_RECEIVE_ENABLED: 'true' },
      operationalHealth: OPERATIONAL_HEALTH,
      database,
      operations,
      logger: LOGGER,
    }),
  );
  t.after(() => api.close());
  const denied = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMAND,
  });
  assert.equal(denied.statusCode, 503);
  assert.equal(denied.json().code, 'BILLING_DISABLED');
  assert.equal(queries, 0);
  const history = await api.inject({
    url: `${PREFIX}/history`,
    headers: HEADERS,
  });
  assert.equal(history.statusCode, 503);
  assert.equal(history.json().code, 'SERVICE_UNAVAILABLE');
  assert.equal(queries, 1);
  assert.doesNotMatch(history.body, /synthetic database offline/);
});

test('BAPI-01/10/B04: production composition admits enabled commands to PostgreSQL without calling a transport', async (t) => {
  let queries = 0;
  /** @type {any} */ const database = {
    async query() {
      queries++;
      throw new Error('synthetic database offline');
    },
    async transaction(/** @type {any} */ work) {
      return work(this);
    },
  };
  const operations = {
    async authorizeRead() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
    async authorizeWrite() {
      return { actor: { id: 'seller', kind: 'human' } };
    },
  };
  const n8n = {
    commandOutbox: {
      async enqueueChannelMessage() {
        assert.fail('no external transport in composition test');
      },
    },
    async receiveInbound() {},
    async recordEvent() {},
    async recordOrderIntent() {},
    async storeAttachment() {},
  };
  const api = createServerApi(
    /** @type {any} */ ({
      environment: {
        ...KEYS,
        ORDER_BILLING_ENABLED: 'true',
        ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
      },
      database,
      operations,
      n8n,
      operationalHealth: OPERATIONAL_HEALTH,
      logger: LOGGER,
    }),
  );
  t.after(() => api.close());
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMAND,
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'SERVICE_UNAVAILABLE');
  assert.equal(queries, 1);
  assert.doesNotMatch(response.body, /synthetic database offline/);
});

test('BAPI-07/B04: text preflight is registered independently from the media runtime', async (t) => {
  const n8n = {
    async receiveInbound() {},
    async recordEvent() {},
    async recordOrderIntent() {},
    async storeAttachment() {},
    async readReservedSend() {
      assert.fail('registration performs no reserved send');
    },
  };
  const api = createApi({}, { n8n, logger: LOGGER });
  t.after(() => api.close());
  await api.ready();
  assert.equal(
    api.hasRoute({
      method: 'GET',
      url: '/api/v1/integrations/n8n/commands/:commandId/preflight',
    }),
    true,
  );
});

test('BAPI-10/B04: shared API and worker inventory exposes an unset flag and no enabled deployment value', async () => {
  const env = await readFile(
    new URL('../.env.example', import.meta.url),
    'utf8',
  );
  assert.match(env, /^ORDER_BILLING_CHAT_SEND_ENABLED=$/mu);
  const topology = JSON.parse(
    await readFile(
      new URL('../ops/easypanel/topology.json', import.meta.url),
      'utf8',
    ),
  );
  const inventory = JSON.stringify(topology);
  assert.equal(
    (inventory.match(/ORDER_BILLING_CHAT_SEND_ENABLED/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(inventory, /ORDER_BILLING_CHAT_SEND_ENABLED["\s:]+true/u);
});
