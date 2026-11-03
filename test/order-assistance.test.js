import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  createOrderAssistanceService,
  requireAssistanceOwner,
} from '../modules/inbox-channels/src/application/order-assistance.js';
import {
  encryptAssistance,
  decryptAssistance,
} from '../modules/inbox-channels/src/application/order-assistance-envelope.js';
import { registerOrderAssistanceRoutes } from '../apps/api/src/order-assistance-routes.js';

const OWNER = { id: 'seller-synthetic', kind: 'human', capabilities: [] };
const OBSERVATION = {
  conversation_id: 'conversation-synthetic',
  source_revision: 3,
  automation_epoch: 1,
  signal: 'purchase_confirmed',
  evidence_message_id: 'message-confirmed',
  product_summary: '20 camisetas brancas',
  briefing_patch: { product_model: 'camiseta', quantity: 20 },
  technical: {
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'correlation-synthetic',
  },
};
const DECISION = {
  actor: OWNER,
  conversationId: 'conversation-synthetic',
  idempotencyKey: 'decision-synthetic',
  correlationId: 'correlation-synthetic',
  suggestionId: 'suggestion-synthetic',
  decision: 'accept',
  reason: 'ready',
  expectedVersion: 1,
  expectedConversationVersion: 2,
  expectedSourceRevision: 3,
};
function harness() {
  /** @type {any[]} */ const calls = [];
  const repository = {
    observe: async (/** @type {any} */ input) => {
      calls.push(input);
      return { accepted: true, suggested: true };
    },
    decide: async (/** @type {any} */ input) => {
      calls.push(input);
      return { decision: { id: 'decision-synthetic' } };
    },
    metrics: async (/** @type {any} */ days) => ({ days }),
    list: async () => ({
      suggestions: [],
      evaluations: [],
      sourceRevision: 3,
      conversationVersion: 2,
    }),
  };
  return { calls, service: createOrderAssistanceService(repository) };
}

test('OA-01/02 observation records evidence without an order command', async () => {
  const { calls, service } = harness();
  await service.observe(OBSERVATION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].evidenceMessageId, 'message-confirmed');
  assert.equal(calls[0].sourceRevision, 3);
  assert.deepEqual(calls[0].briefing, {
    product_model: 'camiseta',
    quantity: 20,
  });
  assert.equal(Object.hasOwn(calls[0], 'openOrder'), false);
});
test('OA-03 missing evidence, technical actor, revision and commercial mutations are refused before persistence', async () => {
  for (const patch of [
    { evidence_message_id: null },
    { product_summary: '' },
    { technical: { actor: 'human' } },
    { source_revision: -1 },
    { briefing_patch: { price: 50 } },
    { briefing_patch: { status: 'confirmado' } },
    { briefing_patch: { quantity: { value: 20 } } },
    { briefing_patch: { quantity: null } },
    { briefing_patch: { quantity: NaN } },
    { briefing_patch: { notes: 'x'.repeat(2001) } },
    { product_summary: 'x'.repeat(257) },
  ]) {
    const { calls, service } = harness();
    await assert.rejects(service.observe({ ...OBSERVATION, ...patch }));
    assert.equal(calls.length, 0);
  }
});
test('OA-04 uncertain, unsupported and failed analyses record coverage without inventing an intent', async () => {
  for (const signal of [
    'uncertain',
    'not_ready',
    'unsupported',
    'withdrawn',
    'analysis_failed',
  ]) {
    const { calls, service } = harness();
    await service.observe({
      ...OBSERVATION,
      signal,
      evidence_message_id: null,
      product_summary: null,
    });
    assert.equal(calls[0].signal, signal);
  }
});
test('OA-05 accept requires explicit ready decision and reviewed revisions', async () => {
  const { calls, service } = harness();
  await service.decide(DECISION);
  assert.equal(calls[0].decision, 'accept');
  for (const patch of [
    { reason: 'not_ready' },
    { expectedVersion: undefined },
    { expectedSourceRevision: undefined },
    { expectedConversationVersion: undefined },
    { suggestionId: null },
    { idempotencyKey: undefined },
  ])
    await assert.rejects(service.decide({ ...DECISION, ...patch }));
});
test('OA-06 review and omission reasons remain finite, without free text telemetry', async () => {
  const { service } = harness();
  await service.decide({ ...DECISION, decision: 'defer', reason: 'not_ready' });
  await service.decide({
    ...DECISION,
    decision: 'reject',
    reason: 'unsupported',
  });
  await service.decide({
    ...DECISION,
    decision: 'missed',
    reason: 'ready',
    sourceMessageId: 'message-confirmed',
  });
  await assert.rejects(
    service.decide({
      ...DECISION,
      decision: 'reject',
      reason: 'Customer private free text',
    }),
  );
  await assert.rejects(
    service.decide({ ...DECISION, decision: 'missed', sourceMessageId: null }),
  );
});
test('OA-07 ownership excludes another seller and an automation actor; admin remains explicit', () => {
  requireAssistanceOwner(OWNER, { assigned_user_id: OWNER.id });
  requireAssistanceOwner(
    { ...OWNER, id: 'admin', capabilities: ['COMMERCIAL_ADMIN'] },
    { assigned_user_id: OWNER.id },
  );
  assert.throws(
    () =>
      requireAssistanceOwner(
        { ...OWNER, id: 'other' },
        { assigned_user_id: OWNER.id },
      ),
    { code: 'FORBIDDEN' },
  );
  assert.throws(
    () =>
      requireAssistanceOwner(
        { ...OWNER, kind: 'automation' },
        { assigned_user_id: OWNER.id },
      ),
    { code: 'FORBIDDEN' },
  );
});
test('OA-08 metrics require admin and bounded windows', async () => {
  const { service } = harness();
  await assert.rejects(service.metrics({ actor: OWNER, days: 30 }), {
    code: 'FORBIDDEN',
  });
  const actor = { ...OWNER, capabilities: ['COMMERCIAL_ADMIN'] };
  assert.deepEqual(await service.metrics({ actor, days: 30 }), { days: 30 });
  for (const days of [0, 91, NaN, 1.5])
    await assert.rejects(service.metrics({ actor, days }), {
      code: 'INVALID_DAYS',
    });
});
test('OA-09 encrypted summaries are bound to their suggestion and reject tampering', () => {
  const key = Buffer.alloc(32, 77);
  const envelope = encryptAssistance(
    { productSummary: '20 camisetas' },
    'suggestion-one',
    key,
  );
  assert.equal(JSON.stringify(envelope).includes('camisetas'), false);
  assert.deepEqual(decryptAssistance(envelope, 'suggestion-one', key), {
    productSummary: '20 camisetas',
  });
  assert.throws(() => decryptAssistance(envelope, 'suggestion-two', key));
  assert.throws(() =>
    decryptAssistance(
      { ...envelope, tag: Buffer.alloc(16).toString('base64url') },
      'suggestion-one',
      key,
    ),
  );
});
test('OA-10 routes preserve existing session, CSRF and admin authorization and strict bodies', async (t) => {
  const api = Fastify();
  t.after(() => api.close());
  const { service } = harness();
  /** @type {any[]} */ const guards = [];
  registerOrderAssistanceRoutes(
    api,
    {
      ...service,
      authorizeRead: async (/** @type {any} */ value) => {
        guards.push(value);
        return { actor: OWNER };
      },
      authorizeWrite: async (/** @type {any} */ value) => {
        guards.push(value);
        if (value.csrfToken !== 'synthetic-csrf')
          throw Object.assign(new Error('FORBIDDEN'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        return { actor: OWNER };
      },
    },
    () => ({ correlationId: 'correlation-synthetic' }),
  );
  const path =
    '/api/v1/inbox/conversations/conversation-synthetic/order-assistance';
  const read = await api.inject({ url: path });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'private, no-store');
  const body = Object.fromEntries(
    Object.entries(DECISION).filter(
      ([key]) =>
        ![
          'actor',
          'conversationId',
          'idempotencyKey',
          'correlationId',
        ].includes(key),
    ),
  );
  const denied = await api.inject({
    method: 'POST',
    url: path + '/decisions',
    payload: body,
  });
  assert.equal(denied.statusCode, 403);
  const allowed = await api.inject({
    method: 'POST',
    url: path + '/decisions',
    headers: {
      'x-csrf-token': 'synthetic-csrf',
      'idempotency-key': 'command-synthetic',
      origin: 'https://crm.example.test',
      cookie: 'crm_session=synthetic',
    },
    payload: body,
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(guards.at(-1).action, 'order.create');
  assert.equal(guards.at(-1).origin, 'https://crm.example.test');
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: path + '/decisions',
        payload: { ...body, open_order: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await api.inject({ url: '/api/v1/inbox/order-assistance/metrics' }))
      .statusCode,
    403,
  );
});
