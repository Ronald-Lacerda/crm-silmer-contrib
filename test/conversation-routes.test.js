import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { InboxNonProductionConversationError } from '../modules/inbox-channels/src/index.js';

const baseHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic; crm_csrf=csrf-synthetic',
  'idempotency-key': 'command-synthetic-1',
  origin: 'https://crm.example.test',
  'x-correlation-id': '20000000-0000-4000-8000-000000000001',
  'x-csrf-token': 'csrf-synthetic',
  'x-request-id': '20000000-0000-4000-8000-000000000002',
});

function harness() {
  /** @type {Array<{method: string, input: Record<string, unknown>}>} */
  const calls = [];
  const conversations = {
    async archive(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'archive' });
      return { archivedAt: '2026-09-12T12:00:00.000Z', version: 10 };
    },
    async unarchive(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'unarchive' });
      return { archivedAt: null, version: 11 };
    },
    async authorize(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'authorize' });
      return { actor: { id: 'user-synthetic', role: 'ATENDIMENTO' } };
    },
    async claimHandoff(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'claimHandoff' });
      return { assignedUserId: 'user-synthetic', version: 4 };
    },
    async close(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'close' });
      return { automationEpoch: 4, version: 8 };
    },
    async sendMessage(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'sendMessage' });
      return { commandId: 'command-synthetic', version: 6 };
    },
    async takeover(/** @type {Record<string, unknown>} */ input) {
      calls.push({ input, method: 'takeover' });
      return { automationEpoch: 3, version: 7 };
    },
  };
  return { api: createApi({}, { conversations }), calls };
}

test('OPS-INBOX-SEND-08: a non-production conversation exposes only its bounded refusal after authorization', async (t) => {
  let authorized = false;
  const api = createApi(
    {},
    {
      conversations: {
        async authorize() {
          authorized = true;
          return { actor: { id: 'seller-test', kind: 'human' } };
        },
        async sendMessage() {
          assert.equal(authorized, true);
          throw new InboxNonProductionConversationError();
        },
      },
    },
  );
  t.after(() => api.close());
  const response = await api.inject({
    headers: baseHeaders,
    method: 'POST',
    payload: {
      content: { text: 'private-content-canary' },
      expectedVersion: 1,
      messageType: 'text',
      reason: 'Resposta',
    },
    url: '/api/v1/conversations/non-production/messages',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().accepted, false);
  assert.equal(response.json().error.code, 'NON_PRODUCTION_CONVERSATION');
  assert.doesNotMatch(
    response.body,
    /private-content-canary|provider_account_id/u,
  );
});

test('human conversation routes authorize, mutate state and enqueue commands', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());

  const message = await api.inject({
    headers: baseHeaders,
    method: 'POST',
    payload: {
      content: { text: 'synthetic' },
      expectedVersion: 5,
      messageType: 'text',
      reason: 'operator_reply',
    },
    url: '/api/v1/conversations/conversation-synthetic/messages',
  });
  assert.equal(message.statusCode, 202);
  assert.equal(message.json().commandId, 'command-synthetic');

  for (const [path, method, action] of [
    ['archive', 'archive', 'conversation.archive'],
    ['unarchive', 'unarchive', 'conversation.unarchive'],
    ['takeover', 'takeover', 'conversation.takeover'],
  ]) {
    const response = await api.inject({
      headers: baseHeaders,
      method: 'POST',
      payload: { expectedVersion: 6, reason: 'operator_command' },
      url: `/api/v1/conversations/conversation-synthetic/${path}`,
    });
    assert.equal(response.statusCode, 202);
    assert.equal(
      calls.some((call) => call.method === method),
      true,
    );
    assert.equal(
      calls.some(
        (call) => call.method === 'authorize' && call.input.action === action,
      ),
      true,
    );
  }

  const closed = await api.inject({
    headers: baseHeaders,
    method: 'POST',
    payload: {
      acknowledgePending: true,
      expectedVersion: 6,
      outcome: 'concluido',
    },
    url: '/api/v1/conversations/conversation-synthetic/close',
  });
  assert.equal(closed.statusCode, 202);
  const closeCall = calls.find((call) => call.method === 'close');
  assert.equal(closeCall?.input.outcome, 'concluido');
  assert.equal(closeCall?.input.acknowledgePending, true);
  assert.equal(closeCall?.input.reason, 'Encerramento: concluido');
  assert.equal(
    calls.some(
      (call) =>
        call.method === 'authorize' &&
        call.input.action === 'conversation.transition',
    ),
    true,
  );

  const claim = await api.inject({
    headers: baseHeaders,
    method: 'POST',
    payload: {
      expectedConversationVersion: 7,
      expectedHandoffVersion: 3,
      reasonCode: 'handoff_claimed',
    },
    url: '/api/v1/handoffs/handoff-synthetic/claim',
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().assignedUserId, 'user-synthetic');
  assert.equal(
    calls.some(
      (call) =>
        call.method === 'authorize' && call.input.action === 'handoff.claim',
    ),
    true,
  );
  const claimCall = calls.find((call) => call.method === 'claimHandoff');
  assert.equal(claimCall?.input.expectedDealVersion, undefined);
  assert.equal(claimCall?.input.expectedTaskVersion, undefined);
});

test('human conversation routes reject requests without an idempotency key', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const headers = { ...baseHeaders };
  Reflect.deleteProperty(headers, 'idempotency-key');
  const response = await api.inject({
    headers,
    method: 'POST',
    payload: {
      content: { text: 'private-canary' },
      expectedVersion: 5,
      messageType: 'text',
      reason: 'operator_reply',
    },
    url: '/api/v1/conversations/conversation-synthetic/messages',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().accepted, false);
  assert.equal(
    JSON.stringify(response.json()).includes('private-canary'),
    false,
  );
  assert.equal(calls.length, 0);
});

test('closing rejects an unknown outcome and missing pending-order acknowledgement', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  for (const payload of [
    { expectedVersion: 6, outcome: 'automatico', acknowledgePending: true },
    { expectedVersion: 6, outcome: 'concluido' },
  ]) {
    const response = await api.inject({
      headers: baseHeaders,
      method: 'POST',
      payload,
      url: '/api/v1/conversations/conversation-synthetic/close',
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(
    calls.some((call) => call.method === 'close'),
    false,
  );
});

test('no route hands a conversation back to the agent (ADR 015)', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  // A runtime that still carried the removed method must not be reachable.
  const legacy = createApi(
    {},
    {
      conversations: {
        async authorize(/** @type {Record<string, unknown>} */ input) {
          calls.push({ input, method: 'authorize' });
          return { actor: { id: 'user-synthetic', role: 'Vendedor' } };
        },
        async returnToAi(/** @type {Record<string, unknown>} */ input) {
          calls.push({ input, method: 'returnToAi' });
          return { automationEpoch: 5, version: 9 };
        },
      },
    },
  );
  t.after(() => legacy.close());

  for (const server of [api, legacy]) {
    for (const path of ['return-to-ai', 'reactivate-agent']) {
      const response = await server.inject({
        headers: baseHeaders,
        method: 'POST',
        payload: { expectedVersion: 6, reason: 'operator_command' },
        url: `/api/v1/conversations/conversation-synthetic/${path}`,
      });
      assert.equal(response.statusCode, 404, path);
    }
  }
  assert.deepEqual(calls, []);
});
