import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { OlistError } from '../modules/olist/src/errors.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/observability.js';

const orderId = 'synthetic-order-of-another-owner';
const requestId = '00000000-0000-4000-8000-000000000009';
const resourceId = '00000000-0000-4000-8000-000000000019';
const prefix = '/api/v1/orders/' + orderId + '/olist';
const session = 'synthetic-olist-administration-session';
const headers = {
  cookie: 'crm_csrf=synthetic-csrf; crm_session=' + session,
  origin: 'https://crm.example.test',
  'sec-fetch-site': 'same-origin',
  'x-csrf-token': 'synthetic-csrf',
  'idempotency-key': 'olist-administration-command',
  'x-correlation-id': 'olist-administration-boundary-test',
};
/** @type {Array<{path:string,method:string,action:string,payload:Record<string,any>,status:number}>} */
const commands = [
  {
    path: '/existing/previews',
    method: 'existingPreview',
    action: 'olist.link',
    payload: { saleId: '401' },
    status: 200,
  },
  {
    path: '/links',
    method: 'linkExisting',
    action: 'olist.link',
    payload: {
      previewToken: 'synthetic-encrypted-existing-receipt',
      reason: 'Synthetic approved link',
    },
    status: 200,
  },
  {
    path: '/reconcile',
    method: 'reconcile',
    action: 'olist.reconcile',
    payload: {
      stage: 'sale',
      resourceId: null,
      expectedVersion: 2,
      reason: 'Synthetic reconciliation',
    },
    status: 202,
  },
  {
    path: '/invalidate',
    method: 'invalidate',
    action: 'olist.invalidate',
    payload: {
      operationId: resourceId,
      expectedVersion: 3,
      reason: 'Synthetic invalidation',
    },
    status: 200,
  },
];
/** @type {Array<{path:string,method:string,action:string}>} */
const reads = [
  { path: '/administration', method: 'administration', action: 'olist.link' },
  {
    path: '/reconciliations/' + requestId,
    method: 'readReconciliation',
    action: 'olist.reconcile',
  },
];

/** @param {Partial<import('../modules/identity-access/src/authorization.js').AccessActor>} [patch] */
function fixture(patch = {}) {
  const actor = {
    id: 'synthetic-current-admin',
    kind: /** @type {const} */ ('human'),
    functionName: /** @type {const} */ ('Vendedor'),
    capabilities:
      /** @type {import('../modules/identity-access/src/authorization.js').Capability[]} */ ([
        'COMMERCIAL_ADMIN',
      ]),
    olistEnabled: false,
    olistAuthorizationVersion: 2,
    ...patch,
  };
  /** @type {Array<{method:string,input:any}>} */ const calls = [];
  /** @type {Array<{write:boolean,input:any}>} */ const authCalls = [];
  /** @type {string[]} */ const logs = [];
  /** @param {any} input @param {boolean} write */
  function check(input, write) {
    authCalls.push({ input, write });
    if (
      input.authorization !== undefined ||
      !String(input.cookie).includes('crm_session=' + session)
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
  for (const method of [...commands, ...reads].map((item) => item.method)) {
    runtime[method] = async (/** @type {any} */ input) => {
      calls.push({ method, input });
      if (method === 'existingPreview')
        return {
          orderId: input.orderId,
          eligible: true,
          sale: { id: '401', number: '99' },
          previewToken: 'synthetic-encrypted-existing-receipt',
          creationEnabled: false,
        };
      if (method === 'linkExisting')
        return {
          operationId: requestId,
          orderId: input.orderId,
          state: 'linked',
          stage: 'complete',
          number: '99',
          creationEnabled: false,
        };
      if (method === 'reconcile')
        return {
          requestId,
          orderId: input.orderId,
          state: 'pending',
          creationEnabled: false,
        };
      if (method === 'invalidate')
        return {
          operationId: input.operationId,
          orderId: input.orderId,
          state: 'invalidated',
          version: input.expectedVersion + 1,
        };
      if (method === 'administration')
        return {
          orderId: input.orderId,
          operation: {
            id: requestId,
            state: 'uncertain',
            stage: 'sale',
            version: 2,
          },
          resources: [],
          creationEnabled: false,
        };
      return {
        requestId: input.requestId,
        state: 'pending',
        stage: 'sale',
        creationEnabled: false,
      };
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
  return { api, actor, runtime, calls, authCalls, logs };
}

/** @param {any} response */
function privateHeaders(response) {
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers.vary, 'Origin, Cookie');
}

test('T09 administrator without export checkbox can use only the dedicated link/reconciliation/invalidation commands', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  for (const command of commands) {
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + command.path,
      headers,
      payload: command.payload,
    });
    assert.equal(response.statusCode, command.status, response.body);
    privateHeaders(response);
    const call = f.calls.at(-1);
    assert.equal(call?.method, command.method);
    assert.equal(call?.input.orderId, orderId);
    assert.equal(call?.input.actor.id, f.actor.id);
    assert.equal(call?.input.actor.olistEnabled, false);
    assert.equal(call?.input.idempotencyKey, headers['idempotency-key']);
    assert.equal(
      call?.input.correlationId,
      response.headers['x-correlation-id'],
    );
    assert.equal(
      call?.input.sessionBinding,
      createHash('sha256').update(session).digest('hex'),
    );
    assert.equal(f.authCalls.at(-1)?.write, true);
    assert.equal(f.authCalls.at(-1)?.input.action, command.action);
    for (const [key, value] of Object.entries(command.payload))
      assert.deepEqual(call?.input[key], value);
  }
  assert.equal(f.calls.length, 4);
  assert.doesNotMatch(JSON.stringify(f.calls), new RegExp(session, 'u'));
});

test('T09 administration and reconciliation status use administrative read authorization and bind the request/order path', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  for (const read of reads) {
    const response = await f.api.inject({ url: prefix + read.path, headers });
    assert.equal(response.statusCode, 200, response.body);
    privateHeaders(response);
    assert.equal(f.authCalls.at(-1)?.write, false);
    assert.equal(f.authCalls.at(-1)?.input.action, read.action);
    assert.equal(f.calls.at(-1)?.method, read.method);
    assert.equal(f.calls.at(-1)?.input.orderId, orderId);
    assert.equal(
      f.calls.at(-1)?.input.sessionBinding,
      createHash('sha256').update(session).digest('hex'),
    );
  }
  assert.equal(f.calls.at(-1)?.input.requestId, requestId);
});

test('T09 strict bodies refuse arbitrary authority, values, URLs, missing fields and arrays before runtime', async (t) => {
  for (const command of commands) {
    const f = fixture();
    t.after(() => f.api.close());
    for (const payload of [
      { ...command.payload, actorId: 'forged-admin' },
      { ...command.payload, accountKey: 'forged-account' },
      { ...command.payload, totalCents: 1 },
      { ...command.payload, unitPrice: 0.01 },
      { ...command.payload, url: 'https://untrusted.example.test/private' },
      { ...command.payload, snapshot: { customer: 'PRIVATE_SNAPSHOT_CANARY' } },
      {},
      [],
      null,
    ]) {
      const response = await f.api.inject({
        method: 'POST',
        url: prefix + command.path,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: payload === null ? 'null' : payload,
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, 'INVALID_REQUEST');
      privateHeaders(response);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('T09 every command and read rejects enabled sellers/Financeiro, disabled actors and automation without administrative elevation', async (t) => {
  for (const patch of [
    { capabilities: [], olistEnabled: true },
    {
      functionName: /** @type {const} */ ('Financeiro'),
      capabilities: [],
      olistEnabled: true,
    },
    { disabledAt: '2026-11-06T12:00:00Z' },
    { kind: /** @type {const} */ ('assistant'), olistEnabled: true },
  ]) {
    const f = fixture(patch);
    t.after(() => f.api.close());
    for (const command of commands) {
      const response = await f.api.inject({
        method: 'POST',
        url: prefix + command.path,
        headers,
        payload: command.payload,
      });
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().code, 'FORBIDDEN');
    }
    for (const read of reads) {
      const response = await f.api.inject({ url: prefix + read.path, headers });
      assert.equal(response.statusCode, 403, response.body);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('T09 administrative commands require the human session, unique cookie binding, CSRF and same-origin even though ERP work only reads', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  for (const command of commands) {
    for (const patch of [
      { cookie: '' },
      { cookie: 'crm_session=' },
      { cookie: headers.cookie + '; crm_session=second-session' },
      { authorization: 'Bearer synthetic-automation-token' },
      { origin: 'https://untrusted.example.test' },
      { 'x-csrf-token': '' },
    ]) {
      const response = await f.api.inject({
        method: 'POST',
        url: prefix + command.path,
        headers: { ...headers, ...patch },
        payload: command.payload,
      });
      assert.equal(response.statusCode, 403, response.body);
      privateHeaders(response);
    }
  }
  for (const read of reads) {
    for (const patch of [
      { cookie: '' },
      { cookie: headers.cookie + '; crm_session=second-session' },
      { authorization: 'Bearer synthetic-automation-token' },
      {
        origin: 'https://untrusted.example.test',
        'sec-fetch-site': 'cross-site',
      },
    ]) {
      const response = await f.api.inject({
        url: prefix + read.path,
        headers: { ...headers, ...patch },
      });
      assert.equal(response.statusCode, 403, response.body);
    }
  }
  assert.deepEqual(f.calls, []);
});

test('T09 resource reconciliation forwards an explicit scoped selector without permitting request payloads', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  const payload = {
    stage: 'variation',
    resourceId,
    expectedVersion: 7,
    reason: 'Synthetic uncertain variation',
  };
  const response = await f.api.inject({
    method: 'POST',
    url: prefix + '/reconcile',
    headers,
    payload,
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'reconcile');
  assert.equal(f.calls[0].input.resourceId, resourceId);
  assert.equal(f.calls[0].input.stage, 'variation');
  assert.equal(f.calls[0].input.expectedVersion, 7);
  assert.equal(response.json().requestId, requestId);
});

test('T09 runtime failures expose bounded classifications without upstream text, payload, reason or session in logs', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  const canary = 'PRIVATE_ADMINISTRATION_REASON_CANARY';
  for (const [index, failure] of [
    Object.assign(new Error(canary), {
      code: 'VERSION_CONFLICT',
      statusCode: 409,
    }),
    Object.assign(new Error(canary), {
      code: 'OLIST_AMBIGUOUS_MATCH',
      statusCode: 409,
    }),
    new Error(canary),
  ].entries()) {
    f.runtime.linkExisting = async () => {
      throw failure;
    };
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + '/links',
      headers,
      payload: { previewToken: 'PRIVATE_PREVIEW_CANARY', reason: canary },
    });
    assert.equal(response.statusCode, index === 2 ? 503 : 409, response.body);
    assert.equal(
      response.json().code,
      index === 2 ? 'SERVICE_UNAVAILABLE' : /** @type {any} */ (failure).code,
    );
    privateHeaders(response);
    assert.doesNotMatch(
      response.body + f.logs.join(''),
      /PRIVATE_|synthetic-olist-administration-session|synthetic-automation-token/u,
    );
  }
});

test('T09 administrative ERP reads are rate limited before unlimited runtime work can be scheduled', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  let limited = false;
  for (let index = 0; index < 40; index++) {
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + '/existing/previews',
      headers,
      payload: { saleId: '401' },
    });
    if (response.statusCode === 429) {
      limited = true;
      break;
    }
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(limited, true);
  assert.ok(f.calls.length < 40);
});

test('T14 payload and parent refusals keep their own 409 code and a fixed body instead of a 503', async (t) => {
  for (const code of [
    'OLIST_PARENT_UNRESOLVED',
    'OLIST_CUSTOMER_INVALID',
    'OLIST_PAYMENT_DUE_REQUIRED',
    'OLIST_SALE_EXACT_CENT_REQUIRED',
    'OLIST_SALE_PLAN_INVALID',
  ]) {
    const f = fixture();
    t.after(() => f.api.close());
    f.runtime.administration = async () => {
      throw Object.assign(new OlistError(code, 409), {
        detail: 'PRIVATE_REMOTE_BODY',
      });
    };
    const response = await f.api.inject({
      url: prefix + '/administration',
      headers,
    });
    assert.equal(response.statusCode, 409, code);
    assert.deepEqual(response.json(), {
      type: 'about:blank',
      title: code,
      status: 409,
      code,
    });
    privateHeaders(response);
    assert.doesNotMatch(response.body, /PRIVATE_/u);
  }
});

const invalidation = {
  operationId: resourceId,
  expectedVersion: 3,
  reason: 'PRIVATE_INVALIDATION_REASON_CANARY',
};

test('L1 invalidate answers 200 (not 202) with the administrator action and forwards the strict body', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  const response = await f.api.inject({
    method: 'POST',
    url: prefix + '/invalidate',
    headers,
    payload: invalidation,
  });
  assert.equal(response.statusCode, 200, response.body);
  privateHeaders(response);
  assert.deepEqual(response.json(), {
    operationId: resourceId,
    orderId,
    state: 'invalidated',
    version: 4,
  });
  assert.equal(f.authCalls.at(-1)?.write, true);
  assert.equal(f.authCalls.at(-1)?.input.action, 'olist.invalidate');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'invalidate');
  assert.equal(f.calls[0].input.orderId, orderId);
  assert.equal(f.calls[0].input.operationId, resourceId);
  assert.equal(f.calls[0].input.expectedVersion, 3);
  assert.equal(f.calls[0].input.reason, invalidation.reason);
  assert.equal(f.calls[0].input.idempotencyKey, headers['idempotency-key']);
  assert.equal(
    f.calls[0].input.sessionBinding,
    createHash('sha256').update(session).digest('hex'),
  );
  assert.doesNotMatch(
    response.body + f.logs.join(''),
    /PRIVATE_|synthetic-olist-administration-session/u,
  );
});

test('L1 invalidate needs Vendedor + COMMERCIAL_ADMIN whatever the Olist checkbox says', async (t) => {
  for (const [patch, status] of /** @type {const} */ ([
    [{ olistEnabled: false }, 200],
    [{ olistEnabled: true }, 200],
    [{ capabilities: [], olistEnabled: true }, 403],
    [{ functionName: 'Financeiro', capabilities: [], olistEnabled: true }, 403],
    [{ disabledAt: '2026-11-06T12:00:00Z' }, 403],
    [{ kind: 'assistant', olistEnabled: true }, 403],
  ])) {
    const f = fixture(/** @type {any} */ (patch));
    t.after(() => f.api.close());
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + '/invalidate',
      headers,
      payload: invalidation,
    });
    assert.equal(response.statusCode, status, JSON.stringify(patch));
    assert.equal(f.calls.length, status === 200 ? 1 : 0);
  }
});

test('L1 invalidate refusals keep their own 409 code and a fixed body without the reason', async (t) => {
  for (const [code, statusCode] of /** @type {const} */ ([
    ['OLIST_INVALIDATION_BLOCKED', 409],
    ['OLIST_EXPORT_IN_FLIGHT', 409],
    ['OLIST_RESOURCE_RECONCILIATION_REQUIRED', 409],
    ['OLIST_EXPORT_UNAVAILABLE', 409],
    ['VERSION_CONFLICT', 409],
    ['ORDER_CANCELLED', 409],
    ['ORDER_NOT_FOUND', 404],
    ['IDEMPOTENCY_KEY_REUSED', 409],
  ])) {
    const f = fixture();
    t.after(() => f.api.close());
    f.runtime.invalidate = async () => {
      throw Object.assign(new OlistError(code, statusCode), {
        detail: 'PRIVATE_REMOTE_BODY',
      });
    };
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + '/invalidate',
      headers,
      payload: invalidation,
    });
    assert.equal(response.statusCode, statusCode, code);
    assert.deepEqual(response.json(), {
      type: 'about:blank',
      title: code,
      status: statusCode,
      code,
    });
    privateHeaders(response);
    assert.doesNotMatch(
      response.body + f.logs.join(''),
      /PRIVATE_|synthetic-olist-administration-session/u,
    );
  }
  // A refusal thrown without its own status still reaches the client as 409,
  // and an unknown failure never leaks as anything but a 503.
  const f = fixture();
  t.after(() => f.api.close());
  f.runtime.invalidate = async () => {
    throw Object.assign(new Error('PRIVATE_INTERNAL'), {
      code: 'OLIST_INVALIDATION_BLOCKED',
    });
  };
  const bare = await f.api.inject({
    method: 'POST',
    url: prefix + '/invalidate',
    headers,
    payload: invalidation,
  });
  assert.equal(bare.statusCode, 409);
  assert.equal(bare.json().code, 'OLIST_INVALIDATION_BLOCKED');
  f.runtime.invalidate = async () => {
    throw new Error('PRIVATE_INTERNAL');
  };
  const unknown = await f.api.inject({
    method: 'POST',
    url: prefix + '/invalidate',
    headers,
    payload: invalidation,
  });
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.json().code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(unknown.body, /PRIVATE_/u);
});

test('L1 invalidate is rate limited at ten commands per minute', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  /** @type {number[]} */ const statuses = [];
  for (let index = 0; index < 14; index++) {
    const response = await f.api.inject({
      method: 'POST',
      url: prefix + '/invalidate',
      headers,
      payload: invalidation,
    });
    statuses.push(response.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.deepEqual(statuses.slice(10), Array(4).fill(429));
  assert.equal(f.calls.length, 10);
});

test('L1 invalidate is a POST only: no GET, PUT or DELETE route exists', async (t) => {
  const f = fixture();
  t.after(() => f.api.close());
  for (const method of /** @type {const} */ (['GET', 'PUT', 'DELETE'])) {
    const response = await f.api.inject({
      method,
      url: prefix + '/invalidate',
      headers,
    });
    assert.equal(response.statusCode, 404, method);
  }
  assert.deepEqual(f.calls, []);
});
