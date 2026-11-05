/** OLIST-T02 / F1-G01: diagnostic only; never authorizes export or closes F1. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fail = () => {
  throw new Error('INVALID_MONETARY_INPUT');
};
const resources = new Set(['new-M', 'new-G', 'existing-M-from-C01']);

// Bound both input and exponent before allocating BigInts. No binary arithmetic.
export function decimal(value) {
  if (typeof value !== 'string' || value.length > 64) fail();
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if (!m) fail();
  let scale = (m[2]?.length ?? 0) - Number(m[3] ?? 0);
  if (Math.abs(scale) > 30) fail();
  let coefficient = BigInt(m[1] + (m[2] ?? ''));
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  if (coefficient > 10n ** 30n) fail();
  return { coefficient, scale };
}
function centsOf(d, round) {
  const n = d.coefficient * 100n,
    divisor = 10n ** BigInt(d.scale);
  if (!round && n % divisor !== 0n) fail();
  const cents =
    n / divisor + (round && (n % divisor) * 2n >= divisor ? 1n : 0n);
  if (cents > 1000000000000n) fail();
  return Number(cents);
}
export function diagnosticLineCents(quantity, unit) {
  const q = decimal(quantity),
    u = decimal(unit);
  if (q.coefficient === 0n || q.scale !== 0 || q.coefficient > 1000000n) fail();
  return centsOf(
    { coefficient: q.coefficient * u.coefficient, scale: u.scale },
    true,
  );
}
function groupKey(line) {
  if (!resources.has(line?.resource)) fail();
  const q = decimal(line.quantity);
  if (q.scale !== 0 || q.coefficient === 0n || q.coefficient > 1000000n) fail();
  return line.resource + ':' + q.coefficient;
}
function sameValues(a, b) {
  return (
    a.length === b.length &&
    [...a]
      .sort((x, y) => x - y)
      .every((x, i) => x === [...b].sort((x, y) => x - y)[i])
  );
}
function centsInput(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000000) fail();
  return n;
}
export function compareMoney(expected, observed) {
  if (
    !['C02', 'C03', 'C04'].includes(expected?.alias) ||
    !Array.isArray(expected.lines) ||
    !Array.isArray(observed?.lines) ||
    expected.lines.length < 1 ||
    expected.lines.length > 10 ||
    observed.lines.length > 10
  )
    fail();
  const wanted = new Map(),
    actual = new Map();
  for (const line of expected.lines) {
    const key = groupKey(line);
    wanted.set(key, [
      ...(wanted.get(key) ?? []),
      centsInput(line.subtotalCents),
    ]);
  }
  for (const line of observed.lines) {
    const key = groupKey(line);
    actual.set(key, [
      ...(actual.get(key) ?? []),
      diagnosticLineCents(line.quantity, line.unit),
    ]);
  }
  const groups = [...new Set([...wanted.keys(), ...actual.keys()])]
    .sort()
    .map((key) => {
      const a = wanted.get(key) ?? [],
        b = actual.get(key) ?? [];
      return {
        resource: key.split(':')[0],
        quantity: key.split(':')[1],
        expectedSubtotalsCents: [...a].sort((x, y) => x - y),
        diagnosticSubtotalsCents: [...b].sort((x, y) => x - y),
        lineCountMatches: a.length === b.length,
        subtotalMultisetMatches: sameValues(a, b),
        // No value-based matching, array position, or invented identity for repeats.
        sourceLineIdentified: a.length === 1 && b.length === 1,
      };
    });
  const totalCents = centsInput(expected.totalCents);
  if (
    expected.lines.reduce((n, line) => n + line.subtotalCents, 0) !== totalCents
  )
    fail();
  const totalProductsCents = centsOf(decimal(observed.totalProducts), false);
  const totalOrderCents = centsOf(decimal(observed.totalOrder), false);
  return {
    alias: expected.alias,
    rounding: 'positive-half-up-hypothesis-only',
    groups,
    totalProductsCents,
    totalOrderCents,
    expectedTotalCents: totalCents,
    totalProductsMatches: totalProductsCents === totalCents,
    totalOrderMatches: totalOrderCents === totalCents,
    allSubtotalMultisetsMatch: groups.every((g) => g.subtotalMultisetMatches),
    everySourceLineIdentified: groups.every((g) => g.sourceLineIdentified),
    independentSubtotalsAvailable: false,
    roundingContractVerified: false,
    f1GatePassed: false,
  };
}
export async function historicalComparison() {
  const evidence = JSON.parse(
    await readFile(
      new URL('./evidence/phase1-controlled-results.json', import.meta.url),
      'utf8',
    ),
  );
  const plan = JSON.parse(
    await readFile(
      new URL('./next-controlled-cases.json', import.meta.url),
      'utf8',
    ),
  );
  const results = plan.orders.map((order) => {
    const alias = order.reference.slice(-3),
      m = evidence.money[alias];
    return compareMoney(
      {
        alias,
        totalCents: m.uiTotalCents,
        lines: order.items.map((line, i) => ({
          resource: line.resource,
          quantity: String(line.quantity),
          subtotalCents: m.uiSubtotalsCents[i],
        })),
      },
      {
        lines: order.items.map((line, i) => ({
          resource: line.resource,
          quantity: String(line.quantity),
          unit: m.apiUnitBySourceLine[i],
        })),
        totalProducts: m.apiTotalProducts,
        totalOrder: m.apiTotalOrder,
      },
    );
  });
  return {
    task: 'OLIST-T02',
    gap: 'F1-G01',
    source: 'historical-sanitized-projection-not-new-raw-read',
    authenticatedCalls: 0,
    erpWrites: 0,
    results,
    f1GatePassed: false,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--historical')
      throw new Error();
    process.stdout.write(
      JSON.stringify(await historicalComparison(), null, 2) + '\n',
    );
  } catch {
    process.stderr.write('MONETARY_COMPARISON_FAILED\n');
    process.exitCode = 1;
  }
}
