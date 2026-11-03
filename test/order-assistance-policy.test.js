import assert from 'node:assert/strict';
import test from 'node:test';
import { createN8nApiRuntime } from '../apps/api/src/n8n-runtime.js';
import { createApi } from '../apps/api/src/app.js';
import { createN8nIntegrationService } from '../modules/n8n-integration/src/service.js';

function integration() {
  const key = Buffer.alloc(32, 71).toString('base64');
  const observations = /** @type {any[]} */ ([]);
  let writes = 0;
  const runtime = createN8nApiRuntime(
    {
      query() {
        throw new Error('No database writes are expected');
      },
      transaction() {
        throw new Error('No database writes are expected');
      },
    },
    {
      environment: Object.fromEntries(
        [
          'N8N_INTEGRATION_ENVELOPE_KEY',
          'CONTACT_IDENTITY_ENVELOPE_KEY',
          'CONTACT_IDENTITY_LOOKUP_KEY',
          'INBOX_MESSAGE_ENVELOPE_KEY',
        ].map((name) => [name, key]),
      ),
      mediaVolume: /** @type {any} */ ({}),
      orders: /** @type {any} */ ({
        async ensurePendingFromIntent() {
          writes++;
        },
      }),
      orderAssistance: {
        async observe(input) {
          observations.push(input);
          return { accepted: true };
        },
      },
    },
  );
  return { runtime, observations, writes: () => writes };
}

test('OA-01: subject-v1 keeps the initial briefing without requesting order creation', async () => {
  /** @type {any} */
  let captured;
  const service = createN8nIntegrationService({
    allowConversationBriefing: true,
    repository: {
      receiveInbound: async () => ({}),
      storeAttachment: async () => ({}),
      recordEvent: async (input) => {
        captured = input;
        return { accepted: true };
      },
    },
  });
  await service.recordEvent({
    schema_version: '1.0',
    event_id: 'synthetic-reservation',
    event_type: 'message.send.requested',
    occurred_at: '2026-11-03T15:00:00.000Z',
    conversation_id: 'synthetic-conversation',
    automation_epoch: 1,
    source_revision: 1,
    target_contract: 'subject-v1',
    open_order: false,
    briefing_patch: { product_type: 'camiseta', quantity: 20 },
    command_id: 'synthetic-command',
    message: { type: 'text', text: 'Qual cor você prefere?' },
    technical: {
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: 'synthetic-correlation',
      credentialVersion: 1,
      executionId: 'synthetic-execution',
      idempotencyKey: 'synthetic-reservation',
      requestId: 'synthetic-request',
      workflowKey: 'silmer-whatsapp',
      workflowVersion: 'mvp-simple-21',
    },
  });
  assert.equal(captured.openOrder, false);
  assert.equal(captured.briefingPatch.quantity, 20);
  assert.equal(captured.allowConversationBriefing, true);
});

test('OA-01: deprecated intent never opens an order, reserves a number or signals technical failure', async () => {
  const h = integration();
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await h.runtime.recordOrderIntent({
      conversation_id: 'synthetic-conversation',
      event_id: 'synthetic-event',
    });
    assert.equal(answer.order_id, null);
    assert.deepEqual(answer.order, { opened: null, status: 'awaiting_human' });
  }
  assert.equal(h.writes(), 0);
});

test('OA-02/OA-10: observer cannot override its authenticated actor or target via observation', async () => {
  const h = integration();
  const event = {
    schema_version: '1.0',
    event_type: 'order.assistance.observed',
    conversation_id: 'synthetic-conversation',
    source_revision: 4,
    automation_epoch: 2,
    technical: {
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: 'synthetic-correlation',
    },
    observation: { signal: 'uncertain' },
  };
  await h.runtime.recordEvent(event);
  assert.equal(h.observations[0].conversation_id, event.conversation_id);
  assert.equal(h.observations[0].technical, event.technical);
  for (const observation of [
    null,
    [],
    { signal: 'uncertain', technical: { actor: 'human' } },
    { signal: 'uncertain', conversation_id: 'other' },
  ]) {
    await assert.rejects(h.runtime.recordEvent({ ...event, observation }), {
      code: 'INVALID_OBSERVATION_EVENT',
    });
  }
  await assert.rejects(h.runtime.recordEvent({ ...event, open_order: true }), {
    code: 'INVALID_OBSERVATION_EVENT',
  });
  assert.equal(h.observations.length, 1);
  assert.equal(h.writes(), 0);
});

test('OA-02: observation event uses the authenticated integration route without send permission', async (t) => {
  const h = integration();
  const actions = /** @type {string[]} */ ([]);
  const api = createApi(
    {},
    {
      n8n: { ...h.runtime, storeAttachment: async () => ({}) },
      automationAuth: {
        async authorize(input) {
          actions.push(input.action);
          return { actor: 'AUTOMATION_EXECUTOR', credentialVersion: 1 };
        },
      },
    },
  );
  t.after(() => api.close());
  const correlation = '10000000-0000-4000-8000-000000000001';
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/integrations/n8n/events',
    headers: {
      'idempotency-key': 'observation:synthetic:4',
      'x-correlation-id': correlation,
      'x-silmer-workflow-key': 'silmer-whatsapp',
      'x-silmer-workflow-version': 'mvp-simple-21',
      'x-silmer-execution-id': 'synthetic-execution',
    },
    payload: {
      schema_version: '1.0',
      event_id: 'observation:synthetic:4',
      event_type: 'order.assistance.observed',
      occurred_at: '2026-11-03T15:00:00Z',
      conversation_id: 'synthetic-conversation',
      source_revision: 4,
      automation_epoch: 2,
      observation: { signal: 'uncertain' },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(actions, ['integration.n8n.event.create']);
  assert.equal(h.observations.length, 1);
});
