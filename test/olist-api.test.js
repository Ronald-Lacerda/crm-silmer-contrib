import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/observability.js';

const prefix = '/api/v1/integrations/olist';
const session = 'synthetic-olist-session';
const headers = {
  cookie: `crm_csrf=synthetic-csrf; crm_session=${session}`,
  origin: 'https://crm.example.test',
  'sec-fetch-site': 'same-origin',
  'x-csrf-token': 'synthetic-csrf',
  'idempotency-key': 'olist-synthetic-command',
  'x-correlation-id': 'olist-api-boundary-test',
};
const settings = {
  sellerId: null,
  operationNatureId: null,
  warehouseId: null,
  paymentMethodId: null,
  priceListId: null,
  originId: null,
  paymentTerms: null,
  purchaseOrder: null,
};
const status = {
  configured: true,
  connected: false,
  reconnectRequired: false,
  version: 0,
  generation: 0,
  environment: 'production',
  expiresAt: null,
  accountConfigured: true,
  creationEnabled: false,
  settingsVersion: 0,
  settings,
};
const projection = {
  orderId: 'order-of-another-owner',
  number: '41-CRM',
  status: 'pendente',
  creationEnabled: false,
  pendingFields: [
    {
      code: 'OLIST_CREATION_DISABLED',
      label: 'Geração Olist ainda indisponível.',
    },
  ],
  operation: null,
};

/** @param {Partial<import('../modules/identity-access/src/authorization.js').AccessActor>} [patch] */
function fixture(patch = {}) {
  const actor = {
    id: 'admin-example',
    kind: /** @type {const} */ ('human'),
    functionName: /** @type {const} */ ('Vendedor'),
    capabilities:
      /** @type {import('../modules/identity-access/src/authorization.js').Capability[]} */ ([
        'COMMERCIAL_ADMIN',
      ]),
    olistEnabled: false,
    olistAuthorizationVersion: 0,
    ...patch,
  };
  /** @type {Array<{method:string,input:any}>} */
  const calls = [];
  /** @type {Array<{write:boolean,input:any}>} */
  const authCalls = [];
  /** @type {string[]} */
  const logs = [];
  /** @param {any} input @param {boolean} write */
  function check(input, write) {
    authCalls.push({ input, write });
    if (
      input.authorization !== undefined ||
      !String(input.cookie).includes(`crm_session=${session}`)
    )
      throw Object.assign(new Error('FORBIDDEN'), {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    if (
      write &&
      (input.origin !== headers.origin || input.csrfToken !== 'synthetic-csrf')
    )
      throw Object.assign(new Error('CSRF_INVALID'), {
        code: 'CSRF_INVALID',
        statusCode: 403,
      });
    if (
      !write &&
      input.origin !== headers.origin &&
      input.secFetchSite !== 'same-origin'
    )
      throw Object.assign(new Error('FORBIDDEN'), {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    authorize(actor, input.action);
    return { actor };
  }
  /** @type {any} */
  const runtime = {
    authorizeRead: async (/** @type {any} */ input) => check(input, false),
    authorizeWrite: async (/** @type {any} */ input) => check(input, true),
  };
  for (const method of [
    'status',
    'authorize',
    'complete',
    'disconnect',
    'settings',
    'creation',
    'recovery',
    'lookup',
    'lookups',
    'mappings',
    'project',
    'exportOrder',
  ]) {
    runtime[method] = async (/** @type {any} */ input) => {
      calls.push({ method, input });
      if (method === 'exportOrder')
        return {
          operationId: 'synthetic-operation',
          orderId: input.orderId,
          number: '41-CRM',
          state: 'queued',
          stage: 'customer',
          creationEnabled: false,
        };
      if (method === 'authorize')
        return {
          authorizationUrl:
            'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth?state=synthetic',
        };
      if (method === 'lookup' || method === 'project') return projection;
      if (method === 'lookups') return { items: [] };
      if (method === 'mappings')
        return {
          id: input.resourceId,
          kind: 'product',
          state: 'pending',
          remoteId: null,
        };
      return status;
    };
  }
  const api = createApi(
    {},
    {
      olist: runtime,
      logger: createSafeLogger({
        service: 'crm-silmer-api',
        sink: (record) => logs.push(JSON.stringify(record)),
      }),
    },
  );
  return { api, runtime, actor, calls, authCalls, logs };
}

test('Olist status is an authenticated admin read with private cache, referrer and session binding', async (t) => {
  const { api, calls, authCalls } = fixture();
  t.after(() => api.close());
  const response = await api.inject({ url: `${prefix}/status`, headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), status);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers.vary, 'Origin, Cookie');
  assert.equal(authCalls[0].write, false);
  assert.equal(authCalls[0].input.action, 'olist.manage');
  assert.equal(authCalls[0].input.cookie, headers.cookie);
  assert.equal(authCalls[0].input.secFetchSite, 'same-origin');
  assert.equal(calls[0].input.actor.id, 'admin-example');
  assert.equal(
    calls[0].input.sessionBinding,
    createHash('sha256').update(session).digest('hex'),
  );
  assert.ok(!JSON.stringify(calls).includes(session));
});

test('Olist writes forward the current actor, CSRF, origin, correlation and idempotency header', async (t) => {
  const { api, calls, authCalls } = fixture();
  t.after(() => api.close());
  const response = await api.inject({
    method: 'POST',
    url: `${prefix}/settings`,
    headers,
    payload: {
      expectedVersion: 4,
      reason: 'Synthetic approved settings',
      settings,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(authCalls[0].write, true);
  assert.equal(authCalls[0].input.action, 'olist.manage');
  assert.equal(authCalls[0].input.csrfToken, 'synthetic-csrf');
  assert.equal(authCalls[0].input.origin, headers.origin);
  assert.equal(calls[0].method, 'settings');
  assert.equal(calls[0].input.expectedVersion, 4);
  assert.deepEqual(calls[0].input.settings, settings);
  assert.equal(calls[0].input.idempotencyKey, headers['idempotency-key']);
  assert.equal(
    calls[0].input.correlationId,
    response.headers['x-correlation-id'],
  );
});

test('OLIST-T17 creation switch is admin-only, session/CSRF-bound and rejects extra authority', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  const payload = {
    expectedVersion: 0,
    enabled: true,
    reason: 'Synthetic activation',
  };
  const accepted = await f.api.inject({
    method: 'POST',
    url: `${prefix}/creation`,
    headers,
    payload,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(f.calls[0].method, 'creation');
  assert.equal(f.authCalls[0].input.action, 'olist.manage');
  assert.equal(f.calls[0].input.enabled, true);
  assert.equal(f.calls[0].input.idempotencyKey, headers['idempotency-key']);
  const injected = await f.api.inject({
    method: 'POST',
    url: `${prefix}/creation`,
    headers,
    payload: { ...payload, recoveryRequired: false },
  });
  assert.equal(injected.statusCode, 400);
  const outsider = fixture({ capabilities: [], olistEnabled: true });
  t.after(() => outsider.api.close());
  const denied = await outsider.api.inject({
    method: 'POST',
    url: `${prefix}/creation`,
    headers,
    payload,
  });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(outsider.calls, []);
});

test('each Olist command accepts only its explicit fields and dispatches its closed runtime method', async (t) => {
  const { api, calls } = fixture({ olistEnabled: true });
  t.after(() => api.close());
  /** @type {Array<[string,object,string]>} */
  const commands = [
    ['authorize', {}, 'authorize'],
    [
      'complete',
      { code: 'synthetic-code', state: 'synthetic-state' },
      'complete',
    ],
    [
      'disconnect',
      { expectedVersion: 0, reason: 'Synthetic reason' },
      'disconnect',
    ],
    [
      'settings',
      { expectedVersion: 0, reason: 'Synthetic reason', settings },
      'settings',
    ],
    [
      'recovery',
      { expectedVersion: 0, confirmed: true, reason: 'Synthetic recovery' },
      'recovery',
    ],
    ['order-lookup', { query: '41-CRM' }, 'lookup'],
    ['lookups', { kind: 'warehouses' }, 'lookups'],
    [
      'mappings',
      { resourceId: 'b81808fa-7807-4ae2-a42a-9571ab489541' },
      'mappings',
    ],
  ];
  for (const [name, payload, method] of commands) {
    const accepted = await api.inject({
      method: 'POST',
      url: `${prefix}/${name}`,
      headers,
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(calls.at(-1)?.method, method);
    const count = calls.length;
    for (const invalid of [
      { ...payload, actorId: 'arbitrary-user' },
      { ...payload, accountId: 'arbitrary-account' },
      { ...payload, payload: { valorTotal: 1 } },
      [],
      null,
    ]) {
      const rejected = await api.inject({
        method: 'POST',
        url: `${prefix}/${name}`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: invalid === null ? 'null' : invalid,
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().code, 'INVALID_REQUEST');
    }
    assert.equal(calls.length, count);
  }
});

test('OLIST-T15 recovery requires administration and preserves a bounded blocked refusal', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  f.runtime.recovery = async () => {
    throw Object.assign(new Error('PRIVATE_RECOVERY'), {
      code: 'OLIST_RECOVERY_BLOCKED',
      statusCode: 409,
    });
  };
  const payload = {
    expectedVersion: 0,
    confirmed: true,
    reason: 'Synthetic checked procedure',
  };
  const blocked = await f.api.inject({
    method: 'POST',
    url: `${prefix}/recovery`,
    headers,
    payload,
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'OLIST_RECOVERY_BLOCKED');
  assert.ok(!blocked.body.includes('PRIVATE_RECOVERY'));
  const outsider = fixture({ capabilities: [], olistEnabled: true });
  t.after(() => outsider.api.close());
  const denied = await outsider.api.inject({
    method: 'POST',
    url: `${prefix}/recovery`,
    headers,
    payload,
  });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(outsider.calls, []);
});

test('Olist rejects missing required command fields before invoking its runtime', async (t) => {
  const { api, calls } = fixture({ olistEnabled: true });
  t.after(() => api.close());
  for (const [name, payload] of /** @type {Array<[string,object]>} */ ([
    ['complete', { code: 'synthetic-code' }],
    ['disconnect', { expectedVersion: 0 }],
    ['settings', { expectedVersion: 0, reason: 'Synthetic reason' }],
    ['order-lookup', {}],
    ['lookups', {}],
    ['mappings', {}],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: `${prefix}/${name}`,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_REQUEST');
  }
  assert.deepEqual(calls, []);
});

test('Olist accepts one session cookie only and rejects missing, duplicate or empty bindings', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const cookie of [
    '',
    'crm_session=',
    `crm_session=${session}; crm_session=other`,
    `crm_session=${session}; crm_session=`,
  ]) {
    const response = await api.inject({
      method: 'POST',
      url: `${prefix}/authorize`,
      headers: { ...headers, cookie },
      payload: {},
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'FORBIDDEN');
  }
  assert.deepEqual(calls, []);
});

test('Olist refuses cross-origin, missing CSRF and automation bearer before business effects', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const patch of [
    { origin: 'https://other.example.test' },
    { 'x-csrf-token': '' },
    { authorization: 'Bearer synthetic-bot' },
  ]) {
    const response = await api.inject({
      method: 'POST',
      url: `${prefix}/authorize`,
      headers: { ...headers, ...patch },
      payload: {},
    });
    assert.equal(response.statusCode, 403);
  }
  assert.deepEqual(calls, []);
});

test('enabled Financeiro may locate another owners order but cannot manage the Olist account', async (t) => {
  const { api, calls, authCalls } = fixture({
    id: 'finance-user',
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: true,
  });
  t.after(() => api.close());
  const found = await api.inject({
    method: 'POST',
    url: `${prefix}/order-lookup`,
    headers,
    payload: { query: '41-CRM' },
  });
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), projection);
  assert.equal(authCalls[0].input.action, 'olist.export');
  assert.equal(calls[0].input.actor.id, 'finance-user');
  const denied = await api.inject({ url: `${prefix}/status`, headers });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 1);
});

test('Admin without checkbox may manage the account but may not locate orders for export', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  assert.equal(
    (await api.inject({ url: `${prefix}/status`, headers })).statusCode,
    200,
  );
  const denied = await api.inject({
    method: 'POST',
    url: `${prefix}/order-lookup`,
    headers,
    payload: { query: '41-CRM' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'FORBIDDEN');
  assert.equal(calls.length, 1);
});

test('disabled humans and technical assistants cannot cross any Olist permission boundary', async (t) => {
  for (const actor of [
    { disabledAt: '2026-11-05T12:00:00.000Z' },
    { kind: /** @type {const} */ ('assistant') },
  ]) {
    const { api, calls } = fixture({ ...actor, olistEnabled: true });
    t.after(() => api.close());
    assert.equal(
      (await api.inject({ url: `${prefix}/status`, headers })).statusCode,
      403,
    );
    assert.equal(
      (
        await api.inject({
          method: 'POST',
          url: `${prefix}/order-lookup`,
          headers,
          payload: { query: '41-CRM' },
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(calls, []);
  }
});

test('minimum order projection uses Olist permission and falls back only to commercial reads', async (t) => {
  const finance = fixture({
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: true,
  });
  const seller = fixture({ capabilities: [], olistEnabled: false });
  const excluded = fixture({
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: false,
  });
  for (const item of [finance, seller, excluded])
    t.after(() => item.api.close());
  for (const item of [finance, seller]) {
    const response = await item.api.inject({
      url: '/api/v1/orders/order-of-another-owner/olist',
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), projection);
    assert.equal(item.calls[0].input.orderId, 'order-of-another-owner');
  }
  assert.equal(finance.calls[0].input.action, 'olist.read');
  assert.equal(seller.calls[0].input.action, 'order.read');
  assert.deepEqual(
    seller.authCalls.map((call) => call.input.action),
    ['olist.read', 'order.read'],
  );
  assert.equal(
    (
      await excluded.api.inject({
        url: '/api/v1/orders/order-of-another-owner/olist',
        headers,
      })
    ).statusCode,
    403,
  );
  assert.deepEqual(excluded.calls, []);
});

test('OAuth callback inputs reach the runtime without leaking into errors, logs or cookies', async (t) => {
  const { api, runtime, logs } = fixture();
  t.after(() => api.close());
  runtime.complete = async (/** @type {any} */ input) => {
    assert.equal(input.code, 'synthetic-private-code');
    assert.equal(input.state, 'synthetic-private-state');
    throw Object.assign(
      new Error('buyer@example.test synthetic-private-secret'),
      {
        code: 'OLIST_ACCOUNT_MISMATCH',
        statusCode: 409,
        details: 'synthetic-private-secret',
      },
    );
  };
  const response = await api.inject({
    method: 'POST',
    url: `${prefix}/complete`,
    headers,
    payload: {
      code: 'synthetic-private-code',
      state: 'synthetic-private-state',
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(
    response.headers['content-type'],
    'application/problem+json; charset=utf-8',
  );
  assert.deepEqual(response.json(), {
    type: 'about:blank',
    title: 'OLIST_ACCOUNT_MISMATCH',
    status: 409,
    code: 'OLIST_ACCOUNT_MISMATCH',
  });
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.doesNotMatch(
    response.body + logs.join(''),
    /buyer@example|synthetic-private/u,
  );
});

test('unexpected Olist runtime exceptions become bounded service errors', async (t) => {
  const { api, runtime, logs } = fixture();
  t.after(() => api.close());
  runtime.status = async () => {
    throw Object.assign(new Error('postgres private DSN buyer@example.test'), {
      code: 'ARBITRARY_PRIVATE_CODE',
      statusCode: 418,
      payload: 'synthetic-private-secret',
    });
  };
  const response = await api.inject({ url: `${prefix}/status`, headers });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    type: 'about:blank',
    title: 'SERVICE_UNAVAILABLE',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  });
  assert.doesNotMatch(
    response.body + logs.join(''),
    /postgres private|buyer@example|ARBITRARY_PRIVATE|synthetic-private/u,
  );
});

test('phase two publishes no route to create remote customer, product, variation or order', async (t) => {
  const { api, calls } = fixture({ olistEnabled: true });
  t.after(() => api.close());
  for (const route of [
    'customers',
    'products',
    'variations',
    'orders',
    'exports',
    'create-order',
  ]) {
    const response = await api.inject({
      method: 'POST',
      url: `${prefix}/${route}`,
      headers,
      payload: { arbitrary: 'ERP payload' },
    });
    assert.equal(response.statusCode, 404);
  }
  assert.deepEqual(calls, []);
});

test('T07 export command forwards only the encrypted preview under current Olist permission and returns 202', async (t) => {
  const { api, calls, authCalls, logs } = fixture({
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: true,
  });
  t.after(() => api.close());
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/orders/order-of-another-owner/olist/export',
    headers,
    payload: { previewToken: 'encrypted-preview-receipt' },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().state, 'queued');
  assert.equal(response.json().creationEnabled, false);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(calls[0].method, 'exportOrder');
  assert.equal(calls[0].input.orderId, 'order-of-another-owner');
  assert.equal(calls[0].input.previewToken, 'encrypted-preview-receipt');
  assert.equal(calls[0].input.idempotencyKey, headers['idempotency-key']);
  assert.equal(authCalls[0].write, true);
  assert.equal(authCalls[0].input.action, 'olist.export');
  assert.equal(
    calls[0].input.sessionBinding,
    createHash('sha256').update(session).digest('hex'),
  );
  assert.doesNotMatch(
    response.body + logs.join(''),
    /encrypted-preview-receipt/u,
  );
});
test('T07 strict export body refuses commercial authority and only active enabled humans can command', async (t) => {
  const valid = fixture({ olistEnabled: true });
  t.after(() => valid.api.close());
  for (const payload of [
    {},
    { previewToken: 'encrypted', snapshot: {} },
    { previewToken: 'encrypted', totalCents: 1 },
    { previewToken: 'encrypted', accountKey: 'forged' },
    { previewToken: 'encrypted', settings },
    { previewToken: 'encrypted', actorId: 'forged' },
    [],
    null,
  ]) {
    const response = await valid.api.inject({
      method: 'POST',
      url: '/api/v1/orders/order-of-another-owner/olist/export',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: payload === null ? 'null' : payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(valid.calls, []);
  for (const patch of [
    { olistEnabled: false },
    { disabledAt: '2026-11-06T12:00:00Z' },
    { kind: /** @type {const} */ ('assistant') },
  ]) {
    const f = fixture({ olistEnabled: true, ...patch });
    t.after(() => f.api.close());
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: '/api/v1/orders/order-of-another-owner/olist/export',
          headers,
          payload: { previewToken: 'encrypted' },
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(f.calls, []);
  }
});
