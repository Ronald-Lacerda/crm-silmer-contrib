import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkOAuthCallback } from '../scripts/check-edge-media-proxy.mjs';

const nginxUrl = new URL('../docker/nginx.conf', import.meta.url);

/** @param {{status?:number,body?:string,headers?:Record<string,string>}} [options] */
function callbackReply(options = {}) {
  return new globalThis.Response(
    options.body ?? '<!doctype html><div id="app">Synthetic CRM SPA</div>',
    {
      status: options.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; object-src 'none';",
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-store',
        ...options.headers,
      },
    },
  );
}

for (const path of [undefined, '/olist']) {
  test(`T138/OLIST-T04: ${path ?? '/melhor-envio (default)'} smoke sends synthetic query and Referer and validates the response boundary`, async () => {
    let fetched = false;
    await checkOAuthCallback(
      'http://127.0.0.1:8080',
      () => 'GET /healthz 200',
      {
        path,
        fetch: async (url, init) => {
          fetched = true;
          const target = new URL(String(url));
          assert.equal(target.pathname, path ?? '/melhor-envio');
          assert.equal(target.searchParams.get('code'), 'synthetic-oauth-code');
          assert.equal(target.searchParams.get('state'), 'synthetic-state');
          assert.equal(
            new globalThis.Headers(init?.headers).get('referer'),
            'https://example.test/synthetic-oauth-referrer',
          );
          assert.equal(init?.redirect, 'error');
          return callbackReply({
            headers: { 'cache-control': 'private, no-store' },
          });
        },
      },
    );
    assert.equal(fetched, true);
  });

  test(`T138/OLIST-T04: ${path ?? '/melhor-envio'} smoke fails if either log stream contains an OAuth or Referer marker`, async () => {
    for (const marker of [
      'synthetic-oauth-code',
      'synthetic-state',
      'synthetic-oauth-referrer',
    ])
      for (const logs of [
        `stdout: ${marker}\nstderr: clean`,
        `stdout: clean\nstderr: ${marker}`,
      ])
        await assert.rejects(
          checkOAuthCallback('http://127.0.0.1:8080', () => logs, {
            path,
            fetch: async () => callbackReply(),
          }),
          /OAuth markers must not enter nginx logs/u,
        );
  });

  test(`T138/OLIST-T04: ${path ?? '/melhor-envio'} smoke rejects missing headers, caching, non-SPA HTML and redirects`, async () => {
    for (const response of [
      callbackReply({ headers: { 'content-security-policy': '' } }),
      callbackReply({ headers: { 'referrer-policy': 'same-origin' } }),
      callbackReply({ headers: { 'cache-control': '' } }),
      callbackReply({ headers: { 'cache-control': 'public, max-age=60' } }),
      callbackReply({
        headers: { 'content-type': 'application/octet-stream' },
      }),
      callbackReply({ body: '<h1>Welcome to nginx!</h1>' }),
      callbackReply({ status: 302 }),
      callbackReply({
        body: '<div id="app">Synthetic CRM SPA</div>synthetic-oauth-code',
      }),
    ])
      await assert.rejects(
        checkOAuthCallback('http://127.0.0.1:8080', () => '', {
          path,
          fetch: async () => response,
        }),
      );
  });

  test(`T138/OLIST-T04: ${path ?? '/melhor-envio'} missing-index callback stays a private 404 with inherited security headers`, async () => {
    await checkOAuthCallback('http://127.0.0.1:8080', () => '', {
      path,
      expectedStatus: 404,
      fetch: async () =>
        callbackReply({ status: 404, body: '<h1>404 Not Found</h1>' }),
    });
    await assert.rejects(
      checkOAuthCallback('http://127.0.0.1:8080', () => 'synthetic-state', {
        path,
        expectedStatus: 404,
        fetch: async () =>
          callbackReply({ status: 404, body: '<h1>404 Not Found</h1>' }),
      }),
      /OAuth markers must not enter nginx logs/u,
    );
  });
}

test('OLIST-T04: callback smoke rejects an unsupported path before HTTP', async () => {
  let requests = 0;
  await assert.rejects(
    checkOAuthCallback('http://127.0.0.1:8080', () => '', {
      path: '//elsewhere.example.test/callback',
      fetch: async () => {
        requests++;
        return callbackReply();
      },
    }),
    /Unsupported OAuth callback path/u,
  );
  assert.equal(requests, 0);
});

test('MED-01/02/03 edge permits local media previews without relaxing scripts or connections', async () => {
  const nginx = await readFile(nginxUrl, 'utf8');
  const policy = /add_header Content-Security-Policy "([^"]+)" always;/u.exec(
    nginx,
  );
  assert.ok(policy, 'the edge must send its CSP on every response');
  const directives = new Map(
    policy[1].split(';').map((value) => {
      const [name, ...sources] = value.trim().split(/\s+/u);
      return [name, sources];
    }),
  );
  assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:']);
  assert.deepEqual(directives.get('media-src'), ["'self'", 'blob:']);
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
});

test('MED-09 edge allows same-origin microphone and keeps camera and location blocked', async () => {
  const nginx = await readFile(nginxUrl, 'utf8');
  const policy = /add_header Permissions-Policy "([^"]+)" always;/u.exec(nginx);
  assert.ok(
    policy,
    'the edge must send its permissions policy on every response',
  );
  assert.deepEqual(
    policy[1].split(',').map((value) => value.trim()),
    ['camera=()', 'geolocation=()', 'microphone=(self)'],
  );
});

test('MED-01/02/03 edge reserves the larger body budget for the chat upload route', async () => {
  const nginx = await readFile(nginxUrl, 'utf8');
  const locations = [...nginx.matchAll(/location ([^\n{]+)\{([^}]+)\}/gu)];
  const enlarged = locations.filter(([, , body]) =>
    /client_max_body_size/u.test(body),
  );
  assert.equal(
    enlarged.length,
    3,
    'only art, chat and authenticated inbound uploads may exceed the default body budget',
  );
  const chat = enlarged.find(
    ([, selector]) =>
      selector.trim() === '~ ^/api/v1/conversations/[^/]+/media$',
  );
  assert.ok(
    chat,
    'only the exact conversation media collection receives the upload budget',
  );
  assert.match(chat[2], /client_max_body_size 17m;/u);
  assert.match(chat[2], /proxy_request_buffering off;/u);
  assert.match(chat[2], /proxy_pass \$api_upstream;/u);
  assert.match(chat[2], /set \$api_upstream http:\/\/silmer-api:3000;/u);
  const art = enlarged.find(
    ([, selector]) => selector.trim() === '~ ^/api/v1/orders/[^/]+/files$',
  );
  assert.ok(art, 'the existing art upload route remains separate');
  assert.match(art[2], /client_max_body_size 11m;/u);
  const withoutLocations = nginx.replace(/location [^\n{]+\{[^}]+\}/gu, '');
  assert.doesNotMatch(
    withoutLocations,
    /client_max_body_size/u,
    'server and http defaults remain 1 MiB',
  );
});
