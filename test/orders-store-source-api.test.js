import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import {
  STORE_NOW,
  STORE_RECEIPT_URL,
  STORE_REQUEST_ID,
  storeOrderBody,
} from './fixtures/store-order.js';

const ADMIN = {
  id: 'synthetic-store-admin',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const SELLER = { ...ADMIN, id: 'synthetic-store-seller', capabilities: [] };
const FINANCE = {
  ...SELLER,
  id: 'synthetic-store-finance',
  functionName: 'Financeiro',
  olistEnabled: true,
};
const HEADERS = {
  cookie: 'crm_session=synthetic-store-source-session',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic-store-source-csrf',
  'x-request-id': '30000000-0000-4000-8000-000000000024',
};
const REGISTRATION = {
  personType: 'individual',
  document: '52998224725',
  legalName: 'Comprador Sintético',
  postalCode: '29010-000',
  city: 'Vitória',
  state: 'ES',
  street: 'Rua Sintética',
  district: 'Centro',
  number: '10',
};

async function harness() {
  const repository = new InMemoryOrderRepository();
  const store = createStoreOrderService({
    repository,
    fabCode: '01',
    hmacKey: Buffer.alloc(32, 91),
    acceptTest: true,
    clock: () => STORE_NOW,
  });
  const body = storeOrderBody((value) => {
    value.pagamento.receipt_url = STORE_RECEIPT_URL;
  });
  const recorded = await store.record({
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'synthetic-store-source-seed',
    record: store.parse(body),
  });
  const printed = await repository.recordFirstPrint({
    orderId: recorded.order.id,
    actorId: ADMIN.id,
    correlationId: 'synthetic-store-source-print',
    now: STORE_NOW,
  });
  const original = printed.order;
  const originalReceipt = await repository.findStoreOrder(STORE_REQUEST_ID);
  /** @type {{actor: any}} */
  const state = { actor: structuredClone(ADMIN) };
  /** @type {{method: string, input: any}[]} */
  const guards = [];
  /** @type {any[]} */
  const audits = [];
  const access = {
    authorizeRead: async (/** @type {any} */ input) => {
      guards.push({ method: 'read', input });
      authorize(state.actor, input.action);
      return { actor: state.actor };
    },
    authorizeWrite: async (/** @type {any} */ input) => {
      guards.push({ method: 'write', input });
      authorize(state.actor, input.action);
      return { actor: state.actor };
    },
  };
  const runtime = createOrderRuntime({
    repository,
    fabCode: '01',
    clock: () => STORE_NOW,
    access,
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    auditTrail: {
      append: async (/** @type {any} */ event) => {
        audits.push(event);
      },
    },
    conversations: {
      readAssignment: async () => null,
      readAssignments: async () => new Map(),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: async () => new Map(),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, 'Pessoa Sintética'])),
      searchConversationIds: async () => [],
    },
  });
  const api = createApi({}, { orders: runtime });
  const url = `/api/v1/orders/${original.id}/price-breakdown`;
  let sequence = 0;
  const request = (
    /** @type {unknown} */ value,
    expectedVersion = original.version,
    key = `synthetic-store-source-${sequence++}`,
  ) => ({
    method: /** @type {const} */ ('POST'),
    url,
    headers: { ...HEADERS, 'idempotency-key': key },
    payload: { expectedVersion, value },
  });
  return {
    api,
    repository,
    store,
    body,
    original,
    originalReceipt,
    state,
    guards,
    audits,
    runtime,
    url,
    request,
  };
}

/** @param {any} source @param {Record<string, unknown>} [override] */
function details(source, override = {}) {
  return {
    action: 'set_store_details',
    deliveryOn: '2026-11-20',
    applications: source.groups.map((/** @type {any} */ group) => ({
      groupId: group.id,
      application: 'SEM ESTAMPA',
    })),
    registration: { ...REGISTRATION },
    ...override,
  };
}

/** Every checkout field is immutable; only the shared order revision/time may move.
 * @param {any} order */
function commercialSnapshot(order) {
  const copy = structuredClone(order);
  delete copy.version;
  delete copy.updatedAt;
  return copy;
}

test('T24 store initialize uses the single stored commercial line and exposes explicit missing complements', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const read = await h.api.inject({
    method: 'GET',
    url: h.url,
    headers: HEADERS,
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal(read.json().mode, 'store');
  assert.ok(
    read
      .json()
      .issues.some(
        (/** @type {any} */ issue) =>
          issue.code === 'STORE_ORDER_COMPLEMENT_REQUIRED',
      ),
  );
  const request = h.request({ action: 'initialize' });
  const initialized = await h.api.inject(request);
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.headers['cache-control'], 'private, no-store');
  const source = initialized.json();
  assert.equal(source.revision, 1);
  assert.equal(source.mode, 'store');
  assert.equal(source.sourceValid, true);
  assert.equal(source.pricing.complete, true);
  assert.equal(source.pricing.totalCents, h.original.finalAmountCents);
  assert.equal(source.groups.length, 1);
  assert.equal(source.groups[0].lines.length, 1);
  assert.match(source.groups[0].id, /^[0-9a-f-]{36}$/u);
  assert.match(source.groups[0].lines[0].id, /^[0-9a-f-]{36}$/u);
  assert.equal(source.groups[0].lines[0].quantity, 10);
  assert.equal(source.groups[0].lines[0].subtotalCents, 18000);
  const codes = source.issues.map((/** @type {any} */ issue) => issue.code);
  assert.ok(codes.includes('STORE_DELIVERY_REQUIRED'));
  assert.ok(codes.includes('STORE_APPLICATION_REQUIRED'));
  assert.ok(codes.includes('STORE_BUYER_FIELD_REQUIRED'));
  assert.equal(source.details.registration, null);
  assert.equal(source.details.deliveryOn, null);
  assert.equal(source.details.applications[0].application, null);
  assert.deepEqual((await h.api.inject(request)).json(), source);
  assert.equal((await h.runtime.priceBreakdown(h.original.id)).revision, 1);
  assert.deepEqual(
    commercialSnapshot(await h.repository.findById(h.original.id)),
    commercialSnapshot(h.original),
  );
});

test('T24 authorized complements preserve checkout, paid receipt and first print while closing readiness gaps', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const init = await h.api.inject(h.request({ action: 'initialize' }));
  const source = init.json();
  const request = h.request(details(source), source.orderVersion);
  const result = await h.api.inject(request);
  assert.equal(result.statusCode, 200);
  const saved = result.json();
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.issues, []);
  assert.equal(saved.details.registration.document, REGISTRATION.document);
  assert.equal(saved.details.registration.postalCode, '29010000');
  assert.equal(saved.buyer.name, h.original.ficha.summary.cliente);
  assert.equal(saved.buyer.phone, h.original.ficha.loja?.telefone);
  assert.equal(saved.pricing.totalCents, h.original.finalAmountCents);
  assert.equal(saved.groups[0].id, source.groups[0].id);
  assert.deepEqual((await h.api.inject(request)).json(), saved);
  const guard = h.guards.findLast((entry) => entry.method === 'write');
  assert.equal(guard?.input.action, 'order.edit');
  assert.equal(guard?.input.origin, HEADERS.origin);
  assert.equal(guard?.input.csrfToken, HEADERS['x-csrf-token']);
  assert.equal(guard?.input.cookie, HEADERS.cookie);
  const current = await h.repository.findById(h.original.id);
  assert.deepEqual(commercialSnapshot(current), commercialSnapshot(h.original));
  assert.equal(current?.ficha.summary.data_entrega_confirmada, null);
  assert.equal(current?.ficha.items[0].tipo_servico, '');
  assert.equal(current?.fichaFirstPrintedAt, h.original.fichaFirstPrintedAt);
  assert.equal(current?.fichaFirstPrintedBy, ADMIN.id);
  assert.deepEqual(current?.gatewayPayment, h.original.gatewayPayment);
  assert.equal(current?.paidOn, h.original.paidOn);
  const receipt = await h.repository.findStoreOrder(STORE_REQUEST_ID);
  assert.equal(receipt?.recordSha256, h.originalReceipt?.recordSha256);
  assert.equal(receipt?.order.ficha.loja?.comprovanteUrl, STORE_RECEIPT_URL);
  const replay = await h.store.record({
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'synthetic-store-source-replay',
    record: h.store.parse(h.body),
  });
  assert.equal(replay.created, false);
  assert.equal(replay.receiptAttached, false);
  assert.deepEqual(
    commercialSnapshot(replay.order),
    commercialSnapshot(h.original),
  );
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(h.audits),
    /52998224725|29010000|Rua Sintética/u,
  );
  const publicOrder = (
    await h.api.inject({
      method: 'GET',
      url: `/api/v1/orders/${h.original.id}`,
      headers: HEADERS,
    })
  ).json().order;
  assert.equal(publicOrder.locked, true);
  assert.equal(publicOrder.contactId, undefined);
  assert.equal(publicOrder.legacySizePricing, undefined);
  assert.equal(publicOrder.ficha.sizePricing, undefined);
});

test('T24 store enrichment is administrator-only and Olist checkbox grants no Order read/edit scope', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  for (const actor of [SELLER, FINANCE, { ...ADMIN, kind: 'automation' }]) {
    h.state.actor = actor;
    assert.equal(
      (await h.api.inject(h.request({ action: 'initialize' }))).statusCode,
      403,
    );
  }
  h.state.actor = FINANCE;
  assert.doesNotThrow(() => authorize(h.state.actor, 'olist.read'));
  const read = await h.api.inject({
    method: 'GET',
    url: h.url,
    headers: HEADERS,
  });
  assert.equal(read.statusCode, 403);
  assert.equal(read.json().details, undefined);
  assert.equal(read.json().buyer, undefined);
  h.state.actor = structuredClone(ADMIN);
  const request = h.request({ action: 'initialize' });
  assert.equal((await h.api.inject(request)).statusCode, 200);
  h.state.actor = { ...ADMIN, capabilities: [] };
  assert.equal((await h.api.inject(request)).statusCode, 403);
  assert.equal((await h.runtime.priceBreakdown(h.original.id)).revision, 1);
  assert.equal(
    h.audits.filter((event) => event.action === 'order.price_breakdown.edit')
      .length,
    1,
  );
});

test('T24 validation rejects fiscal/date errors and forged money, quantity, flags or buyer fields atomically', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const source = (
    await h.api.inject(h.request({ action: 'initialize' }))
  ).json();
  const before = await h.repository.findById(h.original.id);
  for (const value of [
    details(source, { deliveryOn: '2026-02-30' }),
    details(source, {
      registration: { ...REGISTRATION, document: '00000000000' },
    }),
    details(source, {
      registration: { ...REGISTRATION, buyer: { name: 'forged' } },
    }),
    { ...details(source), totalCents: 1 },
    { ...details(source), quantity: 1 },
    { ...details(source), subtotalReviewed: true },
    { ...details(source), groups: source.groups },
    { ...details(source), buyer: { name: 'forged', phone: '00000000' } },
  ]) {
    const result = await h.api.inject(h.request(value, source.orderVersion));
    assert.equal(result.statusCode, 422);
    assert.equal(result.json().error.code, 'ORDER_SOURCE_INVALID');
    assert.deepEqual(await h.repository.findById(h.original.id), before);
  }
  const priceEdit = await h.api.inject(
    h.request({ action: 'set_subtotals', lines: [] }, source.orderVersion),
  );
  assert.equal(priceEdit.statusCode, 400);
  assert.equal(priceEdit.json().error.code, 'ORDER_INVALID');
  const partial = await h.api.inject(
    h.request(
      details(source, { deliveryOn: null, registration: null }),
      source.orderVersion,
    ),
  );
  assert.equal(partial.statusCode, 200);
  assert.ok(partial.json().issues.length > 0);
  assert.equal(partial.json().pricing.totalCents, 18000);
  assert.deepEqual(
    commercialSnapshot(await h.repository.findById(h.original.id)),
    commercialSnapshot(h.original),
  );
});

test('T24 explicit company exemption is supplemental and store editing, reopen and confirmation stay locked', async (t) => {
  const h = await harness();
  t.after(() => h.api.close());
  const source = (
    await h.api.inject(h.request({ action: 'initialize' }))
  ).json();
  const company = {
    ...REGISTRATION,
    personType: 'company',
    document: '11222333000181',
  };
  const missingExemption = await h.api.inject(
    h.request(details(source, { registration: company }), source.orderVersion),
  );
  assert.equal(missingExemption.statusCode, 200);
  assert.ok(
    missingExemption
      .json()
      .issues.some(
        (/** @type {any} */ issue) =>
          issue.field === 'registration.stateRegistration',
      ),
  );
  const filled = await h.api.inject(
    h.request(
      details(source, {
        registration: { ...company, stateRegistration: 'ISENTO' },
      }),
      missingExemption.json().orderVersion,
    ),
  );
  assert.equal(filled.statusCode, 200);
  assert.deepEqual(filled.json().issues, []);
  assert.equal(filled.json().details.registration.stateRegistration, 'ISENTO');
  const version = filled.json().orderVersion;
  for (const [method, suffix, payload] of [
    ['PATCH', '/sections/items', { expectedVersion: version, value: [] }],
    ['POST', '/reopen', { expectedVersion: version }],
    [
      'POST',
      '/confirm',
      {
        expectedVersion: version,
        amountText: '180,00',
        paymentCondition: 'pix',
      },
    ],
  ]) {
    const result = await h.api.inject({
      method: /** @type {'POST'|'PATCH'} */ (method),
      url: `/api/v1/orders/${h.original.id}${suffix}`,
      headers: { ...HEADERS, 'idempotency-key': `store-locked-${suffix}` },
      payload,
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'ORDER_LOCKED');
    assert.equal(
      (await h.repository.findById(h.original.id))?.version,
      version,
    );
  }
});
