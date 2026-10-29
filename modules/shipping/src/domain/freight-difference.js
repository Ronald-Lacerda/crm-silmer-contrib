import { ShippingValidationError } from './errors.js';
import { isNonNegativeInteger } from './guards.js';

/**
 * @typedef {'no_difference' | 'absorb' | 'needs_manager'} FreightDecision
 */

/**
 * MEV-10: what to do when the label costs more than the quote. A cheaper
 * label is fine; a difference up to the tolerance is absorbed and audited;
 * above it the manager decides. The confirmed final value never changes.
 *
 * @param {{quotedCents: number, actualCents: number,
 *   maxAbsoluteCents?: number, maxRatio?: number}} input
 * @returns {Readonly<{differenceCents: number, toleranceCents: number,
 *   decision: FreightDecision}>}
 */
export function decideFreightDifference({
  quotedCents,
  actualCents,
  maxAbsoluteCents = 2000,
  maxRatio = 0.1,
}) {
  const fields = [];
  if (!isNonNegativeInteger(quotedCents)) fields.push('quotedCents');
  if (!isNonNegativeInteger(actualCents)) fields.push('actualCents');
  if (!isNonNegativeInteger(maxAbsoluteCents)) fields.push('maxAbsoluteCents');
  if (
    typeof maxRatio !== 'number' ||
    !Number.isFinite(maxRatio) ||
    maxRatio < 0 ||
    maxRatio > 1
  ) {
    fields.push('maxRatio');
  }
  if (fields.length > 0) {
    throw new ShippingValidationError(
      'Valores de frete e tolerância inválidos.',
      'INVALID_FREIGHT_DIFFERENCE',
      fields,
    );
  }
  // The epsilon keeps 0.29 * 100 from flooring to 28.
  const ratioCents = Math.floor(quotedCents * maxRatio + 1e-9);
  const toleranceCents = Math.min(maxAbsoluteCents, ratioCents);
  const differenceCents = actualCents - quotedCents;
  /** @type {FreightDecision} */
  let decision = 'needs_manager';
  if (differenceCents <= 0) decision = 'no_difference';
  else if (differenceCents <= toleranceCents) decision = 'absorb';
  return Object.freeze({ differenceCents, toleranceCents, decision });
}
