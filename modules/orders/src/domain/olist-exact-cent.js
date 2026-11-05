import { OrderValidationError } from './errors.js';
import { calculateSizePricing } from './size-pricing.js';

// OLIST-T06a/T02: reduced scope approved by the PO. This pure boundary does
// not authorize a remote effect. Application commands still need human ACL,
// version/fencing and a durable reservation before any request. The caller
// must bind ERP product/account/order identity independently of line markers.
/**
 * @typedef {{groupId: string, lineId: string, quantity: number,
 *   subtotalCents: number, unitCents: number, unitLexeme: string}} ExactCentLine
 * @typedef {{code: string, groupId: string|null, lineId: string|null}} ExportIssue
 * @typedef {{policy: 'exact-cent-v1', eligible: boolean, totalCents: number|null,
 *   lines: readonly Readonly<ExactCentLine>[],
 *   issues: readonly Readonly<ExportIssue>[]}} ExactCentPreparation
 * @typedef {{lineId: string, quantity: number, unitLexeme: string}} ObservedLine
 * @typedef {{lines: ObservedLine[], totalProductsLexeme: string,
 *   totalOrderLexeme: string}} ExactCentObservation
 */
const POLICY = 'exact-cent-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** @param {string} code @returns {never} */
function refuse(code) {
  throw new OrderValidationError(
    'Não foi possível conferir os valores e as linhas do pedido no Olist.',
    code,
    ['olistExport'],
  );
}

/** @param {unknown} value @param {readonly string[]} keys
 * @param {string} code @returns {Record<string, unknown>} */
function record(value, keys, code) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    refuse(code);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} code @returns {unknown[]} */
function dense(value, code) {
  if (!Array.isArray(value)) refuse(code);
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  )
    refuse(code);
  return value;
}

/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** @param {number} cents */
function centsLexeme(cents) {
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** Parse the raw response lexeme, never a previously rounded JS Number.
 * Extra zero decimal places and decimal exponents are accepted only when
 * the value is exactly an integer number of cents. No rounding is applied.
 * @param {unknown} lexeme @param {string} code @returns {bigint} */
function exactCents(lexeme, code) {
  if (typeof lexeme !== 'string' || lexeme.length > 80) refuse(code);
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(lexeme);
  if (!match) refuse(code);
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 20) refuse(code);
  const fraction = match[2] ?? '';
  const coefficient = BigInt(match[1] + fraction);
  const power = exponent + 2 - fraction.length;
  let cents;
  if (power >= 0) cents = coefficient * 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (coefficient % divisor !== 0n) refuse(code);
    cents = coefficient / divisor;
  }
  if (cents > MAX) refuse(code);
  return cents;
}

/** @param {boolean} eligible @param {number|null} totalCents
 * @param {ExactCentLine[]} lines @param {ExportIssue[]} issues
 * @returns {Readonly<ExactCentPreparation>} */
function result(eligible, totalCents, lines, issues) {
  return Object.freeze({
    policy: POLICY,
    eligible,
    totalCents,
    lines: Object.freeze(lines.map((line) => Object.freeze(line))),
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}

/**
 * Keep the commercial CRM composition valid while refusing the complete ERP
 * export if even one line needs a fraction of a cent per unit. Never round,
 * split a line, compensate between lines or expose an exportable partial plan.
 * Server-owned state only: review flags are not browser-provided approval.
 * @param {import('./size-pricing.js').SizePriceGroup[]} groups
 * @returns {Readonly<ExactCentPreparation>}
 */
export function prepareExactCentExport(groups) {
  const totals = calculateSizePricing(groups);
  if (!totals.complete) return result(false, null, [], totals.issues);
  /** @type {ExactCentLine[]} */
  const lines = [];
  /** @type {ExportIssue[]} */
  const issues = [];
  for (const group of groups)
    for (const line of group.lines) {
      // calculateSizePricing established non-null, reviewed, positive cents.
      const subtotalCents = /** @type {number} */ (line.subtotalCents);
      const cents = BigInt(subtotalCents);
      const quantity = BigInt(line.quantity);
      if (cents % quantity !== 0n) {
        issues.push({
          code: 'OLIST_FRACTIONAL_CENT_UNIT',
          groupId: group.id,
          lineId: line.id,
        });
      } else {
        const unitCents = Number(cents / quantity);
        lines.push({
          groupId: group.id,
          lineId: line.id,
          quantity: line.quantity,
          subtotalCents,
          unitCents,
          unitLexeme: centsLexeme(unitCents),
        });
      }
    }
  return result(
    issues.length === 0,
    totals.totalCents,
    issues.length ? [] : lines,
    issues,
  );
}

/** Reject a damaged or forged server-side preparation before reconciliation.
 * This integrity validation is not authorization of an external effect.
 * @param {unknown} prepared @returns {Map<string, ExactCentLine>} */
function expectedLines(prepared) {
  const code = 'OLIST_EXACT_CENT_PLAN_INVALID';
  const plan = record(
    prepared,
    ['policy', 'eligible', 'totalCents', 'lines', 'issues'],
    code,
  );
  if (
    plan.policy !== POLICY ||
    plan.eligible !== true ||
    !positiveInteger(plan.totalCents) ||
    dense(plan.issues, code).length !== 0
  )
    refuse(code);
  const source = dense(plan.lines, code);
  if (source.length === 0) refuse(code);
  const lines = new Map();
  let total = 0n;
  for (const value of source) {
    const line = record(
      value,
      [
        'groupId',
        'lineId',
        'quantity',
        'subtotalCents',
        'unitCents',
        'unitLexeme',
      ],
      code,
    );
    if (
      typeof line.groupId !== 'string' ||
      !UUID.test(line.groupId) ||
      typeof line.lineId !== 'string' ||
      !UUID.test(line.lineId) ||
      line.groupId === line.lineId ||
      lines.has(line.lineId) ||
      !positiveInteger(line.quantity) ||
      !positiveInteger(line.subtotalCents) ||
      !positiveInteger(line.unitCents) ||
      exactCents(line.unitLexeme, code) !== BigInt(line.unitCents) ||
      BigInt(line.quantity) * BigInt(line.unitCents) !==
        BigInt(line.subtotalCents)
    )
      refuse(code);
    total += BigInt(line.subtotalCents);
    lines.set(line.lineId, /** @type {ExactCentLine} */ (line));
  }
  if (total !== BigInt(plan.totalCents) || total > MAX) refuse(code);
  return lines;
}

/**
 * Match opaque returned line markers and independently returned quantities,
 * unit values and totals. Metadata must never carry a claimed subtotal as
 * evidence. The adapter checks product IDs/SKUs and account/order identity.
 * @param {Readonly<ExactCentPreparation>} prepared
 * @param {ExactCentObservation} observed
 * @returns {Readonly<{matched: true, lineCount: number, totalCents: number}>}
 */
export function reconcileExactCentExport(prepared, observed) {
  const expected = expectedLines(prepared);
  const code = 'OLIST_EXACT_CENT_READBACK_MISMATCH';
  const body = record(
    observed,
    ['lines', 'totalProductsLexeme', 'totalOrderLexeme'],
    code,
  );
  const lines = dense(body.lines, code);
  if (lines.length !== expected.size) refuse(code);
  const seen = new Set();
  let total = 0n;
  for (const rawLine of lines) {
    const line = record(rawLine, ['lineId', 'quantity', 'unitLexeme'], code);
    if (typeof line.lineId !== 'string' || seen.has(line.lineId)) refuse(code);
    const match = expected.get(line.lineId);
    if (
      !match ||
      !positiveInteger(line.quantity) ||
      line.quantity !== match.quantity
    )
      refuse(code);
    seen.add(line.lineId);
    const unitCents = exactCents(line.unitLexeme, code);
    const subtotal = unitCents * BigInt(line.quantity);
    if (
      unitCents !== BigInt(match.unitCents) ||
      subtotal !== BigInt(match.subtotalCents)
    )
      refuse(code);
    total += subtotal;
  }
  if (
    exactCents(body.totalProductsLexeme, code) !== total ||
    exactCents(body.totalOrderLexeme, code) !== total ||
    total !== BigInt(/** @type {number} */ (prepared.totalCents))
  )
    refuse(code);
  return Object.freeze({
    matched: true,
    lineCount: lines.length,
    totalCents: Number(total),
  });
}
