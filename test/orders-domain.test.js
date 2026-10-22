import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_STATUSES,
  PAYMENT_CONDITIONS,
  confirmOrder,
  formatOrderNumber,
  missingForConfirmation,
  recordMilestones,
  reopenOrder,
} from '../modules/orders/src/domain/order.js';
import { briefingToFicha } from '../modules/orders/src/domain/ficha.js';
import { syntheticArtwork, syntheticItems } from './fixtures/order-items.js';

const CREATED = '2026-09-10T12:00:00.000Z';
// 22:30 in São Paulo on 12/09, already 13/09 in UTC.
const CONFIRMED_AT = new Date('2026-09-13T01:30:00.000Z');

/** @param {Record<string, any>} [overrides] @returns {any} */
function pendingOrder(overrides = {}) {
  return {
    confirmedAt: null,
    confirmedBy: null,
    conversationId: 'conversation-1',
    createdAt: CREATED,
    createdBy: null,
    createdByKind: 'automation',
    fabCode: '01',
    ficha: {
      artwork: syntheticArtwork(),
      items: syntheticItems(),
      observations: [],
      serviceData: {},
      summary: {
        aplicacao: 'SUBLIMACAO TOTAL',
        cliente: 'Cliente Demonstracao',
        data_entrega_confirmada: '2026-09-30',
        nome: 'Equipe Horizonte',
      },
    },
    finalAmountCents: null,
    id: 'order-1',
    missingFields: [],
    number: '01-CRM',
    numberSequence: 1,
    deliveredOn: null,
    firstContactAt: '2026-09-01T13:05:00.000Z',
    orderDate: null,
    paidOn: null,
    paymentCondition: null,
    reopenedAt: null,
    reopenedBy: null,
    status: 'pendente',
    totalPieces: 32,
    updatedAt: CREATED,
    version: 3,
    ...overrides,
  };
}

const confirmation = Object.freeze({
  actorId: 'seller-1',
  amountCents: 482000,
  now: CONFIRMED_AT,
  paymentCondition: 'pix',
});

test('exposes exactly two statuses and three payment conditions', () => {
  assert.deepEqual(ORDER_STATUSES, ['pendente', 'confirmado']);
  assert.deepEqual(PAYMENT_CONDITIONS, [
    'pix',
    'cartao_credito',
    'cartao_debito',
  ]);
  assert.ok(Object.isFrozen(ORDER_STATUSES));
  assert.ok(Object.isFrozen(PAYMENT_CONDITIONS));
});

test('formats the reserved sequence as NN-CRM', () => {
  assert.equal(formatOrderNumber(1), '01-CRM');
  assert.equal(formatOrderNumber(12), '12-CRM');
  assert.equal(formatOrderNumber(105), '105-CRM');
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => formatOrderNumber(invalid), TypeError);
  }
});

test('confirming records amount, condition, author, time and São Paulo order date', () => {
  const order = pendingOrder();
  const confirmed = confirmOrder(order, confirmation);

  assert.equal(confirmed.status, 'confirmado');
  assert.equal(confirmed.finalAmountCents, 482000);
  assert.equal(confirmed.paymentCondition, 'pix');
  assert.equal(confirmed.confirmedBy, 'seller-1');
  assert.equal(confirmed.confirmedAt, CONFIRMED_AT.toISOString());
  assert.equal(confirmed.orderDate, '2026-09-12');
  assert.equal(confirmed.updatedAt, CONFIRMED_AT.toISOString());
  assert.equal(confirmed.number, '01-CRM');
  assert.equal(confirmed.version, 3, 'the repository owns the version bump');
  assert.equal(order.status, 'pendente', 'the input order is not mutated');
});

test('every item needs a technique before confirmation (ADR 020)', () => {
  const draft = pendingOrder();
  draft.ficha.items[1].tipo_servico = '';
  assert.deepEqual(missingForConfirmation(draft), [
    'items[1].tipo_servico',
    'finalAmount',
    'paymentCondition',
  ]);
  assert.throws(() => confirmOrder(draft, confirmation), {
    code: 'ORDER_NOT_CONFIRMABLE',
    fields: ['items[1].tipo_servico'],
    statusCode: 422,
  });
});

test('a complete briefing fills the technique of the item and who makes the art (ADR 020)', () => {
  const ficha = briefingToFicha({
    artwork_status: 'Arte recebida',
    artwork_technique: 'DTF',
    collar: 'Redonda',
    colors: 'Azul',
    fabrics: 'Dry fit',
    product_model: 'Camiseta',
    quantity: 2,
    sizes: '2 M',
  });
  ficha.summary.data_entrega_confirmada = '2026-09-30';
  const draft = pendingOrder({ ficha });
  assert.equal(ficha.summary.aplicacao, null);
  assert.equal(ficha.items[0].tipo_servico, 'DTF');
  assert.equal(ficha.artwork?.feito_pelo_cliente, true);
  assert.deepEqual(missingForConfirmation(draft), [
    'finalAmount',
    'paymentCondition',
  ]);
  assert.equal(confirmOrder(draft, confirmation).status, 'confirmado');
});

test('generating needs who makes the art; "Sem estampa" is an answer (ADR 020)', () => {
  const unknown = pendingOrder();
  unknown.ficha.artwork = {
    feito_pela_silmer: false,
    feito_pelo_cliente: false,
    files: [],
    sem_estampa: false,
  };
  assert.throws(() => confirmOrder(unknown, confirmation), {
    code: 'ORDER_NOT_CONFIRMABLE',
    fields: ['artwork'],
  });
  const stored = pendingOrder();
  delete stored.ficha.artwork;
  assert.deepEqual(missingForConfirmation(stored), [
    'artwork',
    'finalAmount',
    'paymentCondition',
  ]);
  for (const origin of [
    'feito_pelo_cliente',
    'feito_pela_silmer',
    'sem_estampa',
  ]) {
    const order = pendingOrder();
    order.ficha.artwork = { ...unknown.ficha.artwork, [origin]: true };
    assert.equal(confirmOrder(order, confirmation).status, 'confirmado');
  }
});

test('generating needs an item, the seven points of every item, amount and payment method (ADR 016)', () => {
  assert.throws(
    () =>
      confirmOrder(
        pendingOrder({
          ficha: { ...pendingOrder().ficha, items: [] },
        }),
        {
          actorId: 'seller-1',
          amountCents: 0,
          now: CONFIRMED_AT,
          paymentCondition: /** @type {any} */ ('boleto'),
        },
      ),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'ORDER_NOT_CONFIRMABLE');
      assert.equal(error.statusCode, 422);
      assert.deepEqual(error.fields, [
        'items',
        'finalAmount',
        'paymentCondition',
      ]);
      return true;
    },
  );

  // Each of the seven points blocks on its own: quantity is the grade.
  for (const [field, blank] of /** @type {const} */ ([
    ['tipo', ''],
    ['cor', '  '],
    ['tipo_servico', ''],
    ['malhas', []],
    ['malhas', ['  ']],
    ['grade', []],
    ['gola', ''],
  ])) {
    const order = pendingOrder();
    order.ficha.items[1][field] = blank;
    assert.throws(
      () => confirmOrder(order, confirmation),
      { code: 'ORDER_NOT_CONFIRMABLE', fields: [`items[1].${field}`] },
      `${field} = ${JSON.stringify(blank)}`,
    );
  }

  // A ficha stored before ADR 016 has no colour, print or collar; the print
  // is a reference since ADR 020 and never blocks.
  const stored = pendingOrder();
  stored.ficha.items = stored.ficha.items.map(
    (
      /** @type {any} */ { cor: _cor, estampa: _estampa, gola: _gola, ...item },
    ) => item,
  );
  assert.throws(() => confirmOrder(stored, confirmation), {
    code: 'ORDER_NOT_CONFIRMABLE',
    fields: ['items[0].cor', 'items[0].gola', 'items[1].cor', 'items[1].gola'],
  });

  // Nothing else blocks: the rest of the summary, the additional item
  // fields, and the paid and delivered days (generating means paid).
  const sparse = pendingOrder({ deliveredOn: null, paidOn: null });
  sparse.ficha.summary = {
    aplicacao: null,
    cliente: '',
    data_entrega_confirmada: '2026-09-30',
    nome: null,
  };
  for (const key of [
    'estampa',
    'modelo',
    'cor_frente',
    'cor_costas',
    'cor_manga_direita',
    'cor_manga_esquerda',
    'vies_gola',
    'vies_mangas',
  ]) {
    sparse.ficha.items[0][key] = '';
  }
  assert.equal(confirmOrder(sparse, confirmation).status, 'confirmado');
});

test('generating needs a promised delivery written as a real day; the other trail days never block (ADR 016)', () => {
  for (const day of [
    null,
    '',
    '30/09/2026',
    '2026-02-30',
    '2026-9-30',
    'outubro',
  ]) {
    const order = pendingOrder();
    order.ficha.summary.data_entrega_confirmada = day;
    assert.throws(
      () => confirmOrder(order, confirmation),
      {
        code: 'ORDER_NOT_CONFIRMABLE',
        fields: ['summary.data_entrega_confirmada'],
      },
      String(day),
    );
  }
  // Until the CRM handles payments, generating means the order is paid; the
  // delivered day is the after-sale's. Neither blocks, empty or filled.
  for (const days of [
    { deliveredOn: null, paidOn: null },
    { deliveredOn: '2026-09-11', paidOn: '2026-09-10' },
  ]) {
    const order = pendingOrder(days);
    assert.deepEqual(missingForConfirmation(order), [
      'finalAmount',
      'paymentCondition',
    ]);
    assert.equal(confirmOrder(order, confirmation).status, 'confirmado');
  }
  // A promised day in the past still is a day: the seller decides.
  const late = pendingOrder();
  late.ficha.summary.data_entrega_confirmada = '2020-01-01';
  assert.equal(confirmOrder(late, confirmation).status, 'confirmado');
});

test('reopening keeps number, amount and condition and records who reopened', () => {
  const confirmed = confirmOrder(pendingOrder(), confirmation);
  const reopenedAt = new Date('2026-09-14T10:00:00.000Z');
  const reopened = reopenOrder(confirmed, {
    actorId: 'admin-1',
    now: reopenedAt,
  });

  assert.equal(reopened.status, 'pendente');
  assert.equal(reopened.number, '01-CRM');
  assert.equal(reopened.finalAmountCents, 482000);
  assert.equal(reopened.paymentCondition, 'pix');
  assert.equal(reopened.reopenedBy, 'admin-1');
  assert.equal(reopened.reopenedAt, reopenedAt.toISOString());
  assert.equal(reopened.updatedAt, reopenedAt.toISOString());
});

test('a new confirmation overwrites author, time and order date (PCL-12)', () => {
  const first = confirmOrder(pendingOrder(), confirmation);
  const reopened = reopenOrder(first, {
    actorId: 'admin-1',
    now: new Date('2026-09-14T10:00:00.000Z'),
  });
  const secondAt = new Date('2026-09-20T15:00:00.000Z');
  const second = confirmOrder(reopened, {
    actorId: 'seller-2',
    amountCents: 500000,
    now: secondAt,
    paymentCondition: 'cartao_credito',
  });

  assert.equal(second.confirmedBy, 'seller-2');
  assert.equal(second.confirmedAt, secondAt.toISOString());
  assert.equal(second.orderDate, '2026-09-20');
  assert.equal(second.finalAmountCents, 500000);
  assert.equal(second.paymentCondition, 'cartao_credito');
});

test('no other transition is possible', () => {
  const confirmed = confirmOrder(pendingOrder(), confirmation);
  assert.throws(() => confirmOrder(confirmed, confirmation), {
    code: 'ORDER_STATUS_CONFLICT',
    statusCode: 409,
  });
  assert.throws(
    () => reopenOrder(pendingOrder(), { actorId: 'seller-1', now: new Date() }),
    { code: 'ORDER_STATUS_CONFLICT', statusCode: 409 },
  );
  assert.throws(
    () => confirmOrder(pendingOrder({ status: 'cancelado' }), confirmation),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
  assert.throws(
    () => confirmOrder(pendingOrder(), { ...confirmation, actorId: '' }),
    TypeError,
  );
});

test('FINQ-18: reconfirming another amount requires a new full settlement, even on the same day', () => {
  const paid = confirmOrder(
    pendingOrder({ paidOn: '2026-09-12' }),
    confirmation,
  );
  const reopened = reopenOrder(paid, {
    actorId: 'seller-1',
    now: CONFIRMED_AT,
  });
  assert.equal(confirmOrder(reopened, confirmation).paidOn, '2026-09-12');
  const changed = confirmOrder(reopened, {
    ...confirmation,
    amountCents: 500000,
  });
  assert.equal(changed.paidOn, null);
  const settled = recordMilestones(changed, {
    paidOn: '2026-09-12',
    deliveredOn: null,
    now: CONFIRMED_AT,
  });
  assert.equal(settled.paidOn, '2026-09-12');
  assert.equal(paid.paidOn, '2026-09-12');
});

test('records paid and delivered days in either status without moving it (PLA-04, PLA-06)', () => {
  const confirmed = confirmOrder(pendingOrder(), confirmation);
  const recordedAt = new Date('2026-09-20T15:00:00.000Z');
  const recorded = recordMilestones(confirmed, {
    deliveredOn: '2026-09-20',
    now: recordedAt,
    paidOn: '2026-09-12',
  });

  assert.equal(recorded.paidOn, '2026-09-12');
  assert.equal(recorded.deliveredOn, '2026-09-20');
  assert.equal(recorded.updatedAt, recordedAt.toISOString());
  assert.deepEqual(
    { ...recorded, deliveredOn: null, paidOn: null, updatedAt: '' },
    { ...confirmed, updatedAt: '' },
    'nothing else changes: status, order date, ficha and blockers stay',
  );

  const pending = recordMilestones(pendingOrder(), {
    deliveredOn: null,
    now: recordedAt,
    paidOn: '2026-09-12',
  });
  assert.equal(pending.status, 'pendente');
  assert.equal(pending.paidOn, '2026-09-12');
  assert.equal(
    recordMilestones(recorded, {
      deliveredOn: null,
      now: recordedAt,
      paidOn: null,
    }).paidOn,
    null,
    'null clears a recorded day',
  );
});

test('a trail day is a real calendar day that has already come in São Paulo (PLA-05)', () => {
  // 22:30 on 12/09 in São Paulo is already 13/09 in UTC.
  const record = (/** @type {unknown} */ paidOn) =>
    recordMilestones(pendingOrder(), {
      deliveredOn: null,
      now: CONFIRMED_AT,
      paidOn,
    });

  assert.equal(record('2026-09-12').paidOn, '2026-09-12');
  for (const paidOn of [
    '2026-09-13',
    '2026-02-30',
    '12/09/2026',
    '2026-9-12',
    '0012-09-12',
    '',
    20260912,
    undefined,
  ]) {
    assert.throws(
      () => record(paidOn),
      { code: 'INVALID_DATE', fields: ['paidOn'], statusCode: 422 },
      String(paidOn),
    );
  }
  assert.throws(
    () =>
      recordMilestones(pendingOrder(), {
        deliveredOn: '2027-01-01',
        now: CONFIRMED_AT,
        paidOn: '2027-01-01',
      }),
    { code: 'INVALID_DATE', fields: ['paidOn', 'deliveredOn'] },
  );
  assert.throws(
    () =>
      recordMilestones(pendingOrder(), {
        deliveredOn: null,
        now: new Date('invalid'),
        paidOn: null,
      }),
    TypeError,
  );
});

test('lists what is missing to generate: the points of each item, then amount and payment method', () => {
  assert.deepEqual(missingForConfirmation(pendingOrder()), [
    'finalAmount',
    'paymentCondition',
  ]);

  const sparse = pendingOrder();
  sparse.ficha.summary = {
    aplicacao: null,
    cliente: '',
    data_entrega_confirmada: null,
    nome: null,
  };
  sparse.ficha.items = [
    { ...sparse.ficha.items[0], cor: '', cor_costas: '', malhas: [] },
    { ...sparse.ficha.items[1], gola: '', grade: [], modelo: '' },
  ];
  assert.deepEqual(missingForConfirmation(sparse), [
    'items[0].cor',
    'items[0].malhas',
    'items[1].grade',
    'items[1].gola',
    'summary.data_entrega_confirmada',
    'finalAmount',
    'paymentCondition',
  ]);

  const empty = pendingOrder();
  empty.ficha.items = [];
  assert.deepEqual(missingForConfirmation(empty), [
    'items',
    'finalAmount',
    'paymentCondition',
  ]);

  // A reopened order keeps its amount and payment method.
  assert.deepEqual(
    missingForConfirmation(
      pendingOrder({ finalAmountCents: 482000, paymentCondition: 'pix' }),
    ),
    [],
  );
  assert.deepEqual(
    missingForConfirmation(confirmOrder(pendingOrder(), confirmation)),
    [],
  );
});
