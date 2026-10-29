// Small shared guards for the shipping domain. Units are integers on purpose:
// cents, grams and centimetres never go through floating point here.

/** @param {unknown} value @returns {value is number} */
export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

/** @param {unknown} value @returns {value is number} */
export function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} value @returns {value is string} */
export function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {unknown} value
 * @returns {string} only the digits, '' for anything that is not text/number
 */
export function onlyDigits(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return typeof value === 'string' ? value.replace(/\D/gu, '') : '';
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
