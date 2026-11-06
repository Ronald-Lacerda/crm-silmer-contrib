import { confirmOrder } from '../modules/orders/src/domain/order.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOrderSourceCommand,
  projectOrderSource,
} from '../modules/orders/src/domain/order-source.js';
import { blankItem } from '../modules/orders/src/domain/ficha.js';

/** @param {Record<string, any>} [extra] @returns {any} */
function order(extra = {}) {
  return {
    id: 'synthetic-order',
    version: 7,
    origin: 'atendimento',
    status: 'confirmado',
    confirmedAt: '2026-11-05T12:00:00.000Z',
    finalAmountCents: 50000,
    ficha: {
      items: [
        { ...blankItem(), grade: [{ tamanho: 'M', quantidade: 10 }] },
        { ...blankItem(), grade: [{ tamanho: 'M', quantidade: 20 }] },
      ],
      summary: { cliente: '', nome: null, data_entrega_confirmada: null },
      observations: [],
      serviceData: {},
    },
    ...extra,
  };
}

/** @param {ReturnType<typeof applyOrderSourceCommand>} data
 * @param {(number|null)[]} amounts */
function batch(data, amounts) {
  let i = 0;
  return {
    action: 'set_subtotals',
    lines: data.groups.flatMap((group) =>
      group.lines.map((line) => ({
        groupId: group.id,
        lineId: line.id,
        subtotalCents: amounts[i++],
      })),
    ),
  };
}

/** @param {ReturnType<typeof applyOrderSourceCommand>} data @param {boolean} [sourceValid] */
function record(data, sourceValid = true) {
  return {
    data,
    revision: 3,
    sourceValid,
    orderVersion: 7,
    updatedBy: 'synthetic-human',
    updatedAt: '2026-11-05T12:00:00.000Z',
  };
}

test('T26 initialize emits distinct server IDs without inferring historical prices or changing the source', () => {
  const original = order();
  const before = structuredClone(original);
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  assert.deepEqual(original, before);
  assert.equal(data.mode, 'legacy');
  assert.equal(
    new Set(data.groups.flatMap((group) => [group.id, group.lines[0].id])).size,
    4,
  );
  for (const group of data.groups) {
    assert.match(group.id, /^[0-9a-f-]{36}$/u);
    assert.equal(group.lines[0].size, 'M');
    assert.equal(group.lines[0].subtotalCents, null);
    assert.equal(group.lines[0].subtotalReviewed, false);
  }
  const read = projectOrderSource(original, record(data));
  assert.equal(read.orderVersion, original.version);
  assert.equal(read.revision, 3);
  assert.equal(read.sourceValid, true);
  assert.equal(read.pricing?.complete, false);
  assert.equal(read.pricing?.totalCents, null);
  assert.equal(read.issues.length, 2);
  assert.ok(read.issues[0].field.includes(data.groups[0].lines[0].id));
});

test('T26 complete negotiated composition preserves identity and total; divergent composition is refused atomically', () => {
  const original = order();
  const initial = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const before = structuredClone(initial);
  const equal = applyOrderSourceCommand(
    original,
    initial,
    batch(initial, [18000, 32000]),
  );
  assert.deepEqual(initial, before);
  assert.deepEqual(
    equal.groups.map((g) => g.id),
    initial.groups.map((g) => g.id),
  );
  assert.equal(
    projectOrderSource(original, record(equal)).pricing?.totalCents,
    50000,
  );
  assert.ok(equal.groups.every((g) => g.lines[0].subtotalReviewed));
  assert.throws(
    () =>
      applyOrderSourceCommand(
        original,
        initial,
        batch(initial, [18000, 31999]),
      ),
    { code: 'SIZE_PRICING_AMOUNT_MISMATCH', statusCode: 422 },
  );
  assert.deepEqual(initial, before);
  assert.equal(original.finalAmountCents, 50000);
  const partial = applyOrderSourceCommand(
    original,
    equal,
    batch(equal, [18000, null]),
  );
  assert.equal(
    projectOrderSource(original, record(partial)).pricing?.totalCents,
    null,
  );
  assert.equal(partial.groups[1].lines[0].subtotalReviewed, false);
});

test('T26 payloads must cover every persisted line exactly once and cannot replace grade, flags, totals or IDs', () => {
  const original = order();
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const valid = batch(data, [18000, 32000]);
  const sparse = new Array(2);
  sparse[1] = valid.lines[1];
  for (const value of [
    { ...valid, totalCents: 50000 },
    { ...valid, groups: data.groups },
    { action: 'initialize', groups: data.groups },
    { ...valid, lines: valid.lines.slice(1) },
    { ...valid, lines: [valid.lines[0], valid.lines[0]] },
    { ...valid, lines: sparse },
    {
      ...valid,
      lines: [
        valid.lines[0],
        { ...valid.lines[1], groupId: data.groups[0].id },
      ],
    },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], lineId: 'forged' }],
    },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], subtotalReviewed: true }],
    },
    { ...valid, lines: [valid.lines[0], { ...valid.lines[1], quantity: 20 }] },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], subtotalCents: '32000' }],
    },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], subtotalCents: 0 }],
    },
    {
      ...valid,
      lines: [valid.lines[0], { ...valid.lines[1], subtotalCents: 1.5 }],
    },
  ])
    assert.throws(() => applyOrderSourceCommand(original, data, value), {
      code: 'ORDER_SOURCE_INVALID',
    });
  assert.throws(
    () =>
      applyOrderSourceCommand(original, data, { action: 'change_quantity' }),
    { code: 'ORDER_INVALID' },
  );
});

test('T26 refuses non-historical drafts, shop, managed orders and missing/duplicate initialization', () => {
  const original = order();
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  assert.throws(
    () =>
      applyOrderSourceCommand(order({ confirmedAt: null }), null, {
        action: 'initialize',
      }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
  assert.throws(
    () =>
      applyOrderSourceCommand(order({ origin: 'loja' }), null, {
        action: 'initialize',
      }),
    { code: 'ORDER_SOURCE_INVALID' },
  );
  assert.throws(
    () =>
      applyOrderSourceCommand(order({ status: 'cancelado' }), null, {
        action: 'initialize',
      }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
  assert.throws(
    () =>
      applyOrderSourceCommand(order({ finalAmountCents: null }), null, {
        action: 'initialize',
      }),
    { code: 'ORDER_SOURCE_INVALID' },
  );
  assert.throws(
    () => applyOrderSourceCommand(original, data, { action: 'initialize' }),
    { code: 'SIZE_PRICING_ALREADY_INITIALIZED' },
  );
  assert.throws(
    () => applyOrderSourceCommand(original, null, batch(data, [18000, 32000])),
    { code: 'SIZE_PRICING_NOT_INITIALIZED' },
  );
  const managed = order();
  managed.ficha.sizePricing = data.groups;
  assert.throws(
    () => applyOrderSourceCommand(managed, null, { action: 'initialize' }),
    { code: 'SIZE_PRICING_ALREADY_INITIALIZED' },
  );
  const reopened = order({ status: 'pendente' });
  assert.equal(
    applyOrderSourceCommand(reopened, null, { action: 'initialize' }).mode,
    'legacy',
  );
});

test('T26 refuses malformed persisted identities, alignment changes and sum overflow', () => {
  const original = order();
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const duplicate = structuredClone(data);
  duplicate.groups[1].lines[0].id = duplicate.groups[0].lines[0].id;
  assert.throws(
    () =>
      applyOrderSourceCommand(
        original,
        duplicate,
        batch(duplicate, [18000, 32000]),
      ),
    { code: 'SIZE_PRICING_INVALID' },
  );
  const changed = order();
  changed.ficha.items[0].grade[0].quantidade = 11;
  assert.throws(
    () => applyOrderSourceCommand(changed, data, batch(data, [18000, 32000])),
    { code: 'SIZE_PRICING_INVALID' },
  );
  assert.throws(
    () =>
      applyOrderSourceCommand(
        original,
        data,
        batch(data, [Number.MAX_SAFE_INTEGER, 1]),
      ),
    { code: 'SIZE_PRICING_OVERFLOW' },
  );
});

test('T26 atomic batch does not reject a valid budget because intermediate old/new prices overlap', () => {
  const original = order({ finalAmountCents: Number.MAX_SAFE_INTEGER });
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const first = applyOrderSourceCommand(
    original,
    data,
    batch(data, [1, Number.MAX_SAFE_INTEGER - 1]),
  );
  const swapped = applyOrderSourceCommand(
    original,
    first,
    batch(first, [Number.MAX_SAFE_INTEGER - 1, 1]),
  );
  assert.equal(
    projectOrderSource(original, record(swapped)).pricing?.totalCents,
    Number.MAX_SAFE_INTEGER,
  );
});

test('T26 missing and stale records are pending sources and never expose stale pricing as ready', () => {
  const original = order();
  assert.deepEqual(projectOrderSource(original, null).issues, [
    { code: 'LEGACY_PRICE_BREAKDOWN_REQUIRED', field: 'priceBreakdown' },
  ]);
  const initial = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const equal = applyOrderSourceCommand(
    original,
    initial,
    batch(initial, [18000, 32000]),
  );
  const stale = projectOrderSource(
    order({ version: 10 }),
    record(equal, false),
  );
  assert.equal(stale.orderVersion, 10);
  assert.equal(stale.sourceValid, false);
  assert.equal(stale.pricing, null);
  assert.deepEqual(stale.issues, [
    { code: 'ORDER_SOURCE_STALE', field: 'priceBreakdown' },
  ]);
  stale.groups[0].lines[0].subtotalCents = 999;
  assert.equal(equal.groups[0].lines[0].subtotalCents, 18000);
});

test('managed projection uses the actual ficha and ignores supplemental legacy metadata', () => {
  const original = order();
  const data = applyOrderSourceCommand(original, null, {
    action: 'initialize',
  });
  const equal = applyOrderSourceCommand(
    original,
    data,
    batch(data, [18000, 32000]),
  );
  original.ficha.sizePricing = equal.groups;
  const managed = projectOrderSource(original, record(data, false));
  assert.equal(managed.mode, 'managed');
  assert.equal(managed.sourceValid, true);
  assert.equal(managed.revision, 0);
  assert.equal(managed.updatedBy, null);
  assert.equal(managed.pricing?.totalCents, 50000);
  assert.deepEqual(managed.issues, []);
  managed.groups[0].lines[0].quantity = 900;
  assert.equal(original.ficha.sizePricing[0].lines[0].quantity, 10);
});

test('T26 direct confirmation cannot replace the historical total through an internal legacy proof', () => {
  const historical = order({ status: 'pendente' });
  const data = applyOrderSourceCommand(historical, null, {
    action: 'initialize',
  });
  const reviewed = applyOrderSourceCommand(
    historical,
    data,
    batch(data, [18000, 32000]),
  );
  const forged = structuredClone(reviewed.groups);
  forged[0].lines[0].subtotalCents = 28000;
  assert.throws(
    () =>
      confirmOrder(
        { ...historical, legacySizePricing: forged },
        {
          actorId: 'synthetic-human',
          now: new Date('2026-11-05T12:00:00Z'),
          paymentCondition: 'pix',
        },
      ),
    { code: 'SIZE_PRICING_AMOUNT_MISMATCH' },
  );
});
