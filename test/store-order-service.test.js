import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import { StoreOrderDuplicateError } from '../modules/orders/src/domain/store-order.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import {
  STORE_NOW,
  STORE_RECEIPT_URL,
  STORE_REQUEST_ID,
  otherStoreOrderBody,
  storeOrderBody,
} from './fixtures/store-order.js';

const HMAC_KEY = Buffer.alloc(32, 27);
const ADMIN = Object.freeze({
  capabilities: ['COMMERCIAL_ADMIN'],
  id: 'admin-1',
  kind: 'human',
});

/** @param {{acceptTest?: boolean, repository?: any}} [options] */
function setup(options = {}) {
  const repository = /** @type {InMemoryOrderRepository} */ (
    options.repository ?? new InMemoryOrderRepository()
  );
  let now = STORE_NOW.getTime();
  let ids = 0;
  const clock = () => new Date(now);
  const store = createStoreOrderService({
    acceptTest: options.acceptTest ?? true,
    clock,
    fabCode: '01',
    hmacKey: HMAC_KEY,
    idFactory: () => `order-store-${(ids += 1)}`,
    repository,
  });
  const orders = createOrderService({
    authorizeOwnership: async () => undefined,
    clock,
    conversations: {
      readOrderContexts: orderContextsFrom(() => ({
        briefing: { product_type: 'camisa' },
        customerName: 'Cliente do Bot',
      })),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    phoneDigestsFor: store.phoneDigestsFor,
    repository,
  });
  /** @param {any} body */
  async function record(body) {
    return store.record({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${body.pedido_id}`,
      record: store.parse(body),
    });
  }
  return {
    advance: (/** @type {number} */ ms) => (now += ms),
    orders,
    record,
    repository,
    store,
  };
}

/** @param {Promise<unknown>} promise @param {number} statusCode @param {string} code */
async function refuses(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(/** @type {any} */ (error).statusCode, statusCode);
    assert.equal(/** @type {any} */ (error).code, code);
    return true;
  });
}

const testOrderBody = () =>
  storeOrderBody((body) => {
    body.teste = true;
    body.valor_centavos = 100;
    body.pagamento.valor_pago_centavos = 100;
  });

test('LOJ-15/LOJ-21: a paid record becomes a confirmed store order, its receipt and its audit', async () => {
  const { record, repository } = setup();
  const outcome = await record(storeOrderBody());
  assert.equal(outcome.created, true);
  assert.equal(outcome.receiptAttached, false);
  const { order } = outcome;
  assert.equal(order.number, '01-CRM');
  assert.equal(order.storeNumber, 'LJ-5B0C77ED');
  assert.equal(order.status, 'confirmado');
  assert.equal(order.origin, 'loja');
  assert.equal(order.conversationId, null);
  assert.equal(order.finalAmountCents, 18000);
  assert.equal(order.paidOn, '2026-10-07');
  assert.equal(order.version, 1);
  assert.equal(order.ficha.loja?.comprovanteUrl, null);
  const receipt = repository.receiptFor(order.id);
  assert.equal(receipt?.requestId, STORE_REQUEST_ID);
  assert.match(String(receipt?.phoneDigest), /^[0-9a-f]{64}$/u);
  assert.match(String(receipt?.recordSha256), /^[0-9a-f]{64}$/u);
  // The receipt never keeps the phone in the clear.
  assert.equal(JSON.stringify(receipt).includes('5527900000001'), false);
  assert.deepEqual(repository.audits(), [
    {
      action: 'store.order.create',
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${STORE_REQUEST_ID}`,
      occurredAt: STORE_NOW.toISOString(),
      reason: 'INFINITEPAY_PAYMENT_CONFIRMED',
      target: { id: order.id, type: 'order' },
      version: '1',
    },
  ]);
  assert.deepEqual(
    repository.eventsFor(order.id).map((event) => event.eventType),
    ['order.created'],
  );
});

test('LOJ-17: the same record again answers the same order, with nothing new', async () => {
  const { advance, record, repository } = setup();
  const first = await record(storeOrderBody());
  advance(60_000);
  // The same data, with the instant in milliseconds.
  const again = await record(
    storeOrderBody((body) => {
      body.pagamento.pago_em = '2026-10-08T02:15:55.000Z';
    }),
  );
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  assert.equal(again.order.number, '01-CRM');
  assert.equal(again.order.version, 1);
  assert.equal(repository.audits().length, 1);
});

test('LOJ-17/LOJ-21: shipping observation survives a retry and a different CEP conflicts', async () => {
  const { record, repository } = setup();
  /** @param {string} cep */
  const shippingBody = (cep) =>
    storeOrderBody((body) => {
      body.entrega = { tipo: 'envio', cep };
    });
  const first = await record(shippingBody('69301-000'));
  assert.deepEqual(first.order.ficha.observations, [
    'Dados de envio — CEP: 69301-000. Entrar em contato para pegar as informações de entrega.',
  ]);
  const again = await record(shippingBody('69301-000'));
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  assert.deepEqual(
    again.order.ficha.observations,
    first.order.ficha.observations,
  );
  await refuses(record(shippingBody('69302-000')), 409, 'STORE_ORDER_CONFLICT');
  assert.equal(repository.audits().length, 1);
  assert.equal(
    JSON.stringify(repository.audits()).includes('69301-000'),
    false,
  );
});

test('LOJ-17: a retry is answered before the catalog, so a later test policy never refuses it', async () => {
  const repository = new InMemoryOrderRepository();
  const first = await setup({ acceptTest: true, repository }).record(
    testOrderBody(),
  );
  const later = setup({ acceptTest: false, repository });
  const again = await later.record(testOrderBody());
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
});

test('LOJ-17: the receipt link that arrives later is attached once and audited', async () => {
  const { advance, record, repository } = setup();
  const first = await record(storeOrderBody());
  advance(30_000);
  const withReceipt = () =>
    storeOrderBody((body) => (body.pagamento.receipt_url = STORE_RECEIPT_URL));
  const attached = await record(withReceipt());
  assert.equal(attached.created, false);
  assert.equal(attached.receiptAttached, true);
  assert.equal(attached.order.id, first.order.id);
  assert.equal(attached.order.version, 2);
  assert.equal(attached.order.ficha.loja?.comprovanteUrl, STORE_RECEIPT_URL);
  const again = await record(withReceipt());
  assert.equal(again.receiptAttached, false);
  assert.equal(again.order.version, 2);
  // A retry without the link keeps the link.
  const without = await record(storeOrderBody());
  assert.equal(without.order.ficha.loja?.comprovanteUrl, STORE_RECEIPT_URL);
  assert.deepEqual(
    repository.audits().map((audit) => [audit.action, audit.version]),
    [
      ['store.order.create', '1'],
      ['store.order.receipt_attached', '2'],
    ],
  );
  assert.deepEqual(
    repository.eventsFor(first.order.id).map((event) => event.eventType),
    ['order.created', 'order.receipt_attached'],
  );
});

test('LOJ-17: different data or another receipt for the same pedido_id is STORE_ORDER_CONFLICT', async () => {
  const { record, repository } = setup();
  await record(
    storeOrderBody((body) => (body.pagamento.receipt_url = STORE_RECEIPT_URL)),
  );
  for (const change of [
    (/** @type {any} */ body) => (body.item.tamanho_id = 'g'),
    (/** @type {any} */ body) => (body.pagamento.transaction_nsu = 'nsu-2'),
    (/** @type {any} */ body) => (body.pagamento.valor_pago_centavos = 18001),
    (/** @type {any} */ body) => (body.cliente.nome = 'Outra Pessoa'),
    (/** @type {any} */ body) =>
      (body.pagamento.receipt_url = 'https://recibo.infinitepay.io/outro'),
  ]) {
    await refuses(
      record(
        storeOrderBody((body) => {
          body.pagamento.receipt_url = STORE_RECEIPT_URL;
          change(body);
        }),
      ),
      409,
      'STORE_ORDER_CONFLICT',
    );
  }
  assert.equal(repository.audits().length, 1);
});

test('LOJ-17: one transaction_nsu pays one order', async () => {
  const { record } = setup();
  await record(storeOrderBody());
  await refuses(
    record(
      otherStoreOrderBody(2, (body) => {
        body.pagamento.transaction_nsu = 'nsu-sintetico-0001';
      }),
    ),
    409,
    'STORE_ORDER_CONFLICT',
  );
});

test('LOJ-17: a concurrent retry that loses the race is answered from the winner', async () => {
  const inner = new InMemoryOrderRepository();
  const winner = await setup({ repository: inner }).record(storeOrderBody());
  let firstLookup = true;
  // The first lookup misses, as if the winner had not committed yet; the
  // create then finds its receipt and the service reads the order back.
  const racing = {
    attachStoreReceipt: inner.attachStoreReceipt.bind(inner),
    async createStoreOrder(/** @type {any} */ input) {
      if (await inner.findStoreOrder(input.receipt.requestId)) {
        throw new StoreOrderDuplicateError();
      }
      return inner.createStoreOrder(input);
    },
    async findStoreOrder(/** @type {string} */ requestId) {
      if (firstLookup) {
        firstLookup = false;
        return null;
      }
      return inner.findStoreOrder(requestId);
    },
  };
  const store = createStoreOrderService({
    acceptTest: true,
    clock: () => STORE_NOW,
    fabCode: '01',
    hmacKey: HMAC_KEY,
    idFactory: () => 'order-store-loser',
    repository: racing,
  });
  const loser = await store.record({
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'correlation-loser',
    record: store.parse(storeOrderBody()),
  });
  assert.equal(loser.created, false);
  assert.equal(loser.order.id, winner.order.id);
  assert.equal(inner.audits().length, 1);
});

test('LOJ-18/LOJ-19: a refused record creates nothing', async () => {
  const { orders, record, repository } = setup({ acceptTest: false });
  /** @type {Array<[(body: any) => void, string]>} */
  const refusals = [
    [(body) => (body.item.quantidade = 20), 'STORE_CATALOG_MISMATCH'],
    [(body) => (body.pagamento.valor_pago_centavos = 1), 'AMOUNT_BELOW_PRICE'],
    [(body) => (body.pagamento.forma = 'boleto'), 'PAYMENT_METHOD_UNSUPPORTED'],
    [(body) => (body.teste = true), 'TEST_REFUSED'],
  ];
  for (const [change, code] of refusals) {
    await refuses(record(storeOrderBody(change)), 422, code);
  }
  const page = await orders.list({});
  assert.deepEqual(page.items, []);
  assert.deepEqual(repository.audits(), []);
});

test('LOJ-07: every human write on a store order is ORDER_LOCKED, even for an admin', async () => {
  const { orders, record } = setup();
  const { order: created } = await record(storeOrderBody());
  const base = {
    actor: ADMIN,
    correlationId: 'correlation-write',
    expectedVersion: created.version,
    orderId: created.id,
  };
  await refuses(
    orders.patchSection({ ...base, section: 'observations', value: [] }),
    409,
    'ORDER_LOCKED',
  );
  await refuses(
    orders.confirm({ ...base, amountText: '180,00', paymentCondition: 'pix' }),
    409,
    'ORDER_LOCKED',
  );
  await refuses(orders.reopen(base), 409, 'ORDER_LOCKED');
  await refuses(
    orders.recordMilestones({
      ...base,
      deliveredOn: '2026-10-07',
      paidOn: '2026-10-07',
    }),
    409,
    'ORDER_LOCKED',
  );
});

test('LOJ-21: a store order never touches the pending order of a conversation', async () => {
  const { orders, record } = setup();
  const { order: pending } = await orders.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-intent',
  });
  const { order: store } = await record(storeOrderBody());
  const current = await orders.currentForConversation('conversation-1');
  assert.equal(current?.id, pending.id);
  assert.notEqual(store.id, pending.id);
});

test('LOJ-23: the list narrows to store orders and finds one by phone or by its LJ- number', async () => {
  const { orders, record } = setup();
  await orders.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-intent',
  });
  const { order: store } = await record(storeOrderBody());
  const { order: other } = await record(
    otherStoreOrderBody(2, (body) => (body.cliente.telefone = '5527900000002')),
  );
  const onlyStore = await orders.list({ origin: 'loja' });
  assert.deepEqual(onlyStore.counts, { confirmado: 2, pendente: 0 });
  for (const typed of [
    '(27) 90000-0001',
    '+55 27 90000-0001',
    'LJ-5B0C77ED',
    'lj-5b0c77ed',
    'LJ5B0C77ED',
    '#LJ-5B0C77ED',
  ]) {
    const found = await orders.list({ q: typed });
    assert.deepEqual(
      found.items.map((order) => order.id),
      [store.id],
      typed,
    );
  }
  const byOther = await orders.list({ q: 'LJ-0002ABCD' });
  assert.deepEqual(
    byOther.items.map((order) => order.id),
    [other.id],
  );
  assert.deepEqual((await orders.list({ q: 'LJ-5B0C77' })).items, []);
});

test('LOJ-09: a store sale counts like any sale; a test order does not', async () => {
  const { orders, record } = setup();
  await record(testOrderBody());
  /** @param {any} summary */
  const totals = ({
    deliveries: _deliveries,
    period: _period,
    today: _today,
    ...rest
  }) => rest;
  assert.deepEqual(totals(await orders.summary()), {
    averageTicketCents: 0,
    confirmedCount: 0,
    pendingCount: 0,
    soldAmountCents: 0,
    // ADR 031: a test order never shows in the Dashboard notice.
    storeNewCount: 0,
    storeNewOldestPaidAt: null,
    totalPiecesSold: 0,
  });
  assert.equal((await orders.summary()).period.confirmedCount, 0);
  await record(otherStoreOrderBody(2));
  const summary = await orders.summary();
  assert.deepEqual(totals(summary), {
    averageTicketCents: 18000,
    confirmedCount: 1,
    pendingCount: 0,
    soldAmountCents: 18000,
    storeNewCount: 1,
    storeNewOldestPaidAt: '2026-10-08T02:15:55.000Z',
    totalPiecesSold: 10,
  });
  // Painel: the sale lands on the São Paulo day InfinitePay confirmed the Pix.
  assert.equal(summary.today, '2026-10-07');
  assert.deepEqual(summary.period, {
    confirmedCount: 1,
    from: '2026-10-07',
    key: 'hoje',
    soldAmountCents: 18000,
    timeZone: 'America/Sao_Paulo',
    to: '2026-10-07',
  });
  // A store order promises no delivery day, so it is never late.
  assert.equal(summary.deliveries.overdueCount, 0);
  await assert.rejects(orders.summary({ period: 'ano' }), {
    name: 'OrderInputError',
  });
});

test('the store service refuses an incomplete configuration', () => {
  const repository = new InMemoryOrderRepository();
  const base = {
    acceptTest: true,
    fabCode: '01',
    hmacKey: HMAC_KEY,
    repository,
  };
  assert.throws(
    () => createStoreOrderService({ ...base, hmacKey: Buffer.alloc(16) }),
    TypeError,
  );
  assert.throws(
    () => createStoreOrderService({ ...base, fabCode: ' ' }),
    TypeError,
  );
  assert.throws(
    () =>
      createStoreOrderService({
        ...base,
        acceptTest: /** @type {any} */ ('true'),
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createStoreOrderService({
        ...base,
        repository: /** @type {any} */ ({ findStoreOrder() {} }),
      }),
    TypeError,
  );
});

test('manual delivery afazeres exclude normal and test store orders and delivery remains locked', async () => {
  for (const body of [storeOrderBody(), testOrderBody()]) {
    const { orders, record } = setup();
    const { order } = await record(body);
    assert.deepEqual(await orders.deliveryTasks({ actor: ADMIN }), []);
    await assert.rejects(
      orders.confirmDelivery({
        actor: ADMIN,
        correlationId: 'store-delivery-refused',
        orderId: order.id,
        expectedVersion: order.version,
      }),
      { code: 'ORDER_LOCKED', statusCode: 409 },
    );
  }
});
