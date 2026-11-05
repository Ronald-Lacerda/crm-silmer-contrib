import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSizePricing,
  changeSizePricingQuantity,
  createSizePricing,
  reviewSizePricingSubtotal,
} from '../modules/orders/src/domain/size-pricing.js';
import {
  prepareExactCentExport,
  reconcileExactCentExport,
} from '../modules/orders/src/domain/olist-exact-cent.js';

/** @param {{quantity: number, cents: number|null}[][]} input */
function composition(input) {
  let n = 1;
  let groups = createSizePricing(
    input.map((lines) =>
      lines.map((line, index) => ({
        size: index === 0 ? 'M' : 'G',
        quantity: line.quantity,
      })),
    ),
    () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  );
  for (const [g, lines] of input.entries())
    for (const [l, line] of lines.entries()) {
      if (line.cents !== null)
        groups = reviewSizePricingSubtotal(
          groups,
          groups[g].id,
          groups[g].lines[l].id,
          line.cents,
        );
    }
  return groups;
}

function ready() {
  return prepareExactCentExport(
    composition([
      [
        { quantity: 3, cents: 3 },
        { quantity: 3, cents: 6 },
      ],
      [{ quantity: 1, cents: 3 }],
    ]),
  );
}

/** @param {ReturnType<typeof ready>} prepared */
function observed(prepared = ready()) {
  return {
    lines: prepared.lines.map((line) => ({
      lineId: line.lineId,
      quantity: line.quantity,
      unitLexeme: line.unitLexeme,
    })),
    totalProductsLexeme: '0.12',
    totalOrderLexeme: '0.12',
  };
}

/** @param {string} code */
const errorCode = (code) => (/** @type {unknown} */ error) =>
  error instanceof Error &&
  'code' in error &&
  error.code === code &&
  !error.message.includes('PRIVATE_PROVIDER_DETAIL');
const mismatch = errorCode('OLIST_EXACT_CENT_READBACK_MISMATCH');

test('exact cents preserve quantity discounts and derive units without floating point money', () => {
  const prepared = prepareExactCentExport(
    composition([
      [
        { quantity: 10, cents: 18000 },
        { quantity: 20, cents: 32000 },
      ],
    ]),
  );
  assert.equal(prepared.policy, 'exact-cent-v1');
  assert.equal(prepared.eligible, true);
  assert.equal(prepared.totalCents, 50000);
  assert.deepEqual(
    prepared.lines.map((line) => [line.unitCents, line.unitLexeme]),
    [
      [1800, '18.00'],
      [1600, '16.00'],
    ],
  );
  assert.deepEqual(prepared.issues, []);
});

test('C02 fractional units block the complete export while the CRM order remains valid', () => {
  const groups = composition([
    [
      { quantity: 3, cents: 100 },
      { quantity: 3, cents: 200 },
    ],
  ]);
  const before = structuredClone(groups);
  assert.equal(calculateSizePricing(groups).complete, true);
  const prepared = prepareExactCentExport(groups);
  assert.equal(prepared.eligible, false);
  assert.equal(prepared.totalCents, 300);
  assert.deepEqual(prepared.lines, []);
  assert.deepEqual(
    prepared.issues.map((issue) => issue.code),
    ['OLIST_FRACTIONAL_CENT_UNIT', 'OLIST_FRACTIONAL_CENT_UNIT'],
  );
  assert.deepEqual(groups, before);
});

test('C04 tiny subtotal for a large quantity is never rounded to zero or partially exported', () => {
  const groups = composition([
    [
      { quantity: 1000, cents: 1 },
      { quantity: 1, cents: 1 },
    ],
  ]);
  const prepared = prepareExactCentExport(groups);
  assert.equal(calculateSizePricing(groups).totalCents, 2);
  assert.equal(prepared.eligible, false);
  assert.deepEqual(prepared.lines, []);
  assert.equal(prepared.issues.length, 1);
  assert.equal(prepared.issues[0].lineId, groups[0].lines[0].id);
});

test('incomplete and changed-quantity prices cannot produce an export plan', () => {
  const missing = composition([[{ quantity: 1, cents: null }]]);
  assert.equal(prepareExactCentExport(missing).totalCents, null);
  assert.equal(
    prepareExactCentExport(missing).issues[0].code,
    'SIZE_SUBTOTAL_REQUIRED',
  );
  const groups = composition([[{ quantity: 1, cents: 100 }]]);
  const changed = changeSizePricingQuantity(
    groups,
    groups[0].id,
    groups[0].lines[0].id,
    2,
  );
  const prepared = prepareExactCentExport(changed);
  assert.equal(prepared.eligible, false);
  assert.deepEqual(prepared.lines, []);
  assert.equal(prepared.issues[0].code, 'SIZE_SUBTOTAL_REVIEW_REQUIRED');
  assert.equal(prepareExactCentExport([]).eligible, false);
});

test('large exact quantities and the safe-cent boundary remain exact', () => {
  const quantity = Number.MAX_SAFE_INTEGER;
  const prepared = prepareExactCentExport(
    composition([[{ quantity, cents: quantity }]]),
  );
  assert.equal(prepared.lines[0].unitLexeme, '0.01');
  assert.equal(prepared.totalCents, quantity);
  assert.deepEqual(
    reconcileExactCentExport(prepared, {
      lines: [
        { lineId: prepared.lines[0].lineId, quantity, unitLexeme: '0.01' },
      ],
      totalProductsLexeme: '90071992547409.91',
      totalOrderLexeme: '90071992547409.91',
    }),
    { matched: true, lineCount: 1, totalCents: quantity },
  );
});

test('malformed quantities, cents and sparse compositions fail before preparation', () => {
  for (const value of [
    0,
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
  ]) {
    const groups = composition([[{ quantity: 1, cents: 1 }]]);
    groups[0].lines[0].subtotalCents = /** @type {any} */ (value);
    assert.throws(
      () => prepareExactCentExport(groups),
      errorCode('SIZE_PRICING_INVALID'),
    );
    groups[0].lines[0].subtotalCents = 1;
    groups[0].lines[0].quantity = /** @type {any} */ (value);
    assert.throws(
      () => prepareExactCentExport(groups),
      errorCode('SIZE_PRICING_INVALID'),
    );
  }
  assert.throws(
    () => prepareExactCentExport(Array(1)),
    errorCode('SIZE_PRICING_INVALID'),
  );
});

test('prepared snapshots are copied and deeply frozen against later input mutation', () => {
  const groups = composition([
    [
      { quantity: 3, cents: 3 },
      { quantity: 3, cents: 6 },
    ],
    [{ quantity: 1, cents: 3 }],
  ]);
  const prepared = prepareExactCentExport(groups);
  groups[0].lines[0].quantity = 999;
  groups[0].lines[0].subtotalCents = 999;
  assert.equal(prepared.lines[0].quantity, 3);
  assert.equal(prepared.lines[0].subtotalCents, 3);
  assert.throws(() => {
    /** @type {any} */ (prepared.lines).push({});
  }, TypeError);
  assert.throws(() => {
    /** @type {any} */ (prepared.lines[0]).quantity = 999;
  }, TypeError);
  assert.deepEqual(reconcileExactCentExport(prepared, observed(prepared)), {
    matched: true,
    lineCount: 3,
    totalCents: 12,
  });
});

test('returned line identity survives reorder and the same size in two groups', () => {
  const prepared = ready();
  const remote = observed(prepared);
  remote.lines.reverse();
  const result = reconcileExactCentExport(prepared, remote);
  assert.deepEqual(result, { matched: true, lineCount: 3, totalCents: 12 });
  assert.ok(Object.isFrozen(result));
  assert.notEqual(prepared.lines[0].groupId, prepared.lines[2].groupId);
});

test('equal global totals never hide compensating line differences', () => {
  const prepared = ready();
  const remote = observed(prepared);
  remote.lines[0].unitLexeme = '0.02';
  remote.lines[1].unitLexeme = '0.01';
  assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
});

test('missing, duplicate, unknown and extra returned markers are rejected', () => {
  const prepared = ready();
  for (const mutate of [
    (/** @type {ReturnType<typeof observed>} */ r) => {
      r.lines.pop();
    },
    (/** @type {ReturnType<typeof observed>} */ r) => {
      r.lines[1].lineId = r.lines[0].lineId;
    },
    (/** @type {ReturnType<typeof observed>} */ r) => {
      r.lines[0].lineId = '';
    },
    (/** @type {ReturnType<typeof observed>} */ r) => {
      r.lines[0].lineId = 'PRIVATE_PROVIDER_DETAIL';
    },
    (/** @type {ReturnType<typeof observed>} */ r) => {
      r.lines.push({ ...r.lines[0] });
    },
  ]) {
    const remote = observed(prepared);
    mutate(remote);
    assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
  }
});

test('each independently returned total must equal the sum of verified lines', () => {
  const prepared = ready();
  for (const field of ['totalProductsLexeme', 'totalOrderLexeme']) {
    const remote = observed(prepared);
    Object.assign(remote, { [field]: '0.11' });
    assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
  }
});

test('quantities are exact integers and monetary inputs must be raw lexemes', () => {
  const prepared = ready();
  for (const quantity of [0, 1, 3.01, '3', Infinity]) {
    const remote = observed(prepared);
    remote.lines[0].quantity = /** @type {any} */ (quantity);
    assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
  }
  const remote = observed(prepared);
  remote.lines[0].unitLexeme = /** @type {any} */ (0.01);
  assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
});

test('equivalent bounded decimal representations compare exactly without rounding', () => {
  const prepared = ready();
  const remote = observed(prepared);
  remote.lines[0].unitLexeme = '1e-2';
  remote.lines[1].unitLexeme = '0.020000';
  remote.lines[2].unitLexeme = '3.0E-2';
  remote.totalProductsLexeme = '12e-2';
  remote.totalOrderLexeme = '0.12000';
  assert.equal(reconcileExactCentExport(prepared, remote).matched, true);
});

test('subcent, malformed, excessive and private provider values are refused without echo', () => {
  const prepared = ready();
  for (const token of [
    '0.011',
    '0',
    '-0',
    '-0.01',
    '+0.01',
    ' 0.01',
    '01',
    'NaN',
    '1e999999999',
    '0.010000000000000000001',
    '9'.repeat(81),
    '90071992547409.92',
    'PRIVATE_PROVIDER_DETAIL',
  ]) {
    const remote = observed(prepared);
    remote.lines[0].unitLexeme = token;
    assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
  }
});

test('damaged, blocked or partial preparations cannot be used as reconciliation authority', () => {
  for (const mutate of [
    (/** @type {any} */ p) => {
      p.eligible = false;
    },
    (/** @type {any} */ p) => {
      p.policy = 'anything';
    },
    (/** @type {any} */ p) => {
      p.lines = [];
    },
    (/** @type {any} */ p) => {
      p.lines = Array(1);
    },
    (/** @type {any} */ p) => {
      p.lines[1].lineId = p.lines[0].lineId;
    },
    (/** @type {any} */ p) => {
      p.totalCents = 13;
    },
    (/** @type {any} */ p) => {
      p.lines[0].unitCents = 2;
    },
    (/** @type {any} */ p) => {
      p.lines[0].unitLexeme = '0.0101';
    },
    (/** @type {any} */ p) => {
      p.issues.push({ code: 'x', groupId: null, lineId: null });
    },
  ]) {
    const prepared = structuredClone(ready());
    mutate(prepared);
    assert.throws(
      () => reconcileExactCentExport(prepared, observed()),
      errorCode('OLIST_EXACT_CENT_PLAN_INVALID'),
    );
  }
});

test('response fields and sparse arrays cannot smuggle claimed subtotal evidence', () => {
  const prepared = ready();
  const remote = observed(prepared);
  Object.assign(remote.lines[0], { subtotalCents: 3 });
  assert.throws(() => reconcileExactCentExport(prepared, remote), mismatch);
  const sparse = observed(prepared);
  sparse.lines = Array(3);
  assert.throws(() => reconcileExactCentExport(prepared, sparse), mismatch);
});
