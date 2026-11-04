import assert from 'node:assert/strict';
import test from 'node:test';

import {
  N8nForbiddenError,
  N8nValidationError,
  createN8nIntegrationService,
} from '../modules/n8n-integration/src/index.js';

const NOW = new Date('2026-09-07T15:00:00.000Z');
const TECHNICAL = Object.freeze({
  actor: 'AUTOMATION_EXECUTOR',
  correlationId: 'correlation-1',
  credentialVersion: 'current',
  executionId: 'execution-1',
  idempotencyKey: 'idempotency-1',
  requestId: 'request-1',
  workflowKey: 'seller-v1',
  workflowVersion: '1.0.0',
});

function harness() {
  /** @type {{input: any, method: string, runtime: any}[]} */
  const calls = [];
  const repository = /** @type {any} */ (
    Object.fromEntries(
      ['receiveInbound', 'storeAttachment', 'recordEvent'].map((method) => [
        method,
        async (/** @type {any} */ input, /** @type {any} */ runtime) => {
          calls.push({ input, method, runtime });
          return { accepted: true, method };
        },
      ]),
    )
  );
  return {
    calls,
    service: createN8nIntegrationService({
      clock: () => NOW,
      idFactory: (kind) => `${kind}-1`,
      repository,
    }),
  };
}

test('normalizes WhatsApp buttons inside canonical text content', async () => {
  const { calls, service } = harness();
  await service.receiveInbound({
    channel: 'whatsapp',
    contact: { name: 'Cliente', wa_id: '5511000000000' },
    event_id: 'wa-event-1',
    message: {
      button: { id: 'quote', title: 'Quero orçamento' },
      external_id: 'wa-message-1',
      text: 'Quero orçamento',
      type: 'button',
    },
    metadata: { phone_number_id: 'wa-account-1' },
    occurred_at: NOW.toISOString(),
    schema_version: '1.0',
    technical: TECHNICAL,
  });

  const normalized = calls[0].input;
  assert.equal(normalized.channel, 'whatsapp');
  assert.equal(normalized.identityKind, 'phone');
  assert.equal(normalized.message.type, 'text');
  assert.deepEqual(normalized.message.content, {
    interaction: {
      payload: { id: 'quote', title: 'Quero orçamento' },
      type: 'button',
    },
    text: 'Quero orçamento',
  });
  assert.equal(normalized.technical.actor, 'AUTOMATION_EXECUTOR');
});

test('EVOL-02 document image metadata stays optional and restricted to raster placeholders', async () => {
  for (const mime of [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    ' IMAGE/PNG; charset=binary',
    'application/pdf',
    'image/svg+xml',
    null,
  ]) {
    const { calls, service } = harness();
    await service.receiveInbound({
      channel: 'whatsapp',
      contact: { name: 'Synthetic', wa_id: '5511000000000' },
      event_id: 'synthetic-image-document',
      message: {
        external_id: 'synthetic-image-document',
        type: 'document',
        text: 'Synthetic',
        attachment: { external_id: 'synthetic-attachment', mime_type: mime },
      },
      metadata: { phone_number_id: 'synthetic-account' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      technical: TECHNICAL,
    });
    const normalized = calls[0].input.message;
    assert.equal(normalized.type, 'document');
    const supported =
      typeof mime === 'string' &&
      !['application/pdf', 'image/svg+xml'].includes(mime);
    assert.deepEqual(normalized.content, {
      attachmentId: 'synthetic-attachment',
      caption: 'Synthetic',
      ...(supported
        ? { mimeType: mime.trim().toLowerCase().split(';')[0] }
        : {}),
    });
  }
});

test('site chat keeps its synthetic identity apart from the claimed phone', async () => {
  const { calls, service } = harness();
  const payload = {
    channel: 'site_chat',
    contact: { external_id: '999024249434048109030647017182301789831168' },
    event_id: 'site-event-1',
    message: {
      external_id: 'site-message-1',
      text: 'Quero orçamento',
      type: 'text',
    },
    metadata: { provider_account_id: 'silmer-site' },
    occurred_at: NOW.toISOString(),
    schema_version: '1.0',
    site_contact: { name: ' Ana Silva ', phone: '(27) 99999-1234' },
    technical: TECHNICAL,
  };
  await service.receiveInbound(payload);
  assert.equal(calls[0].input.channel, 'site_chat');
  assert.equal(calls[0].input.provider, 'site');
  assert.equal(calls[0].input.externalIdentityId, payload.contact.external_id);
  assert.equal(calls[0].input.identityKind, 'handle');
  assert.equal(calls[0].input.phoneStatus, 'pending');
  assert.deepEqual(calls[0].input.siteContact, {
    name: 'Ana Silva',
    phone: '5527999991234',
  });
  for (const invalid of [
    { ...payload, contact: { wa_id: payload.contact.external_id } },
    { ...payload, contact: { external_id: '5527999991234' } },
    { ...payload, contact: { external_id: '999123456789012' } },
    { ...payload, provider: 'meta' },
    { ...payload, site_contact: { name: 'Ana', phone: '999' } },
    {
      ...payload,
      site_contact: { name: 'Ana', phone: '5527999991234', role: 'owner' },
    },
  ]) {
    await assert.rejects(service.receiveInbound(invalid), N8nValidationError);
  }
  await assert.rejects(
    service.receiveInbound({ ...payload, channel: 'whatsapp' }),
    N8nValidationError,
  );
});

test('passes source revision, epoch and briefing patch to the event repository', async () => {
  const { calls, service } = harness();
  for (const eventType of ['message.send.requested', 'message.send.unknown']) {
    await service.recordEvent({
      automation_epoch: 3,
      ...(eventType === 'message.send.requested'
        ? { briefing_patch: { segment: 'uniform' } }
        : {}),
      command_id: 'command-1',
      conversation_id: 'conversation-1',
      event_id: `${eventType}-1`,
      event_type: eventType,
      message: { text: 'Mensagem segura', type: 'text' },
      occurred_at: NOW.toISOString(),
      source_revision: 7,
      schema_version: '1.0',
      technical: {
        ...TECHNICAL,
        idempotencyKey: `${eventType}-1`,
      },
    });
  }
  assert.deepEqual(
    calls.map(({ input }) => input.eventType),
    ['message.send.requested', 'message.send.unknown'],
  );
  assert.deepEqual(
    calls.map(({ input }) => [
      input.automationEpoch,
      input.sourceRevision,
      input.briefingPatch,
    ]),
    [
      [3, 7, { segment: 'uniform' }],
      [3, 7, null],
    ],
  );
});

test('explicit subject target is an inseparable pair and cannot open a different order', async () => {
  const { calls, service } = harness();
  const payload = {
    automation_epoch: 3,
    briefing_patch: { order_name: 'Pedido B' },
    command_id: 'command-target-b',
    conversation_id: 'conversation-1',
    event_id: 'event-target-b',
    event_type: 'message.send.requested',
    message: { text: 'Qual a cor?', type: 'text' },
    occurred_at: NOW.toISOString(),
    source_revision: 7,
    schema_version: '1.0',
    technical: TECHNICAL,
  };
  await service.recordEvent({
    ...payload,
    subject_id: 'subject-b',
    order_id: 'order-b',
  });
  assert.equal(calls.at(-1)?.input.subjectId, 'subject-b');
  assert.equal(calls.at(-1)?.input.orderId, 'order-b');
  for (const invalid of [
    { subject_id: 'subject-b' },
    { order_id: 'order-b' },
    { subject_id: 'subject-b', order_id: 'order-b', open_order: true },
  ]) {
    await assert.rejects(
      service.recordEvent({ ...payload, ...invalid }),
      N8nValidationError,
    );
  }
  await assert.rejects(
    service.recordEvent({ ...payload, target_contract: 'subject-v1' }),
    N8nValidationError,
  );
  await assert.rejects(
    service.recordEvent({
      ...payload,
      technical: {
        ...TECHNICAL,
        workflowVersion: 'mvp-simple-15',
      },
    }),
    N8nValidationError,
  );
  await service.recordEvent({
    ...payload,
    target_contract: 'subject-v1',
    open_order: true,
  });
});

test('accepts only the structured pre-ficha fields used by the guided agent', async () => {
  const { calls, service } = harness();
  await service.recordEvent({
    automation_epoch: 3,
    briefing_patch: {
      customer_name: 'Associação Horizonte',
      fabrics: ['dry fit'],
      next_required_field: 'sizes',
      order_name: 'Corrida Horizonte 2026',
      product_type: 'camiseta',
      quantity: 120,
    },
    command_id: 'guided-briefing-1',
    conversation_id: 'conversation-1',
    event_id: 'guided-briefing-event-1',
    event_type: 'message.send.requested',
    message: { text: 'Qual a grade por tamanho?', type: 'text' },
    occurred_at: NOW.toISOString(),
    source_revision: 7,
    schema_version: '1.0',
    technical: TECHNICAL,
  });
  assert.deepEqual(calls[0].input.briefingPatch, {
    customer_name: 'Associação Horizonte',
    fabrics: ['dry fit'],
    next_required_field: 'sizes',
    order_name: 'Corrida Horizonte 2026',
    product_type: 'camiseta',
    quantity: 120,
  });
  await assert.rejects(
    service.recordEvent({
      automation_epoch: 3,
      briefing_patch: { price: 100 },
      command_id: 'guided-briefing-2',
      conversation_id: 'conversation-1',
      event_id: 'guided-briefing-event-2',
      event_type: 'message.send.requested',
      message: { text: 'Mensagem segura', type: 'text' },
      occurred_at: NOW.toISOString(),
      source_revision: 7,
      schema_version: '1.0',
      technical: TECHNICAL,
    }),
    (error) =>
      error instanceof N8nValidationError &&
      error.message === 'briefing_patch.price is not allowed',
  );
});

test('accepts the collar as its own pre-ficha field (ADR 012)', async () => {
  const { calls, service } = harness();
  /** @param {string} id @param {Record<string, unknown>} briefingPatch */
  const handoff = (id, briefingPatch) =>
    service.recordEvent({
      automation_epoch: 3,
      briefing_patch: briefingPatch,
      conversation_id: 'conversation-1',
      event_id: `collar-event-${id}`,
      event_type: 'handoff.requested',
      handoff: { reason: 'briefing_complete', summary: 'Pré-ficha completa.' },
      occurred_at: NOW.toISOString(),
      source_revision: 7,
      schema_version: '1.0',
      technical: { ...TECHNICAL, idempotencyKey: `collar-${id}` },
    });

  await handoff('1', { collar: 'gola V', product_model: 'camiseta comum' });
  assert.deepEqual(calls[0].input.briefingPatch, {
    collar: 'gola V',
    product_model: 'camiseta comum',
  });

  // Only the agreed key exists: a translated or guessed name is still a 400.
  for (const key of ['gola', 'neckline', 'collar_type']) {
    await assert.rejects(
      handoff(key, { [key]: 'gola V' }),
      (error) =>
        error instanceof N8nValidationError &&
        error.statusCode === 400 &&
        error.message === `briefing_patch.${key} is not allowed`,
    );
  }
  assert.equal(calls.length, 1);
});

test('rejects Instagram until the channel-specific phase is delivered', async () => {
  const { service } = harness();
  await assert.rejects(
    service.receiveInbound({
      channel: 'instagram',
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      technical: TECHNICAL,
    }),
    (error) =>
      error instanceof N8nValidationError &&
      error.message === 'channel is unsupported',
  );
});

test('rejects a non-technical actor and malformed contract with typed HTTP errors', async () => {
  const { service } = harness();
  await assert.rejects(
    service.receiveInbound({ technical: { ...TECHNICAL, actor: 'user-1' } }),
    (error) => error instanceof N8nForbiddenError && error.statusCode === 403,
  );
  await assert.rejects(
    service.recordEvent({
      event_type: 'unsupported.event',
      schema_version: '1.0',
      technical: TECHNICAL,
    }),
    (error) => error instanceof N8nValidationError && error.statusCode === 400,
  );
  await assert.rejects(
    service.recordEvent({
      automation_epoch: 0,
      command_id: 'command-without-source-revision',
      conversation_id: 'conversation-1',
      event_id: 'send-without-source-revision',
      event_type: 'message.send.requested',
      message: { text: 'Mensagem sem fence completo', type: 'text' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      technical: TECHNICAL,
    }),
    (error) =>
      error instanceof N8nValidationError &&
      /source_revision/u.test(error.message),
  );
});

test('OPS-INBOX-SEND-06: recipient checks accept only bounded before-send failure contracts', async () => {
  const { calls, service } = harness();
  const input = {
    schema_version: '1.0',
    event_id: 'recipient-check-1',
    event_type: 'workflow.failed',
    command_id: 'command-1',
    conversation_id: 'conversation-1',
    occurred_at: NOW.toISOString(),
    technical: TECHNICAL,
    failure: {
      phase: 'before_message_send',
      code: 'EVOLUTION_RECIPIENT_NOT_FOUND',
    },
  };
  for (const code of [
    'EVOLUTION_RECIPIENT_NOT_FOUND',
    'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
  ]) {
    await service.recordEvent({
      ...input,
      failure: { ...input.failure, code },
    });
    assert.deepEqual(calls.at(-1)?.input.failure, {
      phase: 'before_message_send',
      code,
    });
  }
  for (const invalid of [
    { command_id: null },
    { conversation_id: null },
    { failure: { ...input.failure, phase: 'after_message_send' } },
    { failure: { ...input.failure, code: 'EVOLUTION_RECIPIENT_OTHER' } },
    { failure: { ...input.failure, code: 'invalid code' } },
    { failure: { ...input.failure, number: 'NEVER_COPY' } },
    { failure: { ...input.failure, payload: { text: 'NEVER_COPY' } } },
  ]) {
    await assert.rejects(service.recordEvent({ ...input, ...invalid }), {
      statusCode: 400,
    });
  }
  await assert.rejects(
    service.recordEvent({
      ...input,
      technical: { ...TECHNICAL, actor: 'seller-1' },
    }),
    { statusCode: 403 },
  );
  assert.equal(calls.length, 2);
});

test('carries open_order only on the reservation and the handoff (ADR 014)', async () => {
  const { calls, service } = harness();
  /** @param {string} id @param {string} eventType @param {Record<string, unknown>} extra */
  const event = (id, eventType, extra) =>
    service.recordEvent({
      automation_epoch: 3,
      command_id: `command-${id}`,
      conversation_id: 'conversation-1',
      event_id: `open-order-${id}`,
      event_type: eventType,
      external_message_id: 'wamid.outbound.1',
      handoff: { reason: 'negotiation', summary: 'Perguntou o valor.' },
      message: { text: 'Mensagem segura', type: 'text' },
      occurred_at: NOW.toISOString(),
      schema_version: '1.0',
      source_revision: 7,
      technical: { ...TECHNICAL, idempotencyKey: `open-order-${id}` },
      ...extra,
    });

  await event('reserve', 'message.send.requested', { open_order: true });
  await event('handoff', 'handoff.requested', { open_order: true });
  await event('closed', 'message.send.requested', { open_order: false });
  await event('absent', 'message.send.requested', {});
  assert.deepEqual(
    calls.map(({ input }) => [input.eventType, input.openOrder]),
    [
      ['message.send.requested', true],
      ['handoff.requested', true],
      ['message.send.requested', false],
      ['message.send.requested', null],
    ],
  );

  // A flag rendered as text or a number would open nothing in silence.
  for (const value of ['true', 1, null]) {
    await assert.rejects(
      event(`typed-${String(value)}`, 'message.send.requested', {
        open_order: value,
      }),
      (error) =>
        error instanceof N8nValidationError &&
        error.statusCode === 400 &&
        error.message === 'open_order must be a boolean',
    );
  }
  // Only the events that carry the turn's briefing may open the order.
  for (const eventType of ['message.sent', 'workflow.failed']) {
    for (const value of [true, false]) {
      await assert.rejects(
        event(`${eventType}-${value}`, eventType, { open_order: value }),
        (error) =>
          error instanceof N8nValidationError &&
          error.message ===
            'open_order is only allowed on send reservation or handoff',
      );
    }
  }
  assert.equal(calls.length, 4);
});
