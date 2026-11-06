import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { briefingToFicha } from '../modules/orders/src/domain/ficha.js';
import {
  confirmOrder,
  recordMilestones,
  reopenOrder,
} from '../modules/orders/src/domain/order.js';
import { requireUnlocked } from '../modules/orders/src/domain/store-order.js';
import { readOrderListQuery } from '../modules/orders/src/ports/contracts.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const ACTOR = { id: 'seller-synthetic', kind: 'human', capabilities: [] };

/** @param {InMemoryOrderRepository} repository @param {string} id
 * @param {boolean} [confirmed] */
async function create(repository, id, confirmed = false) {
  const order = await repository.createPending({
    id,
    conversationId: 'conversation-' + id,
    manualOwnerId: ACTOR.id,
    fabCode: 'SYNTHETIC',
    ficha: briefingToFicha(null),
    totalPieces: 3,
    missingFields: [],
    createdByKind: 'user',
    createdBy: ACTOR.id,
    firstContactAt: null,
    correlationId: 'create-' + id,
    now: NOW,
  });
  if (!confirmed) return order;
  return repository.saveStatus(
    {
      ...order,
      status: 'confirmado',
      orderDate: '2026-11-06',
      finalAmountCents: 9000,
      paidOn: '2026-11-06',
      confirmedAt: NOW.toISOString(),
      confirmedBy: ACTOR.id,
      paymentCondition: 'pix',
    },
    {
      actor: ACTOR,
      expectedVersion: order.version,
      correlationId: 'confirm-' + id,
    },
  );
}

/** @param {InMemoryOrderRepository} repository
 * @param {import('../modules/orders/src/domain/order.js').Order} order */
function cancel(repository, order) {
  return repository.cancelOrder({
    actor: ACTOR,
    orderId: order.id,
    expectedVersion: order.version,
    reason: 'Cliente desistiu antes da exportação',
    correlationId: 'cancel-' + order.id,
    now: new Date(NOW.getTime() + 1000),
  });
}

test('OLIST-T23 cancellation filters counts and pages before cursor/limit', async () => {
  const repository = new InMemoryOrderRepository();
  await create(repository, 'active-a');
  await create(repository, 'active-b', true);
  await cancel(repository, await create(repository, 'cancelled-a'));
  await cancel(repository, await create(repository, 'cancelled-b', true));

  const first = await repository.list({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.counts, { pendente: 1, confirmado: 1 });
  assert.ok(first.nextCursor);
  const second = await repository.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.ok(
    [...first.items, ...second.items].every((order) => !order.cancelledAt),
  );

  const cancelled = await repository.list({
    limit: 10,
    cancellation: 'cancelled',
  });
  assert.deepEqual(cancelled.counts, { pendente: 1, confirmado: 1 });
  assert.equal(cancelled.items.length, 2);
  assert.ok(cancelled.items.every((order) => order.cancelledAt));
  const all = await repository.list({
    limit: 10,
    cancellation: 'all',
    status: 'confirmado',
  });
  assert.deepEqual(all.counts, { pendente: 2, confirmado: 2 });
  assert.equal(all.items.length, 2);
});

test('OLIST-T23 cancelled sales leave summaries and deliveries, preserving payment/history', async () => {
  const repository = new InMemoryOrderRepository();
  await create(repository, 'active-sale', true);
  const order = await create(repository, 'cancelled-sale', true);
  const before = await repository.summary({
    from: '2026-11-06',
    to: '2026-11-06',
  });
  const cancelled = await cancel(repository, order);
  assert.equal(cancelled.status, 'confirmado');
  assert.equal(cancelled.paidOn, order.paidOn);
  assert.deepEqual(cancelled.ficha, order.ficha);
  assert.equal(cancelled.finalAmountCents, order.finalAmountCents);
  const after = await repository.summary({
    from: '2026-11-06',
    to: '2026-11-06',
  });
  assert.equal(before.confirmedCount, 2);
  assert.equal(after.confirmedCount, 1);
  assert.equal(after.soldAmountCents, 9000);
  assert.equal(after.period.soldAmountCents, 9000);
  assert.equal(after.totalPiecesSold, 3);
  assert.equal((await repository.openDeliveries()).length, 1);
  assert.equal(
    (await repository.findById(order.id))?.cancelledAt,
    cancelled.cancelledAt,
  );
  assert.equal(
    (await repository.listByConversation('conversation-' + order.id)).length,
    1,
  );
  assert.equal(
    repository.eventsFor(order.id).at(-1)?.eventType,
    'order.cancelled',
  );
  assert.equal(
    repository.audits().at(-1)?.reason,
    'LOCAL_PRE_EXPORT_CANCELLATION',
  );
});

test('OLIST-T23 cancelled draft is historical and terminal across domain/repository writes', async () => {
  const repository = new InMemoryOrderRepository();
  const draft = await create(repository, 'cancelled-draft');
  const cancelled = await cancel(repository, draft);
  assert.equal(
    await repository.findPendingByConversation('conversation-' + draft.id),
    null,
  );
  const isCancelled = (/** @type {any} */ error) =>
    error.code === 'ORDER_CANCELLED';
  assert.throws(() => requireUnlocked(cancelled), isCancelled);
  assert.throws(
    () =>
      confirmOrder(cancelled, {
        actorId: ACTOR.id,
        now: NOW,
        paymentCondition: 'pix',
      }),
    isCancelled,
  );
  assert.throws(
    () =>
      reopenOrder(
        { ...cancelled, status: 'confirmado' },
        { actorId: ACTOR.id, now: NOW },
      ),
    isCancelled,
  );
  assert.throws(
    () =>
      recordMilestones(cancelled, {
        paidOn: null,
        deliveredOn: null,
        now: NOW,
      }),
    isCancelled,
  );
  await assert.rejects(
    repository.saveSection(cancelled, {
      actor: ACTOR,
      expectedVersion: cancelled.version,
      correlationId: 'edit-cancelled',
    }),
    isCancelled,
  );
  assert.equal((await repository.list({ limit: 10 })).items.length, 0);
  assert.equal(
    (await repository.list({ limit: 10, cancellation: 'all' })).items.length,
    1,
  );
});

test('OLIST-T23 cancellation filter rejects unknown values without changing status vocabulary', () => {
  assert.equal(readOrderListQuery({ limit: 1 }).cancellation, 'active');
  assert.throws(
    () =>
      readOrderListQuery({
        limit: 1,
        cancellation: /** @type {any} */ ('other'),
      }),
    { code: 'ORDER_INVALID' },
  );
});

test('OLIST-T23 cancellation refuses another manual owner, stale version and malformed reason', async () => {
  const repository = new InMemoryOrderRepository();
  const order = await repository.createPending({
    id: 'owned-manual',
    conversationId: null,
    manualOwnerId: ACTOR.id,
    fabCode: 'SYNTHETIC',
    ficha: briefingToFicha(null),
    totalPieces: 0,
    missingFields: [],
    createdByKind: 'user',
    createdBy: ACTOR.id,
    firstContactAt: null,
    correlationId: 'create-manual',
    now: NOW,
  });
  const input = {
    actor: ACTOR,
    orderId: order.id,
    expectedVersion: order.version,
    reason: 'Desistência',
    correlationId: 'cancel-manual',
    now: NOW,
  };
  await assert.rejects(
    repository.cancelOrder({
      ...input,
      actor: { ...ACTOR, id: 'another-seller' },
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    repository.cancelOrder({ ...input, expectedVersion: order.version + 1 }),
    { code: 'VERSION_CONFLICT' },
  );
  for (const reason of ['', '  ', 'x'.repeat(1001), 'line\nbreak']) {
    await assert.rejects(repository.cancelOrder({ ...input, reason }), {
      code: 'ORDER_INVALID',
    });
  }
  assert.equal((await repository.findById(order.id))?.version, order.version);
  assert.equal(repository.audits().length, 0);
});
