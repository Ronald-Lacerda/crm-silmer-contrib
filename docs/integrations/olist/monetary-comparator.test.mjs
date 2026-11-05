import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareMoney,
  decimal,
  diagnosticLineCents,
  historicalComparison,
} from './monetary-comparator.mjs';

test('historical evidence reproduces all three blockers without remote calls', async () => {
  const report = await historicalComparison();
  const [c02, c03, c04] = report.results;
  assert.equal(report.authenticatedCalls, 0);
  assert.equal(c02.totalOrderMatches, true);
  assert.equal(c02.allSubtotalMultisetsMatch, false);
  assert.deepEqual(
    c02.groups.flatMap((g) => g.diagnosticSubtotalsCents).sort((a, b) => a - b),
    [99, 201],
  );
  assert.equal(c03.allSubtotalMultisetsMatch, true);
  assert.equal(c03.totalProductsMatches, false);
  assert.equal(c03.everySourceLineIdentified, false);
  assert.equal(c04.totalProductsMatches, true);
  assert.equal(c04.totalOrderMatches, false);
  assert.equal(c04.allSubtotalMultisetsMatch, false);
  assert.ok(
    report.results.every((x) => !x.f1GatePassed && !x.roundingContractVerified),
  );
});
test('exact decimal multiplication preserves tiny units, exponents and ties', () => {
  assert.equal(diagnosticLineCents('1000', '0.000010'), 1);
  assert.equal(diagnosticLineCents('1000', '1e-5'), 1);
  assert.equal(diagnosticLineCents('3', '0.3333'), 100);
  assert.equal(diagnosticLineCents('1', '1.025'), 103);
  assert.equal(diagnosticLineCents('1', '0.005'), 1);
  assert.deepEqual(decimal('1.00'), decimal('1e0'));
});
const wanted = () => ({
  alias: 'C03',
  totalCents: 3,
  lines: [
    { resource: 'new-M', quantity: '1', subtotalCents: 1 },
    { resource: 'new-M', quantity: '1', subtotalCents: 2 },
  ],
});
const observed = () => ({
  totalProducts: '0.03',
  totalOrder: '0.03',
  lines: [
    { resource: 'new-M', quantity: '1', unit: '0.015' },
    { resource: 'new-M', quantity: '1', unit: '0.005' },
  ],
});
test('reordering preserves multiset diagnosis but cannot identify repeated source lines', () => {
  const result = compareMoney(wanted(), observed());
  assert.equal(result.allSubtotalMultisetsMatch, true);
  assert.equal(result.everySourceLineIdentified, false);
  assert.equal(result.f1GatePassed, false);
});
test('missing or merged repeated lines fail even when total matches', () => {
  const input = observed();
  input.lines = [{ resource: 'new-M', quantity: '2', unit: '0.015' }];
  assert.equal(compareMoney(wanted(), input).allSubtotalMultisetsMatch, false);
});
test('M from another parent cannot be matched by size or price', () => {
  const input = observed();
  input.lines[0].resource = 'existing-M-from-C01';
  assert.equal(compareMoney(wanted(), input).allSubtotalMultisetsMatch, false);
});
test('invalid, unbounded, binary and absent amounts fail without echoing input', () => {
  for (const value of [
    undefined,
    null,
    0.3333,
    NaN,
    Infinity,
    '-1',
    '01',
    '1,25',
    '1e99',
    '1e-99',
    '1'.repeat(65),
    'SECRET',
  ]) {
    assert.throws(() => decimal(value), { message: 'INVALID_MONETARY_INPUT' });
  }
  assert.throws(() => diagnosticLineCents('0', '1'));
  assert.throws(() => diagnosticLineCents('1.5', '1'));
  assert.throws(() => diagnosticLineCents('1000001', '1'));
  assert.equal(diagnosticLineCents('1', '0'), 0);
});
test('inconsistent expectations, unknown resource and subcent totals fail', () => {
  const a = wanted();
  a.totalCents = 4;
  assert.throws(() => compareMoney(a, observed()));
  const b = observed();
  b.totalOrder = '0.035';
  assert.throws(() => compareMoney(wanted(), b));
  const c = observed();
  c.lines[0].resource = 'PRIVATE-ID';
  assert.throws(() => compareMoney(wanted(), c));
});
