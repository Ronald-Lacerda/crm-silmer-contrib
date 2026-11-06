import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { syntheticItems } from './fixtures/order-items.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';

const synthetic = JSON.parse(
  await readFile(
    new URL('../docs/phase0/ficha-pdf-synthetic.json', import.meta.url),
    'utf8',
  ),
);

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
const ADMIN = Object.freeze({
  capabilities: ['COMMERCIAL_ADMIN'],
  id: 'admin-1',
  kind: 'human',
});

async function setup() {
  const repository = new InMemoryOrderRepository();
  /** @type {Record<string, string>} */
  const owners = { 'conversation-1': 'seller-1' };
  let now = Date.parse('2026-09-12T15:00:00.000Z');
  const service = createOrderService({
    authorizeOwnership: async ({ actor, conversationId }) => {
      if (
        owners[conversationId] !== actor.id &&
        !(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')
      ) {
        throw Object.assign(new Error('not the owner'), {
          code: 'FORBIDDEN',
          statusCode: 403,
        });
      }
    },
    clock: () => {
      now += 60_000;
      return new Date(now);
    },
    conversations: {
      readOrderContexts: orderContextsFrom(() => ({
        briefing: { order_name: 'Evento Inicial', product_type: 'camisa' },
        customerName: 'Cliente Sintetico',
      })),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    repository,
  });
  const { order: created } = await service.ensurePendingFromIntent({
    conversationId: 'conversation-1',
    correlationId: 'correlation-intent',
  });
  // ADR 016/020: the promised delivery and who makes the art are set, so only
  // what each test leaves out keeps the order from being generated.
  const dated = await service.patchSection({
    actor: OWNER,
    correlationId: 'correlation-delivery',
    expectedVersion: created.version,
    orderId: created.id,
    section: 'summary',
    value: {
      data_entrega_confirmada: '2026-10-24',
      nome: 'Evento Inicial',
    },
  });
  const order = await service.patchSection({
    actor: OWNER,
    correlationId: 'correlation-artwork',
    expectedVersion: dated.version,
    orderId: dated.id,
    section: 'artwork',
    value: { feito_pela_silmer: true, feito_pelo_cliente: false },
  });
  return { order, owners, repository, service };
}

/** @param {Record<string, unknown>} [extra] @returns {any} */
function command(extra = {}) {
  return { actor: OWNER, correlationId: 'correlation-command', ...extra };
}

test('saving the summary replaces the whole section but keeps the locked customer and the legacy technique', async () => {
  const { order, repository, service } = await setup();
  // ADR 020: an order saved before the technique moved to the items.
  const stored = /** @type {any} */ (await repository.findById(order.id));
  stored.ficha.summary.aplicacao = 'SUBLIMACAO TOTAL';
  await repository.saveSection(stored, {
    actor: OWNER,
    correlationId: 'correlation-legacy',
    expectedVersion: stored.version,
  });
  const legacy = /** @type {any} */ (await repository.findById(order.id));
  const saved = await service.patchSection(
    command({
      expectedVersion: legacy.version,
      orderId: order.id,
      section: 'summary',
      value: {
        aplicacao: 'TEXTO DE UMA TELA ANTIGA',
        data_entrega_confirmada: '2026-09-30',
        nome: null,
      },
    }),
  );
  assert.equal(saved.version, legacy.version + 1);
  assert.deepEqual(saved.ficha.summary, {
    aplicacao: 'SUBLIMACAO TOTAL',
    cliente: 'Cliente Sintetico',
    data_entrega_confirmada: '2026-09-30',
    nome: null,
  });
  // ADR 016: of the summary, only the promised delivery blocks, and only
  // until it is a real day.
  assert.ok(!saved.missingFields.some((field) => field.startsWith('summary')));
  const typed = await service.patchSection(
    command({
      expectedVersion: saved.version,
      orderId: order.id,
      section: 'summary',
      value: {
        data_entrega_confirmada: '30/09/2026',
        nome: null,
      },
    }),
  );
  assert.ok(typed.missingFields.includes('summary.data_entrega_confirmada'));
  assert.ok(!typed.missingFields.includes('summary.aplicacao'));
});

test('saving items recalculates total pieces and what is missing', async () => {
  const { order, service } = await setup();
  // The bot's product opened item 1, which still lacks five points.
  assert.deepEqual(order.missingFields, [
    'items[0].cor',
    'items[0].tipo_servico',
    'items[0].malhas',
    'items[0].grade',
    'items[0].gola',
    'finalAmount',
    'paymentCondition',
  ]);
  const saved = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  assert.equal(saved.totalPieces, 32);
  assert.equal(saved.ficha.items.length, 2);
  assert.deepEqual(saved.missingFields, ['finalAmount', 'paymentCondition']);

  const observations = await service.patchSection(
    command({
      expectedVersion: saved.version,
      orderId: order.id,
      section: 'observations',
      value: synthetic.pedido.observacoes,
    }),
  );
  assert.deepEqual(
    observations.ficha.observations,
    synthetic.pedido.observacoes,
  );
  assert.equal(observations.totalPieces, 32);
});

test('invalid sections and values are refused without touching the order', async () => {
  const { order, repository, service } = await setup();
  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: order.version,
        orderId: order.id,
        section: 'serviceData',
        value: {},
      }),
    ),
    { code: 'ORDER_INVALID', statusCode: 400 },
  );
  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: order.version,
        orderId: order.id,
        section: 'items',
        value: [
          {
            ...synthetic.pedido.itens[0],
            grade: [{ quantidade: 0, tamanho: 'P' }],
          },
        ],
      }),
    ),
    { code: 'INVALID_GRADE', index: 0, itemIndex: 0 },
  );
  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: order.version,
        orderId: order.id,
        section: 'observations',
        value: ['1', '2', '3', '4', '5', '6'],
      }),
    ),
    { code: 'ORDER_INVALID' },
  );
  assert.deepEqual(await repository.findById(order.id), order);
});

test('only the owner or an admin edits, confirms and reopens', async () => {
  const { order, repository, service } = await setup();
  const summary = {
    aplicacao: null,
    data_entrega_confirmada: null,
    nome: 'Outro',
  };
  await assert.rejects(
    service.patchSection({
      actor: OTHER,
      correlationId: 'correlation-other',
      expectedVersion: order.version,
      orderId: order.id,
      section: 'summary',
      value: summary,
    }),
    { code: 'FORBIDDEN', statusCode: 403 },
  );
  await assert.rejects(
    service.confirm({
      actor: OTHER,
      amountText: '10,00',
      correlationId: 'correlation-other',
      expectedVersion: order.version,
      orderId: order.id,
      paymentCondition: 'pix',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    service.patchSection({
      actor: /** @type {any} */ ({ id: 'n8n', kind: 'automation' }),
      correlationId: 'correlation-automation',
      expectedVersion: order.version,
      orderId: order.id,
      section: 'summary',
      value: summary,
    }),
    { code: 'FORBIDDEN' },
  );
  assert.deepEqual(await repository.findById(order.id), order);

  const byAdmin = await service.patchSection({
    actor: ADMIN,
    correlationId: 'correlation-admin',
    expectedVersion: order.version,
    orderId: order.id,
    section: 'summary',
    value: summary,
  });
  assert.equal(byAdmin.ficha.summary.nome, 'Outro');
});

test('a stale version is reported as a conflict', async () => {
  const { order, service } = await setup();
  await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'observations',
      value: ['primeira'],
    }),
  );
  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: order.version,
        orderId: order.id,
        section: 'observations',
        value: ['segunda'],
      }),
    ),
    { code: 'VERSION_CONFLICT', statusCode: 409 },
  );
  await assert.rejects(
    service.confirm(
      command({
        amountText: '10,00',
        expectedVersion: order.version,
        orderId: order.id,
        paymentCondition: 'pix',
      }),
    ),
    { code: 'VERSION_CONFLICT' },
  );
});

test('confirming parses the amount and refuses what is missing per field', async () => {
  const { order, service } = await setup();
  const withItems = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );

  await assert.rejects(
    service.confirm(
      command({
        amountText: '',
        expectedVersion: withItems.version,
        orderId: order.id,
        paymentCondition: null,
      }),
    ),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'ORDER_NOT_CONFIRMABLE');
      assert.deepEqual(error.fields, ['finalAmount', 'paymentCondition']);
      return true;
    },
  );
  await assert.rejects(
    service.confirm(
      command({
        amountText: '4,820.00',
        expectedVersion: withItems.version,
        orderId: order.id,
        paymentCondition: 'pix',
      }),
    ),
    { code: 'INVALID_AMOUNT', statusCode: 422 },
  );

  const confirmed = await service.confirm(
    command({
      amountText: '4.820,00',
      expectedVersion: withItems.version,
      orderId: order.id,
      paymentCondition: 'cartao_debito',
    }),
  );
  assert.equal(confirmed.status, 'confirmado');
  assert.equal(confirmed.finalAmountCents, 482000);
  assert.equal(confirmed.paymentCondition, 'cartao_debito');
  assert.equal(confirmed.confirmedBy, 'seller-1');
  assert.deepEqual(confirmed.missingFields, []);
});

test('a half-filled item is saved, and generating names what each item lacks (ADR 016)', async () => {
  const { order, service } = await setup();
  const [complete] = syntheticItems();
  const partial = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: [
        { ...complete, cor: '', modelo: '' },
        {
          cor: 'BRANCA',
          cor_costas: '',
          cor_frente: '',
          cor_manga_direita: '',
          cor_manga_esquerda: '',
          estampa: '',
          gola: '',
          grade: [],
          malhas: [],
          modelo: '',
          tipo: 'REGATA',
          vies_gola: '',
          vies_mangas: '',
        },
      ],
    }),
  );
  assert.equal(partial.totalPieces, 20);
  assert.deepEqual(partial.missingFields, [
    'items[0].cor',
    'items[1].tipo_servico',
    'items[1].malhas',
    'items[1].grade',
    'items[1].gola',
    'finalAmount',
    'paymentCondition',
  ]);
  await assert.rejects(
    service.confirm(
      command({
        amountText: '10,00',
        expectedVersion: partial.version,
        orderId: order.id,
        paymentCondition: 'pix',
      }),
    ),
    {
      code: 'ORDER_NOT_CONFIRMABLE',
      fields: [
        'items[0].cor',
        'items[1].tipo_servico',
        'items[1].malhas',
        'items[1].grade',
        'items[1].gola',
      ],
      statusCode: 422,
    },
  );
});

test('a pending order without items cannot be confirmed', async () => {
  const { order, service } = await setup();
  const empty = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: [],
    }),
  );
  await assert.rejects(
    service.confirm(
      command({
        amountText: '10,00',
        expectedVersion: empty.version,
        orderId: order.id,
        paymentCondition: 'pix',
      }),
    ),
    { code: 'ORDER_NOT_CONFIRMABLE', fields: ['items'] },
  );
});

test('a confirmed order is read-only until reopened, and a new owner confirms again', async () => {
  const { order, owners, service } = await setup();
  const withItems = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  const confirmed = await service.confirm(
    command({
      amountText: '100,00',
      expectedVersion: withItems.version,
      orderId: order.id,
      paymentCondition: 'pix',
    }),
  );

  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: confirmed.version,
        orderId: order.id,
        section: 'observations',
        value: ['tarde demais'],
      }),
    ),
    { code: 'ORDER_STATUS_CONFLICT', statusCode: 409 },
  );
  await assert.rejects(
    service.confirm(
      command({
        amountText: '100,00',
        expectedVersion: confirmed.version,
        orderId: order.id,
        paymentCondition: 'pix',
      }),
    ),
    { code: 'ORDER_STATUS_CONFLICT' },
  );

  // The conversation was transferred: the previous owner loses the actions.
  owners['conversation-1'] = 'seller-2';
  await assert.rejects(
    service.reopen(
      command({ expectedVersion: confirmed.version, orderId: order.id }),
    ),
    { code: 'FORBIDDEN' },
  );
  const reopened = await service.reopen({
    actor: OTHER,
    correlationId: 'correlation-reopen',
    expectedVersion: confirmed.version,
    orderId: order.id,
  });
  assert.equal(reopened.status, 'pendente');
  assert.equal(reopened.reopenedBy, 'seller-2');
  assert.equal(reopened.number, order.number);
  assert.equal(reopened.finalAmountCents, 10000);
  await assert.rejects(
    service.reopen({
      actor: OTHER,
      correlationId: 'correlation-reopen-again',
      expectedVersion: reopened.version,
      orderId: order.id,
    }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );

  const reconfirmed = await service.confirm({
    actor: OTHER,
    amountText: '120,00',
    correlationId: 'correlation-reconfirm',
    expectedVersion: reopened.version,
    orderId: order.id,
    paymentCondition: 'cartao_credito',
  });
  assert.equal(reconfirmed.confirmedBy, 'seller-2');
  assert.notEqual(reconfirmed.confirmedAt, confirmed.confirmedAt);
  assert.equal(reconfirmed.finalAmountCents, 12000);
});

test('the owner or an admin records the trail days of a confirmed order without reopening', async () => {
  const { order, owners, service } = await setup();
  const withItems = await service.patchSection(
    command({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  const confirmed = await service.confirm(
    command({
      amountText: '100,00',
      expectedVersion: withItems.version,
      orderId: order.id,
      paymentCondition: 'pix',
    }),
  );

  const paid = await service.recordMilestones(
    command({
      deliveredOn: null,
      expectedVersion: confirmed.version,
      orderId: order.id,
      paidOn: '2026-09-11',
    }),
  );
  assert.equal(paid.paidOn, '2026-09-11');
  assert.equal(paid.status, 'confirmado');
  assert.equal(paid.version, confirmed.version + 1);

  await assert.rejects(
    service.recordMilestones({
      actor: OTHER,
      correlationId: 'correlation-other',
      deliveredOn: '2026-09-12',
      expectedVersion: paid.version,
      orderId: order.id,
      paidOn: '2026-09-11',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    service.recordMilestones(
      command({
        deliveredOn: '2026-09-12',
        expectedVersion: confirmed.version,
        orderId: order.id,
        paidOn: '2026-09-11',
      }),
    ),
    { code: 'VERSION_CONFLICT', statusCode: 409 },
  );
  await assert.rejects(
    service.recordMilestones(
      command({
        deliveredOn: '2026-09-30',
        expectedVersion: paid.version,
        orderId: order.id,
        paidOn: '2026-09-11',
      }),
    ),
    { code: 'INVALID_DATE', fields: ['deliveredOn'], statusCode: 422 },
  );

  // The conversation was transferred; an admin still records the delivery.
  owners['conversation-1'] = 'seller-2';
  const delivered = await service.recordMilestones({
    actor: ADMIN,
    correlationId: 'correlation-admin',
    deliveredOn: '2026-09-12',
    expectedVersion: paid.version,
    orderId: order.id,
    paidOn: '2026-09-11',
  });
  assert.equal(delivered.deliveredOn, '2026-09-12');
  assert.equal(delivered.orderDate, confirmed.orderDate);
});

test('commands on an unknown order are refused as not found', async () => {
  const { service } = await setup();
  await assert.rejects(
    service.reopen(command({ expectedVersion: 1, orderId: 'missing' })),
    { code: 'ORDER_NOT_FOUND', statusCode: 404 },
  );
  await assert.rejects(
    service.patchSection(
      command({
        expectedVersion: 1,
        orderId: 'missing',
        section: 'observations',
        value: [],
      }),
    ),
    { code: 'ORDER_NOT_FOUND' },
  );
});

// OLIST-T20b: explicit opt-in; existing orders keep their contract.
async function pricedDraft() {
  const context = await setup();
  const order = await context.service.patchSection(
    command({
      orderId: context.order.id,
      expectedVersion: context.order.version,
      section: 'items',
      value: syntheticItems().map((item) => ({
        ...item,
        grade: [{ tamanho: 'M', quantidade: 3 }],
      })),
    }),
  );
  return { ...context, order };
}

/** @param {any} service @param {any} order @param {Record<string, unknown>} value
 * @returns {Promise<import('../modules/orders/src/domain/order.js').Order>} */
function pricingCommand(service, order, value) {
  return service.patchSection(
    command({
      orderId: order.id,
      expectedVersion: order.version,
      section: 'size-pricing',
      value,
    }),
  );
}

test('OLIST-T20b persists server IDs; repeated M groups, reorder and duplicate retain distinct identity', async () => {
  const { service, repository, order } = await pricedDraft();
  const initialized = await pricingCommand(service, order, {
    action: 'initialize',
  });
  const groups = initialized.ficha.sizePricing;
  assert.ok(groups);
  assert.equal(
    new Set(groups.flatMap((g) => [g.id, ...g.lines.map((l) => l.id)])).size,
    4,
  );
  for (const group of groups) {
    assert.match(group.id, /^[0-9a-f-]{36}$/u);
    assert.equal(group.lines[0].subtotalCents, null);
    assert.equal(group.lines[0].subtotalReviewed, false);
  }
  assert.equal(initialized.finalAmountCents, order.finalAmountCents);
  assert.deepEqual(
    (await repository.findById(order.id))?.ficha.sizePricing,
    groups,
  );
  const reviewed = await pricingCommand(service, initialized, {
    action: 'review_subtotal',
    groupId: groups[0].id,
    lineId: groups[0].lines[0].id,
    subtotalCents: 100,
  });
  const reordered = await pricingCommand(service, reviewed, {
    action: 'reorder_groups',
    groupIds: groups.map((g) => g.id).reverse(),
  });
  assert.deepEqual(reordered.ficha.items, [...order.ficha.items].reverse());
  assert.equal(reordered.ficha.sizePricing?.[1].lines[0].subtotalCents, 100);
  assert.equal(reordered.ficha.sizePricing?.[0].lines[0].subtotalCents, null);
  const duplicated = await pricingCommand(service, reordered, {
    action: 'duplicate_group',
    groupId: groups[0].id,
  });
  const copy = duplicated.ficha.sizePricing?.[2];
  assert.ok(copy);
  assert.notEqual(copy.id, groups[0].id);
  assert.notEqual(copy.lines[0].id, groups[0].lines[0].id);
  assert.equal(copy.lines[0].subtotalCents, 100);
  assert.equal(copy.lines[0].subtotalReviewed, false);
  assert.deepEqual(duplicated.ficha.items[2], reordered.ficha.items[1]);
});

test('OLIST-T20b quantity changes require a fresh human review even on return to the old quantity', async () => {
  const { service, order } = await pricedDraft();
  let saved = await pricingCommand(service, order, { action: 'initialize' });
  const group = saved.ficha.sizePricing?.[0];
  assert.ok(group);
  const target = { groupId: group.id, lineId: group.lines[0].id };
  saved = await pricingCommand(service, saved, {
    action: 'review_subtotal',
    ...target,
    subtotalCents: 100,
  });
  for (const quantity of [5, 3]) {
    saved = await pricingCommand(service, saved, {
      action: 'change_quantity',
      ...target,
      quantity,
    });
    assert.equal(saved.ficha.sizePricing?.[0].lines[0].quantity, quantity);
    assert.equal(saved.ficha.sizePricing?.[0].lines[0].subtotalCents, 100);
    assert.equal(saved.ficha.sizePricing?.[0].lines[0].subtotalReviewed, false);
    assert.equal(saved.ficha.items[0].grade[0].quantidade, quantity);
    assert.equal(saved.totalPieces, quantity + 3);
  }
  saved = await pricingCommand(service, saved, {
    action: 'review_subtotal',
    ...target,
    subtotalCents: 100,
  });
  assert.equal(saved.ficha.sizePricing?.[0].lines[0].subtotalReviewed, true);
});

test('OLIST-T20b refuses forged state, wrong identities, overflow and stale concurrent reviews atomically', async () => {
  const { service, repository, order } = await pricedDraft();
  const initialized = await pricingCommand(service, order, {
    action: 'initialize',
  });
  const groups = initialized.ficha.sizePricing;
  assert.ok(groups);
  const target = { groupId: groups[0].id, lineId: groups[0].lines[0].id };
  for (const value of [
    {
      action: 'review_subtotal',
      ...target,
      subtotalCents: 10,
      subtotalReviewed: true,
    },
    { action: 'review_subtotal', ...target, subtotalCents: '10' },
    { action: 'review_subtotal', ...target, subtotalCents: -1 },
    { action: 'review_subtotal', ...target, subtotalCents: 1.5 },
    { action: 'review_subtotal', ...target, subtotalCents: 10, totalCents: 10 },
    {
      action: 'review_subtotal',
      ...target,
      lineId: groups[1].lines[0].id,
      subtotalCents: 10,
    },
    { action: 'reorder_groups', groupIds: [groups[0].id, groups[0].id] },
    { action: 'reorder_groups', groupIds: [groups[0].id] },
    { action: 'change_quantity', ...target, quantity: 0 },
  ]) {
    await assert.rejects(pricingCommand(service, initialized, value), {
      code: 'SIZE_PRICING_INVALID',
    });
    assert.equal(
      (await repository.findById(order.id))?.version,
      initialized.version,
    );
  }
  const results = await Promise.allSettled(
    [10, 20].map((subtotalCents) =>
      pricingCommand(service, initialized, {
        action: 'review_subtotal',
        ...target,
        subtotalCents,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.equal(rejected.reason.code, 'VERSION_CONFLICT');
  const latest = await service.get(order.id);
  const maxed = await pricingCommand(service, latest, {
    action: 'review_subtotal',
    ...target,
    subtotalCents: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(
    pricingCommand(service, maxed, {
      action: 'review_subtotal',
      groupId: groups[1].id,
      lineId: groups[1].lines[0].id,
      subtotalCents: 1,
    }),
    { code: 'SIZE_PRICING_OVERFLOW' },
  );
  await assert.rejects(
    pricingCommand(service, maxed, {
      action: 'duplicate_group',
      groupId: groups[0].id,
    }),
    { code: 'SIZE_PRICING_OVERFLOW' },
  );
});

test('OLIST-T20b preserves human composition against legacy replacement, automation and free amount confirmation', async () => {
  const { service, repository, order } = await pricedDraft();
  const saved = await pricingCommand(service, order, { action: 'initialize' });
  await assert.rejects(
    pricingCommand(service, saved, { action: 'initialize' }),
    { code: 'SIZE_PRICING_ALREADY_INITIALIZED' },
  );
  await assert.rejects(
    service.patchSection(
      command({
        orderId: saved.id,
        expectedVersion: saved.version,
        section: 'items',
        value: syntheticItems(),
      }),
    ),
    { code: 'SIZE_PRICING_ITEMS_MANAGED' },
  );
  const projected = await service.projectAgentBriefing({
    conversationId: 'conversation-1',
    correlationId: 'correlation-agent',
    automationState: 'assistant',
    briefing: { quantity: 200 },
  });
  assert.equal(projected.applied, false);
  assert.equal(projected.reason, 'size_pricing_managed');
  await assert.rejects(
    service.confirm(
      command({
        orderId: saved.id,
        expectedVersion: saved.version,
        amountText: '500,00',
        paymentCondition: 'pix',
      }),
    ),
    { code: 'SIZE_PRICING_CONFIRMATION_PENDING' },
  );
  assert.deepEqual((await repository.findById(saved.id))?.ficha, saved.ficha);
  assert.equal((await repository.findById(saved.id))?.version, saved.version);
  await assert.rejects(
    service.patchSection(
      command({
        actor: OTHER,
        orderId: saved.id,
        expectedVersion: saved.version,
        section: 'size-pricing',
        value: { action: 'initialize' },
      }),
    ),
    { code: 'FORBIDDEN' },
  );
});

test('OLIST-T20b confirmed historical composition is not enriched through draft adoption', async () => {
  const { service, order } = await pricedDraft();
  const confirmed = await service.confirm(
    command({
      orderId: order.id,
      expectedVersion: order.version,
      amountText: '500,00',
      paymentCondition: 'pix',
    }),
  );
  await assert.rejects(
    pricingCommand(service, confirmed, { action: 'initialize' }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
  const reopened = await service.reopen(
    command({ orderId: confirmed.id, expectedVersion: confirmed.version }),
  );
  await assert.rejects(
    pricingCommand(service, reopened, { action: 'initialize' }),
    { code: 'SIZE_PRICING_LEGACY_REQUIRES_ADAPTER' },
  );
  assert.equal(reopened.finalAmountCents, confirmed.finalAmountCents);
});

test('OLIST-T20b quantities and duplicate totals fit the PostgreSQL integer contract', async () => {
  const { service, repository, order } = await pricedDraft();
  const saved = await pricingCommand(service, order, { action: 'initialize' });
  const group = saved.ficha.sizePricing?.[0];
  assert.ok(group);
  const target = { groupId: group.id, lineId: group.lines[0].id };
  for (const quantity of [2147483648, Number.MAX_SAFE_INTEGER, 2147483645]) {
    await assert.rejects(
      pricingCommand(service, saved, {
        action: 'change_quantity',
        ...target,
        quantity,
      }),
      { code: 'SIZE_PRICING_INVALID' },
    );
    assert.equal((await repository.findById(saved.id))?.version, saved.version);
  }
  const large = await pricingCommand(service, saved, {
    action: 'change_quantity',
    ...target,
    quantity: 2147483644,
  });
  assert.equal(large.totalPieces, 2147483647);
  await assert.rejects(
    pricingCommand(service, large, {
      action: 'duplicate_group',
      groupId: group.id,
    }),
    { code: 'SIZE_PRICING_INVALID' },
  );
});
