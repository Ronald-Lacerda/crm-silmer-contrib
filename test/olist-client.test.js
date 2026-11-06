import assert from 'node:assert/strict';
import test from 'node:test';
import { createOlistClient } from '../modules/olist/src/client.js';
import {
  OLIST_API,
  OLIST_TOKEN,
  EMPTY_OLIST_SETTINGS,
  normalizeDocument,
  olistConfiguration,
  olistSettings,
} from '../modules/olist/src/configuration.js';
import { identityHash, open, seal } from '../modules/olist/src/crypto.js';
import { olistJson } from '../modules/olist/src/transport.js';

const key = Buffer.alloc(32, 0x31);
const identityKey = Buffer.alloc(32, 0x62);
const syntheticDocument = '00000000000100';

/** @param {unknown} body @param {ResponseInit} [init] */
function json(body, init = {}) {
  return new globalThis.Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** @param {unknown[]} items @param {number} total @param {number} [offset] */
function page(items, total, offset = 0) {
  return json({ itens: items, paginacao: { total, offset } });
}

/** @param {(url:URL,init:RequestInit)=>Response|Promise<Response>} handler */
function harness(handler) {
  /** @type {string[]} */
  const events = [];
  /** @type {URL[]} */
  const urls = [];
  /** @type {number[]} */
  const authFailures = [];
  /** @type {number[]} */
  const blockedFor = [];
  const client = createOlistClient({
    credentials: async () => {
      events.push('credentials');
      return { token: 'synthetic-access-token', version: 17 };
    },
    quota: {
      async reserve() {
        events.push('reserve');
      },
      async observe(/** @type {Headers} */ headers) {
        assert.ok(headers instanceof globalThis.Headers);
        events.push('observe');
      },
      async block(/** @type {number} */ ms) {
        blockedFor.push(ms);
      },
    },
    onAuthFailure: async (version) => {
      authFailures.push(version);
    },
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      urls.push(parsed);
      events.push('fetch');
      assert.equal(parsed.origin, 'https://api.tiny.com.br');
      assert.equal(init?.redirect, 'error');
      assert.equal(
        new globalThis.Headers(init?.headers).get('authorization'),
        'Bearer synthetic-access-token',
      );
      return handler(parsed, init ?? {});
    },
  });
  return { client, events, urls, authFailures, blockedFor };
}

/** @param {unknown} error @param {string} code */
function isSafeError(error, code) {
  const value = /** @type {any} */ (error);
  assert.equal(value.code, code);
  assert.equal(value.message, code);
  assert.doesNotMatch(
    JSON.stringify(value),
    /buyer@example|synthetic-access-token|private-upstream/u,
  );
  return true;
}

test('Olist transport rejects arbitrary origins, credentials, fragments and write methods without fetching', async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchMock = async () => {
    calls++;
    return json({});
  };
  for (const url of [
    'http://127.0.0.1/private-upstream',
    'https://api.tiny.com.br.evil.example.test/public-api/v3/info',
    'https://api.tiny.com.br/private-upstream',
    'https://buyer:private-upstream@api.tiny.com.br/public-api/v3/info',
    OLIST_API + '/info#private-upstream',
    'https://accounts.tiny.com.br/realms/other/token',
  ]) {
    await assert.rejects(olistJson(url, { fetch: fetchMock }), (error) =>
      isSafeError(error, 'INVALID_REQUEST'),
    );
  }
  await assert.rejects(
    olistJson(OLIST_API + '/pedidos', { fetch: fetchMock, method: 'POST' }),
    (error) => isSafeError(error, 'INVALID_REQUEST'),
  );
  await assert.rejects(
    olistJson(OLIST_TOKEN, { fetch: fetchMock, method: 'POST' }),
    (error) => isSafeError(error, 'INVALID_REQUEST'),
  );
  assert.equal(calls, 0);
});

test('Olist transport disables redirects and refuses a redirection response', async () => {
  let calls = 0;
  await assert.rejects(
    olistJson(OLIST_API + '/info', {
      fetch: async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, 'error');
        return new globalThis.Response('buyer@example.test', {
          status: 302,
          headers: { location: 'http://127.0.0.1/private-upstream' },
        });
      },
    }),
    (error) => isSafeError(error, 'OLIST_UPSTREAM_REJECTED'),
  );
  assert.equal(calls, 1);
});

test('Olist transport caps streamed bytes even when Content-Length is omitted', async () => {
  let cancelled = false;
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(
        new globalThis.TextEncoder().encode(
          '{"private-upstream":"' + 'x'.repeat(80),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    olistJson(OLIST_API + '/info', {
      maxBytes: 32,
      fetch: async () =>
        new globalThis.Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
    }),
    (error) => isSafeError(error, 'OLIST_INVALID_RESPONSE'),
  );
  assert.equal(cancelled, true);
});

test('Olist transport rejects invalid JSON, HTML, and oversized declared responses without echoing content', async () => {
  for (const response of [
    new globalThis.Response('{"private-upstream":"buyer@example.test"', {
      headers: { 'content-type': 'application/json' },
    }),
    new globalThis.Response('<p>buyer@example.test</p>', {
      headers: { 'content-type': 'text/html' },
    }),
    new globalThis.Response('buyer@example.test', {
      headers: { 'content-type': 'application/json', 'content-length': '500' },
    }),
  ]) {
    await assert.rejects(
      olistJson(OLIST_API + '/info', {
        maxBytes: 64,
        fetch: async () => response,
      }),
      (error) => {
        const value = /** @type {any} */ (error);
        assert.ok(
          ['OLIST_UNAVAILABLE', 'OLIST_INVALID_RESPONSE'].includes(value.code),
        );
        return isSafeError(value, value.code);
      },
    );
  }
});

test('Olist upstream and network failures are redacted and never retried', async () => {
  let calls = 0;
  for (const status of [400, 422, 500]) {
    await assert.rejects(
      olistJson(OLIST_API + '/info', {
        fetch: async () => {
          calls++;
          return json(
            { error: 'private-upstream buyer@example.test' },
            { status },
          );
        },
      }),
      (error) => isSafeError(error, 'OLIST_UPSTREAM_REJECTED'),
    );
  }
  await assert.rejects(
    olistJson(OLIST_API + '/info', {
      fetch: async () => {
        calls++;
        throw new Error('private-upstream buyer@example.test');
      },
    }),
    (error) => isSafeError(error, 'OLIST_UNAVAILABLE'),
  );
  assert.equal(calls, 4);
});

test('Olist requests reserve shared quota before fetching and observe headers once', async () => {
  const { client, events, urls } = harness(() =>
    json({ company: 'Synthetic company' }),
  );
  await client.info();
  assert.deepEqual(events, ['credentials', 'reserve', 'fetch', 'observe']);
  assert.equal(urls[0].href, OLIST_API + '/info');
});

test('exhausted Olist quota prevents the upstream request entirely', async () => {
  let calls = 0;
  const client = createOlistClient({
    credentials: async () => ({ token: 'synthetic-access-token', version: 1 }),
    quota: {
      async reserve() {
        throw Object.assign(new Error('OLIST_RATE_LIMITED'), {
          code: 'OLIST_RATE_LIMITED',
        });
      },
    },
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(client.info(), { code: 'OLIST_RATE_LIMITED' });
  assert.equal(calls, 0);
});

test('Olist auth failure marks the matching token version and does not retry', async () => {
  const { client, authFailures, urls, events } = harness(() =>
    json({ private: 'buyer@example.test' }, { status: 401 }),
  );
  await assert.rejects(client.info(), (error) =>
    isSafeError(error, 'OLIST_AUTH'),
  );
  assert.deepEqual(authFailures, [17]);
  assert.equal(urls.length, 1);
  assert.deepEqual(events, ['credentials', 'reserve', 'fetch']);
});

test('Olist rate limiting blocks the shared budget with bounded Retry-After and no retry', async () => {
  /** @type {Array<[string, number]>} */
  const cases = [
    ['2', 2000],
    ['99999', 3600000],
    ['private-upstream', 60000],
  ];
  for (const [retryAfter, expected] of cases) {
    const { client, blockedFor, urls } = harness(() =>
      json({}, { status: 429, headers: { 'retry-after': retryAfter } }),
    );
    await assert.rejects(client.info(), (error) =>
      isSafeError(error, 'OLIST_RATE_LIMITED'),
    );
    assert.deepEqual(blockedFor, [expected]);
    assert.equal(urls.length, 1);
  }
});

test('Olist customer lookup scans complete pages before claiming exact or missing identity', async () => {
  const { client, urls } = harness((url) => {
    assert.equal(url.searchParams.get('cpfCnpj'), syntheticDocument);
    assert.equal(url.searchParams.get('limit'), '50');
    return url.searchParams.get('offset') === '0'
      ? page(
          Array.from({ length: 50 }, (_, index) => ({
            id: index + 1,
            cpfCnpj: 'invalid-private-upstream',
          })),
          51,
        )
      : page([{ id: 51, cpfCnpj: syntheticDocument }], 51, 50);
  });
  assert.equal((await client.findCustomer('00.000.000/0001-00'))?.id, 51);
  assert.equal(urls.length, 2);
  const absent = harness(() =>
    page([{ id: 1, cpfCnpj: 'another-document' }], 1),
  );
  assert.equal(await absent.client.findCustomer(syntheticDocument), null);
});

test('Olist product lookup distinguishes exact SKU from prefix matches and rejects ambiguity', async () => {
  const selected = harness((url) => {
    assert.equal(url.searchParams.get('codigo'), 'SKU-M');
    return page(
      [
        { id: 1, sku: 'SKU-M-OTHER' },
        { id: 2, sku: 'SKU-M' },
      ],
      2,
    );
  });
  assert.equal((await selected.client.findProduct('SKU-M'))?.id, 2);
  const ambiguous = harness(() =>
    page(
      [
        { id: 1, sku: 'SKU-M' },
        { id: 2, sku: 'SKU-M' },
      ],
      2,
    ),
  );
  await assert.rejects(ambiguous.client.findProduct('SKU-M'), {
    code: 'OLIST_AMBIGUOUS_MATCH',
  });
});

test('Olist lookup rejects inconsistent, duplicate and truncated pagination', async () => {
  for (const body of [
    { itens: [{ id: 1 }, { id: 1 }], paginacao: { total: 2, offset: 0 } },
    { itens: [{ id: 1 }], paginacao: { total: 51, offset: 0 } },
    { itens: [{ id: 1 }], paginacao: { total: 1, offset: 50 } },
  ]) {
    const { client } = harness(() => json(body));
    await assert.rejects(client.findProduct('SKU-M'), {
      code: 'OLIST_INCOMPLETE_LOOKUP',
    });
  }
  const changed = harness((url) => {
    const offset = Number(url.searchParams.get('offset'));
    return page(
      Array.from({ length: 50 }, (_, index) => ({
        id: offset + index + 1,
        sku: 'OTHER',
      })),
      offset === 0 ? 100 : 101,
      offset,
    );
  });
  await assert.rejects(changed.client.findProduct('SKU-M'), {
    code: 'OLIST_INCOMPLETE_LOOKUP',
  });
});

test('Olist lookup beyond 250 items reports incomplete even when an early item matches', async () => {
  const { client, urls } = harness((url) => {
    const offset = Number(url.searchParams.get('offset'));
    return page(
      Array.from({ length: 50 }, (_, index) => ({
        id: offset + index + 1,
        sku: offset === 0 && index === 0 ? 'SKU-M' : 'OTHER',
      })),
      251,
      offset,
    );
  });
  await assert.rejects(client.findProduct('SKU-M'), {
    code: 'OLIST_INCOMPLETE_LOOKUP',
  });
  assert.equal(urls.length, 5);
});

test('Olist order lookup validates each detail reference instead of trusting the filtered list', async () => {
  const { client, urls } = harness((url) => {
    if (url.pathname.endsWith('/pedidos')) {
      assert.equal(
        url.searchParams.get('numeroPedidoEcommerce'),
        'CRM-order-a',
      );
      return page(
        [{ id: 1, numeroPedidoEcommerce: 'CRM-order-a' }, { id: 2 }],
        2,
      );
    }
    return url.pathname.endsWith('/1')
      ? json({ id: 1, numeroPedidoEcommerce: 'CRM-other' })
      : json({ id: 2, numeroPedidoEcommerce: 'CRM-order-a' });
  });
  assert.equal((await client.findOrder('CRM-order-a'))?.id, 2);
  assert.equal(urls.length, 3);
});

test('Olist order lookup refuses a detail with an identity different from the requested candidate', async () => {
  const { client } = harness((url) =>
    url.pathname.endsWith('/pedidos')
      ? page([{ id: 1 }], 1)
      : json({ id: 2, numeroPedidoEcommerce: 'CRM-order-a' }),
  );
  await assert.rejects(client.findOrder('CRM-order-a'), {
    code: 'OLIST_INVALID_RESPONSE',
  });
});

test('Olist ambiguous order references require reconciliation after all candidate details are read', async () => {
  const { client, urls } = harness((url) =>
    url.pathname.endsWith('/pedidos')
      ? page([{ id: 1 }, { id: 2 }], 2)
      : json({
          id: Number(url.pathname.split('/').at(-1)),
          numeroPedidoEcommerce: 'CRM-order-a',
        }),
  );
  await assert.rejects(client.findOrder('CRM-order-a'), {
    code: 'OLIST_AMBIGUOUS_MATCH',
  });
  assert.equal(urls.length, 3);
});

test('Olist creation methods remain closed even if an attacker supplies write flags and payloads', async () => {
  let calls = 0;
  const { client, events } = harness(() => {
    calls++;
    return json({ id: 1 });
  });
  const malicious = /** @type {any} */ ({
    OLIST_CREATION_ENABLED: 'true',
    enabled: true,
    payload: { id: 1 },
  });
  for (const method of [
    client.createCustomer,
    client.createProduct,
    client.createVariation,
    client.createOrder,
  ]) {
    await assert.rejects(/** @type {any} */ (method)(malicious), {
      code: 'OLIST_CREATION_DISABLED',
    });
  }
  assert.equal(calls, 0);
  assert.deepEqual(events, []);
  assert.equal(
    olistConfiguration({
      OLIST_ENABLED: 'true',
      OLIST_CREATION_ENABLED: 'true',
    }).creationEnabled,
    false,
  );
});

/** @returns {Record<string,string>} */
function configuredEnvironment() {
  return {
    APP_ORIGIN: 'https://crm.example.test',
    OLIST_ENABLED: 'true',
    OLIST_ENVELOPE_KEY: key.toString('base64'),
    OLIST_IDENTITY_HMAC_KEY: identityKey.toString('base64'),
    OLIST_CLIENT_ID: 'synthetic-client',
    OLIST_CLIENT_SECRET: 'synthetic-private-secret',
    OLIST_EXPECTED_ACCOUNT_DOCUMENT: syntheticDocument,
    OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  };
}

test('missing or invalid Olist configuration leaves startup available and creation disabled', () => {
  for (const environment of [
    {},
    { OLIST_ENABLED: 'true' },
    { OLIST_ENVELOPE_KEY: 'invalid-base64' },
  ]) {
    const configuration = olistConfiguration(environment);
    assert.equal(configuration.configured, false);
    assert.equal(configuration.creationEnabled, false);
  }
  const valid = olistConfiguration(configuredEnvironment());
  assert.equal(valid.configured, true);
  assert.equal(valid.creationEnabled, false);
  assert.equal(valid.environment, 'production');
  assert.notEqual(valid.accountKey, syntheticDocument);
});

test('Olist configuration binds redirect to the exact HTTPS CRM origin and callback path', () => {
  for (const redirectUri of [
    'https://other.example.test/olist',
    'http://crm.example.test/olist',
    'https://crm.example.test/another',
    'https://crm.example.test/olist?token=synthetic',
    'https://crm.example.test/olist#synthetic',
    'https://buyer:secret@crm.example.test/olist',
  ])
    assert.equal(
      olistConfiguration({
        ...configuredEnvironment(),
        OLIST_REDIRECT_URI: redirectUri,
      }).configured,
      false,
    );
});

test('Olist requires independent encryption and identity keys and versions identity by kind', () => {
  assert.equal(
    olistConfiguration({
      ...configuredEnvironment(),
      OLIST_IDENTITY_HMAC_KEY: key.toString('base64'),
    }).configured,
    false,
  );
  assert.notEqual(
    identityHash(identityKey, 'account', syntheticDocument),
    identityHash(identityKey, 'customer', syntheticDocument),
  );
  assert.notEqual(
    identityHash(identityKey, 'account', syntheticDocument),
    identityHash(key, 'account', syntheticDocument),
  );
  assert.equal(normalizeDocument('00.000.000/0001-00'), syntheticDocument);
});

test('Olist AEAD envelopes cannot be copied to another account, entity, purpose or key', () => {
  const value = {
    accessToken: 'synthetic-access-token',
    refreshToken: 'synthetic-refresh-token',
  };
  const envelope = seal(value, key, 'tokens', 'account-a', 'connection-a');
  assert.deepEqual(
    open(envelope, key, 'tokens', 'account-a', 'connection-a'),
    value,
  );
  assert.doesNotMatch(
    JSON.stringify(envelope),
    /synthetic-access-token|synthetic-refresh-token/u,
  );
  for (const [purpose, account, entity] of [
    ['tokens', 'account-b', 'connection-a'],
    ['tokens', 'account-a', 'connection-b'],
    ['snapshot', 'account-a', 'connection-a'],
  ])
    assert.throws(() => open(envelope, key, purpose, account, entity), {
      code: 'OLIST_ENVELOPE_INVALID',
    });
  assert.throws(
    () => open(envelope, identityKey, 'tokens', 'account-a', 'connection-a'),
    { code: 'OLIST_ENVELOPE_INVALID' },
  );
  assert.throws(
    () =>
      open(
        { ...envelope, keyVersion: 2 },
        key,
        'tokens',
        'account-a',
        'connection-a',
      ),
    { code: 'OLIST_ENVELOPE_INVALID' },
  );
  assert.throws(
    () =>
      open(
        { ...envelope, ciphertext: envelope.ciphertext.slice(1) },
        key,
        'tokens',
        'account-a',
        'connection-a',
      ),
    { code: 'OLIST_ENVELOPE_INVALID' },
  );
});

test('Olist central settings require a bounded full replacement and never infer missing IDs', () => {
  assert.deepEqual(olistSettings(EMPTY_OLIST_SETTINGS), EMPTY_OLIST_SETTINGS);
  for (const patch of [
    {},
    { ...EMPTY_OLIST_SETTINGS, sellerId: '23' },
    { ...EMPTY_OLIST_SETTINGS, sellerId: 0 },
    { ...EMPTY_OLIST_SETTINGS, paymentTerms: 'x'.repeat(121) },
    { ...EMPTY_OLIST_SETTINGS, clientSecret: 'synthetic-private-secret' },
  ])
    assert.throws(() => olistSettings(patch), { code: 'INVALID_REQUEST' });
});

test('Olist catalog allowlist uses only the five supported v3 routes and a validated minimum projection', async () => {
  const catalogs = [
    ['sellers', '/vendedores'],
    ['warehouses', '/depositos'],
    ['paymentMethods', '/formas-pagamento'],
    ['receivingMethods', '/formas-recebimento'],
    ['priceLists', '/listas-precos'],
  ];
  for (const [kind, path] of catalogs) {
    const { client, urls } = harness((url) => {
      assert.equal(url.pathname, '/public-api/v3' + path);
      const rows = [
        { id: 23, descricao: 'Opção sintética', privateField: 'not-projected' },
      ];
      if (kind === 'warehouses') {
        assert.equal(url.search, '');
        return json(rows);
      }
      assert.equal(url.searchParams.get('limit'), '50');
      assert.equal(url.searchParams.get('offset'), '0');
      return page(rows, 1);
    });
    assert.deepEqual(await client.catalog(kind), [
      { id: 23, name: 'Opção sintética' },
    ]);
    assert.equal(urls.length, 1);
    for (const id of [0, '23', Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = harness(() =>
        kind === 'warehouses'
          ? json([{ id, nome: 'Opção sintética' }])
          : page([{ id, nome: 'Opção sintética' }], 1),
      );
      await assert.rejects(invalid.client.catalog(kind), {
        code: 'INVALID_REQUEST',
        statusCode: 400,
      });
    }
  }
  const unsupported = harness(() => {
    throw new Error('Unsupported catalog must not fetch');
  });
  for (const kind of [
    'operationNatures',
    'paymentTerms',
    'https://other.example.test/catalog',
  ]) {
    await assert.rejects(unsupported.client.catalog(kind), {
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });
  }
  assert.deepEqual(unsupported.events, []);
});

test('T22 absence checks enumerate every customer state and both document formats before returning zero', async () => {
  const { client, urls } = harness(() => page([], 0));
  assert.equal(
    await client.findCustomerAcrossStates('00.000.000/0001-00'),
    null,
  );
  assert.equal(urls.length, 8);
  assert.deepEqual(
    [...new Set(urls.map((url) => url.searchParams.get('situacao')))].sort(),
    ['A', 'B', 'E', 'I'],
  );
  assert.equal(
    new Set(urls.map((url) => url.searchParams.get('cpfCnpj'))).size,
    2,
  );
});
test('T22 repeated sightings deduplicate by ID but distinct document matches block', async () => {
  const one = harness(() => page([{ id: 7, cpfCnpj: syntheticDocument }], 1));
  assert.equal(
    (await one.client.findCustomerAcrossStates(syntheticDocument))?.id,
    7,
  );
  const many = harness((url) =>
    page(
      [
        {
          id: url.searchParams.get('situacao') === 'B' ? 8 : 7,
          cpfCnpj: syntheticDocument,
        },
      ],
      1,
    ),
  );
  await assert.rejects(
    many.client.findCustomerAcrossStates(syntheticDocument),
    { code: 'OLIST_AMBIGUOUS_MATCH' },
  );
});
test('T22 inactive products are discovered by official sku, missing identity never proves absence', async () => {
  const found = harness((url) =>
    page(
      url.searchParams.get('situacao') === 'I'
        ? [{ id: 7, sku: 'CRM-product' }]
        : [],
      url.searchParams.get('situacao') === 'I' ? 1 : 0,
    ),
  );
  assert.equal(
    (await found.client.findProductAcrossStates('CRM-product'))?.id,
    7,
  );
  const malformed = harness(() => page([{ id: 7, codigo: 'CRM-product' }], 1));
  await assert.rejects(
    malformed.client.findProductAcrossStates('CRM-product'),
    { code: 'OLIST_INCOMPLETE_LOOKUP' },
  );
});
test('T22 fiscal policy is explicit, optional for old settings, and never inferred', () => {
  assert.deepEqual(olistSettings(EMPTY_OLIST_SETTINGS), EMPTY_OLIST_SETTINGS);
  const productFiscal = { ncm: '61091000', origin: 0, unit: 'UN' };
  assert.deepEqual(
    olistSettings({ ...EMPTY_OLIST_SETTINGS, productFiscal }).productFiscal,
    productFiscal,
  );
  for (const value of [
    { ...productFiscal, ncm: '123' },
    { ...productFiscal, origin: 9 },
    { ...productFiscal, unit: '' },
    { ...productFiscal, price: 0 },
  ])
    assert.throws(() =>
      olistSettings({ ...EMPTY_OLIST_SETTINGS, productFiscal: value }),
    );
});
