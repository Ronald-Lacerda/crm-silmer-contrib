import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

function harness(overrides = {}) {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  const operations = {
    async authorizeRead(/** @type {any} */ input) {
      calls.push(['authorize', input]);
      return { actor: { functionName: 'Vendedor', id: 'operator-1' } };
    },
    async getContact(/** @type {any} */ input) {
      calls.push(['contact', input]);
      return { contact: { id: input.contactId } };
    },
    async getConversation(/** @type {any} */ input) {
      calls.push(['conversation', input]);
      return { conversation: { id: input.conversationId } };
    },
    async listContacts(/** @type {any} */ input) {
      calls.push(['contacts', input]);
      return { items: [], nextCursor: null, totalCount: 0 };
    },
    async listInbox(/** @type {any} */ input) {
      calls.push(['inbox', input]);
      return { items: [], nextCursor: null, totalCount: 0 };
    },
    async listOpenHandoffs(/** @type {any} */ input) {
      calls.push(['handoffs', input]);
      return { items: [], nextCursor: null, totalCount: 0 };
    },
    async summarizeInbox(/** @type {any} */ input) {
      calls.push(['summary', input]);
      return { mine: { count: 2 } };
    },
    ...overrides,
  };
  const api = createApi(
    {},
    {
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      operations,
    },
  );
  const headers = {
    cookie: 'crm_session=session',
    origin: 'https://crm.example.test',
  };
  return { api, calls, headers };
}

test('publishes authorized Inbox list and detail read models', async () => {
  const { api, calls, headers } = harness();
  const list = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations?state=requer_atencao&channel=whatsapp&automationState=human&assignedUserId=operator-1&unassignedHumanHandoff=true&archived=true&limit=25&cursor=signed',
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers['cache-control'], 'private, no-cache');
  assert.equal(list.headers.vary, 'Origin, Cookie');
  assert.deepEqual(calls[0][0], 'authorize');
  assert.equal(calls[0][1].action, 'conversation.read');
  assert.deepEqual(calls[1], [
    'inbox',
    {
      assignedUserId: 'operator-1',
      archived: true,
      automationState: 'human',
      channel: 'whatsapp',
      cursor: 'signed',
      limit: 25,
      state: 'requer_atencao',
      unassignedHumanHandoff: true,
    },
  ]);

  const detail = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1',
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(calls[2][0], 'authorize');
  assert.deepEqual(calls[3], [
    'conversation',
    { conversationId: 'conversation-1' },
  ]);
  await api.close();
});

test('forwards the waiting-for-seller filter as a boolean', async () => {
  const { api, calls, headers } = harness();
  const list = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations?pendingHandoff=true&automationState=human',
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(calls[1], [
    'inbox',
    { automationState: 'human', pendingHandoff: true },
  ]);
  const invalid = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations?pendingHandoff=sim',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_FILTER');
  assert.equal(calls.length, 2);
  await api.close();
});

test('INBOX-UX-02: work queues receive only the authenticated actor', async () => {
  const reads = /** @type {any[]} */ ([]);
  const { api, headers } = harness({
    async listInbox(/** @type {any} */ input, /** @type {any} */ access) {
      reads.push({ input, access });
      return { items: [], nextCursor: null, totalCount: 0 };
    },
  });
  try {
    for (const workQueue of ['attention', 'closing']) {
      const result = await api.inject({
        headers,
        method: 'GET',
        url: `/api/v1/inbox/conversations?workQueue=${workQueue}&limit=1`,
      });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(reads.at(-1), {
        input: { workQueue, limit: 1 },
        access: { actorId: 'operator-1' },
      });
    }
    const forged = await api.inject({
      headers,
      method: 'GET',
      url: '/api/v1/inbox/conversations?workQueue=attention&actorId=another-seller',
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(reads.length, 2);
  } finally {
    await api.close();
  }
});

test('publishes authorized Contact list and detail read models', async () => {
  const { api, calls, headers } = harness();
  const list = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/contacts?limit=50&cursor=signed',
  });
  assert.equal(list.statusCode, 200);
  assert.equal(calls[0][1].action, 'contact.read');
  assert.deepEqual(calls[1], ['contacts', { cursor: 'signed', limit: 50 }]);

  const detail = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/contacts/contact-1',
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(calls[2][1].action, 'contact.read');
  assert.deepEqual(calls[3], ['contact', { contactId: 'contact-1' }]);
  await api.close();
});

test('searches contacts by name and creates a manual contact with a protected command', async () => {
  const { api, calls, headers } = harness({
    async authorizeWrite(/** @type {any} */ input) {
      calls.push(['authorize-write', input]);
      return { actor: { id: 'operator-1', kind: 'human' } };
    },
    async createContact(/** @type {any} */ input) {
      calls.push(['create-contact', input]);
      return {
        contact: { id: 'contact-new', label: input.displayName },
        created: true,
      };
    },
  });
  const search = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/contacts?q=Cliente&limit=10',
  });
  assert.equal(search.statusCode, 200);
  assert.deepEqual(calls[1], ['contacts', { limit: 10, q: 'Cliente' }]);
  const created = await api.inject({
    headers: {
      ...headers,
      'idempotency-key': 'contact-request-1',
      'x-csrf-token': 'csrf-synthetic',
    },
    method: 'POST',
    url: '/api/v1/contacts',
    payload: { displayName: 'Cliente Novo', phone: '11999999999' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(calls[2][0], 'authorize-write');
  assert.equal(calls[2][1].action, 'contact.create');
  assert.deepEqual(calls[3], [
    'create-contact',
    {
      actor: { id: 'operator-1', kind: 'human' },
      correlationId: created.headers['x-request-id'],
      displayName: 'Cliente Novo',
      phone: '11999999999',
      email: undefined,
      idempotencyKey: 'contact-request-1',
    },
  ]);
  await api.close();
});

test('searches a phone in a protected request body and rejects phone in URL', async () => {
  const { api, calls, headers } = harness({
    async authorizeWrite(/** @type {any} */ input) {
      calls.push(['authorize-write', input]);
      return { actor: { id: 'operator-1', kind: 'human' } };
    },
  });
  const search = await api.inject({
    headers: { ...headers, 'x-csrf-token': 'csrf-synthetic' },
    method: 'POST',
    url: '/api/v1/contacts/search',
    payload: { q: '11987654321', limit: 10 },
  });
  assert.equal(search.statusCode, 200);
  assert.equal(search.headers['cache-control'], 'private, no-cache');
  assert.equal(calls[0][0], 'authorize-write');
  assert.equal(calls[0][1].action, 'contact.read');
  assert.equal(calls[0][1].csrfToken, 'csrf-synthetic');
  assert.deepEqual(calls[1], ['contacts', { q: '11987654321', limit: 10 }]);

  const leaked = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/contacts?q=11987654321',
  });
  assert.equal(leaked.statusCode, 400);
  assert.equal(leaked.json().error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 2);
  await api.close();
});

test('completes a legacy contact with version and idempotency key before an order', async () => {
  const { api, calls, headers } = harness({
    async authorizeWrite(/** @type {any} */ input) {
      calls.push(['authorize-write', input]);
      return { actor: { id: 'operator-1', kind: 'human' } };
    },
    async setContactDetails(/** @type {any} */ input) {
      calls.push(['contact-details', input]);
      return { id: input.contactId, phone: input.phone, version: 2 };
    },
  });
  const response = await api.inject({
    headers: {
      ...headers,
      'idempotency-key': 'details-request-1',
      'x-csrf-token': 'csrf-synthetic',
    },
    method: 'POST',
    url: '/api/v1/contacts/contact-legacy/details',
    payload: { expectedVersion: 1, phone: '11987654321' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0][1].action, 'contact.rename');
  assert.deepEqual(calls[1][1], {
    actor: { id: 'operator-1', kind: 'human' },
    contactId: 'contact-legacy',
    correlationId: response.headers['x-request-id'],
    email: undefined,
    expectedVersion: 1,
    idempotencyKey: 'details-request-1',
    phone: '11987654321',
  });
  await api.close();
});

test('publishes the pending handoff queue through the read-only contract', async () => {
  const { api, calls, headers } = harness();
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/handoffs?limit=25&cursor=signed',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(calls[0], [
    'authorize',
    {
      action: 'handoff.read',
      authorization: undefined,
      cookie: headers.cookie,
      origin: headers.origin,
      secFetchSite: undefined,
    },
  ]);
  assert.deepEqual(calls[1], ['handoffs', { cursor: 'signed', limit: 25 }]);
  await api.close();
});

test('rejects unknown read filters before querying a projection', async () => {
  const { api, calls, headers } = harness();
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations?rawPayload=true',
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls, []);
  assert.equal(response.json().error.code, 'INVALID_REQUEST');
  await api.close();
});

test('rejects an invalid SSE cursor before opening a stream', async () => {
  const { api, headers } = harness();
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/events?topic=inbox&after=invalid',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_CURSOR');
  await api.close();
});

test('maps missing projections without leaking repository details', async () => {
  const { api, headers } = harness({
    async getContact() {
      throw Object.assign(new Error('secret database detail'), {
        code: 'CONTACT_NOT_FOUND',
        statusCode: 404,
      });
    },
  });
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/contacts/missing',
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'CONTACT_NOT_FOUND');
  assert.doesNotMatch(response.body, /secret database detail/u);
  await api.close();
});

test('Painel: the Inbox summary is read for the session user and takes no query', async () => {
  const { api, calls, headers } = harness();
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/summary',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(response.json(), { mine: { count: 2 } });
  assert.equal(calls[0][1].action, 'conversation.read');
  // The queue is always the reader's own: the actor comes from the session.
  assert.deepEqual(calls[1], ['summary', { actorId: 'operator-1' }]);

  const forged = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/summary?actorId=someone-else',
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(calls.length, 2);

  const denied = harness({
    async authorizeRead() {
      throw Object.assign(new Error('FORBIDDEN'), {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    },
  });
  const blocked = await denied.api.inject({
    headers: denied.headers,
    method: 'GET',
    url: '/api/v1/inbox/summary',
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(denied.calls.length, 0);
  await api.close();
  await denied.api.close();
});

test('INBOX-HANDOFF-01: publishes the open handoff summary under handoff.read, never cached', async () => {
  const { api, calls, headers } = harness({
    async getConversationHandoff(/** @type {any} */ input) {
      calls.push(['conversation-handoff', input]);
      return {
        handoff: {
          createdAt: '2026-10-29T12:00:00.000Z',
          id: 'handoff-1',
          reasonCode: 'price_before_quote',
          status: 'pending',
          summary: 'Motivo: Perguntou o valor. Ficha: 5 de 9 (56%).',
          version: 1,
        },
      };
    },
  });
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1/handoff',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers.vary, 'Origin, Cookie');
  assert.equal(calls[0][0], 'authorize');
  assert.equal(calls[0][1].action, 'handoff.read');
  assert.deepEqual(calls[1], [
    'conversation-handoff',
    { conversationId: 'conversation-1' },
  ]);
  assert.equal(
    response.json().handoff.summary,
    'Motivo: Perguntou o valor. Ficha: 5 de 9 (56%).',
  );
  await api.close();
});

test('INBOX-HANDOFF-01: refuses the handoff summary without handoff.read before decrypting it', async () => {
  for (const actor of [
    {
      capabilities: [],
      functionName: 'Financeiro',
      id: 'finance-1',
      kind: 'human',
    },
    {
      capabilities: [],
      functionName: 'Vendedor',
      id: 'n8n',
      kind: 'assistant',
    },
  ]) {
    let decrypted = false;
    const { api, headers } = harness({
      async authorizeRead(/** @type {any} */ input) {
        authorize(/** @type {any} */ (actor), input.action);
        return { actor };
      },
      async getConversationHandoff() {
        decrypted = true;
        return { handoff: null };
      },
    });
    const response = await api.inject({
      headers,
      method: 'GET',
      url: '/api/v1/inbox/conversations/conversation-1/handoff',
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'FORBIDDEN');
    assert.doesNotMatch(response.body, /Motivo|summary/u);
    assert.equal(decrypted, false);
    await api.close();
  }
});

test('INBOX-HANDOFF-01: rejects query parameters on the handoff summary route', async () => {
  const { api, calls, headers } = harness();
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1/handoff?summary=1',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_REQUEST');
  assert.deepEqual(calls, []);
  await api.close();
});

test('AGENTE-OBS-01: publishes the assistant performance with conversation.read and no-store', async () => {
  const { api, calls, headers } = harness({
    async assistantPerformance(/** @type {any} */ input) {
      calls.push(['performance', input]);
      return { assistant_replies: 3, stalled_now: 1 };
    },
  });
  const defaults = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/assistant/performance',
  });
  assert.equal(defaults.statusCode, 200);
  assert.equal(defaults.headers['cache-control'], 'private, no-store');
  assert.equal(defaults.headers.vary, 'Origin, Cookie');
  assert.equal(calls[0][1].action, 'assistant.performance.read');
  assert.deepEqual(calls[1], ['performance', {}]);
  const thirty = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/assistant/performance?days=30',
  });
  assert.equal(thirty.statusCode, 200);
  assert.deepEqual(calls.at(-1), ['performance', { days: 30 }]);
  for (const query of ['days=abc', 'days=-1', 'days=1000', 'conversation=1']) {
    const refused = await api.inject({
      headers,
      method: 'GET',
      url: `/api/v1/inbox/assistant/performance?${query}`,
    });
    assert.equal(refused.statusCode, 400, query);
  }
  await api.close();
});

test('AGENTE-OBS-01: publishes the assistant context of a conversation with no-store', async () => {
  const { api, calls, headers } = harness({
    async getAssistantContext(/** @type {any} */ input) {
      calls.push(['assistant-context', input]);
      return {
        assistant_message_cap: 15,
        assistant_messages: 3,
        last_turn: null,
      };
    },
  });
  const response = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1/assistant-context',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(calls[0][1].action, 'conversation.read');
  assert.deepEqual(calls[1], [
    'assistant-context',
    { conversationId: 'conversation-1' },
  ]);
  const extra = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1/assistant-context?x=1',
  });
  assert.equal(extra.statusCode, 400);
  await api.close();
});

test('AGENTE-OBS-01: refuses the assistant reads without a session or without conversation.read', async () => {
  for (const url of [
    '/api/v1/inbox/assistant/performance',
    '/api/v1/inbox/conversations/conversation-1/assistant-context',
  ]) {
    let read = false;
    const unauthenticated = harness({
      async authorizeRead() {
        throw Object.assign(new Error('Unauthorized'), {
          code: 'UNAUTHENTICATED',
          statusCode: 401,
        });
      },
      async assistantPerformance() {
        read = true;
        return {};
      },
      async getAssistantContext() {
        read = true;
        return {};
      },
    });
    const anonymous = await unauthenticated.api.inject({
      headers: unauthenticated.headers,
      method: 'GET',
      url,
    });
    assert.equal(anonymous.statusCode, 401, url);
    await unauthenticated.api.close();
    const assistantActor = {
      capabilities: [],
      functionName: 'Vendedor',
      id: 'n8n',
      kind: 'assistant',
    };
    const forbidden = harness({
      async authorizeRead(/** @type {any} */ input) {
        authorize(/** @type {any} */ (assistantActor), input.action);
        return { actor: assistantActor };
      },
      async assistantPerformance() {
        read = true;
        return {};
      },
      async getAssistantContext() {
        read = true;
        return {};
      },
    });
    const refused = await forbidden.api.inject({
      headers: forbidden.headers,
      method: 'GET',
      url,
    });
    assert.equal(refused.statusCode, 403, url);
    assert.equal(read, false);
    await forbidden.api.close();
  }
});

test('AGENTE-OBS-01: the assistant performance is the manager panel; a plain seller or finance gets 403', async () => {
  const actors = [
    {
      capabilities: [],
      functionName: 'Vendedor',
      id: 'seller-1',
      kind: 'human',
    },
    {
      capabilities: [],
      functionName: 'Financeiro',
      id: 'finance-1',
      kind: 'human',
    },
  ];
  for (const actor of actors) {
    let read = false;
    const { api, headers } = harness({
      async authorizeRead(/** @type {any} */ input) {
        authorize(/** @type {any} */ (actor), input.action);
        return { actor };
      },
      async assistantPerformance() {
        read = true;
        return {};
      },
    });
    const response = await api.inject({
      headers,
      method: 'GET',
      url: '/api/v1/inbox/assistant/performance',
    });
    assert.equal(response.statusCode, 403, actor.functionName);
    assert.equal(read, false);
    await api.close();
  }
  const manager = {
    capabilities: ['COMMERCIAL_ADMIN'],
    functionName: 'Vendedor',
    id: 'manager-1',
    kind: 'human',
  };
  const { api, headers } = harness({
    async authorizeRead(/** @type {any} */ input) {
      authorize(/** @type {any} */ (manager), input.action);
      return { actor: manager };
    },
    async assistantPerformance() {
      return { stalled_now: 0 };
    },
  });
  const allowed = await api.inject({
    headers,
    method: 'GET',
    url: '/api/v1/inbox/assistant/performance',
  });
  assert.equal(allowed.statusCode, 200);
  await api.close();
  // The context of one conversation stays open to any seller who reads it.
  const seller = harness({
    async authorizeRead(/** @type {any} */ input) {
      authorize(/** @type {any} */ (actors[0]), input.action);
      return { actor: actors[0] };
    },
    async getAssistantContext() {
      return {
        assistant_message_cap: 15,
        assistant_messages: 0,
        last_turn: null,
      };
    },
  });
  const context = await seller.api.inject({
    headers: seller.headers,
    method: 'GET',
    url: '/api/v1/inbox/conversations/conversation-1/assistant-context',
  });
  assert.equal(context.statusCode, 200);
  await seller.api.close();
});
