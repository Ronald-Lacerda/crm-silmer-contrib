import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMelhorEnvioClient,
  MELHOR_ENVIO_BASE_URLS,
  MELHOR_ENVIO_SAFE_TO_RETRY,
  MelhorEnvioError,
} from '../modules/shipping/src/adapters/melhor-envio-client.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isTokenExpiring,
  MELHOR_ENVIO_SCOPES,
  refreshAccessToken,
} from '../modules/shipping/src/adapters/melhor-envio-oauth.js';
import { ShippingError } from '../modules/shipping/src/domain/errors.js';

const TOKEN = 'eyJ0eXAiOiJKV1Qi.secret-access-token.sig';
const CPF = '52998224725';
const USER_AGENT = 'CRM Silmer (tecnico@example.test)';
const ORDER_ID = '9fe2a1b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const BASE = MELHOR_ENVIO_BASE_URLS.sandbox;

/**
 * @param {number} status
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
function reply(status, body, headers = {}) {
  const text =
    body === undefined
      ? ''
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return {
    headers: { get: (/** @type {string} */ name) => headers[name] ?? null },
    status,
    text: async () => text,
  };
}

/** @param {(url: string, init: RequestInit) => unknown} respond */
function fakeFetch(respond) {
  /** @type {Array<{url: string, init: RequestInit}>} */
  const calls = [];
  /** @param {string} url @param {RequestInit} init */
  const fetch = async (url, init) => {
    calls.push({ init, url });
    return /** @type {any} */ (await respond(url, init));
  };
  return { calls, fetch };
}

/** @param {(url: string, init: RequestInit) => unknown} respond @param {object} [extra] */
function clientWith(respond, extra = {}) {
  const fake = fakeFetch(respond);
  const client = createMelhorEnvioClient({
    baseUrl: BASE,
    fetch: fake.fetch,
    getAccessToken: async () => TOKEN,
    userAgent: USER_AGENT,
    ...extra,
  });
  return { calls: fake.calls, client };
}

/** @param {Promise<unknown>} promise */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MelhorEnvioError);
    assert.ok(error instanceof ShippingError);
    return error;
  }
  assert.fail('expected a MelhorEnvioError');
}

/** @param {unknown} error */
function assertNoLeak(error) {
  const serialized = `${String(/** @type {Error} */ (error).message)} ${JSON.stringify(error)}`;
  assert.ok(!serialized.includes(TOKEN), 'token leaked');
  assert.ok(!serialized.includes('secret-access-token'), 'token leaked');
  assert.ok(!serialized.includes(CPF), 'CPF leaked');
  assert.ok(!serialized.includes('529.982.247-25'), 'CPF leaked');
  assert.ok(!serialized.includes('Rua das Flores'), 'address leaked');
  assert.ok(!serialized.includes('11987654321'), 'phone leaked');
}

const quoteBody = {
  from: { postal_code: '01001000' },
  to: { postal_code: '20040020', document: CPF, address: 'Rua das Flores' },
  package: { height: 4, width: 12, length: 17, weight: 0.3 },
};

test('requires a User-Agent, a token provider and an HTTPS base URL', () => {
  const base = {
    baseUrl: BASE,
    getAccessToken: () => TOKEN,
    fetch: async () => reply(200),
  };
  assert.throws(
    () => createMelhorEnvioClient(/** @type {any} */ (base)),
    /userAgent/u,
  );
  assert.throws(
    () => createMelhorEnvioClient({ ...base, userAgent: 'x\r\ny' }),
    /userAgent/u,
  );
  assert.throws(
    () =>
      createMelhorEnvioClient({
        ...base,
        baseUrl: 'http://sandbox.melhorenvio.com.br',
        userAgent: USER_AGENT,
      }),
    /HTTPS/u,
  );
  assert.throws(
    () =>
      createMelhorEnvioClient({
        ...base,
        getAccessToken: /** @type {any} */ (null),
        userAgent: USER_AGENT,
      }),
    /getAccessToken/u,
  );
});

test('calculate posts JSON with bearer token and the required headers', async () => {
  const { calls, client } = clientWith(() => reply(200, [{ id: 1 }]));
  assert.ok(Object.isFrozen(client));

  const result = await client.calculate(quoteBody);

  assert.deepEqual(result, [{ id: 1 }]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, `${BASE}/api/v2/me/shipment/calculate`);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, {
    Accept: 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  });
  assert.deepEqual(JSON.parse(String(call.init.body)), quoteBody);
  assert.ok(call.init.signal instanceof AbortSignal);
});

test('every endpoint uses the documented method, path and body', async () => {
  const { calls, client } = clientWith((url) =>
    reply(200, url.endsWith('/me/cart') ? { id: ORDER_ID } : { ok: true }),
  );

  const cart = await client.addToCart({ service: 1 });
  assert.equal(cart.id, ORDER_ID);
  await client.checkout([ORDER_ID]);
  await client.generate([ORDER_ID]);
  await client.tracking([ORDER_ID]);
  await client.cancellable([ORDER_ID]);
  await client.cancel({
    orderId: ORDER_ID,
    description: 'Mudou para retirada',
  });
  await client.labelFile({ orderId: ORDER_ID, format: 'zpl' });
  await client.daceFile({ orderId: ORDER_ID, format: 'pdf' });
  await client.services();
  await client.getOrder(ORDER_ID);
  await client.addBalancePix({ valueCents: 15050 });

  const seen = calls.map((call) => [
    call.init.method,
    call.url.slice(BASE.length),
    call.init.body === undefined
      ? undefined
      : JSON.parse(String(call.init.body)),
  ]);
  assert.deepEqual(seen, [
    ['POST', '/api/v2/me/cart', { service: 1 }],
    ['POST', '/api/v2/me/shipment/checkout', { orders: [ORDER_ID] }],
    ['POST', '/api/v2/me/shipment/generate', { orders: [ORDER_ID] }],
    ['POST', '/api/v2/me/shipment/tracking', { orders: [ORDER_ID] }],
    ['POST', '/api/v2/me/shipment/cancellable', { orders: [ORDER_ID] }],
    [
      'POST',
      '/api/v2/me/shipment/cancel',
      {
        order: {
          id: ORDER_ID,
          reason_id: '2',
          description: 'Mudou para retirada',
        },
      },
    ],
    ['GET', `/api/v2/me/imprimir/zpl/${ORDER_ID}`, undefined],
    ['GET', `/api/v2/me/imprimir/dace/pdf/${ORDER_ID}`, undefined],
    ['GET', '/api/v2/me/shipment/services', undefined],
    ['GET', `/api/v2/me/orders/${ORDER_ID}`, undefined],
    [
      'POST',
      '/api/v2/me/balance',
      { gateway: 'yapay-transparente', slug: 'pix', value: '150.50' },
    ],
  ]);
});

test('file endpoints return the URL as given, JSON or plain text', async () => {
  const url = 'https://me-0047-prod.s3.amazonaws.com/zpl/abc';
  const json = clientWith(() => reply(200, { zpl: url }));
  assert.deepEqual(
    await json.client.daceFile({ orderId: ORDER_ID, format: 'zpl' }),
    { zpl: url },
  );
  const text = clientWith(() => reply(200, ` ${url}\n`));
  assert.equal(
    await text.client.labelFile({ orderId: ORDER_ID, format: 'pdf' }),
    url,
  );
});

test('rejects bad ids, formats and amounts before any request', async () => {
  const { calls, client } = clientWith(() => reply(200, {}));
  await assert.rejects(client.checkout([]), TypeError);
  await assert.rejects(client.checkout(['../balance']), TypeError);
  await assert.rejects(
    client.labelFile({ orderId: ORDER_ID, format: /** @type {any} */ ('exe') }),
    TypeError,
  );
  await assert.rejects(
    client.labelFile({ orderId: `${ORDER_ID}/x`, format: 'pdf' }),
    TypeError,
  );
  await assert.rejects(client.addBalancePix({ valueCents: 10.5 }), TypeError);
  await assert.rejects(client.addBalancePix({ valueCents: 0 }), TypeError);
  await assert.rejects(client.calculate(/** @type {any} */ (null)), TypeError);
  await assert.rejects(client.getOrder('../balance'), TypeError);
  await assert.rejects(
    client.getOrder(/** @type {any} */ (undefined)),
    TypeError,
  );
  assert.equal(calls.length, 0);
});

test('a cart reply without an id is an invalid response', async () => {
  const { client } = clientWith(() => reply(200, { protocol: 'ORD-1' }));
  const error = await failure(client.addToCart({ service: 1 }));
  assert.equal(error.kind, 'invalid_response');
  assert.equal(error.outcomeKnown, false);
  assert.equal(error.retriable, false);
  assert.equal(error.reconcileRequired, true);
});

test('401 maps to auth without logging the CRM user out', async () => {
  const { client } = clientWith(() =>
    reply(401, { message: 'Unauthenticated.' }),
  );
  const error = await failure(client.calculate(quoteBody));
  assert.equal(error.kind, 'auth');
  assert.equal(error.code, 'MELHOR_ENVIO_AUTH');
  assert.equal(error.upstreamStatus, 401);
  assert.equal(error.statusCode, 502);
  assert.equal(error.retriable, false);
  assertNoLeak(error);
});

test('422 exposes redacted field errors and never echoes the request', async () => {
  const { client } = clientWith(() =>
    reply(422, {
      message: `The given data was invalid for ${CPF}.`,
      errors: {
        'to.document': [`O documento ${CPF} é inválido.`],
        'to.phone': ['Telefone 11987654321 inválido'],
        'to.address': ['O campo to.address é obrigatório.'],
      },
    }),
  );
  const error = await failure(client.calculate(quoteBody));
  assert.equal(error.kind, 'validation');
  assert.equal(error.statusCode, 422);
  assert.equal(error.retriable, false);
  assert.deepEqual(Object.keys(error.fieldErrors), [
    'to.document',
    'to.phone',
    'to.address',
  ]);
  assert.deepEqual(error.fieldErrors['to.address'], [
    'O campo to.address é obrigatório.',
  ]);
  assert.match(String(error.fieldErrors['to.document']), /\[redacted\]/u);
  assert.ok(Object.isFrozen(error.fieldErrors));
  assertNoLeak(error);
});

test('429 is retriable and honours Retry-After', async () => {
  const { client } = clientWith(() =>
    reply(429, { message: 'Too Many Attempts.' }, { 'retry-after': '30' }),
  );
  const error = await failure(client.calculate(quoteBody));
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.retriable, true);
  assert.equal(error.retryAfterMs, 30_000);
});

test('429 on checkout was not processed and stays retriable', async () => {
  const { client } = clientWith(() =>
    reply(429, { message: 'Too Many Attempts.' }),
  );
  const error = await failure(client.checkout([ORDER_ID]));
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.retriable, true);
  assert.equal(error.reconcileRequired, false);
});

test('only reads and read-only POSTs are safe to retry', () => {
  assert.deepEqual(MELHOR_ENVIO_SAFE_TO_RETRY, [
    'calculate',
    'tracking',
    'cancellable',
    'services',
    'labelFile',
    'daceFile',
    'getOrder',
  ]);
  assert.ok(Object.isFrozen(MELHOR_ENVIO_SAFE_TO_RETRY));
});

test('5xx on checkout is of unknown outcome and needs reconciliation', async () => {
  const { client } = clientWith(() => reply(503, '<html>down</html>'));
  const error = await failure(client.checkout([ORDER_ID]));
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.retriable, false);
  assert.equal(error.reconcileRequired, true);
  assert.equal(error.outcomeKnown, false);
  assert.equal(error.upstreamStatus, 503);
});

test('5xx on calculate is unavailable and retriable', async () => {
  const { client } = clientWith(() => reply(502, '<html>bad gateway</html>'));
  const error = await failure(client.calculate(quoteBody));
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.retriable, true);
  assert.equal(error.reconcileRequired, false);
  assert.equal(error.outcomeKnown, false);
});

test('every purchase step asks for reconciliation, every read retries', async () => {
  const { client } = clientWith(() => reply(500, { message: 'Server Error' }));
  const purchaseSteps = [
    () => client.addToCart({ service: 1 }),
    () => client.checkout([ORDER_ID]),
    () => client.generate([ORDER_ID]),
    () => client.cancel({ orderId: ORDER_ID }),
    () => client.addBalancePix({ valueCents: 100 }),
  ];
  for (const step of purchaseSteps) {
    const error = await failure(step());
    assert.equal(error.retriable, false);
    assert.equal(error.reconcileRequired, true);
    assert.equal(error.outcomeKnown, false);
  }
  const reads = [
    () => client.calculate(quoteBody),
    () => client.tracking([ORDER_ID]),
    () => client.cancellable([ORDER_ID]),
    () => client.services(),
    () => client.labelFile({ orderId: ORDER_ID, format: 'pdf' }),
    () => client.daceFile({ orderId: ORDER_ID, format: 'pdf' }),
    () => client.getOrder(ORDER_ID),
  ];
  for (const read of reads) {
    const error = await failure(read());
    assert.equal(error.retriable, true);
    assert.equal(error.reconcileRequired, false);
  }
});

test('a network error is unavailable and does not leak its message', async () => {
  const { client } = clientWith(() => {
    throw new Error(`connect failed with Bearer ${TOKEN} for ${CPF}`);
  });
  const error = await failure(client.calculate(quoteBody));
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.retriable, true);
  assert.equal(error.upstreamStatus, null);
  assertNoLeak(error);
  const checkout = await failure(client.checkout([ORDER_ID]));
  assert.equal(checkout.retriable, false);
  assert.equal(checkout.reconcileRequired, true);
  assertNoLeak(checkout);
});

/** @param {string} _url @param {RequestInit} init */
function hang(_url, init) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      reject(abort);
    });
  });
}

test('a checkout timeout needs reconciliation, never a blind retry', async () => {
  const { client } = clientWith(hang, { timeoutMs: 20 });
  const error = await failure(client.checkout([ORDER_ID]));
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.retriable, false);
  assert.equal(error.reconcileRequired, true);
  assert.equal(error.outcomeKnown, false);
  assert.equal(error.upstreamStatus, null);
});

test('a hung read times out as unavailable and retriable', async () => {
  const { client } = clientWith(hang, { timeoutMs: 20 });
  const error = await failure(client.services());
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.retriable, true);
  assert.equal(error.reconcileRequired, false);
});

test('a refusal for lack of balance is insufficient_balance', async () => {
  const { client } = clientWith(() =>
    reply(422, {
      message: 'The given data was invalid.',
      errors: { orders: ['Saldo insuficiente para realizar a compra.'] },
    }),
  );
  const error = await failure(client.checkout([ORDER_ID]));
  assert.equal(error.kind, 'insufficient_balance');
  assert.equal(error.statusCode, 409);
  assert.equal(error.retriable, false);
  assert.equal(error.outcomeKnown, true);
  assert.deepEqual(error.fieldErrors, {
    orders: ['Saldo insuficiente para realizar a compra.'],
  });
});

test('a checkout 4xx saying "Saldo insuficiente" is insufficient_balance', async () => {
  const { client } = clientWith(() =>
    reply(400, { message: 'Saldo insuficiente.' }),
  );
  const error = await failure(client.checkout([ORDER_ID]));
  assert.equal(error.kind, 'insufficient_balance');
  assert.equal(error.upstreamStatus, 400);
  assert.equal(error.reconcileRequired, false);
});

test('balance wording outside checkout, or vague, stays validation', async () => {
  const body = {
    message: 'Insufficient balance for the declared insurance.',
    errors: {
      'options.insurance_value': ['Insufficient insurance value.'],
    },
  };
  const cart = clientWith(() => reply(422, body));
  const error = await failure(cart.client.addToCart({ service: 1 }));
  assert.equal(error.kind, 'validation');
  assert.deepEqual(error.fieldErrors, {
    'options.insurance_value': ['Insufficient insurance value.'],
  });

  const vague = clientWith(() =>
    reply(422, {
      message: 'The given data was invalid.',
      errors: { orders: ['Saldo do pedido inválido: insufficient data.'] },
    }),
  );
  const checkout = await failure(vague.client.checkout([ORDER_ID]));
  assert.equal(checkout.kind, 'validation');
  assert.deepEqual(Object.keys(checkout.fieldErrors), ['orders']);
});

test('a rejected 4xx keeps its field errors', async () => {
  const { client } = clientWith(() =>
    reply(400, { errors: { orders: ['Pedido já pago.'] } }),
  );
  const error = await failure(client.generate([ORDER_ID]));
  assert.equal(error.kind, 'rejected');
  assert.deepEqual(error.fieldErrors, { orders: ['Pedido já pago.'] });
});

test('other 4xx are rejected and final', async () => {
  const { client } = clientWith(() =>
    reply(404, { message: 'No query results for model [App\\Order]' }),
  );
  const error = await failure(
    client.labelFile({ orderId: ORDER_ID, format: 'pdf' }),
  );
  assert.equal(error.kind, 'rejected');
  assert.equal(error.retriable, false);
  assert.equal(error.upstreamStatus, 404);
});

test('a bad token from the provider fails as auth before fetch', async () => {
  const { calls, client } = clientWith(() => reply(200, {}), {
    getAccessToken: async () => '',
  });
  const error = await failure(client.services());
  assert.equal(error.kind, 'auth');
  assert.equal(calls.length, 0);
});

// OAuth

const OAUTH = {
  baseUrl: BASE,
  clientId: '7374',
  clientSecret: 'super-secret-client-value',
  userAgent: USER_AGENT,
};

test('authorize URL carries client, redirect, code, state and scopes', () => {
  const url = new URL(
    buildAuthorizeUrl({
      baseUrl: `${BASE}/`,
      clientId: '7374',
      redirectUri: 'https://crm.example.test/melhor-envio/callback',
      state: 'csrf-state',
    }),
  );
  assert.equal(url.origin + url.pathname, `${BASE}/oauth/authorize`);
  assert.equal(url.searchParams.get('client_id'), '7374');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://crm.example.test/melhor-envio/callback',
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'csrf-state');
  assert.equal(url.searchParams.get('scope'), MELHOR_ENVIO_SCOPES.join(' '));
  assert.ok(url.search.includes('cart-read%20cart-write'));
  assert.ok(MELHOR_ENVIO_SCOPES.includes('shipping-checkout'));
  assert.throws(
    () =>
      buildAuthorizeUrl({
        baseUrl: BASE,
        clientId: '7374',
        redirectUri: 'https://crm.example.test/cb',
        state: '',
      }),
    /state/u,
  );
});

test('exchanges an authorization code for a token set', async () => {
  const { calls, fetch } = fakeFetch(() =>
    reply(200, {
      token_type: 'Bearer',
      expires_in: 2_592_000,
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    }),
  );
  const issuedAt = new Date('2026-10-29T12:00:00Z');

  const tokens = await exchangeAuthorizationCode({
    ...OAUTH,
    code: 'auth-code',
    fetch,
    now: () => issuedAt,
    redirectUri: 'https://crm.example.test/cb',
  });

  assert.equal(tokens.accessToken, 'new-access');
  assert.equal(tokens.refreshToken, 'new-refresh');
  assert.equal(tokens.expiresAt.toISOString(), '2026-11-28T12:00:00.000Z');
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, `${BASE}/oauth/token`);
  assert.equal(call.init.method, 'POST');
  const headers = /** @type {Record<string, string>} */ (call.init.headers);
  assert.equal(headers['User-Agent'], USER_AGENT);
  assert.equal(headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    grant_type: 'authorization_code',
    redirect_uri: 'https://crm.example.test/cb',
    code: 'auth-code',
    client_id: '7374',
    client_secret: 'super-secret-client-value',
  });
});

test('refreshes a token with the refresh grant', async () => {
  const { calls, fetch } = fakeFetch(() =>
    reply(200, {
      expires_in: 60,
      access_token: 'a2',
      refresh_token: 'r2',
    }),
  );
  const tokens = await refreshAccessToken({
    ...OAUTH,
    fetch,
    now: () => 1_000,
    refreshToken: 'old-refresh',
  });
  assert.equal(tokens.expiresAt.getTime(), 61_000);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    grant_type: 'refresh_token',
    refresh_token: 'old-refresh',
    client_id: '7374',
    client_secret: 'super-secret-client-value',
  });
});

test('token failures map to auth or unavailable without secrets', async () => {
  for (const [status, kind] of /** @type {const} */ ([
    [400, 'auth'],
    [401, 'auth'],
    [500, 'unavailable'],
  ])) {
    const { fetch } = fakeFetch(() =>
      reply(status, {
        error: 'invalid_grant',
        message: 'refresh token old-refresh is invalid',
      }),
    );
    const error = await failure(
      refreshAccessToken({ ...OAUTH, fetch, refreshToken: 'old-refresh' }),
    );
    assert.equal(error.kind, kind);
    const serialized = `${error.message} ${JSON.stringify(error)}`;
    assert.ok(!serialized.includes('super-secret-client-value'));
    assert.ok(!serialized.includes('old-refresh'));
  }
  const { fetch } = fakeFetch(() => reply(200, { access_token: 'only' }));
  const error = await failure(
    refreshAccessToken({ ...OAUTH, fetch, refreshToken: 'old-refresh' }),
  );
  assert.equal(error.kind, 'invalid_response');
});

test('a token is expiring inside the margin or when unreadable', () => {
  const now = new Date('2026-10-29T00:00:00Z');
  const hour = 60 * 60 * 1000;
  assert.equal(
    isTokenExpiring({ expiresAt: new Date(now.getTime() + 48 * hour), now }),
    false,
  );
  assert.equal(
    isTokenExpiring({ expiresAt: new Date(now.getTime() + 23 * hour), now }),
    true,
  );
  assert.equal(
    isTokenExpiring({
      expiresAt: new Date(now.getTime() + 23 * hour),
      now: () => now,
      marginMs: hour,
    }),
    false,
  );
  assert.equal(isTokenExpiring({ expiresAt: 'not a date', now }), true);
});
