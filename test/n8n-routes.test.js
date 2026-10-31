import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';

const technicalHeaders = Object.freeze({
  authorization: 'Basic dGVzdDp0ZXN0',
  'idempotency-key': 'wamid.synthetic.1',
  'x-correlation-id': '10000000-0000-4000-8000-000000000001',
  'x-request-id': '10000000-0000-4000-8000-000000000002',
  'x-silmer-execution-id': 'execution-synthetic-1',
  'x-silmer-workflow-key': 'silmer-whatsapp',
  'x-silmer-workflow-version': '98f96069-ede2-4900-aa5c-7fec0d3b80cb',
});

function harness() {
  /** @type {Array<{method: string, input: Record<string, unknown>}>} */
  const calls = [];
  /** @type {string[]} */
  const authorizedActions = [];
  const integration = Object.fromEntries(
    [
      'receiveInbound',
      'recordEvent',
      'recordOrderIntent',
      'storeAttachment',
    ].map((method) => [
      method,
      async (/** @type {Record<string, unknown>} */ input) => {
        calls.push({ input, method });
        return { accepted: true, method };
      },
    ]),
  );
  const api = createApi(
    {},
    {
      automationAuth: {
        async authorize(/** @type {Record<string, unknown>} */ input) {
          assert.equal(
            input.correlationId,
            technicalHeaders['x-correlation-id'],
          );
          authorizedActions.push(/** @type {string} */ (input.action));
          return { actor: 'AUTOMATION_EXECUTOR', credentialVersion: 1 };
        },
      },
      n8n: integration,
    },
  );
  return { api, authorizedActions, calls };
}

test('n8n inbound route authenticates the technical envelope and forwards the DTO', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const response = await api.inject({
    headers: technicalHeaders,
    method: 'POST',
    payload: {
      channel: 'whatsapp',
      contact: { name: 'Synthetic', wa_id: '5511000000000' },
      event_id: 'wamid.synthetic.1',
      message: {
        external_id: 'wamid.synthetic.1',
        text: 'synthetic',
        type: 'text',
      },
      metadata: { phone_number_id: 'phone-synthetic' },
      occurred_at: '2026-09-07T12:00:00.000Z',
      schema_version: '1.0',
    },
    url: '/api/v1/integrations/n8n/messages/inbound',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'receiveInbound');
  assert.deepEqual(calls[0].input.technical, {
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: technicalHeaders['x-correlation-id'],
    credentialVersion: 1,
    executionId: technicalHeaders['x-silmer-execution-id'],
    idempotencyKey: technicalHeaders['idempotency-key'],
    requestId: technicalHeaders['x-request-id'],
    workflowKey: technicalHeaders['x-silmer-workflow-key'],
    workflowVersion: technicalHeaders['x-silmer-workflow-version'],
  });
});

test('n8n boundary rejects a missing technical header as problem+json without echoing input', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const headers = { ...technicalHeaders };
  Reflect.deleteProperty(headers, 'x-silmer-execution-id');
  const response = await api.inject({
    headers,
    method: 'POST',
    payload: {
      channel: 'whatsapp',
      contact: { wa_id: '5511999999999' },
      event_id: 'private-canary',
      message: {
        external_id: 'private-canary',
        text: 'private-canary',
        type: 'text',
      },
      metadata: { phone_number_id: 'phone-synthetic' },
      occurred_at: '2026-09-07T12:00:00.000Z',
      schema_version: '1.0',
    },
    url: '/api/v1/integrations/n8n/messages/inbound',
  });

  assert.equal(response.statusCode, 400);
  assert.match(
    String(response.headers['content-type']),
    /^application\/problem\+json/u,
  );
  const problem = response.json();
  assert.equal(problem.accepted, false);
  assert.equal(problem.error.code, 'INVALID_X_SILMER_EXECUTION_ID');
  assert.equal(JSON.stringify(problem).includes('private-canary'), false);
  assert.equal(calls.length, 0);
});

test('n8n events route rejects event types outside the v1 allowlist', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const response = await api.inject({
    headers: technicalHeaders,
    method: 'POST',
    payload: {
      conversation_id: 'conversation-synthetic',
      event_id: 'event-synthetic',
      event_type: 'message.retried',
      occurred_at: '2026-09-07T12:00:00.000Z',
      schema_version: '1.0',
    },
    url: '/api/v1/integrations/n8n/events',
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'UNSUPPORTED_EVENT_TYPE');
  assert.equal(calls.length, 0);
});

test('n8n events route sends order.intent_confirmed to recordOrderIntent under the order.intent action', async (t) => {
  const { api, authorizedActions, calls } = harness();
  t.after(() => api.close());
  const response = await api.inject({
    headers: technicalHeaders,
    method: 'POST',
    payload: {
      conversation_id: 'conversation-synthetic',
      event_id: 'event-synthetic',
      event_type: 'order.intent_confirmed',
      occurred_at: '2026-09-13T12:00:00.000Z',
      schema_version: '1.0',
    },
    url: '/api/v1/integrations/n8n/events',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authorizedActions, ['order.intent']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'recordOrderIntent');
  assert.equal(calls[0].input.conversation_id, 'conversation-synthetic');
  assert.equal(calls[0].input.event_id, 'event-synthetic');
});

test('n8n events route forwards open_order under the event action (ADR 014)', async (t) => {
  const { api, authorizedActions, calls } = harness();
  t.after(() => api.close());
  /** @param {Record<string, unknown>} extra */
  const send = (extra) =>
    api.inject({
      headers: technicalHeaders,
      method: 'POST',
      payload: {
        automation_epoch: 1,
        command_id: 'conversation-synthetic:2:ai-response',
        conversation_id: 'conversation-synthetic',
        event_id: 'reserve:conversation-synthetic:2:ai-response',
        event_type: 'message.send.requested',
        message: { text: 'Qual a cor?', type: 'text' },
        occurred_at: '2026-10-02T12:00:00.000Z',
        schema_version: '1.0',
        source_revision: 2,
        ...extra,
      },
      url: '/api/v1/integrations/n8n/events',
    });

  const opening = await send({ open_order: true });
  assert.equal(opening.statusCode, 200);
  assert.deepEqual(authorizedActions, ['integration.n8n.event.create']);
  assert.equal(calls[0].method, 'recordEvent');
  assert.equal(calls[0].input.open_order, true);

  authorizedActions.length = 0;
  const handoff = await send({
    event_type: 'handoff.requested',
    handoff: { reason: 'negotiation', summary: 'Perguntou o valor.' },
    open_order: true,
  });
  assert.equal(handoff.statusCode, 200);
  assert.deepEqual(authorizedActions, ['handoff.create']);

  authorizedActions.length = 0;
  assert.equal((await send({ open_order: false })).statusCode, 200);
  assert.equal((await send({})).statusCode, 200);
  assert.deepEqual(authorizedActions, [
    'integration.n8n.event.create',
    'integration.n8n.event.create',
  ]);
  assert.equal(calls.length, 4);
});

test('n8n events route accepts the optional turn and still refuses unknown fields (AGENTE-OBS-01)', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  /** @param {Record<string, unknown>} extra */
  const send = (extra) =>
    api.inject({
      headers: technicalHeaders,
      method: 'POST',
      payload: {
        automation_epoch: 1,
        command_id: 'conversation-synthetic:2:ai-response',
        conversation_id: 'conversation-synthetic',
        event_id: 'reserve:conversation-synthetic:2:ai-response',
        event_type: 'message.send.requested',
        message: { text: 'Qual a cor?', type: 'text' },
        occurred_at: '2026-10-30T12:00:00.000Z',
        schema_version: '1.0',
        source_revision: 2,
        ...extra,
      },
      url: '/api/v1/integrations/n8n/events',
    });
  const accepted = await send({ turn: { ficha_filled: 1, ficha_total: 8 } });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(calls[0].input.turn, { ficha_filled: 1, ficha_total: 8 });
  const unknown = await send({ telemetry: {} });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error.code, 'UNKNOWN_REQUEST_FIELD');
  assert.equal(calls.length, 1);
});

test('n8n events route accepts message.transcribed under the event action (INBOX-AUDIO-TRANSCRIPT-01)', async (t) => {
  const { api, authorizedActions, calls } = harness();
  t.after(() => api.close());
  const response = await api.inject({
    headers: technicalHeaders,
    method: 'POST',
    payload: {
      conversation_id: 'conversation-synthetic',
      event_id: 'transcribed:wamid.audio',
      event_type: 'message.transcribed',
      external_message_id: 'wamid.audio',
      occurred_at: '2026-10-30T12:00:00.000Z',
      schema_version: '1.0',
      transcript: { code: 'TRANSCRIPTION_FAILED', status: 'failed' },
    },
    url: '/api/v1/integrations/n8n/events',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(authorizedActions, ['integration.n8n.event.create']);
  assert.deepEqual(calls[0].input.transcript, {
    code: 'TRANSCRIPTION_FAILED',
    status: 'failed',
  });
});
