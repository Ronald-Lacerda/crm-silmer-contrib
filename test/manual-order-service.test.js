import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { syntheticItems } from './fixtures/order-items.js';

const OWNER = { id: 'seller-1', kind: 'human', capabilities: [] };
const OTHER = { id: 'seller-2', kind: 'human', capabilities: [] };

function setup() {
  const repository = new InMemoryOrderRepository();
  const names = new Map([['contact-1', 'Cliente Sintético']]);
  let sequence = 0;
  let now = new Date('2026-10-22T01:30:00.000Z');
  const service = createOrderService({
    clock: () => now,
    authorizeOwnership: async () => undefined,
    authorizeManualOwnership: async ({ actor, ownerId }) => {
      if (
        actor.id !== ownerId &&
        !(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')
      ) {
        throw Object.assign(new Error('not owner'), {
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      }
    },
    conversations: {
      readContactNames: async (ids) =>
        new Map(
          ids
            .filter((id) => names.has(id))
            .map((id) => [id, names.get(id) ?? null]),
        ),
      readOrderContexts: async () => new Map(),
      searchContactIds: async () => ['contact-1'],
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    idFactory: () => `manual-order-${++sequence}`,
    repository,
  });
  return {
    names,
    repository,
    service,
    setClock: (/** @type {Date} */ value) => {
      now = value;
    },
  };
}

/**
 * @param {ReturnType<typeof setup>['service']} service
 * @param {string} key
 * @param {typeof OWNER} [actor]
 * @param {string} [contactId]
 */
function create(service, key, actor = OWNER, contactId = 'contact-1') {
  return service.createForContact({
    actor,
    contactId,
    correlationId: `correlation-${key}`,
    idempotencyKey: key,
  });
}

test('manual orders are independent drafts for the same contact and retry is stable', async () => {
  const { repository, service } = setup();
  const [first, second] = await Promise.all([
    create(service, 'request-1'),
    create(service, 'request-2'),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.number, second.number);
  assert.equal(first.conversationId, null);
  assert.equal(first.contactId, 'contact-1');
  assert.equal(first.manualOwnerId, OWNER.id);
  assert.equal(first.status, 'pendente');
  assert.equal(first.firstContactAt, first.createdAt);
  assert.equal(first.ficha.summary.cliente, 'Cliente Sintético');
  assert.equal((await create(service, 'request-1')).id, first.id);
  const concurrent = await Promise.all([
    create(service, 'request-concurrent'),
    create(service, 'request-concurrent'),
  ]);
  assert.equal(concurrent[0].id, concurrent[1].id);
  assert.equal((await repository.list({ limit: 10 })).counts.pendente, 3);
});

test('manual first contact is stable on a retry on another day', async () => {
  const { service, setClock } = setup();
  const first = await create(service, 'retry-contact');
  setClock(new Date('2026-10-24T15:00:00.000Z'));
  const replay = await create(service, 'retry-contact');
  assert.equal(replay.firstContactAt, first.createdAt);
  assert.equal(replay.createdAt, first.createdAt);
});

/** @param {ReturnType<typeof setup>['service']} service @param {string} key @param {typeof OWNER} [actor] */
async function confirmedManual(service, key, actor = OWNER) {
  let order = await create(service, key, actor);
  for (const [section, value] of Object.entries({
    summary: {
      nome: 'Evento Sintético',
      data_entrega_confirmada: '2026-10-24',
    },
    items: syntheticItems(),
    artwork: { feito_pelo_cliente: true, feito_pela_silmer: false },
  })) {
    order = await service.patchSection({
      actor,
      correlationId: key,
      orderId: order.id,
      expectedVersion: order.version,
      section,
      value,
    });
  }
  return service.confirm({
    actor,
    correlationId: key,
    orderId: order.id,
    expectedVersion: order.version,
    amountText: '100,00',
    paymentCondition: 'pix',
  });
}

test('delivery afazeres are only own confirmed undelivered manual orders', async () => {
  const { service } = setup();
  const first = await confirmedManual(service, 'own-delivery');
  const other = await confirmedManual(service, 'other-delivery', OTHER);
  await create(service, 'pending-delivery');
  assert.deepEqual(
    (await service.deliveryTasks({ actor: OWNER })).map((o) => o.id),
    [first.id],
  );
  assert.deepEqual(
    (await service.deliveryTasks({ actor: OTHER })).map((o) => o.id),
    [other.id],
  );
  await assert.rejects(
    service.deliveryTasks({
      actor: { id: 'bot', kind: 'automation', capabilities: [] },
    }),
    { code: 'FORBIDDEN' },
  );
});

test('manual delivery confirmation uses São Paulo today, preserves payment and handles concurrent requests', async () => {
  const { service, repository } = setup();
  const created = await confirmedManual(service, 'confirm-delivery');
  const paid = await service.recordMilestones({
    actor: OWNER,
    correlationId: 'paid',
    orderId: created.id,
    expectedVersion: created.version,
    paidOn: '2026-10-20',
  });
  const command = {
    actor: OWNER,
    correlationId: 'deliver',
    orderId: paid.id,
    expectedVersion: paid.version,
  };
  await assert.rejects(service.confirmDelivery({ ...command, actor: OTHER }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    service.recordMilestones({
      ...command,
      paidOn: null,
      deliveredOn: '2026-10-20',
    }),
    { code: 'ORDER_INVALID' },
  );
  const results = await Promise.allSettled([
    service.confirmDelivery(command),
    service.confirmDelivery(command),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const delivered = await service.get(paid.id);
  assert.equal(delivered.deliveredOn, '2026-10-21');
  assert.equal(delivered.paidOn, '2026-10-20');
  assert.equal(delivered.status, 'confirmado');
  assert.equal(delivered.version, paid.version + 1);
  assert.equal((await service.deliveryTasks({ actor: OWNER })).length, 0);
  assert.equal(
    (
      await service.confirmDelivery({
        ...command,
        expectedVersion: delivered.version,
      })
    ).version,
    delivered.version,
  );
  const cleared = await service.recordMilestones({
    ...command,
    expectedVersion: delivered.version,
    paidOn: null,
  });
  assert.equal(cleared.deliveredOn, '2026-10-21');
  assert.equal(
    repository
      .eventsFor(paid.id)
      .filter((e) => e.eventType === 'order.milestones_saved').length,
    3,
  );
});

test('a pending manual order cannot be marked delivered', async () => {
  const { service } = setup();
  const pending = await create(service, 'not-confirmed');
  await assert.rejects(
    service.confirmDelivery({
      actor: OWNER,
      correlationId: 'pending',
      orderId: pending.id,
      expectedVersion: pending.version,
    }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
});

test('an administrator can confirm delivery but their own afazeres exclude another seller', async () => {
  const { service } = setup();
  const confirmed = await confirmedManual(service, 'admin-delivery');
  const admin = {
    id: 'admin-1',
    kind: 'human',
    capabilities: ['COMMERCIAL_ADMIN'],
  };
  assert.deepEqual(await service.deliveryTasks({ actor: admin }), []);
  const delivered = await service.confirmDelivery({
    actor: admin,
    correlationId: 'admin',
    orderId: confirmed.id,
    expectedVersion: confirmed.version,
  });
  assert.equal(delivered.deliveredOn, '2026-10-21');
});

test('manual draft follows contact name and refuses unknown contact or another owner', async () => {
  const { names, service } = setup();
  await assert.rejects(create(service, 'missing', OWNER, 'unknown'), {
    code: 'CONTACT_NOT_FOUND',
  });
  const created = await create(service, 'request-1');
  names.set('contact-1', 'Nome Corrigido');
  assert.equal(
    (await service.get(created.id)).ficha.summary.cliente,
    'Nome Corrigido',
  );
  await assert.rejects(
    service.patchSection({
      actor: OTHER,
      correlationId: 'correlation-edit',
      expectedVersion: created.version,
      orderId: created.id,
      section: 'summary',
      value: { data_entrega_confirmada: '2026-10-24', nome: 'Evento' },
    }),
    { code: 'FORBIDDEN' },
  );
});
