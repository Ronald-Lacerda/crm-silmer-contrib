import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { syntheticItems } from './fixtures/order-items.js';
import { priceDraft } from './fixtures/size-pricing.js';

// ADR 018: the client of an order follows the contact while it is pending.
const OWNER = Object.freeze({
  capabilities: [],
  id: 'seller-1',
  kind: 'human',
});

function setup() {
  const repository = new InMemoryOrderRepository();
  /** @type {Record<string, {briefing: Record<string, unknown>|null, customerName: string|null}>} */
  const contexts = {
    'conversation-1': {
      briefing: { customer_name: 'Nome Dito Ao Bot', product_type: 'camisa' },
      customerName: 'Ana Sintetica',
    },
    'conversation-2': { briefing: null, customerName: 'Bruno Sintetico' },
  };
  /** @type {string[][]} */
  const reads = [];
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  const service = createOrderService({
    authorizeOwnership: async () => {},
    clock: () => new Date((now += 60_000)),
    conversations: {
      readOrderContexts: async (/** @type {string[]} */ ids) => {
        reads.push([...ids]);
        return new Map(
          ids
            .filter((id) => id in contexts)
            .map((id) => [id, structuredClone(contexts[id])]),
        );
      },
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    repository,
  });

  /** @param {string} conversationId */
  async function pending(conversationId) {
    return (
      await service.ensurePendingFromIntent({
        conversationId,
        correlationId: `correlation-${conversationId}`,
      })
    ).order;
  }

  /**
   * Completes the order; `beforeGenerating` runs between the last save and
   * generating, so a rename there is seen only by the confirmation.
   *
   * @param {any} order @param {() => void} [beforeGenerating]
   */
  async function generate(order, beforeGenerating) {
    const promised = await service.patchSection({
      actor: OWNER,
      correlationId: 'correlation-summary',
      expectedVersion: order.version,
      orderId: order.id,
      section: 'summary',
      value: {
        aplicacao: null,
        data_entrega_confirmada: '2026-10-24',
        nome: null,
      },
    });
    const items = await service.patchSection({
      actor: OWNER,
      correlationId: 'correlation-items',
      expectedVersion: promised.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    });
    let ready = await service.patchSection({
      actor: OWNER,
      correlationId: 'correlation-artwork',
      expectedVersion: items.version,
      orderId: order.id,
      section: 'artwork',
      value: { feito_pela_silmer: false, feito_pelo_cliente: true },
    });
    ready = await priceDraft(service, ready, 15000, OWNER);
    beforeGenerating?.();
    return service.confirm({
      actor: OWNER,
      amountText: '150,00',
      correlationId: 'correlation-confirm',
      expectedVersion: ready.version,
      orderId: order.id,
      paymentCondition: 'pix',
    });
  }

  /** @param {string} orderId */
  async function shown(orderId) {
    const [listed] = (await service.list({})).items.filter(
      (/** @type {any} */ order) => order.id === orderId,
    );
    const order = await service.get(orderId);
    return {
      current: (
        await service.currentForConversation(
          /** @type {string} */ (order.conversationId),
        )
      )?.ficha.summary.cliente,
      detail: order.ficha.summary.cliente,
      list: listed?.ficha.summary.cliente,
    };
  }

  /** @param {string} cliente */
  const everywhere = (cliente) => ({
    current: cliente,
    detail: cliente,
    list: cliente,
  });

  return {
    contexts,
    everywhere,
    generate,
    pending,
    reads,
    repository,
    service,
    shown,
  };
}

test('a pending order shows the contact as renamed, without changing the order (PCT-01)', async () => {
  const { contexts, everywhere, pending, repository, shown } = setup();
  const created = await pending('conversation-1');
  assert.equal(created.ficha.summary.cliente, 'Ana Sintetica');

  contexts['conversation-1'].customerName = 'Ana Paula Sintetica';
  assert.deepEqual(await shown(created.id), everywhere('Ana Paula Sintetica'));

  // The rename is not a change to the order: nothing is written.
  const stored = await repository.findById(created.id);
  assert.equal(stored?.version, created.version);
  assert.equal(stored?.updatedAt, created.updatedAt);
  assert.equal(stored?.ficha.summary.cliente, 'Ana Sintetica');
  assert.deepEqual(
    repository.eventsFor(created.id).map((event) => event.eventType),
    ['order.created'],
  );

  // A name cleared by a person falls back to what the customer told the bot,
  // then to blank (PIT-11); the order never keeps the old name.
  contexts['conversation-1'].customerName = null;
  assert.deepEqual(await shown(created.id), everywhere('Nome Dito Ao Bot'));
  contexts['conversation-1'].briefing = { product_type: 'camisa' };
  assert.deepEqual(await shown(created.id), everywhere(''));
});

test('a list reads the client of every pending order in one go and leaves the generated ones alone', async () => {
  const { contexts, generate, pending, reads, service } = setup();
  const first = await pending('conversation-1');
  const second = await pending('conversation-2');
  const generated = await generate(await pending('conversation-1'));
  assert.equal(generated.id, first.id);
  const newer = await pending('conversation-1');
  contexts['conversation-1'].customerName = 'Ana Renomeada';
  contexts['conversation-2'].customerName = 'Bruno Renomeado';

  reads.length = 0;
  const page = await service.list({});
  assert.deepEqual(reads, [['conversation-1', 'conversation-2']]);
  assert.deepEqual(
    page.items.map((/** @type {any} */ order) => [
      order.id,
      order.status,
      order.ficha.summary.cliente,
    ]),
    [
      [newer.id, 'pendente', 'Ana Renomeada'],
      [generated.id, 'confirmado', 'Ana Sintetica'],
      [second.id, 'pendente', 'Bruno Renomeado'],
    ],
  );

  reads.length = 0;
  assert.equal(
    (await service.get(generated.id)).ficha.summary.cliente,
    'Ana Sintetica',
  );
  assert.deepEqual(reads, [], 'a generated order does not read the contact');
});

test('generating writes down the client the order showed; a later rename never reaches it (PCT-02)', async () => {
  const { contexts, everywhere, generate, pending, repository, shown } =
    setup();
  const created = await pending('conversation-1');

  // Renamed after the last save: only the confirmation reads the new name.
  const generated = await generate(created, () => {
    contexts['conversation-1'].customerName = 'Ana Paula Sintetica';
  });
  assert.equal(generated.status, 'confirmado');
  assert.equal(generated.ficha.summary.cliente, 'Ana Paula Sintetica');
  assert.equal(
    (await repository.findById(created.id))?.ficha.summary.cliente,
    'Ana Paula Sintetica',
  );

  contexts['conversation-1'].customerName = 'Outra Pessoa';
  assert.deepEqual(await shown(created.id), everywhere('Ana Paula Sintetica'));
});

test('reopened, the order follows the contact again, and generating again writes the newest name (PCT-03)', async () => {
  const { contexts, everywhere, generate, pending, service, shown } = setup();
  const generated = await generate(await pending('conversation-1'));
  contexts['conversation-1'].customerName = 'Ana Renomeada';

  const reopened = await service.reopen({
    actor: OWNER,
    correlationId: 'correlation-reopen',
    expectedVersion: generated.version,
    orderId: generated.id,
  });
  assert.equal(reopened.status, 'pendente');
  assert.equal(reopened.ficha.summary.cliente, 'Ana Renomeada');
  contexts['conversation-1'].customerName = 'Ana Renomeada Duas Vezes';
  assert.deepEqual(
    await shown(generated.id),
    everywhere('Ana Renomeada Duas Vezes'),
  );

  const again = await service.confirm({
    actor: OWNER,
    amountText: '150,00',
    correlationId: 'correlation-confirm-again',
    expectedVersion: reopened.version,
    orderId: generated.id,
    paymentCondition: 'pix',
  });
  assert.equal(again.ficha.summary.cliente, 'Ana Renomeada Duas Vezes');
  contexts['conversation-1'].customerName = 'Mais Um Nome';
  assert.deepEqual(
    await shown(generated.id),
    everywhere('Ana Renomeada Duas Vezes'),
  );
});

test('saving a section and the bot projection write the client the order shows now', async () => {
  const { contexts, pending, repository, service } = setup();
  const created = await pending('conversation-1');

  contexts['conversation-1'].customerName = 'Ana Renomeada';
  const saved = await service.patchSection({
    actor: OWNER,
    correlationId: 'correlation-observations',
    expectedVersion: created.version,
    orderId: created.id,
    section: 'observations',
    value: ['Conferir a arte'],
  });
  assert.equal(saved.ficha.summary.cliente, 'Ana Renomeada');
  assert.equal(
    (await repository.findById(created.id))?.ficha.summary.cliente,
    'Ana Renomeada',
  );

  contexts['conversation-1'].customerName = 'Ana Pelo Bot';
  const projected = await service.projectAgentBriefing({
    automationState: 'assistant',
    briefing: { colors: 'preta', customer_name: 'Ana Pelo Bot' },
    conversationId: 'conversation-1',
    correlationId: 'correlation-projection',
  });
  assert.equal(projected.order?.ficha.summary.cliente, 'Ana Pelo Bot');
  assert.equal(
    (await repository.findById(created.id))?.ficha.summary.cliente,
    'Ana Pelo Bot',
  );
});
