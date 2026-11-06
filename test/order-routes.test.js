import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { syntheticItems } from './fixtures/order-items.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';

const synthetic = JSON.parse(
  await readFile(
    new URL('../docs/phase0/ficha-pdf-synthetic.json', import.meta.url),
    'utf8',
  ),
);

const SELLER = Object.freeze({
  capabilities: [],
  functionName: 'Vendedor',
  id: 'seller-1',
  kind: 'human',
});
const OTHER = Object.freeze({ ...SELLER, id: 'seller-2' });

const readHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic',
  origin: 'https://crm.example.test',
  'x-request-id': '30000000-0000-4000-8000-000000000001',
});

const ORDER_KEYS = [
  'confirmedAt',
  'confirmedBy',
  'conversationId',
  'createdAt',
  'deliveredOn',
  'fabCode',
  'ficha',
  'fichaFirstPrintedAt',
  'fichaFirstPrintedBy',
  'finalAmountCents',
  'firstContactAt',
  'gatewayPayment',
  'id',
  'isTest',
  'lastMessage',
  'leadTimeBusinessDays',
  'locked',
  'missingFields',
  'number',
  'orderDate',
  'origin',
  'paidOn',
  'paymentCondition',
  'paymentReviewRequired',
  'reopenedAt',
  'reopenedBy',
  'seller',
  'status',
  'storeNumber',
  'totalPieces',
  'updatedAt',
  'version',
];

/** @param {{readActor?: any, writeActor?: any, pdfRenderer?: (html: string) => Promise<Buffer>}} [options] */
function orderHarness(options = {}) {
  /** @type {Record<string, string|null>} */
  const assignments = {
    'conversation-1': 'seller-1',
    'conversation-2': 'seller-1',
    // Painel: more of the same seller's conversations for the delivery views.
    'conversation-3': 'seller-1',
    'conversation-4': 'seller-1',
    'conversation-5': 'seller-1',
    'conversation-6': 'seller-1',
    'conversation-empty': null,
  };
  /** @type {Record<string, string|null>} */
  const names = { 'seller-1': 'Vendedora Um', 'seller-2': 'Vendedor Dois' };
  // ADR 018: the contact's confirmed name; a test renames it here.
  /** @type {Record<string, string|null>} */
  const contactNames = {};
  /** @type {Map<string, {direction: string, occurredAt: string, sentAt: string|null, deliveryStatus: string|null, status: string}>} */
  const latestMessageStates = new Map();
  /** @type {Array<{method: string, input: any}>} */
  const guards = [];
  let clock = Date.parse('2026-09-12T15:00:00.000Z');
  let sequence = 0;
  const repository = new InMemoryOrderRepository();
  const runtime = createOrderRuntime({
    access: {
      authorizeRead: async (input) => {
        guards.push({ input, method: 'authorizeRead' });
        if (options.readActor === null) {
          throw Object.assign(new Error('forbidden'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }
        return { actor: options.readActor ?? OTHER };
      },
      authorizeWrite: async (input) => {
        guards.push({ input, method: 'authorizeWrite' });
        return { actor: options.writeActor ?? SELLER };
      },
    },
    auditTrail: { append: async () => undefined },
    clock: () => {
      clock += 60_000;
      return new Date(clock);
    },
    conversations: {
      readAssignment: async (/** @type {string} */ id) =>
        id in assignments
          ? { assignedUserId: assignments[id], version: 4 }
          : null,
      readAssignments: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, assignments[id] ?? null])),
      readLatestMessageStates: async (/** @type {string[]} */ ids) =>
        new Map([...latestMessageStates].filter(([id]) => ids.includes(id))),
      readOrderContexts: orderContextsFrom((/** @type {string} */ id) =>
        id in assignments
          ? {
              briefing: { order_name: 'Equipe Sintetica' },
              customerName: contactNames[id] ?? 'Cliente Sintetico',
              openedAt: '2026-09-01T13:05:00.000Z',
            }
          : null,
      ),
      readContactNames: async (/** @type {string[]} */ ids) =>
        new Map(
          ids
            .filter((id) => id === 'contact-1')
            .map((id) => [id, 'Cliente Manual']),
        ),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, names[id] ?? null])),
      searchConversationIds: async (/** @type {string} */ query) =>
        query === 'sintetico' ? ['conversation-2'] : [],
      listAssignedOrderConversationIds: async (/** @type {string} */ id) =>
        Object.keys(assignments).filter((key) => assignments[key] === id),
      searchContactIds: async (/** @type {string} */ query) =>
        query === 'manual' ? ['contact-1'] : [],
    },
    fabCode: '01',
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    idFactory: () => {
      sequence += 1;
      return `order-${sequence}`;
    },
    repository,
  });
  const api = createApi(
    {},
    { orders: runtime, orderPdfRenderer: options.pdfRenderer },
  );
  return {
    api,
    assignments,
    contactNames,
    guards,
    latestMessageStates,
    names,
    repository,
    runtime,
  };
}

let seedSequence = 0;
/** @param {Record<string, unknown>} input @returns {any} */
function seed(input) {
  seedSequence += 1;
  return {
    actor: SELLER,
    correlationId: 'correlation-seed',
    idempotencyKey: `seed-${seedSequence}`,
    ...input,
  };
}

// ADR 020: who makes the art, marked before generating.
const ART_FROM_CUSTOMER = Object.freeze({
  feito_pela_silmer: false,
  feito_pelo_cliente: true,
});

// ADR 016: the promised delivery a seller sets before generating.
const PROMISED_SUMMARY = Object.freeze({
  aplicacao: null,
  data_entrega_confirmada: '2026-10-24',
  nome: 'Equipe Sintetica',
});

/** @param {any} runtime @param {string} conversationId */
async function createPending(runtime, conversationId) {
  const { order } = await runtime.createManual(
    seed({ conversationId, expectedVersion: 4 }),
  );
  return order;
}

/**
 * @param {any} runtime @param {string|null} conversationId
 * @param {Record<string, unknown>} [summary] saved before the items
 */
async function createConfirmed(runtime, conversationId, summary) {
  let order =
    conversationId === null
      ? await runtime.createForContact(seed({ contactId: 'contact-1' }))
      : await createPending(runtime, conversationId);
  order = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'summary',
      value: summary ?? PROMISED_SUMMARY,
    }),
  );
  const withItems = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  const edited = await runtime.patchSection(
    seed({
      expectedVersion: withItems.version,
      orderId: withItems.id,
      section: 'artwork',
      value: ART_FROM_CUSTOMER,
    }),
  );
  return runtime.confirm(
    seed({
      amountText: '4.820,00',
      expectedVersion: edited.version,
      orderId: edited.id,
      paymentCondition: 'pix',
    }),
  );
}

test('summary aggregates all confirmed orders and requires a read session', async () => {
  const { api, runtime } = orderHarness();
  await createConfirmed(runtime, 'conversation-1');
  await createPending(runtime, 'conversation-2');
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/summary',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    confirmedCount: 1,
    soldAmountCents: 482000,
    averageTicketCents: 482000,
    pendingCount: 1,
    totalPiecesSold: 32,
    // ADR 031: no site shop order waits for its first print.
    storeNewCount: 0,
    storeNewOldestPaidAt: null,
    // Painel: the period defaults to today, on the São Paulo day.
    period: {
      confirmedCount: 1,
      from: '2026-09-12',
      key: 'hoje',
      soldAmountCents: 482000,
      timeZone: 'America/Sao_Paulo',
      to: '2026-09-12',
    },
    // PNL-05: the last seven São Paulo days, oldest first, empty days at 0.
    daily: [
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]
      .map((day) => ({ confirmedCount: 0, day, soldAmountCents: 0 }))
      .concat({
        confirmedCount: 1,
        day: '2026-09-12',
        soldAmountCents: 482000,
      }),
    deliveries: {
      dueSoonCount: 0,
      dueSoonUntil: '2026-09-18',
      oldestOverdueOn: null,
      overdueCount: 0,
    },
    today: '2026-09-12',
  });
  const denied = orderHarness({ readActor: null });
  const blocked = await denied.api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/summary',
  });
  assert.equal(blocked.statusCode, 403);
});

test('Painel: the summary reads a period and the server works out overdue and upcoming deliveries', async () => {
  const { api, runtime } = orderHarness();
  // The harness clock reads 12/09/2026 in São Paulo.
  const late = await createConfirmed(runtime, 'conversation-1', {
    ...PROMISED_SUMMARY,
    data_entrega_confirmada: '2026-09-10',
  });
  const later = await createConfirmed(runtime, 'conversation-2', {
    ...PROMISED_SUMMARY,
    data_entrega_confirmada: '2026-09-11',
  });
  const soon = await createConfirmed(runtime, 'conversation-3', {
    ...PROMISED_SUMMARY,
    data_entrega_confirmada: '2026-09-18',
  });
  await createConfirmed(runtime, 'conversation-4', {
    ...PROMISED_SUMMARY,
    data_entrega_confirmada: '2026-09-19',
  });
  // A promised day already delivered is no longer late.
  const delivered = await createConfirmed(runtime, 'conversation-5', {
    ...PROMISED_SUMMARY,
    data_entrega_confirmada: '2026-09-01',
  });
  await runtime.recordMilestones({
    ...seed({}),
    deliveredOn: '2026-09-02',
    expectedVersion: delivered.version,
    orderId: delivered.id,
    paidOn: null,
  });
  await createPending(runtime, 'conversation-6');

  const summary = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/summary?period=mes',
  });
  assert.equal(summary.statusCode, 200);
  const body = summary.json();
  assert.deepEqual(body.deliveries, {
    dueSoonCount: 1,
    dueSoonUntil: '2026-09-18',
    oldestOverdueOn: '2026-09-10',
    overdueCount: 2,
  });
  assert.equal(body.period.key, 'mes');
  assert.equal(body.period.from, '2026-09-01');
  assert.equal(body.period.to, '2026-09-12');
  assert.equal(body.period.confirmedCount, 5);
  assert.equal(body.period.soldAmountCents, 5 * 482000);

  const overdue = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?delivery=overdue',
  });
  assert.equal(overdue.statusCode, 200);
  assert.deepEqual(
    overdue.json().items.map((/** @type {any} */ order) => order.id),
    [late.id, later.id],
  );
  assert.deepEqual(overdue.json().counts, { confirmado: 2, pendente: 0 });
  assert.equal(overdue.json().nextCursor, null);
  const upcoming = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?delivery=due_soon',
  });
  assert.deepEqual(
    upcoming.json().items.map((/** @type {any} */ order) => order.id),
    [soon.id],
  );

  for (const url of [
    '/api/v1/orders/summary?period=ano',
    '/api/v1/orders/summary?from=2026-01-01',
    '/api/v1/orders?delivery=late',
    '/api/v1/orders?delivery=overdue&status=pendente',
  ]) {
    const rejected = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url,
    });
    assert.equal(rejected.statusCode, 400, url);
  }
});

test('Painel: owner=me lists only the session seller orders', async () => {
  const { api, assignments, runtime } = orderHarness({ readActor: SELLER });
  const mine = await createPending(runtime, 'conversation-1');
  await createPending(runtime, 'conversation-3');
  // The conversation went to another seller: so did its order.
  assignments['conversation-3'] = 'seller-2';
  const listed = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?status=pendente&owner=me',
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json().items.map((/** @type {any} */ order) => order.id),
    [mine.id],
  );
  assert.deepEqual(listed.json().counts, { confirmado: 0, pendente: 1 });
  // The owner is always the session's: no id travels in the URL.
  for (const url of [
    '/api/v1/orders?owner=seller-2',
    '/api/v1/orders?ownerId=seller-2',
    '/api/v1/orders?owner=me&delivery=overdue',
  ]) {
    const rejected = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url,
    });
    assert.equal(rejected.statusCode, 400, url);
  }
});

test('orders expose last-message delivery state without message content', async () => {
  const { api, latestMessageStates, runtime } = orderHarness();
  const order = await createPending(runtime, 'conversation-1');
  latestMessageStates.set('conversation-1', {
    direction: 'outbound',
    occurredAt: '2026-10-03T12:00:00.000Z',
    sentAt: null,
    deliveryStatus: 'failed',
    status: 'sent',
  });
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${order.id}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().order.lastMessage, {
    direction: 'outbound',
    occurredAt: '2026-10-03T12:00:00.000Z',
    sentAt: null,
    deliveryStatus: 'failed',
    status: 'sent',
  });
});

test('who makes the art: two origins together or "Sem estampa", never file metadata (ADR 020)', async () => {
  const { api, runtime } = orderHarness();
  const order = await createPending(runtime, 'conversation-1');
  const accepted = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: order.version,
      value: { feito_pelo_cliente: true, feito_pela_silmer: true },
    },
    url: `/api/v1/orders/${order.id}/sections/artwork`,
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json().order.ficha.artwork, {
    feito_pelo_cliente: true,
    feito_pela_silmer: true,
    files: [],
    sem_estampa: false,
  });
  assert.equal(
    accepted.json().order.missingFields.includes('artwork'),
    false,
    'a marked origin no longer blocks',
  );
  const mixed = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'reject-mixed-artwork' },
    method: 'PATCH',
    payload: {
      expectedVersion: accepted.json().order.version,
      value: {
        feito_pelo_cliente: true,
        feito_pela_silmer: false,
        sem_estampa: true,
      },
    },
    url: `/api/v1/orders/${order.id}/sections/artwork`,
  });
  assert.equal(mixed.statusCode, 400);
  const refused = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'reject-artwork-files' },
    method: 'PATCH',
    payload: {
      expectedVersion: accepted.json().order.version,
      value: {
        feito_pelo_cliente: true,
        feito_pela_silmer: false,
        files: [{ name: 'arte.cdr' }],
      },
    },
    url: `/api/v1/orders/${order.id}/sections/artwork`,
  });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.json(), { error: { code: 'ORDER_INVALID' } });

  const other = orderHarness({ writeActor: OTHER });
  const otherOrder = await createPending(other.runtime, 'conversation-1');
  const forbidden = await other.api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: otherOrder.version,
      value: { feito_pelo_cliente: true, feito_pela_silmer: false },
    },
    url: `/api/v1/orders/${otherOrder.id}/sections/artwork`,
  });
  assert.equal(forbidden.statusCode, 403);
});

const writeHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic; crm_csrf=csrf-synthetic',
  'content-type': 'application/json',
  'idempotency-key': 'order-command-1',
  origin: 'https://crm.example.test',
  'x-correlation-id': '30000000-0000-4000-8000-000000000002',
  'x-csrf-token': 'csrf-synthetic',
  'x-request-id': '30000000-0000-4000-8000-000000000003',
});

test('GET /orders/:orderId returns the Order contract with named actors', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');

  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  const { order } = response.json();
  assert.deepEqual(Object.keys(response.json()), ['order']);
  assert.deepEqual(Object.keys(order).sort(), ORDER_KEYS);
  assert.equal(order.number, '01-CRM');
  assert.equal(order.status, 'confirmado');
  assert.equal(order.finalAmountCents, 482000);
  assert.equal(order.totalPieces, 32);
  assert.deepEqual(order.confirmedBy, { id: 'seller-1', name: 'Vendedora Um' });
  assert.deepEqual(order.seller, { id: 'seller-1', name: 'Vendedora Um' });
  assert.equal(order.reopenedBy, null);
  assert.equal(order.ficha.summary.cliente, 'Cliente Sintetico');
  // PLA-02: the first contact is the day the conversation opened.
  assert.equal(order.firstContactAt, '2026-09-01T13:05:00.000Z');
  assert.equal(order.paidOn, null);
  assert.equal(order.deliveredOn, null);
  assert.deepEqual(
    guards.map((guard) => [guard.method, guard.input.action]),
    [['authorizeRead', 'order.read']],
  );
});

test('GET /orders/:orderId answers 404 ORDER_NOT_FOUND', async (t) => {
  const { api } = orderHarness();
  t.after(() => api.close());
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/order-missing',
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: 'ORDER_NOT_FOUND' } });
});

test('GET /orders filters by status, searches and pages with counts', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  await createConfirmed(runtime, 'conversation-1');
  await createPending(runtime, 'conversation-2');

  const all = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?limit=1',
  });
  assert.equal(all.statusCode, 200);
  const firstPage = all.json();
  assert.deepEqual(Object.keys(firstPage).sort(), [
    'counts',
    'items',
    'nextCursor',
  ]);
  assert.deepEqual(firstPage.counts, { confirmado: 1, pendente: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.deepEqual(Object.keys(firstPage.items[0]).sort(), ORDER_KEYS);
  assert.ok(firstPage.nextCursor);

  const next = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
  });
  assert.equal(next.json().items.length, 1);
  assert.notEqual(next.json().items[0].id, firstPage.items[0].id);
  assert.equal(next.json().nextCursor, null);

  const pending = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?status=pendente',
  });
  assert.deepEqual(
    pending.json().items.map((/** @type {any} */ order) => order.status),
    ['pendente'],
  );

  const searched = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?q=sintetico',
  });
  assert.deepEqual(
    searched
      .json()
      .items.map((/** @type {any} */ order) => order.conversationId),
    ['conversation-2'],
  );
  const byNumber = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?q=01-CRM',
  });
  assert.deepEqual(
    byNumber.json().items.map((/** @type {any} */ order) => order.number),
    ['01-CRM'],
  );
});

test('GET /orders refuses unknown or malformed parameters with 400', async (t) => {
  const { api, guards } = orderHarness();
  t.after(() => api.close());
  for (const query of [
    'unknown=1',
    'status=cancelado',
    'limit=0',
    'limit=101',
    'limit=abc',
    'q=',
    'cursor=not-a-cursor',
  ]) {
    const response = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url: `/api/v1/orders?${query}`,
    });
    assert.equal(response.statusCode, 400, query);
    assert.equal(typeof response.json().error.code, 'string');
  }
  // Only the opaque cursor needs the service; every other shape error is
  // refused before the session is read.
  assert.equal(guards.length, 1);
});

test('phone search stays in a protected POST body, never in an order URL', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  await createPending(runtime, 'conversation-2');
  const phone = '5527999991234';
  const inUrl = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders?q=${phone}`,
  });
  assert.equal(inUrl.statusCode, 400);
  const searched = await api.inject({
    headers: { ...readHeaders, 'x-csrf-token': 'csrf-synthetic' },
    method: 'POST',
    url: '/api/v1/orders/search',
    payload: { q: phone, limit: 25 },
  });
  assert.equal(searched.statusCode, 200);
  assert.match(String(searched.headers['cache-control']), /private, no-cache/u);
  const searchGuard = guards.at(-1);
  assert.ok(searchGuard);
  assert.equal(searchGuard.method, 'authorizeWrite');
  assert.equal(searchGuard.input.action, 'order.read');
  assert.equal(searchGuard.input.csrfToken, 'csrf-synthetic');
});

test('GET /conversations/:conversationId/order returns the current order or null', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');

  const current = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/conversations/conversation-1/order',
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().order.id, confirmed.id);

  const empty = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/conversations/conversation-empty/order',
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { order: null });

  const missing = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/conversations/conversation-missing/order',
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), {
    error: { code: 'CONVERSATION_NOT_FOUND' },
  });
});

test('order reads refuse a request the session guard rejects', async (t) => {
  const { api } = orderHarness({ readActor: null });
  t.after(() => api.close());
  for (const url of [
    '/api/v1/orders',
    '/api/v1/orders/order-1',
    '/api/v1/conversations/conversation-1/order',
  ]) {
    const response = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url,
    });
    assert.equal(response.statusCode, 403, url);
    assert.deepEqual(response.json(), { error: { code: 'FORBIDDEN' } });
  }
});

test('a seller without a name and an unassigned conversation still fit the contract', async (t) => {
  const { api, assignments, names, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  names['seller-1'] = null;
  assignments['conversation-1'] = null;
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}`,
  });
  const { order } = response.json();
  assert.deepEqual(order.confirmedBy, { id: 'seller-1', name: '' });
  assert.equal(order.seller, null);
});

test('POST /conversations/:id/orders creates 201, then answers 200 with the pending order', async (t) => {
  const { api, guards } = orderHarness();
  t.after(() => api.close());
  const created = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: { expectedVersion: 4 },
    url: '/api/v1/conversations/conversation-1/orders',
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(Object.keys(created.json()), ['order']);
  const { order } = created.json();
  assert.deepEqual(Object.keys(order).sort(), ORDER_KEYS);
  assert.equal(order.status, 'pendente');
  assert.equal(order.ficha.summary.cliente, 'Cliente Sintetico');
  assert.equal(guards.at(-1)?.input.action, 'order.create');
  assert.equal(guards.at(-1)?.input.csrfToken, 'csrf-synthetic');

  const again = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'order-command-2' },
    method: 'POST',
    payload: { expectedVersion: 4 },
    url: '/api/v1/conversations/conversation-1/orders',
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().order.id, order.id);
});

test('POST /orders creates an editable manual draft for a selected contact', async (t) => {
  const { api } = orderHarness();
  t.after(() => api.close());
  const created = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'manual-order-1' },
    method: 'POST',
    payload: { contactId: 'contact-1' },
    url: '/api/v1/orders',
  });
  assert.equal(created.statusCode, 201);
  const order = created.json().order;
  assert.equal(order.conversationId, null);
  assert.equal(order.ficha.summary.cliente, 'Cliente Manual');
  assert.equal(order.seller.id, 'seller-1');
  const replay = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'manual-order-1' },
    method: 'POST',
    payload: { contactId: 'contact-1' },
    url: '/api/v1/orders',
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().order.id, order.id);
});

test('order writes require an Idempotency-Key and expectedVersion before the session', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const withoutKey = { ...writeHeaders };
  Reflect.deleteProperty(withoutKey, 'idempotency-key');
  const createUrl = '/api/v1/conversations/conversation-1/orders';
  const sectionUrl = `/api/v1/orders/${pending.id}/sections/observations`;
  const cases =
    /** @type {Array<[any, any, 'POST'|'PATCH', string, string]>} */ ([
      [
        withoutKey,
        { expectedVersion: 4 },
        'POST',
        createUrl,
        'INVALID_IDEMPOTENCY_KEY',
      ],
      [writeHeaders, {}, 'POST', createUrl, 'INVALID_EXPECTED_VERSION'],
      [
        writeHeaders,
        { expectedVersion: 4, extra: true },
        'POST',
        createUrl,
        'INVALID_REQUEST',
      ],
      [
        withoutKey,
        { expectedVersion: pending.version, value: [] },
        'PATCH',
        sectionUrl,
        'INVALID_IDEMPOTENCY_KEY',
      ],
      [
        writeHeaders,
        { value: [] },
        'PATCH',
        sectionUrl,
        'INVALID_EXPECTED_VERSION',
      ],
      [
        writeHeaders,
        { expectedVersion: 0, value: [] },
        'PATCH',
        sectionUrl,
        'INVALID_EXPECTED_VERSION',
      ],
      [
        writeHeaders,
        { expectedVersion: pending.version },
        'PATCH',
        sectionUrl,
        'INVALID_REQUEST',
      ],
      [
        writeHeaders,
        { expectedVersion: pending.version, value: [] },
        'PATCH',
        `/api/v1/orders/${pending.id}/sections/pagamento`,
        'INVALID_SECTION',
      ],
    ]);
  for (const [headers, payload, method, url, code] of cases) {
    guards.length = 0;
    const response = await api.inject({ headers, method, payload, url });
    assert.equal(
      response.statusCode,
      400,
      `${method} ${url} ${JSON.stringify(payload)}`,
    );
    assert.deepEqual(response.json(), { error: { code } });
    assert.deepEqual(guards, []);
  }
});

test('PATCH /orders/:id/sections/:section saves the whole section', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const response = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: pending.version,
      value: syntheticItems(),
    },
    url: `/api/v1/orders/${pending.id}/sections/items`,
  });
  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.equal(order.version, pending.version + 1);
  assert.equal(order.totalPieces, 32);
  assert.deepEqual(order.missingFields, [
    'artwork',
    'summary.data_entrega_confirmada',
    'finalAmount',
    'paymentCondition',
  ]);
  assert.equal(guards.at(-1)?.input.action, 'order.edit');
});

test('PATCH items takes a half-filled item, and one without the ADR 016 fields', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const [first] = synthetic.pedido.itens;
  const response = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: pending.version,
      // A screen from before ADR 016 sends no colour, artwork or collar.
      value: [{ ...first, grade: [], malhas: [] }],
    },
    url: `/api/v1/orders/${pending.id}/sections/items`,
  });
  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.equal(order.ficha.items[0].cor, '');
  assert.equal(order.ficha.items[0].estampa, '');
  assert.equal(order.ficha.items[0].gola, 'OLIMPICA - VERDE');
  assert.equal(order.totalPieces, 0);
  assert.deepEqual(order.missingFields, [
    'items[0].cor',
    'items[0].tipo_servico',
    'items[0].malhas',
    'items[0].grade',
    'artwork',
    'summary.data_entrega_confirmada',
    'finalAmount',
    'paymentCondition',
  ]);

  const blocked = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'confirm-partial' },
    method: 'POST',
    payload: {
      amountText: '100,00',
      expectedVersion: order.version,
      paymentCondition: 'pix',
    },
    url: `/api/v1/orders/${order.id}/confirm`,
  });
  assert.equal(blocked.statusCode, 422);
  assert.deepEqual(blocked.json(), {
    error: {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: [
        'items[0].cor',
        'items[0].tipo_servico',
        'items[0].malhas',
        'items[0].grade',
        'artwork',
        'summary.data_entrega_confirmada',
      ],
    },
  });
});

test('PATCH items keeps the audience and the quantity said, and refuses another audience (ADR 025)', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const [first] = synthetic.pedido.itens;
  const response = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: pending.version,
      value: [
        { ...first, publico: 'masculino', quantidade_informada: 4 },
        { ...first, publico: 'infantil', quantidade_informada: 3 },
      ],
    },
    url: `/api/v1/orders/${pending.id}/sections/items`,
  });
  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.deepEqual(
    order.ficha.items.map((/** @type {any} */ item) => [
      item.publico,
      item.quantidade_informada,
    ]),
    [
      ['masculino', 4],
      ['infantil', 3],
    ],
  );
  assert.equal(
    order.missingFields.some((/** @type {string} */ field) =>
      field.includes('publico'),
    ),
    false,
    'the audience never blocks the order',
  );

  const refused = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'items-bad-audience' },
    method: 'PATCH',
    payload: {
      expectedVersion: order.version,
      value: [{ ...first, publico: 'baby look' }],
    },
    url: `/api/v1/orders/${pending.id}/sections/items`,
  });
  assert.equal(refused.statusCode, 400);
  assert.doesNotMatch(refused.body, /baby look/u);
});

test('section writes answer 403 outside ownership, 409 on a stale version and 422 with fields', async (t) => {
  const { api, runtime } = orderHarness({ writeActor: OTHER });
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');

  const forbidden = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: { expectedVersion: pending.version, value: [] },
    url: `/api/v1/orders/${pending.id}/sections/observations`,
  });
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(forbidden.json(), { error: { code: 'FORBIDDEN' } });

  const createForbidden = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: { expectedVersion: 4 },
    url: '/api/v1/conversations/conversation-2/orders',
  });
  assert.equal(createForbidden.statusCode, 403);

  const owner = orderHarness();
  t.after(() => owner.api.close());
  const mine = await createPending(owner.runtime, 'conversation-1');
  const stale = await owner.api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: { expectedVersion: mine.version + 3, value: [] },
    url: `/api/v1/orders/${mine.id}/sections/observations`,
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: { code: 'VERSION_CONFLICT' } });

  const staleConversation = await owner.api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'stale-conversation' },
    method: 'POST',
    payload: { expectedVersion: 3 },
    url: '/api/v1/conversations/conversation-2/orders',
  });
  assert.equal(staleConversation.statusCode, 409);
  assert.deepEqual(staleConversation.json(), {
    error: { code: 'VERSION_CONFLICT' },
  });

  const items = syntheticItems();
  items[0].grade[1].quantidade = 0;
  const invalid = await owner.api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'invalid-grade' },
    method: 'PATCH',
    payload: { expectedVersion: mine.version, value: items },
    url: `/api/v1/orders/${mine.id}/sections/items`,
  });
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual(invalid.json(), {
    error: { code: 'INVALID_GRADE', fields: ['items[0].grade[1]'], index: 1 },
  });

  const missing = await owner.api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'missing-order' },
    method: 'PATCH',
    payload: { expectedVersion: 1, value: [] },
    url: '/api/v1/orders/order-missing/sections/observations',
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: { code: 'ORDER_NOT_FOUND' } });
});

test('a retried write with the same key replays; another body under that key is 409', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const request = {
    headers: { ...writeHeaders, 'idempotency-key': 'retry-key' },
    method: /** @type {const} */ ('PATCH'),
    payload: { expectedVersion: pending.version, value: ['Linha 1'] },
    url: `/api/v1/orders/${pending.id}/sections/observations`,
  };
  const first = await api.inject(request);
  const replay = await api.inject(request);
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(
    (await runtime.get(pending.id)).order.version,
    pending.version + 1,
  );

  const reused = await api.inject({
    ...request,
    payload: { expectedVersion: pending.version, value: ['Outra'] },
  });
  assert.equal(reused.statusCode, 409);
  assert.deepEqual(reused.json(), {
    error: { code: 'IDEMPOTENCY_KEY_REUSED' },
  });
});

test('a malformed section answers 400 without echoing its content', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const summary = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      expectedVersion: pending.version,
      value: { nome: 'PII-canary' },
    },
    url: `/api/v1/orders/${pending.id}/sections/summary`,
  });
  assert.equal(summary.statusCode, 400);
  assert.deepEqual(summary.json(), { error: { code: 'ORDER_INVALID' } });
  assert.equal(summary.body.includes('PII-canary'), false);
});

/** @param {any} runtime @param {string} conversationId */
async function createReady(runtime, conversationId) {
  const created = await createPending(runtime, conversationId);
  const order = await runtime.patchSection(
    seed({
      expectedVersion: created.version,
      orderId: created.id,
      section: 'summary',
      value: PROMISED_SUMMARY,
    }),
  );
  const withItems = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  return runtime.patchSection(
    seed({
      expectedVersion: withItems.version,
      orderId: withItems.id,
      section: 'artwork',
      value: ART_FROM_CUSTOMER,
    }),
  );
}

test('POST /orders/:id/confirm confirms with amount and condition', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const ready = await createReady(runtime, 'conversation-1');
  const response = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: {
      amountText: '4.820,00',
      expectedVersion: ready.version,
      paymentCondition: 'cartao_credito',
    },
    url: `/api/v1/orders/${ready.id}/confirm`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()), ['order']);
  const { order } = response.json();
  assert.deepEqual(Object.keys(order).sort(), ORDER_KEYS);
  assert.equal(order.status, 'confirmado');
  assert.equal(order.finalAmountCents, 482000);
  assert.equal(order.paymentCondition, 'cartao_credito');
  assert.deepEqual(order.confirmedBy, { id: 'seller-1', name: 'Vendedora Um' });
  assert.match(order.orderDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(guards.at(-1)?.input.action, 'order.confirm');
});

test('confirming without what ADR 016 requires answers 422 ORDER_NOT_CONFIRMABLE with fields', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  const blocked = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: { expectedVersion: pending.version },
    url: `/api/v1/orders/${pending.id}/confirm`,
  });
  assert.equal(blocked.statusCode, 422);
  assert.deepEqual(blocked.json(), {
    error: {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: [
        'items',
        'artwork',
        'summary.data_entrega_confirmada',
        'finalAmount',
        'paymentCondition',
      ],
    },
  });

  const malformed = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'malformed-amount' },
    method: 'POST',
    payload: {
      amountText: '4,820.00',
      expectedVersion: pending.version,
      paymentCondition: 'pix',
    },
    url: `/api/v1/orders/${pending.id}/confirm`,
  });
  assert.equal(malformed.statusCode, 422);
  assert.deepEqual(malformed.json(), {
    error: { code: 'INVALID_AMOUNT', fields: ['finalAmount'] },
  });
  assert.equal(
    (await runtime.get(pending.id)).order.status,
    'pendente',
    'a refused confirmation keeps the order pending',
  );
});

test('two confirmations on the same version: one 200, the other 409', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const ready = await createReady(runtime, 'conversation-1');
  const confirm = (/** @type {string} */ key) =>
    api.inject({
      headers: { ...writeHeaders, 'idempotency-key': key },
      method: 'POST',
      payload: {
        amountText: '100,00',
        expectedVersion: ready.version,
        paymentCondition: 'pix',
      },
      url: `/api/v1/orders/${ready.id}/confirm`,
    });
  const responses = await Promise.all([confirm('first'), confirm('second')]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const conflict = responses.find((response) => response.statusCode === 409);
  assert.deepEqual(conflict?.json(), { error: { code: 'VERSION_CONFLICT' } });
});

test('POST /orders/:id/reopen returns a confirmed order to pending', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const response = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: { expectedVersion: confirmed.version },
    url: `/api/v1/orders/${confirmed.id}/reopen`,
  });
  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.equal(order.status, 'pendente');
  assert.equal(order.number, confirmed.number);
  assert.equal(order.finalAmountCents, confirmed.finalAmountCents);
  assert.equal(order.paymentCondition, confirmed.paymentCondition);
  assert.deepEqual(order.reopenedBy, { id: 'seller-1', name: 'Vendedora Um' });
  assert.equal(guards.at(-1)?.input.action, 'order.reopen');

  const again = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'reopen-again' },
    method: 'POST',
    payload: { expectedVersion: order.version },
    url: `/api/v1/orders/${confirmed.id}/reopen`,
  });
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), { error: { code: 'ORDER_STATUS_CONFLICT' } });

  const reconfirmed = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'reconfirm' },
    method: 'POST',
    payload: {
      amountText: '5.000,00',
      expectedVersion: order.version,
      paymentCondition: 'pix',
    },
    url: `/api/v1/orders/${confirmed.id}/confirm`,
  });
  assert.equal(reconfirmed.statusCode, 200);
  assert.equal(reconfirmed.json().order.finalAmountCents, 500000);
  assert.notEqual(
    reconfirmed.json().order.confirmedAt,
    confirmed.confirmedAt,
    'PCL-12: a new confirmation records its own time',
  );
});

test('PATCH /orders/:id/milestones records paid and delivered days without reopening', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');

  const response = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      deliveredOn: null,
      expectedVersion: confirmed.version,
      paidOn: '2026-09-10',
    },
    url: `/api/v1/orders/${confirmed.id}/milestones`,
  });

  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.equal(order.paidOn, '2026-09-10');
  assert.equal(order.deliveredOn, null);
  assert.equal(order.version, confirmed.version + 1);
  // PLA-06: the trail never moves the status nor unlocks the ficha.
  assert.equal(order.status, 'confirmado');
  assert.equal(order.confirmedAt, confirmed.confirmedAt);
  assert.equal(order.orderDate, confirmed.orderDate);
  assert.equal(guards.at(-1)?.input.action, 'order.milestones');

  const delivered = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'milestones-delivered' },
    method: 'PATCH',
    payload: {
      deliveredOn: '2026-09-12',
      expectedVersion: order.version,
      paidOn: null,
    },
    url: `/api/v1/orders/${confirmed.id}/milestones`,
  });
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.json().order.deliveredOn, '2026-09-12');
  assert.equal(delivered.json().order.paidOn, null, 'null clears a day');

  const stale = await api.inject({
    headers: { ...writeHeaders, 'idempotency-key': 'milestones-stale' },
    method: 'PATCH',
    payload: {
      deliveredOn: null,
      expectedVersion: order.version,
      paidOn: null,
    },
    url: `/api/v1/orders/${confirmed.id}/milestones`,
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: { code: 'VERSION_CONFLICT' } });
});

test('PATCH /orders/:id/milestones refuses future or malformed days with 422', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');

  // The harness clock reads 12/09/2026 in São Paulo.
  const response = await api.inject({
    headers: writeHeaders,
    method: 'PATCH',
    payload: {
      deliveredOn: '2026-09-13',
      expectedVersion: pending.version,
      paidOn: '10/09/2026',
    },
    url: `/api/v1/orders/${pending.id}/milestones`,
  });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    error: { code: 'INVALID_DATE', fields: ['paidOn', 'deliveredOn'] },
  });

  const unchanged = await runtime.get(pending.id);
  assert.equal(unchanged.order.version, pending.version);
});

test('PATCH /orders/:id/milestones refuses non-owners and malformed requests', async (t) => {
  const { api, runtime } = orderHarness({ writeActor: OTHER });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const patch = (/** @type {Record<string, unknown>} */ payload) =>
    api.inject({
      headers: writeHeaders,
      method: 'PATCH',
      payload,
      url: `/api/v1/orders/${confirmed.id}/milestones`,
    });

  const forbidden = await patch({
    deliveredOn: null,
    expectedVersion: confirmed.version,
    paidOn: '2026-09-10',
  });
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(forbidden.json(), { error: { code: 'FORBIDDEN' } });

  for (const payload of [
    { expectedVersion: confirmed.version, paidOn: '2026-09-10' },
    { deliveredOn: 20260910, expectedVersion: confirmed.version, paidOn: null },
    {
      deliveredOn: null,
      expectedVersion: confirmed.version,
      paidOn: null,
      status: 'entregue',
    },
  ]) {
    const refused = await patch(payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(refused.json(), { error: { code: 'INVALID_REQUEST' } });
  }
});

test('confirm and reopen refuse non-owners and malformed requests', async (t) => {
  const { api, guards, runtime } = orderHarness({ writeActor: OTHER });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const pending = await createReady(runtime, 'conversation-2');
  for (const [url, payload] of /** @type {Array<[string, any]>} */ ([
    [
      `/api/v1/orders/${pending.id}/confirm`,
      {
        amountText: '10,00',
        expectedVersion: pending.version,
        paymentCondition: 'pix',
      },
    ],
    [
      `/api/v1/orders/${confirmed.id}/reopen`,
      { expectedVersion: confirmed.version },
    ],
  ])) {
    const response = await api.inject({
      headers: writeHeaders,
      method: 'POST',
      payload,
      url,
    });
    assert.equal(response.statusCode, 403, url);
    assert.deepEqual(response.json(), { error: { code: 'FORBIDDEN' } });
  }

  const withoutKey = { ...writeHeaders };
  Reflect.deleteProperty(withoutKey, 'idempotency-key');
  const cases = /** @type {Array<[any, string, any, string]>} */ ([
    [
      withoutKey,
      `/api/v1/orders/${pending.id}/confirm`,
      { expectedVersion: pending.version },
      'INVALID_IDEMPOTENCY_KEY',
    ],
    [
      writeHeaders,
      `/api/v1/orders/${pending.id}/confirm`,
      { amountText: '10,00', paymentCondition: 'pix' },
      'INVALID_EXPECTED_VERSION',
    ],
    [
      writeHeaders,
      `/api/v1/orders/${pending.id}/confirm`,
      { amountText: 10, expectedVersion: pending.version },
      'INVALID_REQUEST',
    ],
    [
      writeHeaders,
      `/api/v1/orders/${pending.id}/confirm`,
      { expectedVersion: pending.version, status: 'confirmado' },
      'INVALID_REQUEST',
    ],
    [
      withoutKey,
      `/api/v1/orders/${confirmed.id}/reopen`,
      { expectedVersion: confirmed.version },
      'INVALID_IDEMPOTENCY_KEY',
    ],
    [
      writeHeaders,
      `/api/v1/orders/${confirmed.id}/reopen`,
      { expectedVersion: confirmed.version, reason: 'x' },
      'INVALID_REQUEST',
    ],
  ]);
  for (const [headers, url, payload, code] of cases) {
    guards.length = 0;
    const response = await api.inject({
      headers,
      method: 'POST',
      payload,
      url,
    });
    assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
    assert.deepEqual(response.json(), { error: { code } });
    assert.deepEqual(guards, []);
  }
});

test('GET /orders/:orderId/print renders the confirmed order on the printed template', async (t) => {
  const { api, assignments, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  // The document names who confirmed, not who owns the conversation now.
  assignments['conversation-1'] = 'seller-2';
  guards.length = 0;

  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/print`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/html/u);
  assert.equal(response.headers['cache-control'], 'private, no-cache');
  const html = response.body;
  assert.deepEqual(
    guards.map((guard) => [guard.method, guard.input.action]),
    [['authorizeRead', 'order.print']],
  );
  assert.match(html, /FICHA DE PEDIDO/u);
  assert.match(html, /@page \{ size: A4 landscape/u);
  assert.match(html, /01-CRM/u);
  assert.match(html, /Cliente Sintetico/u);
  assert.match(html, /Equipe Sintetica/u);
  assert.match(html, /FAB 01/u);
  assert.match(html, /Vendedora Um/u);
  assert.doesNotMatch(html, /Vendedor Dois/u);
});

test('PIM-13: PDF download uses the approved ficha and the same print permission', async (t) => {
  /** @type {string[]} */
  const rendered = [];
  const { api, guards, runtime } = orderHarness({
    pdfRenderer: async (html) => {
      rendered.push(html);
      return Buffer.from('%PDF-1.7\nsynthetic PDF');
    },
  });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const pending = await createPending(runtime, 'conversation-2');
  guards.length = 0;

  const pdf = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/pdf`,
  });
  assert.equal(pdf.statusCode, 200);
  assert.match(String(pdf.headers['content-type']), /^application\/pdf/u);
  assert.equal(pdf.headers['cache-control'], 'private, no-store');
  assert.match(
    String(pdf.headers['content-disposition']),
    /pedido-01-CRM\.pdf/u,
  );
  assert.equal(pdf.rawPayload.toString(), '%PDF-1.7\nsynthetic PDF');
  assert.match(rendered[0], /FICHA DE PEDIDO/u);
  assert.deepEqual(
    guards.map(({ input }) => input.action),
    ['order.print'],
  );

  const head = await api.inject({
    headers: readHeaders,
    method: 'HEAD',
    url: `/api/v1/orders/${confirmed.id}/pdf`,
  });
  assert.equal(head.statusCode, 200);
  assert.equal(rendered.length, 1);

  const refused = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${pending.id}/pdf`,
  });
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json(), { error: { code: 'ORDER_NOT_CONFIRMED' } });
  assert.equal(rendered.length, 1);
});

test('PIM-13: denied PDF read never reaches the renderer', async (t) => {
  let calls = 0;
  const { api, runtime } = orderHarness({
    readActor: null,
    pdfRenderer: async () => {
      calls += 1;
      return Buffer.from('%PDF');
    },
  });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/pdf`,
  });
  assert.equal(response.statusCode, 403);
  assert.equal(calls, 0);
});

test('PIM-14: PDF generation is limited to ten requests per minute', async (t) => {
  let calls = 0;
  const { api, runtime } = orderHarness({
    pdfRenderer: async () => {
      calls += 1;
      return Buffer.from('%PDF-1.7\nsynthetic PDF');
    },
  });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const request = () =>
    api.inject({
      headers: readHeaders,
      method: 'GET',
      url: `/api/v1/orders/${confirmed.id}/pdf`,
    });
  for (let count = 0; count < 10; count += 1) {
    assert.equal((await request()).statusCode, 200);
  }
  assert.equal((await request()).statusCode, 429);
  assert.equal(calls, 10);
});

test('the client follows a renamed contact while pending and stays on the generated order and its paper (ADR 018)', async (t) => {
  const { api, contactNames, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  assert.equal(pending.ficha.summary.cliente, 'Cliente Sintetico');
  /** @param {string} url */
  const read = async (url) =>
    (await api.inject({ headers: readHeaders, method: 'GET', url })).json();
  const clients = async (/** @type {string} */ orderId) => {
    const detail = await read(`/api/v1/orders/${orderId}`);
    const list = await read('/api/v1/orders');
    const drawer = await read('/api/v1/conversations/conversation-1/order');
    return {
      detail: detail.order.ficha.summary.cliente,
      drawer: drawer.order.ficha.summary.cliente,
      list: list.items.map((/** @type {any} */ order) => [
        order.id,
        order.ficha.summary.cliente,
      ]),
      version: detail.order.version,
    };
  };

  // PCT-01: a rename reaches the pending order everywhere, as no change.
  contactNames['conversation-1'] = 'Cliente Renomeado';
  assert.deepEqual(await clients(pending.id), {
    detail: 'Cliente Renomeado',
    drawer: 'Cliente Renomeado',
    list: [[pending.id, 'Cliente Renomeado']],
    version: pending.version,
  });

  // PCT-02: generating keeps the name it showed, on screen and on paper.
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  assert.equal(confirmed.id, pending.id);
  assert.equal(confirmed.ficha.summary.cliente, 'Cliente Renomeado');
  contactNames['conversation-1'] = 'Outro Nome Sintetico';
  assert.deepEqual(await clients(confirmed.id), {
    detail: 'Cliente Renomeado',
    drawer: 'Cliente Renomeado',
    list: [[confirmed.id, 'Cliente Renomeado']],
    version: confirmed.version,
  });
  const printed = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/print`,
  });
  assert.equal(printed.statusCode, 200);
  assert.match(printed.body, /Cliente Renomeado/u);
  assert.doesNotMatch(printed.body, /Outro Nome Sintetico/u);

  // PCT-03: reopened, it follows the contact again.
  const reopened = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    payload: { expectedVersion: confirmed.version },
    url: `/api/v1/orders/${confirmed.id}/reopen`,
  });
  assert.equal(reopened.statusCode, 200);
  assert.equal(
    reopened.json().order.ficha.summary.cliente,
    'Outro Nome Sintetico',
  );
  assert.equal((await clients(confirmed.id)).drawer, 'Outro Nome Sintetico');
});

test('the printed order hides money, the sample band and empty fields', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');

  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/print`,
  });
  const html = response.body;

  // PIM-02: no final amount and no payment condition on the document.
  assert.equal(confirmed.finalAmountCents, 482000);
  assert.equal(confirmed.paymentCondition, 'pix');
  assert.doesNotMatch(html, /4\.820,00|482000|R\$/u);
  assert.doesNotMatch(html, /pix|cartao_credito|cartao_debito/iu);
  // PIM-04: the sample band belongs to the synthetic review package.
  assert.doesNotMatch(html, /Amostra sint[eé]tica/u);
  // A blank field prints blank, never "null" or "undefined".
  assert.equal(confirmed.ficha.summary.aplicacao, null);
  assert.doesNotMatch(html, /null|undefined/u);
  // The 14 production fields reach the shop floor empty.
  assert.equal(
    (html.match(/<span class="campo-producao-vazio"><\/span>/gu) ?? []).length,
    14,
  );
});

test('the printed order dates the document on the day it was confirmed', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1', {
    aplicacao: null,
    data_entrega_confirmada: '2026-10-24',
    nome: null,
  });

  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/print`,
  });

  assert.equal(confirmed.orderDate, '2026-09-12');
  assert.match(response.body, /Data do pedido<\/span><strong>12\/09\/2026</u);
  // The page stores the promised day as ISO; paper reads it like the sample.
  assert.match(
    response.body,
    /Entrega prometida<\/span><strong>24\/10\/2026</u,
  );
});

test('GET /orders/:orderId/print refuses a pending order with 409', async (t) => {
  const { api, guards, runtime } = orderHarness();
  t.after(() => api.close());
  const pending = await createPending(runtime, 'conversation-1');
  guards.length = 0;

  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${pending.id}/print`,
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: { code: 'ORDER_NOT_CONFIRMED' },
  });
  assert.deepEqual(
    guards.map((guard) => [guard.method, guard.input.action]),
    [['authorizeRead', 'order.print']],
  );
});

test('GET /orders/:orderId/print needs an order and a session', async (t) => {
  const { api } = orderHarness();
  t.after(() => api.close());

  const missing = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/order-missing/print',
  });

  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: { code: 'ORDER_NOT_FOUND' } });

  const guarded = orderHarness({ readActor: null });
  t.after(() => guarded.api.close());
  const confirmed = await createConfirmed(guarded.runtime, 'conversation-1');
  const forbidden = await guarded.api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${confirmed.id}/print`,
  });

  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(forbidden.json(), { error: { code: 'FORBIDDEN' } });
});

test('manual delivery afazeres are scoped and confirmation is idempotent with no client date', async (t) => {
  const { api, runtime, repository, guards } = orderHarness({
    readActor: SELLER,
  });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, null);
  assert.equal(confirmed.firstContactAt, confirmed.createdAt);
  await createConfirmed(runtime, 'conversation-1');
  const listed = await api.inject({
    method: 'GET',
    headers: readHeaders,
    url: '/api/v1/orders/delivery-tasks',
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json().items.map((/** @type {any} */ order) => order.id),
    [confirmed.id],
  );
  assert.match(String(listed.headers['cache-control']), /private/u);

  const paid = await api.inject({
    method: 'PATCH',
    headers: writeHeaders,
    url: `/api/v1/orders/${confirmed.id}/milestones`,
    payload: { expectedVersion: confirmed.version, paidOn: '2026-09-10' },
  });
  assert.equal(paid.statusCode, 200);
  const order = paid.json().order;
  const confirmation = {
    method: /** @type {const} */ ('POST'),
    headers: { ...writeHeaders, 'idempotency-key': 'delivery-confirm' },
    url: `/api/v1/orders/${order.id}/delivery-confirmation`,
    payload: { expectedVersion: order.version },
  };
  const first = await api.inject(confirmation);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().order.deliveredOn, '2026-09-12');
  assert.equal(first.json().order.paidOn, '2026-09-10');
  assert.equal(guards.at(-1)?.input.action, 'order.milestones');
  const replay = await api.inject(confirmation);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(
    repository
      .eventsFor(order.id)
      .filter((event) => event.eventType === 'order.milestones_saved').length,
    2,
  );
  const empty = await api.inject({
    method: 'GET',
    headers: readHeaders,
    url: '/api/v1/orders/delivery-tasks',
  });
  assert.deepEqual(empty.json(), { items: [] });
  const stale = await api.inject({
    ...confirmation,
    headers: { ...writeHeaders, 'idempotency-key': 'delivery-stale' },
  });
  assert.equal(stale.statusCode, 409);
  const clientDate = await api.inject({
    ...confirmation,
    payload: {
      expectedVersion: first.json().order.version,
      deliveredOn: '2026-09-11',
    },
  });
  assert.equal(clientDate.statusCode, 400);
  const editDelivery = await api.inject({
    method: 'PATCH',
    headers: { ...writeHeaders, 'idempotency-key': 'edit-delivery' },
    url: `/api/v1/orders/${order.id}/milestones`,
    payload: {
      expectedVersion: first.json().order.version,
      paidOn: null,
      deliveredOn: null,
    },
  });
  assert.equal(editDelivery.statusCode, 400);
});

test('manual delivery tasks require session and another seller cannot confirm', async (t) => {
  const harness = orderHarness({ writeActor: OTHER });
  t.after(() => harness.api.close());
  const confirmed = await createConfirmed(harness.runtime, null);
  const list = await harness.api.inject({
    method: 'GET',
    headers: readHeaders,
    url: '/api/v1/orders/delivery-tasks',
  });
  assert.deepEqual(list.json(), { items: [] });
  const forbidden = await harness.api.inject({
    method: 'POST',
    headers: writeHeaders,
    url: `/api/v1/orders/${confirmed.id}/delivery-confirmation`,
    payload: { expectedVersion: confirmed.version },
  });
  assert.equal(forbidden.statusCode, 403);
  const guarded = orderHarness({ readActor: null });
  t.after(() => guarded.api.close());
  const denied = await guarded.api.inject({
    method: 'GET',
    headers: readHeaders,
    url: '/api/v1/orders/delivery-tasks',
  });
  assert.equal(denied.statusCode, 403);
});

test('ACT: payment and delivery confirmations preserve each other on conversation orders', async (t) => {
  const { api, runtime } = orderHarness({ readActor: SELLER });
  t.after(() => api.close());
  const confirmed = await createConfirmed(runtime, 'conversation-1');
  const delivered = await api.inject({
    method: 'POST',
    headers: { ...writeHeaders, 'idempotency-key': 'dashboard-delivery' },
    url: `/api/v1/orders/${confirmed.id}/delivery-confirmation`,
    payload: { expectedVersion: confirmed.version },
  });
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.json().order.deliveredOn, '2026-09-12');
  const request = {
    method: /** @type {const} */ ('POST'),
    headers: { ...writeHeaders, 'idempotency-key': 'dashboard-payment' },
    url: `/api/v1/orders/${confirmed.id}/payment-confirmation`,
    payload: {
      expectedVersion: delivered.json().order.version,
      paidOn: '2026-09-11',
      receivedInFull: true,
    },
  };
  const paid = await api.inject(request);
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().order.paidOn, '2026-09-11');
  assert.equal(paid.json().order.deliveredOn, '2026-09-12');
  assert.equal(paid.json().order.paymentReviewRequired, false);
  assert.equal(paid.json().order.status, 'confirmado');
  assert.deepEqual((await api.inject(request)).json(), paid.json());
  assert.equal(
    (
      await api.inject({
        ...request,
        headers: {
          ...writeHeaders,
          'idempotency-key': 'dashboard-payment-stale',
        },
      })
    ).statusCode,
    409,
  );
  for (const payload of [
    {
      expectedVersion: paid.json().order.version,
      paidOn: '2026-09-11',
      receivedInFull: false,
    },
    {
      expectedVersion: paid.json().order.version,
      paidOn: '2026-09-11',
      receivedInFull: true,
      deliveredOn: null,
    },
  ])
    assert.equal((await api.inject({ ...request, payload })).statusCode, 400);
});

test('ACT: competing payment and delivery commands have one version winner without losing a date', async (t) => {
  const { api, runtime } = orderHarness();
  t.after(() => api.close());
  const order = await createConfirmed(runtime, 'conversation-1');
  const settled = await Promise.allSettled([
    runtime.confirmPayment(
      seed({
        orderId: order.id,
        expectedVersion: order.version,
        paidOn: '2026-09-11',
        receivedInFull: true,
      }),
    ),
    runtime.confirmDelivery(
      seed({ orderId: order.id, expectedVersion: order.version }),
    ),
  ]);
  assert.equal(
    settled.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.equal(
    /** @type {PromiseRejectedResult} */ (rejected).reason.code,
    'VERSION_CONFLICT',
  );
  const current = (await runtime.get(order.id)).order;
  const completed = current.paidOn
    ? await runtime.confirmDelivery(
        seed({ orderId: order.id, expectedVersion: current.version }),
      )
    : await runtime.confirmPayment(
        seed({
          orderId: order.id,
          expectedVersion: current.version,
          paidOn: '2026-09-11',
          receivedInFull: true,
        }),
      );
  assert.equal(completed.paidOn, '2026-09-11');
  assert.equal(completed.deliveredOn, '2026-09-12');
});
