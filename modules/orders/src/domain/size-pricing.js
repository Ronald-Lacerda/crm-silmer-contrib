import { randomUUID } from 'node:crypto';
import { OrderValidationError } from './errors.js';

// ADR 057 / OLIST-T20a/T21a: local domain foundation only. These records are
// server-owned state, not an HTTP payload or proof of ERP representability.
// Existing ficha snapshots and finalAmount are deliberately not migrated here.
/**
 * @typedef {{id: string, size: string, quantity: number,
 *   subtotalCents: number|null, subtotalReviewed: boolean}} SizePriceLine
 * @typedef {{id: string, lines: SizePriceLine[]}} SizePriceGroup
 * @typedef {{size: string, quantity: number}} SizePriceSeed
 * @typedef {{code: string, groupId: string|null, lineId: string|null}} PricingIssue
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GROUP_KEYS = new Set(['id', 'lines']);
const LINE_KEYS = new Set([
  'id',
  'size',
  'quantity',
  'subtotalCents',
  'subtotalReviewed',
]);
const SEED_KEYS = new Set(['size', 'quantity']);
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** @param {string} [field] @returns {never} */
function invalid(field = 'sizePricing') {
  throw new OrderValidationError(
    'Revise os tamanhos, quantidades e subtotais do pedido.',
    'SIZE_PRICING_INVALID',
    [field],
  );
}

/** Holes must not silently disappear through Array.map and make an order
 * appear completely priced. Also refuse non-index properties on arrays.
 * @param {unknown} value @returns {unknown[]} */
function denseArray(value) {
  if (!Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  )
    invalid();
  return value;
}

/** @param {unknown} value @param {Set<string>} keys
 * @returns {Record<string, unknown>} */
function record(value, keys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.has(key))
  )
    invalid();
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {number} */
function positiveInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid();
  return value;
}

/** @param {unknown} value @returns {string} */
function size(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    invalid();
  return value.trim();
}

/** @param {unknown} value @param {Set<string>} used @returns {string} */
function identity(value, used) {
  if (typeof value !== 'string' || !UUID.test(value) || used.has(value))
    invalid();
  used.add(value);
  return value;
}

/** Validate and copy canonical state before a domain operation.
 * @param {unknown} value @returns {SizePriceGroup[]} */
function copyGroups(value) {
  const groups = denseArray(value);
  if (groups.length > 50) invalid();
  const used = new Set();
  return groups.map((rawGroup) => {
    const group = record(rawGroup, GROUP_KEYS);
    const id = identity(group.id, used);
    const sizes = new Set();
    const lines = denseArray(group.lines).map((rawLine) => {
      const line = record(rawLine, LINE_KEYS);
      const lineSize = size(line.size);
      if (sizes.has(lineSize)) invalid();
      sizes.add(lineSize);
      const subtotal =
        line.subtotalCents === null
          ? null
          : positiveInteger(line.subtotalCents);
      if (
        typeof line.subtotalReviewed !== 'boolean' ||
        (subtotal === null && line.subtotalReviewed)
      )
        invalid();
      return {
        id: identity(line.id, used),
        size: lineSize,
        quantity: positiveInteger(line.quantity),
        subtotalCents: subtotal,
        subtotalReviewed: line.subtotalReviewed,
      };
    });
    return { id, lines };
  });
}

/**
 * Start an unpriced composition. Never divide an old final amount or derive
 * subtotals from catalog prices; existing orders need a later explicit command.
 * @param {SizePriceSeed[][]} groups @param {() => string} [createId]
 * @returns {SizePriceGroup[]}
 */
export function createSizePricing(groups, createId = randomUUID) {
  const seeds = denseArray(groups);
  if (seeds.length > 50) invalid();
  return copyGroups(
    seeds.map((lines) => {
      return {
        id: createId(),
        lines: denseArray(lines).map((rawLine) => {
          const line = record(rawLine, SEED_KEYS);
          return {
            id: createId(),
            size: size(line.size),
            quantity: positiveInteger(line.quantity),
            subtotalCents: null,
            subtotalReviewed: false,
          };
        }),
      };
    }),
  );
}

/** @param {SizePriceGroup[]} groups @param {string} groupId
 * @param {string} lineId @returns {SizePriceLine} */
function findLine(groups, groupId, lineId) {
  const line = groups
    .find((group) => group.id === groupId)
    ?.lines.find((candidate) => candidate.id === lineId);
  if (!line) invalid();
  return line;
}

/**
 * A change invalidates review even if the quantity is later changed back.
 * Keeping the old subtotal is not a human review; no old unit price is applied.
 * @param {SizePriceGroup[]} groups @param {string} groupId
 * @param {string} lineId @param {number} quantity @returns {SizePriceGroup[]}
 */
export function changeSizePricingQuantity(groups, groupId, lineId, quantity) {
  const next = copyGroups(groups);
  const line = findLine(next, groupId, lineId);
  const value = positiveInteger(quantity);
  if (line.quantity !== value) {
    line.quantity = value;
    line.subtotalReviewed = false;
  }
  calculateSizePricing(next);
  return next;
}

/**
 * Future application commands must authorize a human and fence order version
 * before calling this. A browser-supplied review flag must never be imported.
 * @param {SizePriceGroup[]} groups @param {string} groupId
 * @param {string} lineId @param {number|null} subtotalCents
 * @returns {SizePriceGroup[]}
 */
export function reviewSizePricingSubtotal(
  groups,
  groupId,
  lineId,
  subtotalCents,
) {
  const next = copyGroups(groups);
  const line = findLine(next, groupId, lineId);
  line.subtotalCents =
    subtotalCents === null ? null : positiveInteger(subtotalCents);
  line.subtotalReviewed = subtotalCents !== null;
  calculateSizePricing(next);
  return next;
}

/** Duplicating a garment creates new identities and requires price review.
 * @param {SizePriceGroup[]} groups @param {string} groupId
 * @param {() => string} [createId] @returns {SizePriceGroup[]} */
export function duplicateSizePricingGroup(
  groups,
  groupId,
  createId = randomUUID,
) {
  const next = copyGroups(groups);
  const group = next.find((candidate) => candidate.id === groupId);
  if (!group) invalid();
  next.push({
    id: createId(),
    lines: group.lines.map((line) => ({
      ...line,
      id: createId(),
      subtotalReviewed: false,
    })),
  });
  const validated = copyGroups(next);
  calculateSizePricing(validated);
  return validated;
}

/** @param {bigint} cents @returns {number} */
function boundedCents(cents) {
  if (cents > MAX_CENTS) {
    throw new OrderValidationError(
      'A soma dos subtotais ultrapassa o limite de valores do pedido.',
      'SIZE_PRICING_OVERFLOW',
      ['sizePricing'],
    );
  }
  return Number(cents);
}

/**
 * Incomplete or unreviewed prices never become a partial authoritative total.
 * No independent total, quantity-informed field or ERP price enters this sum.
 * @param {SizePriceGroup[]} input
 * @returns {{complete: boolean, totalCents: number|null,
 * groups: {id: string, subtotalCents: number|null}[], issues: PricingIssue[]}}
 */
export function calculateSizePricing(input) {
  const groups = copyGroups(input);
  /** @type {PricingIssue[]} */
  const issues = [];
  if (groups.length === 0)
    issues.push({ code: 'SIZE_PRICING_EMPTY', groupId: null, lineId: null });
  let total = 0n;
  const totals = groups.map((group) => {
    let sum = 0n;
    let complete = group.lines.length > 0;
    if (!complete)
      issues.push({
        code: 'SIZE_PRICING_EMPTY_GROUP',
        groupId: group.id,
        lineId: null,
      });
    for (const line of group.lines) {
      if (line.subtotalCents !== null) sum += BigInt(line.subtotalCents);
      if (line.subtotalCents === null || !line.subtotalReviewed) {
        complete = false;
        issues.push({
          code:
            line.subtotalCents === null
              ? 'SIZE_SUBTOTAL_REQUIRED'
              : 'SIZE_SUBTOTAL_REVIEW_REQUIRED',
          groupId: group.id,
          lineId: line.id,
        });
      }
    }
    const subtotal = boundedCents(sum);
    total += sum;
    return { id: group.id, subtotalCents: complete ? subtotal : null };
  });
  const totalCents = boundedCents(total);
  return {
    complete: issues.length === 0,
    totalCents: issues.length === 0 ? totalCents : null,
    groups: totals,
    issues,
  };
}
