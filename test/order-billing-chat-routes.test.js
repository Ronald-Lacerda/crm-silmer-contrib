import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { registerOrderBillingChatRoutes } from '../apps/api/src/order-billing-chat-routes.js';
import {
  billingSendCommandSchema,
  billingIntentSchema,
  billingHistorySchema,
} from '../apps/api/src/order-billing-chat-contract.js';

const PREFIX = '/api/v1/orders/order-example/billing';
const HEADERS = {
  cookie: 'crm_session=synthetic',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic',
  'idempotency-key': 'synthetic-intent',
};
const BASE = {
  conversationId: 'conversation-example',
  expectedVersion: 2,
  expectedBillingVersion: 1,
  expectedConversationVersion: 3,
};
const COMMANDS = [
  { ...BASE, action: 'issue', percent: 30 },
  { ...BASE, action: 'send_existing', chargeId: 'charge-existing' },
  { ...BASE, action: 'balance' },
  {
    ...BASE,
    action: 'correct',
    chargeId: 'charge-expired',
    amountCents: 24000,
    confirmedAgreement: true,
    confirmedProviderReview: true,
  },
  {
    ...BASE,
    action: 'retry',
    intentId: 'intent-failed',
    expectedIntentVersion: 4,
  },
];
const INTENT = {
  id: 'intent-example',
  version: 1,
  action: 'issue',
  chargeId: 'charge-example',
  conversationId: BASE.conversationId,
  state: 'waiting_link',
  blockedReason: null,
  messageId: null,
  commandId: null,
  amountCents: 36000,
};
const HISTORY = {
  orderId: 'order-example',
  orderVersion: 2,
  billingVersion: 1,
  totalAmountCents: 120000,
  receivedAmountCents: 36000,
  balanceAmountCents: 84000,
  items: [
    {
      id: 'receipt-example',
      kind: 'receipt',
      chargeId: 'charge-example',
      intentId: null,
      amountCents: 36000,
      status: 'paid',
      occurredAt: '2026-11-06T12:00:00.000Z',
    },
  ],
  nextCursor: null,
};

/** @param {boolean} [enabled] */
function fixture(enabled = true) {
  const api = Fastify();
  /** @type {any[]} */ const calls = [];
  /** @param {any} input @param {boolean} write */
  function authorize(input, write) {
    if (
      input.cookie !== HEADERS.cookie ||
      (write &&
        (input.csrfToken !== HEADERS['x-csrf-token'] ||
          input.origin !== HEADERS.origin))
    )
      throw Object.assign(new Error('private session'), {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    assert.equal(input.action, write ? 'billing.manage' : 'billing.read');
    return { actor: { id: 'seller-example', kind: 'human' } };
  }
  const service = {
    authorizeRead: (/** @type {any} */ input) => authorize(input, false),
    authorizeWrite: (/** @type {any} */ input) => authorize(input, true),
    submit: async (/** @type {any} */ input) => {
      calls.push(input);
      return INTENT;
    },
    getIntent: async (/** @type {any} */ input) => {
      calls.push(input);
      return INTENT;
    },
    getHistory: async (/** @type {any} */ input) => {
      calls.push(input);
      return HISTORY;
    },
  };
  registerOrderBillingChatRoutes(
    api,
    service,
    () => ({ correlationId: 'correlation-example' }),
    { enabled },
  );
  return { api, service, calls };
}

test('BAPI-01/02: five explicit actions accept the reviewed command and return a pending intent, not a sent message', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const payload of COMMANDS) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: HEADERS,
      payload,
    });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), INTENT);
    assert.deepEqual(calls.at(-1), {
      ...payload,
      actor: { id: 'seller-example', kind: 'human' },
      orderId: 'order-example',
      idempotencyKey: 'synthetic-intent',
      correlationId: 'correlation-example',
    });
  }
});

test('BAPI-02: commands reject extra/missing fields, coercion, unsafe numbers, zero charge, arbitrary destination and unconfirmed correction', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const payload of [
    {},
    [],
    null,
    { ...COMMANDS[0], action: '__proto__' },
    { ...COMMANDS[0], text: 'unreviewed' },
    { ...COMMANDS[0], phone: '+550000' },
    { ...COMMANDS[0], conversationId: '' },
    { ...COMMANDS[0], conversationId: ' bad' },
    { ...COMMANDS[0], percent: 0 },
    { ...COMMANDS[0], percent: 101 },
    { ...COMMANDS[0], percent: 30.5 },
    { ...COMMANDS[0], percent: '30' },
    { ...COMMANDS[0], expectedVersion: 0 },
    { ...COMMANDS[0], expectedVersion: 9007199254740992 },
    { ...COMMANDS[0], expectedBillingVersion: -1 },
    { ...COMMANDS[0], expectedConversationVersion: null },
    { ...COMMANDS[2], percent: 30 },
    { ...COMMANDS[2], amountCents: 84000 },
    { ...COMMANDS[3], amountCents: 99 },
    { ...COMMANDS[3], amountCents: 240.5 },
    { ...COMMANDS[3], confirmedAgreement: false },
    { ...COMMANDS[3], confirmedProviderReview: 'true' },
    { ...COMMANDS[4], expectedIntentVersion: 0 },
    { ...COMMANDS[4], intentId: '' },
  ]) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: HEADERS,
      payload: payload ?? {},
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().code, 'INVALID_REQUEST');
  }
  for (const command of COMMANDS) {
    for (const key of Object.keys(command)) {
      const payload = { ...command };
      delete (/** @type {any} */ (payload)[key]);
      const response = await api.inject({
        method: 'POST',
        url: `${PREFIX}/send-intents`,
        headers: HEADERS,
        payload,
      });
      assert.equal(response.statusCode, 400, `${command.action}:${key}`);
    }
  }
  assert.equal(calls.length, 0);
});

test('BAPI-03: session, CSRF/origin, automation rejection and idempotency header precede every write', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const headers of [
    {},
    { ...HEADERS, authorization: 'Basic synthetic' },
    { ...HEADERS, cookie: '' },
    { ...HEADERS, 'x-csrf-token': '' },
    { ...HEADERS, origin: 'https://foreign.example.test' },
  ]) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers,
      payload: COMMANDS[0],
    });
    assert.equal(response.statusCode, 403);
  }
  for (const key of ['', 'contains space', 'x'.repeat(256)]) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: { ...HEADERS, 'idempotency-key': key },
      payload: COMMANDS[0],
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('BAPI-04/05: disabled writes fail closed while private intent/history reads remain available', async (t) => {
  const { api, calls } = fixture(false);
  t.after(() => api.close());
  const denied = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMANDS[0],
  });
  assert.equal(denied.statusCode, 503);
  assert.equal(denied.json().code, 'BILLING_DISABLED');
  assert.equal(calls.length, 0);
  for (const [path, expected] of [
    ['send-intents/intent-example', INTENT],
    ['history', HISTORY],
  ]) {
    const result = await api.inject({
      url: `${PREFIX}/${path}`,
      headers: HEADERS,
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), expected);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.headers.vary, 'Cookie, Origin');
    for (const headers of [
      {},
      { ...HEADERS, authorization: 'Basic synthetic' },
    ]) {
      const deniedRead = await api.inject({
        url: `${PREFIX}/${path}`,
        headers,
      });
      assert.equal(deniedRead.statusCode, 403);
    }
  }
});

test('BAPI-04: omitted enable option does not admit writes', async (t) => {
  const api = Fastify();
  t.after(() => api.close());
  registerOrderBillingChatRoutes(
    api,
    {
      authorizeWrite: async () => ({ actor: { id: 'seller' } }),
      submit: () => assert.fail('disabled submit'),
    },
    () => ({ correlationId: 'test' }),
  );
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMANDS[0],
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'BILLING_DISABLED');
});

test('BAPI-03: real capability policy denies Financeiro and preserves the administrative capability and identity', async (t) => {
  const { api, service, calls } = fixture();
  t.after(() => api.close());
  const sessionAccess = service.authorizeWrite;
  /** @type {any} */ let actor = {
    id: 'finance-example',
    kind: 'human',
    functionName: 'Financeiro',
    capabilities: [],
  };
  service.authorizeWrite = (input) => {
    sessionAccess(input);
    authorize(actor, input.action);
    return { actor };
  };
  const denied = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMANDS[0],
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
  actor = {
    id: 'admin-example',
    kind: 'human',
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
  };
  const accepted = await api.inject({
    method: 'POST',
    url: `${PREFIX}/send-intents`,
    headers: HEADERS,
    payload: COMMANDS[0],
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(calls[0].actor, actor);
  assert.equal(calls[0].actor.functionName, 'Vendedor');
  assert.deepEqual(calls[0].actor.capabilities, ['COMMERCIAL_ADMIN']);
});

test('BAPI-05: history pagination is bounded and selectors are not silently accepted', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const query of [
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=01',
    'limit=-1',
    'cursor=',
    'limit=2&limit=3',
    'phone=unknown',
  ]) {
    const response = await api.inject({
      url: `${PREFIX}/history?${query}`,
      headers: HEADERS,
    });
    assert.equal(response.statusCode, 400, query);
  }
  assert.equal(calls.length, 0);
  const response = await api.inject({
    url: `${PREFIX}/history?limit=50&cursor=opaque-cursor`,
    headers: HEADERS,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0], {
    actor: { id: 'seller-example', kind: 'human' },
    orderId: 'order-example',
    limit: 50,
    cursor: 'opaque-cursor',
  });
  assert.equal(
    (
      await api.inject({
        url: `${PREFIX}/send-intents/intent-example?other=x`,
        headers: HEADERS,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: `${PREFIX}/send-intents?other=x`,
        headers: HEADERS,
        payload: COMMANDS[0],
      })
    ).statusCode,
    400,
  );
});

test('BAPI-05: intent and history projections omit private provider fields and failures use safe problem JSON', async (t) => {
  const { api, service } = fixture();
  t.after(() => api.close());
  service.submit = async () => ({
    ...INTENT,
    checkoutUrl: 'private-canary',
    providerPayload: 'private-canary',
  });
  service.getIntent = service.submit;
  service.getHistory = async () => ({
    ...HISTORY,
    token: 'private-canary',
    items: [{ ...HISTORY.items[0], payload: 'private-canary' }],
  });
  for (const request of [
    {
      method: /** @type {const} */ ('POST'),
      url: `${PREFIX}/send-intents`,
      payload: COMMANDS[0],
    },
    {
      method: /** @type {const} */ ('GET'),
      url: `${PREFIX}/send-intents/intent-example`,
    },
    { method: /** @type {const} */ ('GET'), url: `${PREFIX}/history` },
  ]) {
    const response = await api.inject({ ...request, headers: HEADERS });
    assert.equal(response.statusCode, request.method === 'POST' ? 202 : 200);
    assert.doesNotMatch(response.body, /private-canary/);
  }
  for (const [code, status] of [
    ['VERSION_CONFLICT', 409],
    ['BILLING_LINK_STILL_VALID', 409],
    ['BILLING_RETRY_UNSAFE', 409],
    ['BILLING_TARGET_CONFLICT', 409],
    ['BILLING_INVALID_AMOUNT', 422],
    ['secret-database-detail', 500],
  ]) {
    service.submit = async () => {
      throw Object.assign(new Error('private-canary'), {
        code,
        statusCode: status,
      });
    };
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: HEADERS,
      payload: COMMANDS[0],
    });
    const expectedCode = status === 500 ? 'SERVICE_UNAVAILABLE' : code;
    assert.equal(response.statusCode, status === 500 ? 503 : status);
    assert.match(
      String(response.headers['content-type']),
      /application\/problem\+json/,
    );
    assert.deepEqual(response.json(), {
      type: 'about:blank',
      title: expectedCode,
      status: status === 500 ? 503 : status,
      code: expectedCode,
    });
    assert.doesNotMatch(response.body, /private-canary|database/);
  }
});

test('BAPI-02/05: oversized, malformed and non-JSON bodies fail without invoking a command', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const [
    payload,
    contentType,
    status,
  ] of /** @type {Array<[string,string,number]>} */ ([
    ['x'.repeat(9000), 'application/json', 413],
    ['{', 'application/json', 400],
    ['value', 'application/octet-stream', 415],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/send-intents`,
      headers: { ...HEADERS, 'content-type': contentType },
      payload,
    });
    assert.equal(response.statusCode, status);
    assert.doesNotMatch(response.body, /stack|SyntaxError/);
  }
  assert.equal(calls.length, 0);
});

test('BAPI-01: published schemas match the executable HTTP contract', async () => {
  const doc = JSON.parse(
    await readFile(
      new URL('../docs/api/order-billing-chat.v1.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(
    doc.components.schemas.SendIntentCommand,
    billingSendCommandSchema,
  );
  assert.deepEqual(doc.components.schemas.Intent, billingIntentSchema);
  assert.deepEqual(doc.components.schemas.History, billingHistorySchema);
  assert.equal(
    doc.paths['/orders/{orderId}/billing/send-intents'].post.responses['202']
      .description,
    'Intenção persistida; não comprova envio ou pagamento',
  );
});
