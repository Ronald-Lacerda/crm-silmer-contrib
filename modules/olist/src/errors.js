export class OlistError extends Error {
  /** @param {string} code @param {number} [statusCode] */
  constructor(code, statusCode = 409) {
    super(code);
    this.name = 'OlistError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
/** @param {unknown} value @param {boolean} [zero] */
export function integer(value, zero = false) {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1))
    throw new OlistError('INVALID_REQUEST', 400);
  return /** @type {number} */ (value);
}
/** @param {unknown} value @param {number} [max] */
export function text(value, max = 128) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return value.trim();
}
/** @param {unknown} value @param {string[]} keys */
export function object(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return /** @type {Record<string, any>} */ (value);
}
