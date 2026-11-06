import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { syntheticItems } from './fixtures/order-items.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';

const OWNER = {
  id: 'synthetic-source-owner',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: [],
};
const OTHER = { ...OWNER, id: 'synthetic-other-owner' };
const HEADERS = {
  cookie: 'crm_session=synthetic-source-session',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic-source-csrf',
  'x-request-id': '30000000-0000-4000-8000-000000000026',
};
const NOW = new Date('2026-11-05T12:00:00.000Z');

async function harness() {
  const repository = new InMemoryOrderRepository();
  const state = {
    readAllowed: true,
    actor: { ...OWNER },
    assignedUserId: OWNER.id,
  };
  /** @type {{method: string, input: any}[]} */
  const guards = [];
  /** @type {any[]} */
  const audits = [];
  const runtime = createOrderRuntime({
    repository,
    fabCode: '01',
    clock: () => NOW,
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    auditTrail: {
      append: async (/** @type {any} */ event) => {
        audits.push(event);
      },
    },
    access: {
      authorizeRead: async (input) => {
        guards.push({ method: 'read', input });
        if (!state.readAllowed)
          throw Object.assign(new Error('Denied'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        return { actor: state.actor };
      },
      authorizeWrite: async (input) => {
        guards.push({ method: 'write', input });
        return { actor: state.actor };
      },
    },
    conversations: {
      readAssignment: async () => ({
        assignedUserId: state.assignedUserId,
        version: 1,
      }),
      readAssignments: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, state.assignedUserId])),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: orderContextsFrom(() => ({
        briefing: null,
        customerName: 'Cliente Sintético',
      })),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, 'Pessoa Sintética'])),
      searchConversationIds: async () => [],
    },
  });
  const { order: pending } = await runtime.createManual({
    actor: OWNER,
    conversationId: 'synthetic-conversation',
    expectedVersion: 1,
    correlationId: 'synthetic-source-fixture',
    idempotencyKey: 'synthetic-source-create',
  });
  const rawPending = await repository.findById(pending.id);
  assert.ok(rawPending);
  const legacy = await repository.saveStatus(
    {
      ...rawPending,
      ficha: {
        ...pending.ficha,
        items: syntheticItems().map((item, index) => ({
          ...item,
          grade: [{ tamanho: 'M', quantidade: index === 0 ? 10 : 20 }],
        })),
      },
      status: 'confirmado',
      finalAmountCents: 50000,
      paymentCondition: 'pix',
      confirmedAt: NOW.toISOString(),
      confirmedBy: OWNER.id,
      orderDate: '2026-11-05',
      totalPieces: 30,
      missingFields: [],
    },
    {
      actor: OWNER,
      expectedVersion: pending.version,
      correlationId: 'synthetic-source-history',
    },
  );
  const api = createApi({}, { orders: runtime });
  let sequence = 0;
  const url = `/api/v1/orders/${legacy.id}/price-breakdown`;
  const request = (
    /** @type {unknown} */ value,
    expectedVersion = legacy.version,
    key = `synthetic-source-${sequence++}`,
  ) => ({
    method: /** @type {const} */ ('POST'),
    url,
    headers: { ...HEADERS, 'idempotency-key': key },
    payload: { expectedVersion, value },
  });
  return {
    api,
    repository,
    runtime,
    state,
    guards,
    audits,
    legacy,
    url,
    request,
  };
}

/** @param {any} source @param {(number|null)[]} [prices] */
function batch(source, prices = [18000, 32000]) {
  let index = 0;
  return {
    action: 'set_subtotals',
    lines: source.groups.flatMap((/** @type {any} */ group) =>
      group.lines.map((/** @type {any} */ line) => ({
        groupId: group.id,
        lineId: line.id,
        subtotalCents: prices[index++],
      })),
    ),
  };
}

test('T26 GET source requires read authorization and suppresses caching without changing legacy ficha', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const before = await h.repository.findById(h.legacy.id);
  const read = await h.api.inject({
    method: 'GET',
    url: h.url,
    headers: HEADERS,
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal(h.guards.at(-1)?.input.action, 'order.read');
  assert.equal(read.json().revision, 0);
  assert.equal(read.json().pricing, null);
  assert.deepEqual(read.json().issues, [
    { code: 'LEGACY_PRICE_BREAKDOWN_REQUIRED', field: 'priceBreakdown' },
  ]);
  assert.deepEqual(await h.repository.findById(h.legacy.id), before);
  h.state.readAllowed = false;
  const denied = await h.api.inject({
    method: 'GET',
    url: h.url,
    headers: HEADERS,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().groups, undefined);
  assert.equal(
    (
      await h.api.inject({
        method: 'GET',
        url: `${h.url}?unknown=true`,
        headers: HEADERS,
      })
    ).statusCode,
    400,
  );
});

test('T26 initialize and equal full batch preserve the original public order and replay once', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const publicBefore = (await h.runtime.get(h.legacy.id)).order;
  const initRequest = h.request({ action: 'initialize' });
  const initialized = await h.api.inject(initRequest);
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.headers['cache-control'], 'private, no-store');
  const source = initialized.json();
  assert.equal(source.revision, 1);
  assert.equal(source.orderVersion, h.legacy.version + 1);
  assert.equal(source.sourceValid, true);
  assert.equal(source.pricing.complete, false);
  assert.equal(
    new Set(
      source.groups.flatMap((/** @type {any} */ group) => [
        group.id,
        ...group.lines.map((/** @type {any} */ line) => line.id),
      ]),
    ).size,
    4,
  );
  const writeGuard = h.guards.findLast((guard) => guard.method === 'write');
  assert.equal(writeGuard?.input.action, 'order.edit');
  assert.equal(writeGuard?.input.origin, HEADERS.origin);
  assert.equal(writeGuard?.input.csrfToken, HEADERS['x-csrf-token']);
  assert.equal(writeGuard?.input.cookie, HEADERS.cookie);
  assert.deepEqual((await h.api.inject(initRequest)).json(), source);
  assert.equal((await h.runtime.priceBreakdown(h.legacy.id)).revision, 1);
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    1,
  );
  const saveRequest = h.request(batch(source), source.orderVersion);
  const saved = await h.api.inject(saveRequest);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, 2);
  assert.equal(saved.json().pricing.totalCents, 50000);
  assert.deepEqual(
    saved.json().groups.map((/** @type {any} */ g) => g.id),
    source.groups.map((/** @type {any} */ g) => g.id),
  );
  assert.deepEqual((await h.api.inject(saveRequest)).json(), saved.json());
  assert.equal((await h.runtime.priceBreakdown(h.legacy.id)).revision, 2);
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(h.audits),
    /subtotalCents|Cliente|Pessoa/u,
  );
  const stored = await h.repository.findById(h.legacy.id);
  assert.ok(stored);
  assert.deepEqual(stored.ficha, h.legacy.ficha);
  assert.equal(stored.finalAmountCents, 50000);
  assert.equal(stored.confirmedAt, h.legacy.confirmedAt);
  const publicRead = await h.api.inject({
    method: 'GET',
    url: `/api/v1/orders/${h.legacy.id}`,
    headers: HEADERS,
  });
  assert.equal(publicRead.statusCode, 200);
  const publicOrder = publicRead.json().order;
  assert.deepEqual(publicOrder.ficha, publicBefore.ficha);
  assert.equal(publicOrder.legacySizePricing, undefined);
  assert.equal(publicOrder.ficha.sizePricing, undefined);
  assert.equal(publicOrder.pricing.totalCents, 50000);
  assert.equal(publicOrder.status, 'confirmado');
});

test('T26 divergent batch and forged coverage or server state are refused without a write', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const initialized = await h.api.inject(h.request({ action: 'initialize' }));
  assert.equal(initialized.statusCode, 200);
  const source = initialized.json();
  const before = await h.repository.findById(h.legacy.id);
  const divergent = await h.api.inject(
    h.request(batch(source, [18000, 31999]), source.orderVersion),
  );
  assert.equal(divergent.statusCode, 422);
  assert.equal(divergent.json().error.code, 'SIZE_PRICING_AMOUNT_MISMATCH');
  const valid = batch(source);
  for (const value of [
    { ...valid, lines: valid.lines.slice(1) },
    { ...valid, lines: [valid.lines[0], valid.lines[0]] },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], subtotalReviewed: true }],
    },
    { ...valid, legacySizePricing: source.groups },
    { ...valid, totalCents: 50000 },
  ]) {
    const refused = await h.api.inject(h.request(value, source.orderVersion));
    assert.equal(refused.statusCode, 422);
    assert.equal(refused.json().error.code, 'ORDER_SOURCE_INVALID');
    assert.deepEqual(await h.repository.findById(h.legacy.id), before);
    assert.equal((await h.runtime.priceBreakdown(h.legacy.id)).revision, 1);
  }
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    1,
  );
});

test('T26 source commands reject non-owner and automation actors and recheck ownership before replay', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  h.state.actor = { ...OTHER };
  assert.equal(
    (await h.api.inject(h.request({ action: 'initialize' }))).statusCode,
    403,
  );
  h.state.actor = { ...OWNER, kind: 'automation' };
  assert.equal(
    (await h.api.inject(h.request({ action: 'initialize' }))).statusCode,
    403,
  );
  h.state.actor = { ...OWNER };
  const request = h.request({ action: 'initialize' });
  const saved = await h.api.inject(request);
  assert.equal(saved.statusCode, 200);
  h.state.assignedUserId = OTHER.id;
  assert.equal((await h.api.inject(request)).statusCode, 403);
  assert.equal((await h.runtime.priceBreakdown(h.legacy.id)).revision, 1);
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    1,
  );
});

test('T26 HTTP body/version guards reject malformed requests before mutation', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  for (const payload of [
    {
      expectedVersion: h.legacy.version,
      value: { action: 'initialize' },
      legacySizePricing: [],
    },
    {
      expectedVersion: h.legacy.version,
      value: { action: 'initialize' },
      totalCents: 50000,
    },
    { expectedVersion: h.legacy.version },
    { value: { action: 'initialize' } },
    { expectedVersion: '2', value: { action: 'initialize' } },
    { expectedVersion: 0, value: { action: 'initialize' } },
    { expectedVersion: null, value: { action: 'initialize' } },
  ]) {
    const refused = await h.api.inject({
      ...h.request({ action: 'initialize' }),
      payload,
    });
    assert.equal(refused.statusCode, 400);
    assert.equal(
      (await h.repository.findById(h.legacy.id))?.version,
      h.legacy.version,
    );
  }
  assert.equal((await h.runtime.priceBreakdown(h.legacy.id)).revision, 0);
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    0,
  );
});
