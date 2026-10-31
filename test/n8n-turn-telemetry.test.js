import assert from 'node:assert/strict';
import test from 'node:test';

import { createN8nIntegrationService } from '../modules/n8n-integration/src/index.js';

const technical = Object.freeze({
  actor: 'AUTOMATION_EXECUTOR',
  correlationId: 'correlation-turn',
  credentialVersion: 'current',
  executionId: 'execution-turn',
  idempotencyKey: 'key-turn',
  requestId: 'request-turn',
  workflowKey: 'whatsapp-mvp',
  workflowVersion: 'mvp-simple-14',
});

function harness() {
  const recorded = /** @type {any[]} */ ([]);
  const service = createN8nIntegrationService({
    repository: {
      receiveInbound: async () => ({}),
      storeAttachment: async () => ({}),
      async recordEvent(/** @type {any} */ input) {
        recorded.push(input);
        return { accepted: true };
      },
    },
  });
  return { recorded, service };
}

/** @param {Record<string, unknown>} extra */
function reply(extra = {}) {
  return {
    automation_epoch: 0,
    command_id: 'command-turn',
    conversation_id: 'conversation-turn',
    event_id: 'event-turn',
    event_type: 'message.send.requested',
    message: { text: 'Olá', type: 'text' },
    occurred_at: '2026-10-30T12:00:00.000Z',
    schema_version: '1.0',
    source_revision: 1,
    technical,
    ...extra,
  };
}

const TURN = Object.freeze({
  answer_status: 'answered',
  asked_field: 'colors',
  ficha_filled: 3,
  ficha_total: 8,
  latency_ms: 5400,
  media_kind: 'text',
  model: 'gpt-5.6-luna',
  trigger: 'briefing_complete',
});

test('AGENTE-OBS-01: a reply or a handoff carries the strict turn telemetry', async () => {
  const { recorded, service } = harness();
  await service.recordEvent(reply({ turn: TURN }));
  assert.deepEqual(recorded[0].turn, {
    answerStatus: 'answered',
    askedField: 'colors',
    fichaFilled: 3,
    fichaTotal: 8,
    latencyMs: 5400,
    mediaKind: 'text',
    model: 'gpt-5.6-luna',
    trigger: 'briefing_complete',
  });
  await service.recordEvent({
    automation_epoch: 0,
    conversation_id: 'conversation-turn',
    event_id: 'event-handoff-turn',
    event_type: 'handoff.requested',
    handoff: { reason: 'automation_failure' },
    occurred_at: '2026-10-30T12:00:00.000Z',
    schema_version: '1.0',
    source_revision: 1,
    technical,
    turn: {
      answer_status: null,
      asked_field: null,
      ficha_filled: 0,
      ficha_total: 0,
    },
  });
  assert.deepEqual(recorded[1].turn, {
    answerStatus: null,
    askedField: null,
    fichaFilled: 0,
    fichaTotal: 0,
    latencyMs: null,
    mediaKind: null,
    model: null,
    trigger: null,
  });
  // The workflow published today sends no turn and keeps working.
  await service.recordEvent(reply());
  assert.equal(recorded[2].turn, null);
});

test('AGENTE-OBS-01: an unknown key, free text or an out-of-range count is refused', async () => {
  const { recorded, service } = harness();
  for (const turn of [
    { ...TURN, customer_name: 'Fulana' },
    { ...TURN, asked_field: 'Qual a cor?' },
    { ...TURN, answer_status: 'yes' },
    { ...TURN, trigger: 'Cliente pediu desconto' },
    { ...TURN, model: 'GPT 5' },
    { ...TURN, media_kind: 'video' },
    { ...TURN, latency_ms: 600_001 },
    { ...TURN, latency_ms: 1.5 },
    { ...TURN, ficha_filled: 9, ficha_total: 8 },
    { ...TURN, ficha_total: 65 },
    { ficha_total: 8 },
    'answered',
    [TURN],
  ]) {
    await assert.rejects(service.recordEvent(reply({ turn })), {
      name: 'N8nValidationError',
      statusCode: 400,
    });
  }
  await assert.rejects(
    service.recordEvent({
      conversation_id: 'conversation-turn',
      event_id: 'event-delivered',
      event_type: 'message.delivered',
      external_message_id: 'wamid.out',
      occurred_at: '2026-10-30T12:00:00.000Z',
      schema_version: '1.0',
      technical,
      turn: TURN,
    }),
    /only allowed on send reservation or handoff/u,
  );
  assert.equal(recorded.length, 0);
});

test('AGENTE-OBS-01: the turn is part of the idempotency fingerprint', async () => {
  const { recorded, service } = harness();
  await service.recordEvent(reply({ turn: TURN }));
  await service.recordEvent(reply({ turn: { ...TURN, latency_ms: 1 } }));
  assert.notEqual(recorded[0].eventFingerprint, recorded[1].eventFingerprint);
});
