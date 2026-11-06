import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { confirmOrder } from '../modules/orders/src/domain/order.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import { fixturePricing } from './fixtures/size-pricing.js';

const NOW = new Date('2026-09-12T15:00:00.000Z');
const OWNER = Object.freeze({
  capabilities: [],
  id: 'seller-1',
  kind: 'human',
});
const OTHER = Object.freeze({
  capabilities: [],
  id: 'seller-2',
  kind: 'human',
});

// The seven points of ADR 012, as the bot records them.
const BRIEFING = Object.freeze({
  artwork_locations: 'frente',
  artwork_status: 'já tem a arte',
  artwork_technique: 'sublimação total',
  briefing_status: 'collecting',
  collar: 'gola V',
  colors: 'azul',
  customer_name: 'Nome Dito Na Conversa',
  fabrics: 'dry fit',
  next_required_field: 'sizes',
  order_name: 'Equipe Horizonte',
  product_model: 'camiseta comum',
  product_type: 'camisa',
  quantity: 12,
  sizes: '4 P, 6 M',
});

/**
 * The delivery date and item technique a seller would set before confirmation.
 *
 * @param {any} order
 */
function sellerCompleted(order) {
  return {
    ...order,
    ficha: fixturePricing(
      {
        ...order.ficha,
        items: order.ficha.items.map((/** @type {any} */ item) => ({
          ...item,
          tipo_servico: 'Sublimação escolhida pelo vendedor',
        })),
        summary: {
          ...order.ficha.summary,
          data_entrega_confirmada: '2026-10-24',
        },
      },
      1000,
    ),
  };
}

/** @param {{contexts?: Record<string, any>, owners?: Record<string, string|null>}} [options] */
function setup(options = {}) {
  const repository = new InMemoryOrderRepository();
  const contexts = options.contexts ?? {
    'conversation-1': {
      briefing: BRIEFING,
      customerName: 'Cliente Sintetico',
      openedAt: '2026-09-01T13:05:00.000Z',
    },
    'conversation-2': { briefing: null, customerName: null },
  };
  const owners = options.owners ?? {
    'conversation-1': 'seller-1',
    'conversation-2': 'seller-1',
  };
  /** @type {Array<{conversationId: string, actor: any}>} */
  const ownershipChecks = [];
  let sequence = 0;
  const service = createOrderService({
    authorizeOwnership: async ({ actor, conversationId }) => {
      ownershipChecks.push({ actor, conversationId });
      if (owners[conversationId] !== actor.id) {
        const error = Object.assign(new Error('not the owner'), {
          code: 'FORBIDDEN',
          statusCode: 403,
        });
        throw error;
      }
    },
    clock: () => NOW,
    conversations: {
      readOrderContexts: orderContextsFrom(
        (/** @type {string} */ conversationId) =>
          contexts[conversationId] ?? null,
      ),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    idFactory: () => {
      sequence += 1;
      return `order-${sequence}`;
    },
    repository,
  });
  return { ownershipChecks, repository, service };
}

test('an intent without a pending order creates one pre-filled from the pre-ficha', async () => {
  const { repository, service } = setup();
  const result = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-intent',
  });

  assert.equal(result.created, true);
  const { order } = result;
  assert.equal(order.status, 'pendente');
  assert.equal(order.number, '01-CRM');
  assert.equal(order.fabCode, '01');
  assert.equal(order.createdByKind, 'automation');
  assert.equal(order.createdBy, null);
  assert.equal(order.createdAt, NOW.toISOString());
  // PLA-02: the first contact is copied from the conversation, not typed.
  assert.equal(order.firstContactAt, '2026-09-01T13:05:00.000Z');
  assert.equal(order.paidOn, null);
  assert.equal(order.deliveredOn, null);
  assert.equal(order.ficha.summary.cliente, 'Cliente Sintetico');
  assert.equal(order.ficha.summary.nome, 'Equipe Horizonte');
  assert.equal(order.ficha.summary.aplicacao, null);
  // ADR 016/020: the points land on item 1 and the art on the order, with
  // nothing left to fill.
  assert.deepEqual(order.ficha.artwork, {
    feito_pela_silmer: false,
    feito_pelo_cliente: true,
    files: [],
    sem_estampa: false,
  });
  const [item] = order.ficha.items;
  assert.equal(item.tipo, 'camiseta comum');
  assert.equal(item.cor, 'azul');
  assert.equal(item.estampa, 'frente');
  assert.deepEqual(item.malhas, ['dry fit']);
  assert.deepEqual(item.grade, [
    { quantidade: 4, tamanho: 'P' },
    { quantidade: 6, tamanho: 'M' },
  ]);
  assert.equal(item.gola, 'gola V');
  assert.equal(item.modelo, '');
  assert.equal(item.tipo_servico, 'sublimação total', 'o bot sugere a técnica');
  assert.equal(order.ficha.serviceData.quantity, 12);
  assert.equal(order.ficha.serviceData.product_type, 'camisa');
  assert.equal(order.totalPieces, 10);
  // The bot never knows the promised delivery: the seller sets it.
  assert.deepEqual(order.missingFields, [
    'summary.data_entrega_confirmada',
    'finalAmount',
    'paymentCondition',
    'sizePricing',
  ]);
  assert.deepEqual(await repository.findById(order.id), order);
});

test('the customer falls back to the pre-ficha name and then to empty', async () => {
  const { service } = setup({
    contexts: {
      a: { briefing: BRIEFING, customerName: null },
      b: { briefing: null, customerName: null },
    },
  });
  const a = await service.ensurePendingFromIntent({
    conversationId: 'a',
    correlationId: 'correlation-a',
  });
  const b = await service.ensurePendingFromIntent({
    conversationId: 'b',
    correlationId: 'correlation-b',
  });
  assert.equal(a.order.ficha.summary.cliente, 'Nome Dito Na Conversa');
  assert.equal(b.order.ficha.summary.cliente, '');
  assert.deepEqual(b.order.ficha.items, []);
  assert.equal(b.order.totalPieces, 0);
  assert.equal(b.order.missingFields[0], 'items');
});

test('a repeated intent returns the existing pending order', async () => {
  const { repository, service } = setup();
  const first = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-1',
  });
  const again = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-2',
  });
  assert.equal(again.created, false);
  assert.deepEqual(again.order, first.order);

  const concurrent = await Promise.all([
    service.ensurePendingFromIntent({
      conversationId: 'conversation-2',
      correlationId: 'correlation-3',
    }),
    service.ensurePendingFromIntent({
      conversationId: 'conversation-2',
      correlationId: 'correlation-4',
    }),
  ]);
  assert.equal(concurrent[0].order.id, concurrent[1].order.id);
  assert.equal(
    (await repository.listByConversation('conversation-2')).length,
    1,
  );
});

test('an intent on a conversation with only confirmed orders creates a new pending one', async () => {
  const { repository, service } = setup();
  const { order } = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-1',
  });
  await repository.saveStatus(
    confirmOrder(sellerCompleted(order), {
      actorId: 'seller-1',
      amountCents: 1000,
      now: NOW,
      paymentCondition: 'pix',
    }),
    { correlationId: 'correlation-confirm', expectedVersion: order.version },
  );

  const next = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-2',
  });
  assert.equal(next.created, true);
  assert.notEqual(next.order.id, order.id);
  assert.equal(next.order.number, '02-CRM');
});

test('an intent on an unknown conversation is refused', async () => {
  const { service } = setup();
  await assert.rejects(
    service.ensurePendingFromIntent({
      conversationId: 'missing',
      correlationId: 'correlation-x',
    }),
    { code: 'CONVERSATION_NOT_FOUND', statusCode: 404 },
  );
});

test('the owner creates a pending order manually, pre-filled with the pre-ficha', async () => {
  const { ownershipChecks, service } = setup();
  const result = await service.createManual({
    actor: OWNER,
    conversationId: 'conversation-1',
    correlationId: 'correlation-manual',
  });
  assert.equal(result.created, true);
  assert.equal(result.order.createdByKind, 'user');
  assert.equal(result.order.createdBy, 'seller-1');
  assert.equal(result.order.ficha.summary.nome, 'Equipe Horizonte');
  assert.deepEqual(ownershipChecks, [
    { actor: OWNER, conversationId: 'conversation-1' },
  ]);

  const again = await service.createManual({
    actor: OWNER,
    conversationId: 'conversation-1',
    correlationId: 'correlation-manual-2',
  });
  assert.equal(again.created, false);
  assert.equal(again.order.id, result.order.id);
});

test('someone who does not own the conversation cannot create an order', async () => {
  const { repository, service } = setup();
  await assert.rejects(
    service.createManual({
      actor: OTHER,
      conversationId: 'conversation-1',
      correlationId: 'correlation-other',
    }),
    { code: 'FORBIDDEN', statusCode: 403 },
  );
  assert.deepEqual(await repository.listByConversation('conversation-1'), []);
  await assert.rejects(
    service.createManual({
      actor: /** @type {any} */ ({ id: 'n8n', kind: 'automation' }),
      conversationId: 'conversation-1',
      correlationId: 'correlation-automation',
    }),
    { code: 'FORBIDDEN' },
  );
});

test('the agent briefing is projected only while the conversation is with the agent', async () => {
  const { repository, service } = setup();
  const { order } = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-1',
  });
  // The seller filled parts the agent never collects.
  const edited = await repository.saveSection(
    {
      ...order,
      ficha: {
        ...order.ficha,
        items: [
          { ...order.ficha.items[0], cor_frente: 'AZUL MARINHO' },
          // Saved before ADR 016: no colour, artwork or collar.
          /** @type {any} */ ({
            cor_costas: 'PRETA',
            cor_frente: 'PRETA',
            cor_manga_direita: 'NAO APLICAVEL',
            cor_manga_esquerda: 'NAO APLICAVEL',
            grade: [{ quantidade: 2, tamanho: 'G' }],
            malhas: ['HELANCA'],
            modelo: 'ESPORTIVO',
            tipo: 'SHORT',
            vies_gola: 'NAO APLICAVEL',
            vies_mangas: 'BRANCO',
          }),
        ],
        observations: ['Separar por tamanho'],
        summary: {
          ...order.ficha.summary,
          data_entrega_confirmada: '2026-09-30',
        },
      },
    },
    { correlationId: 'correlation-edit', expectedVersion: 1 },
  );

  const ignored = await service.projectAgentBriefing({
    automationState: 'human',
    briefing: { ...BRIEFING, order_name: 'Nome Ignorado' },
    conversationId: 'conversation-1',
    correlationId: 'correlation-human',
  });
  assert.deepEqual(ignored, { applied: false, order: null, reason: 'human' });
  assert.deepEqual(await repository.findById(order.id), edited);

  const projected = await service.projectAgentBriefing({
    automationState: 'assistant',
    briefing: {
      ...BRIEFING,
      notes: 'Sem gola',
      order_name: 'Equipe Horizonte 2026',
      sizes: [{ quantity: 12, size: 'GG' }],
    },
    conversationId: 'conversation-1',
    correlationId: 'correlation-assistant',
  });
  assert.equal(projected.applied, true);
  const result = /** @type {any} */ (projected.order);
  assert.equal(result.version, edited.version + 1);
  assert.equal(result.ficha.summary.nome, 'Equipe Horizonte 2026');
  assert.equal(result.ficha.summary.data_entrega_confirmada, '2026-09-30');
  assert.equal(result.ficha.summary.cliente, 'Cliente Sintetico');
  assert.deepEqual(result.ficha.items[0].grade, [
    { quantidade: 12, tamanho: 'GG' },
  ]);
  assert.equal(result.ficha.items[0].cor_frente, 'AZUL MARINHO');
  assert.equal(result.ficha.items[0].tipo_servico, 'sublimação total');
  assert.equal(result.ficha.items[1].tipo, 'SHORT');
  // The seller's second item was saved before ADR 016 and reads blank.
  assert.equal(result.ficha.items[1].cor, '');
  assert.deepEqual(result.missingFields, [
    'items[1].cor',
    'items[1].tipo_servico',
    'finalAmount',
    'paymentCondition',
    'sizePricing',
  ]);
  assert.deepEqual(result.ficha.observations, ['Separar por tamanho']);
  assert.equal(result.ficha.serviceData.notes, 'Sem gola');
  assert.equal(result.totalPieces, 14);
  assert.equal(result.status, 'pendente');
});

test('the projection needs a pending order and never touches a confirmed one', async () => {
  const { repository, service } = setup();
  assert.deepEqual(
    await service.projectAgentBriefing({
      automationState: 'assistant',
      briefing: BRIEFING,
      conversationId: 'conversation-1',
      correlationId: 'correlation-none',
    }),
    { applied: false, order: null, reason: 'no_pending_order' },
  );

  const { order } = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-1',
  });
  const confirmed = await repository.saveStatus(
    confirmOrder(sellerCompleted(order), {
      actorId: 'seller-1',
      amountCents: 1000,
      now: NOW,
      paymentCondition: 'pix',
    }),
    { correlationId: 'correlation-confirm', expectedVersion: 1 },
  );
  const result = await service.projectAgentBriefing({
    automationState: 'assistant',
    briefing: { ...BRIEFING, order_name: 'Depois' },
    conversationId: 'conversation-1',
    correlationId: 'correlation-after',
  });
  assert.equal(result.applied, false);
  assert.deepEqual(await repository.findById(order.id), confirmed);
});

test('explicit projection writes the chosen pending order across cycles', async () => {
  const { repository, service } = setup();
  const { order } = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'create-explicit',
  });
  const result = await service.projectAgentBriefing({
    automationState: 'assistant',
    briefing: { order_name: 'Retomado no ciclo 2' },
    conversationId: 'conversation-2',
    correlationId: 'project-explicit',
    orderId: order.id,
    subjectId: 'subject-cycle-2',
    automationEpoch: 2,
    sourceRevision: 1,
    eventId: 'event-cycle-2',
    eventType: 'message.send.requested',
    expectedSubjectVersion: 1,
    expectedOrderVersion: order.version,
  });
  assert.equal(result.applied, true);
  assert.equal(result.order?.id, order.id);
  assert.equal(
    (await repository.findById(order.id))?.ficha.summary.nome,
    'Retomado no ciclo 2',
  );
});
