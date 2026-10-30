import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

test('documents the authorized Inbox and Contact read contracts', async () => {
  const openapi = await readFile(
    new URL('docs/api/openapi.v1.yaml', rootUrl),
    'utf8',
  );
  for (const operation of [
    'listInboxConversations',
    'getInboxConversation',
    'getInboxConversationHandoff',
    'listContacts',
    'getContact',
  ]) {
    assert.match(openapi, new RegExp(`operationId: ${operation}`, 'u'));
  }
  assert.match(openapi, /security: \[\{ sessionCookie: \[\] \}\]/u);
  assert.match(openapi, /private, no-cache/u);
  assert.match(openapi, /InboxConversationDetail/u);
  assert.match(openapi, /ContactDetail/u);
});

test('ships connected screens without the demonstration dataset', async () => {
  const paths = [
    'apps/edge-web/src/views/DashboardView.vue',
    'apps/edge-web/src/views/InboxView.vue',
    'apps/edge-web/src/views/ClientsView.vue',
  ];
  const screens = await Promise.all(
    paths.map((path) => readFile(new URL(path, rootUrl), 'utf8')),
  );
  // Painel: the Dashboard reads the server's queue summary, not a page of
  // conversations it would have to count itself.
  assert.match(screens[0], /\/api\/v1\/inbox\/summary/u);
  assert.doesNotMatch(screens[0], /\/api\/v1\/inbox\/conversations/u);
  assert.match(screens[1], /\/api\/v1\/inbox\/conversations/u);
  assert.match(screens[2], /\/api\/v1\/contacts/u);
  assert.ok(screens.every((screen) => !screen.includes('demo-crm')));
  assert.ok(screens.every((screen) => !/kanban|negócio/iu.test(screen)));
  assert.ok(screens.every((screen) => !/instagram/iu.test(screen)));
  const format = await readFile(
    new URL('apps/edge-web/src/lib/format.js', rootUrl),
    'utf8',
  );
  assert.match(format, /whatsapp: 'WhatsApp'/u);
  assert.match(format, /site_chat: 'Chat do site'/u);
  await assert.rejects(
    access(new URL('apps/edge-web/src/data/demo-crm.js', rootUrl)),
  );
  const client = await readFile(
    new URL('apps/edge-web/src/lib/api-client.js', rootUrl),
    'utf8',
  );
  assert.match(client, /readCookie\('crm_csrf'\)/u);
});
