import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerShippingRoutes } from '../apps/api/src/shipping-routes.js';
import { ShippingHttpError } from '../apps/api/src/shipping-runtime.js';

const PREFIX = '/api/v1/shipping/melhor-envio';
const HEADERS = {
  cookie: 'crm_session=synthetic-session',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic-csrf',
  'sec-fetch-site': 'same-origin',
};

function fixture() {
  /** @type {any[]} */ const calls = [];
  const status = {
    configured: true,
    connected: false,
    environment: 'sandbox',
    expiresAt: null,
    reconnectRequired: false,
  };
  /** @param {any} input @param {boolean} write */
  const check = (input, write) => {
    if (
      input.authorization !== undefined ||
      input.cookie !== 'crm_session=synthetic-session' ||
      input.origin !== 'https://crm.example.test'
    )
      throw new ShippingHttpError(403, 'FORBIDDEN');
    if (write && input.csrfToken !== 'synthetic-csrf')
      throw new ShippingHttpError(403, 'CSRF_INVALID');
    return { actor: { id: 'admin' } };
  };
  /** @type {any} */ const runtime = {
    authorizeRead: (/** @type {any} */ input) => check(input, false),
    authorizeWrite: (/** @type {any} */ input) => check(input, true),
    status: async () => status,
  };
  for (const action of ['authorize', 'complete', 'quote', 'disconnect'])
    runtime[action] = async (/** @type {any} */ input) => {
      calls.push({ action, input });
      return action === 'authorize'
        ? {
            authorizationUrl:
              'https://sandbox.melhorenvio.com.br/oauth/authorize',
          }
        : status;
    };
  const api = Fastify();
  registerShippingRoutes(api, runtime, () => ({
    correlationId: 'shipping-route-test',
  }));
  return { api, runtime, calls };
}

test('shipping status uses the authenticated boundary and private cache headers', async (t) => {
  const { api } = fixture();
  t.after(() => api.close());
  const response = await api.inject({
    url: `${PREFIX}/status`,
    headers: HEADERS,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.json().configured, true);
});

test('shipping writes reject missing CSRF, unauthorized token and malformed bodies before effects', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const [
    headers,
    payload,
    status,
  ] of /** @type {Array<[Record<string,string>,object,number]>} */ ([
    [{ ...HEADERS, 'x-csrf-token': '' }, {}, 403],
    [{ ...HEADERS, authorization: 'Bearer arbitrary' }, {}, 403],
    [HEADERS, { extra: true }, 400],
    [HEADERS, [], 400],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/authorize`,
      headers,
      payload,
    });
    assert.equal(response.statusCode, status);
  }
  assert.equal(calls.length, 0);
});

test('authorize binds state to a hash of the current session and actor', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/authorize`,
    headers: HEADERS,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].input.actor.id, 'admin');
  assert.match(calls[0].input.sessionBinding, /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(calls).includes('synthetic-session'));
});

test('provider authentication and errors never expose tokens or disconnect the CRM session', async (t) => {
  const { api, runtime } = fixture();
  t.after(() => api.close());
  runtime.complete = async () => {
    throw Object.assign(new Error('Bearer synthetic-secret'), {
      code: 'MELHOR_ENVIO_AUTH',
      statusCode: 502,
      fieldErrors: { code: ['synthetic-secret'] },
    });
  };
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/complete`,
    headers: HEADERS,
    payload: { code: 'private-auth-code', state: 'state' },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().code, 'MELHOR_ENVIO_AUTH');
  assert.ok(!response.body.includes('synthetic-secret'));
  assert.ok(!response.body.includes('private-auth-code'));
  assert.equal(response.headers['set-cookie'], undefined);
});

test('unexpected database/provider exceptions are bounded service errors', async (t) => {
  const { api, runtime } = fixture();
  t.after(() => api.close());
  runtime.disconnect = async () => {
    throw new Error('connection string and private token');
  };
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/disconnect`,
    headers: HEADERS,
    payload: {},
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'SERVICE_UNAVAILABLE');
  assert.ok(!response.body.includes('private token'));
});
