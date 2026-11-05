import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSizePricing,
  changeSizePricingQuantity,
  createSizePricing,
  duplicateSizePricingGroup,
  reviewSizePricingSubtotal,
} from '../modules/orders/src/domain/size-pricing.js';

/** @param {number} [start] */
function ids(start = 1) {
  let n = start;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
}

function composition() {
  return createSizePricing(
    [
      [
        { size: 'M', quantity: 10 },
        { size: 'G', quantity: 20 },
      ],
      [{ size: 'M', quantity: 3 }],
    ],
    ids(),
  );
}

/** @param {ReturnType<typeof composition>} input */
function priced(input = composition()) {
  let state = input;
  const amounts = [18000, 32000, 100];
  for (const group of input)
    for (const line of group.lines) {
      state = reviewSizePricingSubtotal(
        state,
        group.id,
        line.id,
        /** @type {number} */ (amounts.shift()),
      );
    }
  return state;
}

/** @param {string} code */
function errorCode(code) {
  return (/** @type {unknown} */ error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

test('OLIST-10/40: cents are authoritative; negotiated quantity discounts sum exactly', () => {
  const result = calculateSizePricing(priced());
  assert.equal(result.complete, true);
  assert.equal(result.totalCents, 50100);
  assert.deepEqual(
    result.groups.map((group) => group.subtotalCents),
    [50000, 100],
  );
  assert.deepEqual(result.issues, []);
});

test('new compositions have no inferred price; missing lines never produce a partial total', () => {
  const state = composition();
  const initial = calculateSizePricing(state);
  assert.equal(initial.complete, false);
  assert.equal(initial.totalCents, null);
  assert.equal(initial.issues.length, 3);
  assert.ok(
    state.every((group) =>
      group.lines.every(
        (line) =>
          line.subtotalCents === null && line.subtotalReviewed === false,
      ),
    ),
  );
  const partial = reviewSizePricingSubtotal(
    state,
    state[0].id,
    state[0].lines[0].id,
    18000,
  );
  assert.equal(calculateSizePricing(partial).totalCents, null);
  assert.equal(calculateSizePricing([]).complete, false);
  assert.equal(
    calculateSizePricing(createSizePricing([[]], ids())).groups[0]
      .subtotalCents,
    null,
  );
});

test('OLIST-42: reorder preserves identities and M in different garments stays separate', () => {
  const state = priced();
  const original = structuredClone(state);
  const reordered = [
    state[1],
    { ...state[0], lines: [...state[0].lines].reverse() },
  ];
  assert.equal(calculateSizePricing(reordered).totalCents, 50100);
  const edited = reviewSizePricingSubtotal(
    reordered,
    state[1].id,
    state[1].lines[0].id,
    200,
  );
  assert.equal(edited[0].lines[0].subtotalCents, 200);
  assert.equal(
    edited[1].lines.find((line) => line.size === 'M')?.subtotalCents,
    18000,
  );
  assert.deepEqual(state, original);
  assert.throws(
    () =>
      reviewSizePricingSubtotal(state, state[0].id, state[1].lines[0].id, 200),
    errorCode('SIZE_PRICING_INVALID'),
  );
});

test('OLIST-10/43: quantity change keeps negotiated subtotal but requires explicit review', () => {
  const state = priced();
  const group = state[0];
  const line = group.lines[0];
  const same = changeSizePricingQuantity(
    state,
    group.id,
    line.id,
    line.quantity,
  );
  assert.equal(calculateSizePricing(same).complete, true);
  const changed = changeSizePricingQuantity(state, group.id, line.id, 11);
  assert.equal(changed[0].lines[0].subtotalCents, 18000);
  assert.equal(changed[0].lines[0].subtotalReviewed, false);
  assert.equal(calculateSizePricing(changed).totalCents, null);
  assert.equal(
    calculateSizePricing(changed).issues[0].code,
    'SIZE_SUBTOTAL_REVIEW_REQUIRED',
  );
  const back = changeSizePricingQuantity(changed, group.id, line.id, 10);
  assert.equal(calculateSizePricing(back).complete, false);
  assert.equal(
    calculateSizePricing(
      reviewSizePricingSubtotal(back, group.id, line.id, 18000),
    ).totalCents,
    50100,
  );
  assert.equal(state[0].lines[0].subtotalReviewed, true);
});

test('clearing a subtotal returns to incomplete rather than zero-price sale', () => {
  const state = priced();
  const next = reviewSizePricingSubtotal(
    state,
    state[0].id,
    state[0].lines[0].id,
    null,
  );
  assert.equal(next[0].lines[0].subtotalCents, null);
  assert.equal(next[0].lines[0].subtotalReviewed, false);
  assert.equal(
    calculateSizePricing(next).issues[0].code,
    'SIZE_SUBTOTAL_REQUIRED',
  );
});

test('OLIST-42: duplication allocates fresh group/line IDs and does not inherit review', () => {
  const state = priced();
  const next = duplicateSizePricingGroup(state, state[0].id, ids(10));
  assert.equal(next.length, 3);
  const originals = new Set(
    state.flatMap((group) => [group.id, ...group.lines.map((line) => line.id)]),
  );
  assert.ok(!originals.has(next[2].id));
  assert.ok(
    next[2].lines.every(
      (line) => !originals.has(line.id) && !line.subtotalReviewed,
    ),
  );
  assert.deepEqual(
    next[2].lines.map((line) => line.subtotalCents),
    [18000, 32000],
  );
  assert.equal(calculateSizePricing(next).totalCents, null);
  assert.throws(
    () => duplicateSizePricingGroup(state, state[0].id, () => state[0].id),
    errorCode('SIZE_PRICING_INVALID'),
  );
  assert.equal(state.length, 2);
});

test('OLIST-40: group and cross-group overflow fail before lossy Number conversion', () => {
  const single = createSizePricing([[{ size: 'M', quantity: 1 }]], ids());
  const maximum = reviewSizePricingSubtotal(
    single,
    single[0].id,
    single[0].lines[0].id,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    calculateSizePricing(maximum).totalCents,
    Number.MAX_SAFE_INTEGER,
  );
  const state = priced();
  assert.throws(
    () =>
      reviewSizePricingSubtotal(
        state,
        state[0].id,
        state[0].lines[0].id,
        Number.MAX_SAFE_INTEGER,
      ),
    errorCode('SIZE_PRICING_OVERFLOW'),
  );
  assert.throws(
    () =>
      reviewSizePricingSubtotal(
        state,
        state[1].id,
        state[1].lines[0].id,
        Number.MAX_SAFE_INTEGER,
      ),
    errorCode('SIZE_PRICING_OVERFLOW'),
  );
  assert.throws(
    () => duplicateSizePricingGroup(maximum, maximum[0].id, ids(20)),
    errorCode('SIZE_PRICING_OVERFLOW'),
  );
  const corrupt = structuredClone(state);
  corrupt[1].lines[0].subtotalCents = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => calculateSizePricing(corrupt),
    errorCode('SIZE_PRICING_OVERFLOW'),
  );
  assert.equal(calculateSizePricing(state).totalCents, 50100);
});

test('malformed and hostile money/quantities cannot be coerced or echoed', () => {
  const state = composition();
  for (const value of [
    0,
    -1,
    0.01,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    'PRIVATE_INPUT',
    {},
    undefined,
  ]) {
    for (const operation of [
      changeSizePricingQuantity,
      reviewSizePricingSubtotal,
    ]) {
      assert.throws(
        () =>
          operation(
            state,
            state[0].id,
            state[0].lines[0].id,
            /** @type {any} */ (value),
          ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes('PRIVATE_INPUT'));
          return errorCode('SIZE_PRICING_INVALID')(error);
        },
      );
    }
  }
});

test('duplicate identities, unknown totals and duplicated sizes are rejected', () => {
  const state = priced();
  for (const mutate of [
    (/** @type {typeof state} */ s) => {
      s[1].id = s[0].id;
    },
    (/** @type {typeof state} */ s) => {
      s[1].lines[0].id = s[0].id;
    },
    (/** @type {typeof state} */ s) => {
      s[1].lines[0].id = s[0].lines[0].id;
    },
    (/** @type {typeof state} */ s) => {
      s[0].lines[1].size = 'M';
    },
    (/** @type {typeof state} */ s) => {
      Object.assign(s[0], { totalCents: 999 });
    },
    (/** @type {typeof state} */ s) => {
      Object.assign(s[0].lines[0], { unitPrice: 1 });
    },
  ]) {
    const copy = structuredClone(state);
    mutate(copy);
    assert.throws(
      () => calculateSizePricing(copy),
      errorCode('SIZE_PRICING_INVALID'),
    );
  }
  assert.throws(
    () =>
      createSizePricing(
        [[/** @type {any} */ ({ size: 'M', quantity: 1, subtotalCents: 100 })]],
        ids(),
      ),
    errorCode('SIZE_PRICING_INVALID'),
  );
});

test('fractional ERP units do not restrict valid CRM subtotals or cause automatic rounding', () => {
  const state = createSizePricing(
    [
      [
        { size: 'M', quantity: 3 },
        { size: 'G', quantity: 1000 },
      ],
    ],
    ids(),
  );
  const first = reviewSizePricingSubtotal(
    state,
    state[0].id,
    state[0].lines[0].id,
    100,
  );
  const complete = reviewSizePricingSubtotal(
    first,
    state[0].id,
    state[0].lines[1].id,
    1,
  );
  assert.equal(calculateSizePricing(complete).totalCents, 101);
  assert.deepEqual(
    complete[0].lines.map((line) => line.subtotalCents),
    [100, 1],
  );
  assert.ok(!('erpUnitPrice' in calculateSizePricing(complete)));
});

test('sparse arrays cannot skip validation and produce a complete zero total', () => {
  assert.throws(
    () => createSizePricing(Array(1)),
    errorCode('SIZE_PRICING_INVALID'),
  );
  assert.throws(
    () => createSizePricing([Array(1)]),
    errorCode('SIZE_PRICING_INVALID'),
  );
  assert.throws(
    () => calculateSizePricing(Array(1)),
    errorCode('SIZE_PRICING_INVALID'),
  );
  const state = priced();
  state[0].lines = Array(1);
  assert.throws(
    () => calculateSizePricing(state),
    errorCode('SIZE_PRICING_INVALID'),
  );
  const disguisedHole = Array(1);
  Object.assign(disguisedHole, { fake: state[1] });
  assert.throws(
    () => calculateSizePricing(disguisedHole),
    errorCode('SIZE_PRICING_INVALID'),
  );
});
