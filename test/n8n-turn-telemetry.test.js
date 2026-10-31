import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import { createN8nIntegrationService } from '../modules/n8n-integration/src/index.js';
import { validateEvent } from '../schemas/fixtures/external/n8n/contract-validator.mjs';

const contract = JSON.parse(
  await readFile(
    new URL(
      '../schemas/fixtures/external/n8n/contract-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

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

test('INBOX-DELIVERY-02: failure carries only a bounded code on failed and unknown sends', async () => {
  const { recorded, service } = harness();
  const unknown = {
    command_id: 'command-turn',
    conversation_id: 'conversation-turn',
    event_id: 'event-unknown',
    event_type: 'message.send.unknown',
    occurred_at: '2026-10-30T12:00:00.000Z',
    schema_version: '1.0',
    technical,
  };
  const withoutCommand = Object.fromEntries(
    Object.entries(unknown).filter(([key]) => key !== 'command_id'),
  );
  await service.recordEvent({ ...unknown, failure: { code: 'META_131047' } });
  await service.recordEvent({ ...unknown, failure: { code: 'meta erro' } });
  await service.recordEvent(unknown);
  await service.recordEvent({
    ...unknown,
    event_type: 'message.failed',
    external_message_id: 'wamid.out',
    failure: { code: 'Cliente 5527999999999' },
  });
  assert.deepEqual(
    recorded.map((input) => input.failure),
    [
      { code: 'META_131047' },
      { code: 'SEND_OUTCOME_UNKNOWN' },
      null,
      { code: 'SEND_FAILED' },
    ],
  );
  await assert.rejects(
    service.recordEvent({
      ...unknown,
      failure: { code: 'META_131047', message: 'texto' },
    }),
    /failure only accepts code/u,
  );
  await assert.rejects(
    service.recordEvent({
      ...withoutCommand,
      event_type: 'message.transcribed',
      external_message_id: 'wamid.audio',
      transcript: { code: 'TRANSCRIPTION_FAILED', status: 'ok', text: 'oi' },
    }),
    { name: 'N8nValidationError' },
  );
});

test('the n8n contract validator knows the Vendedor evolution fields', () => {
  const base = {
    automation_epoch: 0,
    conversation_id: 'conversation-turn',
    event_id: 'event-contract',
    occurred_at: '2026-10-30T12:00:00.000Z',
    schema_version: '1.0',
    source_revision: 1,
  };
  assert.equal(
    validateEvent(
      {
        ...base,
        command_id: 'command-turn',
        event_type: 'message.send.requested',
        message: { text: 'Oi', type: 'text' },
        turn: TURN,
      },
      contract,
    ),
    true,
  );
  for (const reason of ['automation_failure', 'partnership']) {
    assert.equal(
      validateEvent(
        {
          ...base,
          event_type: 'handoff.requested',
          handoff: { reason, requested_seller_id: 'seller-1' },
        },
        contract,
      ),
      true,
    );
  }
  assert.throws(
    () =>
      validateEvent(
        { ...base, event_type: 'handoff.requested', handoff: { reason: 'x' } },
        contract,
      ),
    { code: 'INVALID_HANDOFF_REASON' },
  );
  assert.throws(
    () =>
      validateEvent(
        {
          ...base,
          command_id: 'command-turn',
          event_type: 'message.send.requested',
          message: { text: 'Oi', type: 'text' },
          turn: { ...TURN, note: 'texto livre' },
        },
        contract,
      ),
    { code: 'UNKNOWN_FIELD:note' },
  );
  assert.equal(
    validateEvent(
      {
        ...base,
        event_type: 'message.transcribed',
        external_message_id: 'wamid.audio',
        transcript: { status: 'ok', text: 'Quero camisas' },
      },
      contract,
    ),
    true,
  );
  assert.throws(
    () =>
      validateEvent(
        {
          ...base,
          event_type: 'message.transcribed',
          external_message_id: 'wamid.audio',
          transcript: { code: 'X', status: 'failed' },
        },
        contract,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  );
  assert.equal(
    validateEvent(
      {
        ...base,
        command_id: 'command-turn',
        event_type: 'message.send.unknown',
        failure: { code: 'META_SEND_OUTCOME_UNKNOWN' },
      },
      contract,
    ),
    true,
  );
  assert.throws(
    () =>
      validateEvent(
        {
          ...base,
          event_type: 'message.failed',
          external_message_id: 'wamid.out',
          failure: { code: 'X', message: 'texto' },
        },
        contract,
      ),
    { code: 'UNKNOWN_FIELD:message' },
  );
});
