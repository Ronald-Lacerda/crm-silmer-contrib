import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderFileService } from '../modules/orders/src/application/order-file-service.js';
import { createStoreOrderCorrectionService } from '../modules/orders/src/application/store-order-correction-service.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import {
  InMemoryObjectStorage,
  InMemoryOrderFileRepository,
} from '../modules/orders/src/adapters/in-memory-order-files.js';
import { briefingToFicha } from '../modules/orders/src/domain/ficha.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const ACTOR = { id: 'file-owner-synthetic', kind: 'human', capabilities: [] };
const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');

async function fixture() {
  const orders = new InMemoryOrderRepository();
  const order = await orders.createPending({
    id: 'synthetic-file-order',
    conversationId: null,
    manualOwnerId: ACTOR.id,
    fabCode: 'SYNTHETIC',
    ficha: briefingToFicha(null),
    totalPieces: 0,
    missingFields: [],
    createdByKind: 'user',
    createdBy: ACTOR.id,
    firstContactAt: null,
    correlationId: 'create-file-order',
    now: NOW,
  });
  const files = new InMemoryOrderFileRepository(orders);
  const storage = new InMemoryObjectStorage();
  const service = createOrderFileService({
    orders,
    files,
    storage,
    authorizeOwnership: async () => {},
    clock: () => NOW,
  });
  const cancel = () =>
    orders.cancelOrder({
      actor: ACTOR,
      orderId: order.id,
      expectedVersion: order.version,
      reason: 'Desistência antes da exportação',
      correlationId: 'cancel-file-order',
      now: NOW,
    });
  return { order, orders, files, storage, service, cancel };
}

test('OLIST-T23 cancelled art remains readable while upload and delete are denied', async () => {
  const f = await fixture();
  const uploaded = await f.service.upload({
    actor: ACTOR,
    orderId: f.order.id,
    slot: 'final',
    name: 'arte.pdf',
    content: PDF,
  });
  await f.cancel();
  await assert.rejects(
    f.service.upload({
      actor: ACTOR,
      orderId: f.order.id,
      slot: 'final',
      name: 'nova.pdf',
      content: PDF,
    }),
    { code: 'ORDER_CANCELLED' },
  );
  await assert.rejects(
    f.service.remove({
      actor: ACTOR,
      orderId: f.order.id,
      fileId: uploaded.file.id,
    }),
    { code: 'ORDER_CANCELLED' },
  );
  assert.equal((await f.service.list(f.order.id)).final?.id, uploaded.file.id);
  const opened = await f.service.openContent(f.order.id, uploaded.file.id);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), PDF);
  assert.equal(f.storage.objects.size, 1);
});

test('OLIST-T23 cancellation between storage upload and catalog commit preserves previous art and cleans new bytes', async () => {
  const f = await fixture();
  const original = await f.service.upload({
    actor: ACTOR,
    orderId: f.order.id,
    slot: 'final',
    name: 'original.pdf',
    content: PDF,
  });
  const put = f.storage.putObject.bind(f.storage);
  f.storage.putObject = async (...args) => {
    await put(...args);
    await f.cancel();
  };
  await assert.rejects(
    f.service.upload({
      actor: ACTOR,
      orderId: f.order.id,
      slot: 'final',
      name: 'replacement.pdf',
      content: PDF,
    }),
    { code: 'ORDER_CANCELLED' },
  );
  assert.equal(
    (await f.files.listByOrder(f.order.id))[0]?.id,
    original.file.id,
  );
  assert.deepEqual([...f.storage.objects.keys()], [original.file.objectKey]);
});

test('OLIST-T23 cancelled store order cannot enter quantity correction', async () => {
  let writes = 0;
  const service = createStoreOrderCorrectionService({
    repository: {
      findById: async () => ({ cancelledAt: NOW.toISOString() }),
      correctStoreOrder: async () => {
        writes += 1;
      },
    },
  });
  await assert.rejects(
    service.correct({
      actor: { ...ACTOR, capabilities: ['COMMERCIAL_ADMIN'] },
      orderId: 'cancelled-store-synthetic',
      expectedVersion: 1,
      expectedQuantity: 2,
      expectedAmountCents: 3600,
      quantity: 1,
      reason: 'USER_CONFIRMED_QUANTITY',
      correlationId: 'correct-cancelled-store',
      idempotencyKey: 'correct-cancelled-store',
    }),
    { code: 'ORDER_CANCELLED' },
  );
  assert.equal(writes, 0);
});

test('OLIST-T23 cancellation after delete preflight preserves catalog and stored art', async () => {
  const f = await fixture();
  const original = await f.service.upload({
    actor: ACTOR,
    orderId: f.order.id,
    slot: 'final',
    name: 'original.pdf',
    content: PDF,
  });
  const remove = f.files.remove.bind(f.files);
  f.files.remove = async (...args) => {
    await f.cancel();
    return remove(...args);
  };
  await assert.rejects(
    f.service.remove({
      actor: ACTOR,
      orderId: f.order.id,
      fileId: original.file.id,
    }),
    { code: 'ORDER_CANCELLED' },
  );
  assert.equal(
    (await f.files.listByOrder(f.order.id))[0]?.id,
    original.file.id,
  );
  assert.deepEqual([...f.storage.objects.keys()], [original.file.objectKey]);
});
