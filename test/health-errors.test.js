import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerApi } from '../apps/api/src/server.js';
import {
  createHealthErrorsRuntime,
  validateIncidentChange,
} from '../apps/api/src/health-errors-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const quiet = createSafeLogger({ service: 'crm-silmer-api', sink: () => {} });
const allowed = {
  id: 'console-admin',
  email: 'admin@crm-silmer.local',
  functionName: /** @type {const} */ ('Vendedor'),
  capabilities: [/** @type {const} */ ('COMMERCIAL_ADMIN')],
};

test('OPS-ERR-01: only the named human administrator passes the policy', () => {
  for (const action of ['health.errors.read', 'health.errors.update']) {
    assert.doesNotThrow(() => authorize(allowed, action));
    for (const actor of [
      { ...allowed, email: 'other-admin@example.test' },
      { ...allowed, email: undefined },
      { ...allowed, capabilities: [] },
      { ...allowed, functionName: /** @type {const} */ ('Financeiro') },
      { ...allowed, kind: /** @type {const} */ ('assistant') },
    ])
      assert.throws(() => authorize(actor, action), { code: 'FORBIDDEN' });
  }
});

test('OPS-ERR-03: triage accepts only a status and a positive numeric version', () => {
  assert.deepEqual(
    validateIncidentChange({ status: 'investigating', version: 2 }),
    { status: 'investigating', version: 2 },
  );
  for (const input of [
    null,
    [],
    { status: 'retry', version: 1 },
    { status: 'new', version: '1' },
    { status: 'resolved', version: 0 },
    { status: 'new', version: 1, message: 'private' },
  ])
    assert.throws(() => validateIncidentChange(input), {
      code: 'INVALID_REQUEST',
    });
});

test('OPS-ERR-01: foreign origins, Basic, missing/duplicate cookies and CSRF stop before querying data', async () => {
  let calls = 0;
  const runtime = createHealthErrorsRuntime({
    database: {
      transaction: async () => {
        calls += 1;
        throw new Error('not reached');
      },
    },
    identity: { allowedOrigins: ['https://crm.example.test'] },
    envelopeKey: Buffer.alloc(32, 3),
  });
  for (const input of [
    { cookie: 'crm_session=test', origin: 'https://elsewhere.example.test' },
    {
      cookie: 'crm_session=test',
      origin: 'https://crm.example.test',
      authorization: 'Basic synthetic',
    },
    { origin: 'https://crm.example.test' },
    {
      cookie: 'crm_session=a; crm_session=b',
      origin: 'https://crm.example.test',
    },
    { cookie: 'crm_session=test', secFetchSite: 'cross-site' },
  ])
    await assert.rejects(runtime.list(input), (error) =>
      [400, 403].includes(/** @type {any} */ (error).statusCode),
    );
  await assert.rejects(
    runtime.change({
      origin: 'https://crm.example.test',
      cookie: 'crm_session=test; crm_csrf=a',
      csrfToken: 'b',
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(calls, 0);
});

test('OPS-ERR-01: a valid cookie still needs current identity authorization before any incident query', async () => {
  /** @type {string[]} */
  const queries = [];
  const client = {
    query: async (/** @type {string} */ sql) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  const runtime = createHealthErrorsRuntime({
    database: { transaction: (/** @type {Function} */ work) => work(client) },
    identity: {
      allowedOrigins: ['https://crm.example.test'],
      authorizeHealthErrors: async () => {
        throw Object.assign(new Error('FORBIDDEN'), {
          code: 'FORBIDDEN',
          statusCode: 403,
        });
      },
    },
    envelopeKey: Buffer.alloc(32, 3),
  });
  await assert.rejects(
    runtime.list({ cookie: 'crm_session=test', secFetchSite: 'same-origin' }),
    { code: 'FORBIDDEN' },
  );
  assert.deepEqual(queries, []);
});

test('OPS-ERR-04: API collection persists no exception, body, URL, foreign code or invalid trace', async () => {
  /** @type {unknown[][]} */
  const values = [];
  const client = {
    query: async (
      /** @type {string} */ sql,
      /** @type {unknown[]} */ args = [],
    ) => {
      values.push(args);
      if (sql.includes('INSERT INTO crm.operational_incidents'))
        return { rows: [{ id: 'incident', status: 'new', version: 1 }] };
      if (sql.includes('INSERT INTO crm.operational_incident_receipts'))
        return { rows: [{ event_key: 'receipt' }] };
      return { rows: [] };
    },
  };
  const runtime = createHealthErrorsRuntime({
    database: { transaction: (/** @type {Function} */ work) => work(client) },
    identity: {},
    envelopeKey: Buffer.alloc(32),
  });
  await runtime.recordApiFailure(
    /** @type {any} */ ({
      statusCode: 500,
      requestId: 'private@example.test',
      correlationId: 'customer-phone',
      error: { message: 'secret exception' },
      url: '/customer/private',
      body: 'private message',
      code: 'PRIVATE_CODE',
    }),
  );
  const serialized = JSON.stringify(values);
  assert.match(serialized, /API_5XX/u);
  assert.doesNotMatch(serialized, /private|secret|customer|PRIVATE_CODE/iu);
});

test('OPS-ERR-05: API collector does not delay response, does not recurse and drains before database close', async () => {
  /** @type {() => void} */
  let release = () => {};
  let stored = false;
  let closed = false;
  /** @type {any[]} */
  const captured = [];
  const pending = new Promise(
    (/** @type {(value?: void) => void} */ resolve) => {
      release = resolve;
    },
  );
  const api = createServerApi({
    database: {
      query: async () => ({ rows: [] }),
      transaction: async (work) => work({ query: async () => ({ rows: [] }) }),
      close: async () => {
        assert.equal(stored, true);
        closed = true;
      },
    },
    environment: {},
    logger: quiet,
    healthErrors: /** @type {any} */ ({
      cleanup: async () => {},
      list: async () => {
        throw new Error('secret');
      },
      change: async () => ({}),
      recordApiFailure: async (/** @type {any} */ input) => {
        captured.push(input);
        await pending;
        stored = true;
      },
    }),
  });
  api.get('/synthetic-failure', async (_request, reply) =>
    reply.code(500).send({ error: 'synthetic' }),
  );
  try {
    const response = await api.inject('/synthetic-failure');
    assert.equal(response.statusCode, 500);
    assert.equal(stored, false);
    assert.equal(captured.length, 1);
    assert.deepEqual(Object.keys(captured[0]).sort(), [
      'correlationId',
      'readiness',
      'requestId',
      'statusCode',
    ]);
    const consoleFailure = await api.inject('/api/v1/admin/health-errors');
    assert.equal(consoleFailure.statusCode, 503);
    assert.equal(consoleFailure.headers['cache-control'], 'private, no-store');
    assert.doesNotMatch(consoleFailure.body, /secret/u);
    assert.equal(captured.length, 1);
    const closing = api.close();
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(closed, true);
  } finally {
    release();
    await api.close();
  }
});
