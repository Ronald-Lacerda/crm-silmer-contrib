import { ShippingValidationError } from './errors.js';
import {
  isFilledString,
  isNonNegativeInteger,
  isPositiveInteger,
} from './guards.js';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: 'bag' | 'box',
 *   lengthCm: number,
 *   widthCm: number,
 *   heightCm: number,
 *   tareGrams: number,
 *   maxLoadGrams: number,
 * }} PackageType
 *
 * @typedef {{
 *   maxWeightGrams?: number,
 *   minLengthCm?: number,
 *   maxLengthCm?: number,
 *   minWidthCm?: number,
 *   maxWidthCm?: number,
 *   minHeightCm?: number,
 *   maxHeightCm?: number,
 *   maxSumCm?: number,
 * }} CarrierLimits
 */

export const PACKAGE_KINDS = Object.freeze(['bag', 'box']);

// MEV-13: the real limits come from /me/shipment/services; these are the
// Correios numbers from RFC 038 section 9, used until the API is read.
export const CORREIOS_LIMITS = Object.freeze({
  maxWeightGrams: 30000,
  minLengthCm: 16,
  maxLengthCm: 105,
  minWidthCm: 11,
  maxWidthCm: 105,
  minHeightCm: 2,
  maxHeightCm: 105,
  maxSumCm: 200,
});

/**
 * MEV-06/13: a bag or box registered in the Melhor Envio menu. `maxLoadGrams`
 * is what fits inside, not counting the package's own weight (`tareGrams`).
 *
 * @param {Readonly<Record<string, unknown>>} input untrusted, e.g. from the menu
 * @returns {Readonly<PackageType>}
 */
export function createPackageType(input) {
  const source = input ?? {};
  const fields = [];
  if (!isFilledString(source.id)) fields.push('id');
  if (!isFilledString(source.name)) fields.push('name');
  if (!PACKAGE_KINDS.includes(/** @type {string} */ (source.kind))) {
    fields.push('kind');
  }
  for (const field of ['lengthCm', 'widthCm', 'heightCm', 'maxLoadGrams']) {
    if (!isPositiveInteger(source[field])) fields.push(field);
  }
  if (!isNonNegativeInteger(source.tareGrams)) fields.push('tareGrams');
  if (fields.length > 0) {
    throw new ShippingValidationError(
      'Confira o tipo, as medidas e os pesos da embalagem.',
      'INVALID_PACKAGE_TYPE',
      fields,
    );
  }
  return Object.freeze({
    id: /** @type {string} */ (source.id).trim(),
    name: /** @type {string} */ (source.name).trim(),
    kind: /** @type {'bag' | 'box'} */ (source.kind),
    lengthCm: /** @type {number} */ (source.lengthCm),
    widthCm: /** @type {number} */ (source.widthCm),
    heightCm: /** @type {number} */ (source.heightCm),
    tareGrams: /** @type {number} */ (source.tareGrams),
    maxLoadGrams: /** @type {number} */ (source.maxLoadGrams),
  });
}

/** @type {readonly [string, keyof CarrierLimits, 'min' | 'max', string][]} */
const DIMENSION_RULES = [
  ['lengthCm', 'minLengthCm', 'min', 'LENGTH_BELOW_MIN'],
  ['lengthCm', 'maxLengthCm', 'max', 'LENGTH_ABOVE_MAX'],
  ['widthCm', 'minWidthCm', 'min', 'WIDTH_BELOW_MIN'],
  ['widthCm', 'maxWidthCm', 'max', 'WIDTH_ABOVE_MAX'],
  ['heightCm', 'minHeightCm', 'min', 'HEIGHT_BELOW_MIN'],
  ['heightCm', 'maxHeightCm', 'max', 'HEIGHT_ABOVE_MAX'],
];

/**
 * MEV-06/13: whether one volume fits a carrier. A limit left out of `limits`
 * is not checked.
 *
 * @param {{lengthCm: number, widthCm: number, heightCm: number,
 *   weightGrams: number}} volume
 * @param {CarrierLimits} [limits]
 * @returns {Readonly<{fits: boolean, reasons: readonly string[]}>}
 */
export function checkCarrierLimits(volume, limits = CORREIOS_LIMITS) {
  const source = /** @type {Record<string, unknown>} */ (volume ?? {});
  const invalid = ['lengthCm', 'widthCm', 'heightCm', 'weightGrams'].filter(
    (field) => !isPositiveInteger(source[field]),
  );
  if (invalid.length > 0) {
    throw new ShippingValidationError(
      'Medidas e peso precisam ser inteiros positivos.',
      'INVALID_VOLUME',
      invalid,
    );
  }
  const { lengthCm, widthCm, heightCm, weightGrams } = volume;
  /** @type {string[]} */
  const reasons = [];
  if (
    limits.maxWeightGrams !== undefined &&
    weightGrams > limits.maxWeightGrams
  ) {
    reasons.push('WEIGHT_ABOVE_MAX');
  }
  for (const [field, limitKey, kind, reason] of DIMENSION_RULES) {
    const limit = limits[limitKey];
    if (limit === undefined) continue;
    const measure = /** @type {number} */ (source[field]);
    if (kind === 'min' ? measure < limit : measure > limit)
      reasons.push(reason);
  }
  if (
    limits.maxSumCm !== undefined &&
    lengthCm + widthCm + heightCm > limits.maxSumCm
  ) {
    reasons.push('SUM_ABOVE_MAX');
  }
  return Object.freeze({
    fits: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
