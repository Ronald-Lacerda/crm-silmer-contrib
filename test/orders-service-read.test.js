import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { confirmOrder } from '../modules/orders/src/domain/order.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import { fixturePricing } from './fixtures/size-pricing.js';

async function setup() {
  const repository = new InMemoryOrderRepository();
  let now = Date.parse('2026-09-12T15:00:00.000Z');
  const clock = () => {
    now += 60_000;
    return new Date(now);
  };
  /** @type {string[]} */
  const searches = [];
  /** @type {Record<string, string[]>} */
  const customerIndex = {
    horizonte: ['conversation-1', 'conversation-3'],
    11999990000: ['conversation-2'],
  };
  const service = createOrderService({
    authorizeOwnership: async () => {},
    clock,
    conversations: {
      readOrderContexts: orderContextsFrom(() => ({
        briefing: { product_type: 'camisa' },
        customerName: 'Cliente Sintetico',
      })),
      searchConversationIds: async (/** @type {string} */ query) => {
        searches.push(query);
        return customerIndex[query.toLowerCase()] ?? [];
      },
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
  /** @param {any} order */
  async function confirm(order) {
    const withGrade = await repository.saveSection(
      {
        ...order,
        ficha: fixturePricing(
          {
            ...order.ficha,
            artwork: { ...order.ficha.artwork, sem_estampa: true },
            summary: {
              ...order.ficha.summary,
              data_entrega_confirmada: '2026-10-24',
            },
            items: [
              {
                ...order.ficha.items[0],
                cor: 'BRANCA',
                gola: 'GOLA REDONDA',
                grade: [{ quantidade: 1, tamanho: 'M' }],
                malhas: ['ALGODÃO'],
                tipo_servico: 'SEM ESTAMPA',
              },
            ],
          },
          1000,
        ),
        totalPieces: 1,
        updatedAt: clock().toISOString(),
      },
      { correlationId: 'correlation-grade', expectedVersion: order.version },
    );
    return repository.saveStatus(
      confirmOrder(withGrade, {
        actorId: 'seller-1',
        amountCents: 1000,
        now: clock(),
        paymentCondition: 'pix',
      }),
      {
        correlationId: 'correlation-confirm',
        expectedVersion: withGrade.version,
      },
    );
  }
  return { confirm, pending, repository, searches, service };
}

test('gets an order by id or refuses as not found', async () => {
  const { pending, service } = await setup();
  const order = await pending('conversation-1');
  assert.deepEqual(await service.get(order.id), order);
  await assert.rejects(service.get('missing'), {
    code: 'ORDER_NOT_FOUND',
    statusCode: 404,
  });
});

test('lists by status with counts per group and cursor pages', async () => {
  const { confirm, pending, service } = await setup();
  const first = await pending('conversation-1');
  const second = await confirm(await pending('conversation-2'));
  const third = await pending('conversation-3');

  const all = await service.list({});
  assert.deepEqual(
    all.items.map((/** @type {any} */ order) => order.id),
    [third.id, second.id, first.id],
  );
  assert.deepEqual(all.counts, { confirmado: 1, pendente: 2 });
  assert.equal(all.nextCursor, null);

  const confirmed = await service.list({ status: 'confirmado' });
  assert.deepEqual(
    confirmed.items.map((/** @type {any} */ order) => order.id),
    [second.id],
  );
  assert.deepEqual(confirmed.counts, { confirmado: 1, pendente: 2 });

  const page = await service.list({ limit: 2 });
  assert.equal(page.items.length, 2);
  const rest = await service.list({ cursor: page.nextCursor, limit: 2 });
  assert.deepEqual(
    rest.items.map((/** @type {any} */ order) => order.id),
    [first.id],
  );
  assert.equal(rest.nextCursor, null);
});

test('searches by order number or by customer and phone through the conversation', async () => {
  const { pending, searches, service } = await setup();
  const first = await pending('conversation-1');
  const second = await pending('conversation-2');
  const third = await pending('conversation-3');

  for (const q of ['2', '02', '02-CRM', ' 2-crm ']) {
    const result = await service.list({ q });
    assert.deepEqual(
      result.items.map((/** @type {any} */ order) => order.id),
      [second.id],
      `query ${JSON.stringify(q)}`,
    );
  }

  const byCustomer = await service.list({ q: 'Horizonte' });
  assert.deepEqual(
    byCustomer.items.map((/** @type {any} */ order) => order.id),
    [third.id, first.id],
  );
  assert.deepEqual(byCustomer.counts, { confirmado: 0, pendente: 2 });

  const byPhone = await service.list({ q: '11999990000' });
  assert.deepEqual(
    byPhone.items.map((/** @type {any} */ order) => order.id),
    [second.id],
  );

  const nothing = await service.list({ q: 'ninguém' });
  assert.deepEqual(nothing.items, []);
  assert.deepEqual(nothing.counts, { confirmado: 0, pendente: 0 });

  searches.length = 0;
  assert.equal((await service.list({ q: '   ' })).items.length, 3);
  assert.deepEqual(searches, [], 'a blank query does not search');
});

test('refuses malformed list parameters', async () => {
  const { service } = await setup();
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { status: 'cancelado' },
    { cursor: 'nope' },
    { q: 'x'.repeat(121) },
    { unknown: true },
  ]) {
    await assert.rejects(
      service.list(/** @type {any} */ (query)),
      { code: 'ORDER_INVALID', statusCode: 400 },
      JSON.stringify(query),
    );
  }
});

test('the current order of a conversation is its pending one, else the last confirmed', async () => {
  const { confirm, pending, service } = await setup();
  assert.equal(await service.currentForConversation('conversation-1'), null);

  const older = await confirm(await pending('conversation-1'));
  const newer = await confirm(await pending('conversation-1'));
  assert.deepEqual(
    await service.currentForConversation('conversation-1'),
    newer,
  );
  assert.notEqual(older.id, newer.id);

  const open = await pending('conversation-1');
  assert.deepEqual(
    await service.currentForConversation('conversation-1'),
    open,
  );
});

test('reads an order saved before ADR 016 under the current rules', async () => {
  const { repository, service } = await setup();
  // As stored on 02/10/2026: no colour, artwork or collar, and the list of
  // what was missing under rule A01.
  const stored = await repository.createPending({
    conversationId: 'conversation-old',
    correlationId: 'correlation-old',
    createdBy: null,
    createdByKind: 'automation',
    fabCode: '01',
    ficha: /** @type {any} */ ({
      items: [
        {
          cor_costas: '',
          cor_frente: '',
          cor_manga_direita: '',
          cor_manga_esquerda: '',
          grade: [],
          malhas: ['Definir com o vendedor'],
          modelo: 'camiseta comum, gola V',
          tipo: '',
          vies_gola: '',
          vies_mangas: '',
        },
      ],
      observations: [],
      serviceData: { colors: 'preta', quantity: 30 },
      summary: {
        aplicacao: 'estampada',
        cliente: 'Cliente Sintetico',
        data_entrega_confirmada: null,
        nome: null,
      },
    }),
    firstContactAt: null,
    id: 'order-old',
    missingFields: ['items', 'finalAmount', 'summary.nome'],
    now: new Date('2026-10-02T12:00:00.000Z'),
    totalPieces: 0,
  });
  const expectedMissing = [
    'items[0].tipo',
    'items[0].cor',
    'items[0].tipo_servico',
    'items[0].grade',
    'items[0].gola',
    'artwork',
    'summary.data_entrega_confirmada',
    'finalAmount',
    'paymentCondition',
    'sizePricing',
  ];

  const read = await service.get(stored.id);
  assert.equal(read.ficha.items[0].cor, '');
  assert.equal(read.ficha.items[0].estampa, '');
  assert.equal(read.ficha.items[0].gola, '');
  assert.equal(read.ficha.items[0].modelo, 'camiseta comum, gola V');
  assert.deepEqual(read.missingFields, expectedMissing);
  assert.equal(read.totalPieces, 0);

  const listed = await service.list({});
  assert.deepEqual(listed.items[0].missingFields, expectedMissing);
  assert.equal(listed.items[0].ficha.items[0].gola, '');
  assert.deepEqual(
    (await service.currentForConversation('conversation-old'))?.missingFields,
    expectedMissing,
  );
  assert.deepEqual(
    (await repository.findById(stored.id))?.missingFields,
    ['items', 'finalAmount', 'summary.nome'],
    'nothing is rewritten by a read',
  );
});
