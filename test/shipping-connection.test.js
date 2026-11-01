import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createShippingApiRuntime,
  quotePayload,
  quoteProjection,
} from '../apps/api/src/shipping-runtime.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const ACTOR = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const SESSION = 'a'.repeat(64);
const ENV = {
  MELHOR_ENVIO_ENABLED: 'true',
  MELHOR_ENVIO_ENVIRONMENT: 'sandbox',
  MELHOR_ENVIO_CLIENT_ID: '1234',
  MELHOR_ENVIO_CLIENT_SECRET: 'synthetic-client-secret',
  MELHOR_ENVIO_REDIRECT_URI: 'https://crm.example.test/melhor-envio',
  MELHOR_ENVIO_USER_AGENT: 'CRM Silmer (support@example.test)',
  MELHOR_ENVIO_ENVELOPE_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const QUOTE = {
  fromPostalCode: '01001000',
  toPostalCode: '20040020',
  weightGrams: 800,
  widthCm: 15,
  heightCm: 10,
  lengthCm: 20,
  insuranceValueCents: 10000,
};

/** A serialized transactional fake, exercising runtime SQL/rollback boundaries.
 * No remote provider or real customer data is used. */
function database() {
  /** @type {any} */
  const state = { connection: null, states: [], audits: [], admin: true };
  let tail = Promise.resolve();
  const db = {
    state,
    /** @param {string} sql @param {any[]} [values] */
    async query(sql, values = []) {
      const [context, second, third, fourth, fifth, sixth] = values;
      if (sql.includes('SELECT u.id'))
        return {
          rows: state.admin
            ? [{ id: ACTOR.id, function_name: 'Vendedor' }]
            : [],
        };
      if (sql.includes('SELECT capability'))
        return {
          rows: state.admin ? [{ capability: 'COMMERCIAL_ADMIN' }] : [],
        };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('INSERT INTO crm.shipping_connections')) {
        state.connection ??= {
          context_key: context,
          environment: second,
          token_envelope: null,
          expires_at: null,
          reconnect_required: false,
          refresh_started_at: null,
          version: 0,
        };
        return { rows: [] };
      }
      if (sql.startsWith('SELECT * FROM crm.shipping_connections'))
        return {
          rows:
            state.connection?.context_key === context
              ? [structuredClone(state.connection)]
              : [],
        };
      if (
        sql.startsWith('DELETE FROM crm.shipping_oauth_states WHERE expires_at')
      ) {
        state.states = state.states.filter(
          (/** @type {any} */ row) => row.expires_at > context,
        );
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO crm.shipping_oauth_states')) {
        state.states = state.states.filter(
          (/** @type {any} */ row) =>
            !(
              row.context_key === context &&
              row.actor_id === second &&
              row.session_hash === third
            ),
        );
        state.states.push({
          context_key: context,
          actor_id: second,
          session_hash: third,
          state_hash: fourth,
          expires_at: fifth,
          connection_version: sixth,
        });
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM crm.shipping_oauth_states')) {
        const found = state.states.filter(
          (/** @type {any} */ row) =>
            row.context_key === context &&
            (values.length === 1 ||
              (row.actor_id === second &&
                row.session_hash === third &&
                row.state_hash === fourth &&
                row.expires_at > fifth)),
        );
        state.states = state.states.filter(
          (/** @type {any} */ row) => !found.includes(row),
        );
        return { rows: found };
      }
      if (sql.startsWith('UPDATE crm.shipping_connections')) {
        const row = state.connection;
        row.version += 1;
        if (sql.includes('token_envelope=$2'))
          Object.assign(row, {
            token_envelope: JSON.parse(second),
            expires_at: third,
            reconnect_required: false,
            connected_by: fourth,
            refresh_started_at: null,
          });
        else if (sql.includes('token_envelope=NULL'))
          Object.assign(row, {
            token_envelope: null,
            expires_at: null,
            reconnect_required: false,
            refresh_started_at: null,
          });
        else if (sql.includes('SET refresh_started_at=$2'))
          row.refresh_started_at = second;
        else
          Object.assign(row, {
            reconnect_required: true,
            refresh_started_at: null,
          });
        return { rows: [structuredClone(row)] };
      }
      if (sql.includes('INSERT INTO crm.audit_events')) {
        state.audits.push(values);
        return { rows: [] };
      }
      throw new Error(`Unexpected synthetic DB query: ${sql}`);
    },
    /** @template T @param {(client:any)=>Promise<T>} work */
    async transaction(work) {
      const previous = tail;
      /** @type {()=>void} */ let release = () => {};
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      const before = structuredClone(state);
      try {
        return await work(db);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      } finally {
        release();
      }
    },
  };
  return db;
}

/** @param {number} status @param {unknown} value */
const reply = (status, value) => ({
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(value),
});

/** @param {{environment?:Record<string,string|undefined>,fetch?:any,timeoutMs?:number}} [options] */
function fixture(options = {}) {
  const db = database();
  let time = NOW;
  /** @type {Array<{url:string,init:RequestInit}>} */ const calls = [];
  const fetch =
    options.fetch ??
    (async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      calls.push({ url, init });
      return url.endsWith('/oauth/token')
        ? reply(200, {
            access_token: 'synthetic-access',
            refresh_token: 'synthetic-refresh',
            expires_in: 2_592_000,
          })
        : reply(200, [
            {
              id: 1,
              name: 'PAC',
              company: { name: 'Correios' },
              price: '25.90',
              delivery_time: 5,
            },
          ]);
    });
  const runtime = createShippingApiRuntime(db, {
    access: {},
    environment: options.environment ?? ENV,
    clock: () => time,
    fetch,
    timeoutMs: options.timeoutMs,
  });
  const input = {
    actor: ACTOR,
    sessionBinding: SESSION,
    correlationId: 'shipping-test',
  };
  return {
    db,
    runtime,
    input,
    calls,
    setTime: (/** @type {Date} */ value) => {
      time = value;
    },
    async connect() {
      const { authorizationUrl } = await runtime.authorize(input);
      const state = new URL(authorizationUrl).searchParams.get('state');
      await runtime.complete({ ...input, state, code: 'synthetic-code' });
      return state;
    },
  };
}

test('disabled or incomplete shipping configuration never touches the database', async () => {
  for (const env of [
    {},
    { ...ENV, MELHOR_ENVIO_CLIENT_SECRET: '' },
    {
      ...ENV,
      MELHOR_ENVIO_REDIRECT_URI:
        'https://crm.example.test/melhor-envio?steal=x',
    },
    { ...ENV, MELHOR_ENVIO_ENVIRONMENT: 'https://evil.example.test' },
  ]) {
    const { runtime, input, db } = fixture({ environment: env });
    const status = await runtime.status(input);
    assert.equal(status.configured, false);
    assert.equal(status.connected, false);
    assert.equal(db.state.connection, null);
    await assert.rejects(runtime.authorize(input), {
      code: 'MELHOR_ENVIO_NOT_CONFIGURED',
    });
  }
});

test('OAuth uses only quote scopes and persists authenticated ciphertext, hashes and expiry', async () => {
  const { runtime, input, db } = fixture();
  const { authorizationUrl } = await runtime.authorize(input);
  const url = new URL(authorizationUrl);
  assert.equal(url.origin, 'https://sandbox.melhorenvio.com.br');
  assert.equal(
    url.searchParams.get('scope'),
    'shipping-calculate shipping-companies',
  );
  const state = url.searchParams.get('state');
  assert.ok(state);
  assert.ok(!JSON.stringify(db.state).includes(state));
  const status = await runtime.complete({
    ...input,
    state,
    code: 'synthetic-code',
  });
  assert.deepEqual(status, {
    configured: true,
    connected: true,
    environment: 'sandbox',
    expiresAt: '2026-12-01T12:00:00.000Z',
    reconnectRequired: false,
  });
  for (const secret of [
    'synthetic-access',
    'synthetic-refresh',
    'synthetic-client-secret',
  ])
    assert.ok(!JSON.stringify(db.state).includes(secret));
  assert.equal(db.state.connection.token_envelope.algorithm, 'AES-256-GCM');
  assert.equal(db.state.states.length, 0);
  assert.equal(db.state.audits.length, 1);
});

test('state rejects another actor/session, expiry and replay without exchanging a token', async () => {
  const f = fixture();
  const { authorizationUrl } = await f.runtime.authorize(f.input);
  const state = new URL(authorizationUrl).searchParams.get('state');
  await assert.rejects(
    f.runtime.complete({
      ...f.input,
      state,
      code: 'code',
      sessionBinding: 'b'.repeat(64),
    }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  await assert.rejects(
    f.runtime.complete({
      ...f.input,
      state,
      code: 'code',
      actor: { ...ACTOR, id: 'other-actor' },
    }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  f.setTime(new Date(NOW.getTime() + 600_001));
  await assert.rejects(
    f.runtime.complete({ ...f.input, state, code: 'code' }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  assert.equal(f.calls.length, 0);
  f.setTime(NOW);
  const used = await f.connect();
  const count = f.calls.length;
  await assert.rejects(
    f.runtime.complete({ ...f.input, state: used, code: 'code' }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  assert.equal(f.calls.length, count);
});

test('failed token exchange consumes state in its committed transaction', async () => {
  let exchanges = 0;
  const f = fixture({
    fetch: async () => {
      exchanges += 1;
      return reply(401, { message: 'synthetic-client-secret' });
    },
  });
  const { authorizationUrl } = await f.runtime.authorize(f.input);
  const state = new URL(authorizationUrl).searchParams.get('state');
  await assert.rejects(
    f.runtime.complete({ ...f.input, state, code: 'code' }),
    { code: 'MELHOR_ENVIO_AUTH' },
  );
  await assert.rejects(
    f.runtime.complete({ ...f.input, state, code: 'code' }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  assert.equal(exchanges, 1);
});

test('quote validates first, sends measured dimensions and projects bounded public fields', async () => {
  const f = fixture();
  await f.connect();
  const result = await f.runtime.quote({ ...f.input, body: QUOTE });
  assert.deepEqual(result, {
    services: [
      {
        id: 1,
        name: 'PAC',
        company: 'Correios',
        priceCents: 2590,
        deliveryDays: 5,
      },
    ],
    unavailable: [],
  });
  const call = f.calls.at(-1);
  assert.ok(call);
  assert.deepEqual(JSON.parse(String(call.init.body)).volumes, [
    { height: 10, width: 15, length: 20, weight: 0.8 },
  ]);
  const count = f.calls.length;
  await assert.rejects(
    f.runtime.quote({ ...f.input, body: { ...QUOTE, widthCm: Infinity } }),
    { code: 'INVALID_QUOTE_PACKAGES' },
  );
  await assert.rejects(
    f.runtime.quote({ ...f.input, body: { ...QUOTE, toPostalCode: 'bad' } }),
    { code: 'INVALID_POSTAL_CODE' },
  );
  assert.equal(f.calls.length, count);
});

test('concurrent quotes claim one durable refresh and disconnect prevents subsequent use', async () => {
  const f = fixture();
  await f.connect();
  f.setTime(new Date('2026-11-30T20:00:00Z'));
  const results = await Promise.allSettled([
    f.runtime.quote({ ...f.input, body: QUOTE }),
    f.runtime.quote({ ...f.input, body: QUOTE }),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  const rejected = results.find((row) => row.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(rejected.reason.code, 'MELHOR_ENVIO_REFRESH_IN_PROGRESS');
  assert.equal(
    f.calls.filter((call) => call.url.endsWith('/oauth/token')).length,
    2,
  );
  const { authorizationUrl } = await f.runtime.authorize(f.input);
  const state = new URL(authorizationUrl).searchParams.get('state');
  const status = await f.runtime.disconnect(f.input);
  assert.equal(status.connected, false);
  await assert.rejects(
    f.runtime.complete({ ...f.input, state, code: 'code' }),
    { code: 'MELHOR_ENVIO_INVALID_STATE' },
  );
  await assert.rejects(f.runtime.quote({ ...f.input, body: QUOTE }), {
    code: 'MELHOR_ENVIO_NOT_CONNECTED',
  });
});

test('failed refresh commits reconnection state and never blindly retries a rotated token', async () => {
  let count = 0;
  const f = fixture({
    fetch: async () => {
      count += 1;
      if (count === 1)
        return reply(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 10,
        });
      throw new Error('synthetic secret from provider');
    },
  });
  await f.connect();
  await assert.rejects(f.runtime.quote({ ...f.input, body: QUOTE }), {
    code: 'MELHOR_ENVIO_UNAVAILABLE',
  });
  assert.equal((await f.runtime.status(f.input)).reconnectRequired, true);
  await assert.rejects(f.runtime.quote({ ...f.input, body: QUOTE }), {
    code: 'MELHOR_ENVIO_RECONNECT_REQUIRED',
  });
  assert.equal(count, 2);
});

test('revoked administrator and authenticated-envelope tampering fail closed', async () => {
  const f = fixture();
  await f.connect();
  f.db.state.admin = false;
  await assert.rejects(f.runtime.quote({ ...f.input, body: QUOTE }), {
    code: 'FORBIDDEN',
  });
  f.db.state.admin = true;
  f.db.state.connection.token_envelope.ciphertext =
    Buffer.from('tampered').toString('base64');
  await assert.rejects(f.runtime.quote({ ...f.input, body: QUOTE }), {
    code: 'MELHOR_ENVIO_RECONNECT_REQUIRED',
  });
  assert.equal((await f.runtime.status(f.input)).reconnectRequired, true);
});

test('quote rejects injection arrays and malformed provider values; unavailability text is fixed', () => {
  assert.throws(() => quotePayload({ ...QUOTE, toPostalCode: ['01001000'] }), {
    code: 'INVALID_POSTAL_CODE',
  });
  assert.throws(
    () => quotePayload({ ...QUOTE, callback: 'https://elsewhere.test' }),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () =>
      quoteProjection([
        {
          id: 1,
          name: 'PAC',
          company: { name: 'Correios' },
          price: 'NaN',
          delivery_time: 5,
        },
      ]),
    { code: 'MELHOR_ENVIO_INVALID_RESPONSE' },
  );
  assert.deepEqual(
    quoteProjection([{ id: 1, name: 'PAC', error: 'private upstream data' }]),
    {
      services: [],
      unavailable: [
        {
          id: 1,
          name: 'PAC',
          message: 'Serviço indisponível para esta cotação.',
        },
      ],
    },
  );
});
