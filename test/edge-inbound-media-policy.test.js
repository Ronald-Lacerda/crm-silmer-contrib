import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const nginx = await readFile(
  new URL('../docker/nginx.conf', import.meta.url),
  'utf8',
);
const location =
  /location ~ (\^\/api\/v1\/integrations\/n8n\/conversations\/\[\^\/\]\+\/attachments\$) \{([\s\S]*?)^    \}/mu.exec(
    nginx,
  );

test('INBOX-AUDIO-01: only the exact inbound attachment collection receives the 17MiB budget', () => {
  assert.ok(
    location,
    'an exact inbound attachment upload location is required',
  );
  const path = new RegExp(location[1], 'u');
  assert.equal(
    path.test('/api/v1/integrations/n8n/conversations/synthetic/attachments'),
    true,
  );
  for (const value of [
    '/api/v1/integrations/n8n/conversations//attachments',
    '/api/v1/integrations/n8n/conversations/synthetic/attachments/',
    '/api/v1/integrations/n8n/conversations/synthetic/attachments/content',
    '/api/v1/integrations/n8n/conversations/synthetic/messages',
    '/api/v1/integrations/n8n/messages/inbound',
    '/api/v1/conversations/synthetic/attachments',
  ])
    assert.equal(path.test(value), false, value);
  assert.match(location[2], /client_max_body_size 17m;/u);
  assert.match(location[2], /limit_except POST \{ deny all; \}/u);
  assert.ok(
    nginx.indexOf(location[0]) < nginx.indexOf('location /api/ {'),
    'the upload collection has its own location before the generic API proxy',
  );
});

test('INBOX-AUDIO-01: inbound proxy streams to the existing API and preserves authentication headers', () => {
  assert.ok(location);
  const body = location[2];
  assert.match(body, /proxy_request_buffering off;/u);
  assert.match(body, /proxy_pass \$api_upstream;/u);
  assert.match(body, /set \$api_upstream http:\/\/silmer-api:3000;/u);
  assert.match(body, /proxy_set_header Host \$host;/u);
  assert.match(body, /proxy_set_header X-Request-Id \$request_id;/u);
  assert.doesNotMatch(
    body,
    /proxy_set_header (?:Authorization|X-Silmer-|Idempotency-Key)|auth_basic off|return 30\d|rewrite |proxy_pass_request_headers off/iu,
  );
  assert.match(
    nginx,
    /location \/api\/ \{\s*resolver[^}]+proxy_pass \$api_upstream;[^}]+\}/u,
  );
});
