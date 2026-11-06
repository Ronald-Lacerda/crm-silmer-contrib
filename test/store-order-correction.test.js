import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createStoreOrderCorrectionService } from '../modules/orders/src/application/store-order-correction-service.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import { storeOrderBody, STORE_NOW } from './fixtures/store-order.js';

const ADMIN = {
  id: 'admin-synthetic',
  kind: 'human',
  capabilities: ['COMMERCIAL_ADMIN'],
};

/** @param {number} [paid] */
async function setup(paid = 9000) {
  const repository = new InMemoryOrderRepository();
  const store = createStoreOrderService({
    repository,
    fabCode: '01',
    hmacKey: Buffer.alloc(32, 27),
    acceptTest: false,
    clock: () => STORE_NOW,
  });
  const body = storeOrderBody((body) => {
    body.produto.slug = 'bloquinho-22-completa';
    body.item = {
      cor_id: 'verde-amarela',
      prazo_dias: 1,
      quantidade: 1,
      tamanho_id: 'm',
    };
    body.valor_centavos = 4500;
    body.pagamento.valor_pago_centavos = paid;
  });
  const record = store.parse(body);
  const { order } = await store.record({
    record,
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'seed-synthetic',
  });
  await repository.recordFirstPrint({
    orderId: order.id,
    actorId: ADMIN.id,
    correlationId: 'print-synthetic',
    now: STORE_NOW,
  });
  const current = await repository.findById(order.id);
  assert.ok(current);
  const service = createStoreOrderCorrectionService({
    repository,
    clock: () => STORE_NOW,
  });
  const command = {
    actor: ADMIN,
    orderId: order.id,
    expectedVersion: current.version,
    expectedQuantity: 1,
    expectedAmountCents: 4500,
    quantity: 2,
    reason: 'USER_CONFIRMED_QUANTITY',
    idempotencyKey: 'repair-synthetic-1',
    correlationId: 'repair-synthetic',
  };
  return { repository, store, record, service, command, current };
}

test('LOJ-39: correction preserves the gateway, identifiers, print and original fingerprint; original n8n replay cannot revert it', async () => {
  const { repository, service, command, current, store, record } =
    await setup();
  const receipt = repository.receiptFor(current.id);
  const corrected = await service.correct(command);
  assert.equal(corrected.totalPieces, 2);
  assert.equal(corrected.finalAmountCents, 9000);
  assert.equal(corrected.ficha.items[0].grade[0].quantidade, 2);
  for (const key of [
    'id',
    'number',
    'storeNumber',
    'status',
    'conversationId',
    'confirmedAt',
    'confirmedBy',
    'createdAt',
    'paidOn',
    'orderDate',
    'fichaFirstPrintedAt',
    'fichaFirstPrintedBy',
    'gatewayPayment',
  ])
    assert.deepEqual(corrected[key], /** @type {any} */ (current)[key]);
  assert.deepEqual(repository.receiptFor(current.id), receipt);
  const replay = await store.record({
    record,
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: 'replay-synthetic',
  });
  assert.equal(replay.order.totalPieces, 2);
  assert.equal(replay.order.finalAmountCents, 9000);
  const summary = await repository.summary({
    dailyFrom: '2026-10-01',
    dailyTo: '2026-10-31',
    from: '2026-10-01',
    to: '2026-10-31',
  });
  assert.equal(summary.totalPiecesSold, 2);
  assert.equal(summary.soldAmountCents, 9000);
  // PNL-05: the corrected amount is the one in "Vendido por dia".
  assert.deepEqual(
    summary.daily.map((day) => day.soldAmountCents),
    [9000],
  );
  assert.equal(
    repository
      .audits()
      .filter((event) => event.action === 'store.order.quantity_corrected')
      .length,
    1,
  );
});

test('LOJ-40: concurrent/repeated repair has one effect, including lost idempotency response', async () => {
  const { repository, service, command, current } = await setup();
  const [first, second] = await Promise.all([
    service.correct(command),
    service.correct(command),
  ]);
  assert.equal(first.version, current.version + 1);
  assert.equal(second.version, first.version);
  assert.equal(
    (
      await service.correct({
        ...command,
        correlationId: 'new-request-synthetic',
      })
    ).version,
    first.version,
  );
  assert.equal(
    repository
      .audits()
      .filter((event) => event.action === 'store.order.quantity_corrected')
      .length,
    1,
  );
  await assert.rejects(
    service.correct({ ...command, idempotencyKey: 'different-command' }),
    { code: 'VERSION_CONFLICT' },
  );
  await assert.rejects(service.correct({ ...command, quantity: 3 }), {
    code: 'AMOUNT_BELOW_PRICE',
  });
});

test('LOJ-41: invalid quantity, stale snapshot, unsupported reason and nonadmin produce no effect', async () => {
  const { repository, service, command, current } = await setup();
  /** @type {[Record<string, any>, string][]} */
  const refusals = [
    [{ actor: { ...ADMIN, capabilities: [] } }, 'FORBIDDEN'],
    [{ actor: { ...ADMIN, kind: 'automation' } }, 'FORBIDDEN'],
    [{ reason: 'free text' }, 'INVALID_CORRECTION_REASON'],
    [{ quantity: 0 }, 'INVALID_REQUEST'],
    [{ quantity: 1.5 }, 'INVALID_REQUEST'],
    [{ quantity: 11 }, 'STORE_ORDER_CONFLICT'],
    [{ quantity: 1 }, 'STORE_ORDER_CONFLICT'],
    [{ expectedQuantity: 2 }, 'STORE_ORDER_CONFLICT'],
    [{ expectedAmountCents: 9000 }, 'STORE_ORDER_CONFLICT'],
    [{ expectedVersion: 99 }, 'VERSION_CONFLICT'],
  ];
  for (const [change, code] of refusals)
    await assert.rejects(service.correct({ ...command, ...change }), { code });
  assert.deepEqual(await repository.findById(current.id), current);
});

test('LOJ-41: payment never supplies quantity and cannot fund a larger subtotal', async () => {
  const { service, command } = await setup(4500);
  await assert.rejects(service.correct(command), {
    code: 'AMOUNT_BELOW_PRICE',
  });
});

test('LOJ-40/41: HTTP correction uses write guard and runtime admin check; repeated key replays and different body conflicts', async (t) => {
  const { repository, command, current } = await setup();
  /** @type {any} */
  let actor = ADMIN;
  const runtime = createOrderRuntime({
    repository,
    fabCode: '01',
    clock: () => STORE_NOW,
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    auditTrail: { append: async () => undefined },
    access: {
      authorizeRead: async () => ({ actor }),
      authorizeWrite: async (input) => {
        assert.equal(input.action, 'order.edit');
        if (
          input.authorization ||
          input.cookie !== 'crm_session=synthetic' ||
          input.csrfToken !== 'synthetic-csrf' ||
          input.origin !== 'https://crm.example.test'
        )
          throw Object.assign(new Error('Forbidden'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        return { actor };
      },
    },
    conversations: {
      readAssignment: async () => null,
      readAssignments: async () => new Map(),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: async () => new Map(),
      readUserNames: async () => new Map(),
      searchConversationIds: async () => [],
    },
  });
  const api = createApi({}, { orders: runtime });
  t.after(() => api.close());
  const payload = {
    expectedVersion: command.expectedVersion,
    expectedQuantity: 1,
    expectedAmountCents: 4500,
    quantity: 2,
    reason: 'USER_CONFIRMED_QUANTITY',
  };
  const headers = {
    cookie: 'crm_session=synthetic',
    'x-csrf-token': 'synthetic-csrf',
    origin: 'https://crm.example.test',
    'idempotency-key': 'synthetic-http-correction',
  };
  /** @param {Record<string, any>} [overrides] */
  const post = (overrides = {}) =>
    api.inject({
      method: 'POST',
      url: `/api/v1/orders/${current.id}/store-correction`,
      headers,
      payload,
      ...overrides,
    });
  for (const altered of [
    { cookie: '' },
    { 'x-csrf-token': '' },
    { origin: 'https://foreign.example.test' },
    { authorization: 'Basic synthetic' },
  ])
    assert.equal(
      (await post({ headers: { ...headers, ...altered } })).statusCode,
      403,
    );
  actor = { ...ADMIN, capabilities: [] };
  assert.equal((await post()).statusCode, 403);
  actor = ADMIN;
  assert.equal(
    (await post({ payload: { ...payload, quantity: undefined } })).statusCode,
    400,
  );
  const first = await post();
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().order.totalPieces, 2);
  assert.equal(first.json().order.finalAmountCents, 9000);
  assert.equal(first.json().order.locked, true);
  const second = await post();
  assert.deepEqual(second.json(), first.json());
  const conflict = await post({ payload: { ...payload, quantity: 3 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
});
