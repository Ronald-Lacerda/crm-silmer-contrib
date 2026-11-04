import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLBACK,
  QUERIES,
  authorizationUrl,
  consumeCallback,
  assertRequest,
  safeSummary,
  boundedJson,
  queryAccount,
  normalizeDocument,
  startProbe,
} from './read-only-probe.mjs';

const state = 'a'.repeat(64);
const host = '127.0.0.1:8765';
const response = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('OAuth URL has fixed endpoints/callback and state, without secret', () => {
  const url = new URL(authorizationUrl('synthetic-client', state));
  assert.equal(url.origin, 'https://accounts.tiny.com.br');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.has('client_secret'), false);
});
test('callback rejects forged host, path, state and duplicate parameters', () => {
  for (const [url, h] of [
    [`/olist/callback?state=${state}&code=synthetic`, 'evil.test'],
    [`http://evil.test/olist/callback?state=${state}&code=synthetic`, host],
    [`/different?state=${state}&code=synthetic`, host],
    ['/olist/callback?state=wrong&code=synthetic', host],
    [`/olist/callback?state=${state}&state=${state}&code=synthetic`, host],
    [`/olist/callback?state=${state}&code=one&code=two`, host],
    [`/olist/callback?state=${state}&error=denied`, host],
  ])
    assert.throws(() => consumeCallback(url, h, state, { used: false }));
});
test('correct callback is consumed once; invalid state does not consume latch', () => {
  const latch = { used: false };
  assert.throws(() =>
    consumeCallback('/olist/callback?state=wrong&code=x', host, state, latch),
  );
  assert.equal(latch.used, false);
  const url = `/olist/callback?state=${state}&code=synthetic`;
  assert.equal(consumeCallback(url, host, state, latch), 'synthetic');
  assert.throws(
    () => consumeCallback(url, host, state, latch),
    /CALLBACK_ALREADY_USED/u,
  );
});
test('only the exact eight GETs and OAuth token POST are allowed', () => {
  assert.equal(QUERIES.length, 8);
  for (const path of QUERIES)
    assert.doesNotThrow(() =>
      assertRequest('https://api.tiny.com.br/public-api/v3' + path, 'GET'),
    );
  for (const [url, method] of [
    ['https://api.tiny.com.br/public-api/v3/pedidos', 'POST'],
    ['https://api.tiny.com.br/public-api/v3/contatos', 'POST'],
    ['https://api.tiny.com.br/public-api/v3/produtos', 'POST'],
    ['https://api.tiny.com.br/public-api/v3/info', 'DELETE'],
    ['https://api.tiny.com.br/public-api/v3/info?arbitrary=1', 'GET'],
    ['https://evil.test/public-api/v3/info', 'GET'],
  ])
    assert.throws(() => assertRequest(url, method), /REQUEST_NOT_ALLOWED/u);
  assert.doesNotThrow(() =>
    assertRequest(
      'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token',
      'POST',
    ),
  );
});
test('request rejection happens before network, with no credential disclosure', async () => {
  let calls = 0;
  await assert.rejects(
    boundedJson('https://evil.test', 'GET', {
      token: 'synthetic-secret',
      fetcher: async () => {
        calls++;
      },
    }),
    /REQUEST_NOT_ALLOWED/u,
  );
  assert.equal(calls, 0);
});
test('fetch disables redirects and returns bounded JSON', async () => {
  const result = await boundedJson(
    'https://api.tiny.com.br/public-api/v3/info',
    'GET',
    {
      token: 'synthetic',
      fetcher: async (url, options) => {
        assert.equal(options.redirect, 'error');
        assert.equal(options.method, 'GET');
        return response({ cpfCnpj: '00000000000000' });
      },
    },
  );
  assert.equal(result.status, 200);
});
test('wrong content, large body and raw provider messages never escape', async () => {
  for (const [expected, fetcher] of [
    [
      'INVALID_CONTENT_TYPE',
      async () =>
        new Response('synthetic-sensitive', {
          headers: { 'content-type': 'text/plain' },
        }),
    ],
    ['BODY_TOO_LARGE', async () => response({ data: 'x'.repeat(131073) })],
    ['HTTP_403', async () => response({ message: 'synthetic-sensitive' }, 403)],
    [
      'INVALID_RESPONSE',
      async () =>
        new Response('{bad', {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'HTTP_OUTCOME_UNKNOWN',
      async () => {
        throw new Error('synthetic-sensitive');
      },
    ],
  ])
    await assert.rejects(
      boundedJson('https://api.tiny.com.br/public-api/v3/info', 'GET', {
        fetcher,
      }),
      { message: expected },
    );
});
test('safe summary excludes buyer, account, ID, token, query and error payload', () => {
  const summary = safeSummary(
    '/contatos?nome=private',
    200,
    {
      cpfCnpj: 'synthetic-sensitive',
      id: 123,
      access_token: 'synthetic-sensitive',
      itens: [{ nome: 'synthetic-sensitive' }],
    },
    new Headers({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '119' }),
  );
  assert.equal(summary.count, 1);
  assert.equal(summary.path, '/contatos');
  assert.equal(JSON.stringify(summary).includes('synthetic-sensitive'), false);
  assert.equal(JSON.stringify(summary).includes('private'), false);
});
test('account mismatch prevents all dependent queries', async () => {
  let calls = 0;
  await assert.rejects(
    queryAccount('synthetic', '00000000000000', async () => {
      calls++;
      return response({ cpfCnpj: '11111111111111' });
    }),
    /ACCOUNT_MISMATCH/u,
  );
  assert.equal(calls, 1);
});
test('missing expected identity prevents network', async () => {
  let calls = 0;
  await assert.rejects(
    queryAccount('synthetic', null, async () => {
      calls++;
    }),
    /EXPECTED_ACCOUNT_REQUIRED/u,
  );
  assert.equal(calls, 0);
});
test('only eight fixed GETs execute after matching account; report has no raw PII', async () => {
  const calls = [];
  const result = await queryAccount(
    'synthetic',
    '00.000.000/0000-00',
    async (url, options) => {
      calls.push([url, options.method]);
      return response(
        calls.length === 1 ? { cpfCnpj: '00000000000000' } : { itens: [] },
      );
    },
  );
  assert.equal(calls.length, 8);
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.equal(result.accountMatched, true);
  assert.equal(result.erpWrites, 0);
  assert.equal(JSON.stringify(result).includes('00000000000000'), false);
});
test('429 stops the probe without retries', async () => {
  let calls = 0;
  await assert.rejects(
    queryAccount('synthetic', '00000000000000', async () => {
      calls++;
      return response({ message: 'private' }, 429);
    }),
    /HTTP_429/u,
  );
  assert.equal(calls, 1);
});
test('low quota stops dependent queries', async () => {
  let calls = 0;
  await assert.rejects(
    queryAccount('synthetic', '00000000000000', async () => {
      calls++;
      return response({ cpfCnpj: '00000000000000' }, 200, {
        'x-ratelimit-remaining': '1',
      });
    }),
    /QUOTA_LOW/u,
  );
  assert.equal(calls, 1);
});
test('document normalization is explicit, preserving alphanumeric CNPJ', () => {
  assert.equal(normalizeDocument('AB.CDE.FGH/0001-00'), 'ABCDEFGH000100');
  assert.throws(
    () => normalizeDocument('not-an-identity'),
    /EXPECTED_ACCOUNT_REQUIRED/u,
  );
});

test('expired lifecycle prevents all API reads', async () => {
  const lifecycle = new AbortController();
  lifecycle.abort();
  let calls = 0;
  await assert.rejects(
    queryAccount(
      'synthetic',
      '00000000000000',
      async () => {
        calls++;
      },
      lifecycle.signal,
    ),
    /PROBE_STOPPED/u,
  );
  assert.equal(calls, 0);
});

test('loopback integration: encrypted credentials, clean redirect, synthetic queries and no private result', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } =
    await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const { publicEncrypt, constants } = await import('node:crypto');
  const { setTimeout: delay } = await import('node:timers/promises');
  const base = resolve('var/olist-phase1');
  await mkdir(base, { recursive: true });
  const parent = await mkdtemp(join(base, 'test-'));
  const calls = [];
  let probe;
  try {
    probe = await startProbe(parent, {
      fetcher: async (url, options) => {
        calls.push([url, options.method]);
        if (options.method === 'POST')
          return response({
            access_token: 'synthetic-sensitive-token',
            refresh_token: 'synthetic-sensitive-refresh',
          });
        if (url.endsWith('/info'))
          return response({ cpfCnpj: '00000000000000' });
        return response({
          itens: [{ id: 123, nome: 'synthetic-sensitive-name' }],
        });
      },
    });
    const publicKey = await readFile(join(probe.directory, 'public-key.pem'));
    const clear = Buffer.from(
      JSON.stringify({
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-sensitive-secret',
        expectedDocument: '00000000000000',
      }),
    );
    const encrypted = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      clear,
    );
    assert.equal(
      encrypted.includes(Buffer.from('synthetic-sensitive-secret')),
      false,
    );
    clear.fill(0);
    await writeFile(join(probe.directory, 'credentials.enc'), encrypted);
    let page = '';
    for (let i = 0; i < 60; i++) {
      page = await (await fetch('http://127.0.0.1:8765/')).text();
      if (page.includes('Conectar Olist')) break;
      await delay(50);
    }
    assert.ok(page.includes('Conectar Olist'));
    assert.equal(page.includes('synthetic-sensitive-secret'), false);
    const href = page.match(/href="([^"]+)"/u)[1].replaceAll('&amp;', '&');
    const oauthState = new URL(href).searchParams.get('state');
    const callback = await fetch(
      `http://127.0.0.1:8765/olist/callback?state=${oauthState}&code=synthetic-code`,
      { redirect: 'manual' },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/');
    for (let i = 0; i < 60; i++) {
      page = await (await fetch('http://127.0.0.1:8765/')).text();
      if (page.includes('accountMatched')) break;
      await delay(50);
    }
    assert.ok(page.includes('accountMatched'));
    assert.equal(page.includes('synthetic-sensitive'), false);
    assert.equal(page.includes('00000000000000'), false);
    assert.equal(calls.length, 9);
    assert.equal(calls[0][1], 'POST');
    assert.ok(calls.slice(1).every(([, method]) => method === 'GET'));
    await assert.rejects(readFile(join(probe.directory, 'credentials.enc')), {
      code: 'ENOENT',
    });
    const { request } = await import('node:http');
    const forgedStatus = await new Promise((accept, reject) => {
      const requestHandle = request(
        'http://127.0.0.1:8765/',
        { headers: { host: 'evil.test' } },
        (response) => {
          response.resume();
          response.on('end', () => accept(response.statusCode));
        },
      );
      requestHandle.on('error', reject);
      requestHandle.end();
    });
    assert.equal(forgedStatus, 403);
  } finally {
    probe?.close();
    if (probe) {
      await unlink(join(probe.directory, 'public-key.pem'));
      await rmdir(probe.directory);
    }
    await rmdir(parent);
  }
});

test('all proposed query parameters are documented in the official schema snapshot', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = JSON.parse(
    await readFile(
      new URL('./evidence/read-only-queries-schema.json', import.meta.url),
      'utf8',
    ),
  );
  for (const path of QUERIES) {
    const url = new URL(path, 'https://api.tiny.com.br');
    const operation = source.operations[url.pathname];
    assert.ok(operation);
    const allowed = new Set(
      operation.parameters.filter((x) => x.in === 'query').map((x) => x.name),
    );
    for (const name of url.searchParams.keys())
      assert.ok(allowed.has(name), `${url.pathname}: ${name}`);
  }
  assert.equal(source.operations['/depositos'].parameters.length, 0);
});
