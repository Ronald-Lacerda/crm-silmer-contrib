import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const nginxUrl = new URL('../docker/nginx.conf', import.meta.url);

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
