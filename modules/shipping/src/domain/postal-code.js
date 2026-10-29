import { ShippingValidationError } from './errors.js';

// MEV-02: a CEP is 8 digits, typed as 69301-000, 69301000 or 69.301-000.
const POSTAL_CODE = /^(\d{2})\.?(\d{3})-?(\d{3})$/u;

// In free text the CEP must stand alone: a digit (or a digit followed by a
// separator) on either side means it is part of a phone, CPF or order number.
const POSTAL_CODE_IN_TEXT =
  /(?<!\d)(?<!\d[./-])(\d{2})\.?(\d{3})-?(\d{3})(?!\d)(?![./-]\d)/gu;

/**
 * @param {unknown} value
 * @returns {string} 8 digits, e.g. `69301000`
 */
export function normalizePostalCode(value) {
  const match =
    typeof value === 'string' ? POSTAL_CODE.exec(value.trim()) : null;
  const digits = match ? `${match[1]}${match[2]}${match[3]}` : '';
  if (!digits || /^0+$/u.test(digits)) {
    throw new ShippingValidationError(
      'Informe um CEP com 8 dígitos.',
      'INVALID_POSTAL_CODE',
      ['postalCode'],
    );
  }
  return digits;
}

/**
 * MEV-02: CEPs a customer wrote in a chat message, in the order they appear.
 *
 * @param {unknown} text
 * @returns {readonly string[]}
 */
export function findPostalCodes(text) {
  if (typeof text !== 'string') return Object.freeze([]);
  const found = new Set();
  for (const match of text.matchAll(POSTAL_CODE_IN_TEXT)) {
    const digits = `${match[1]}${match[2]}${match[3]}`;
    if (!/^0+$/u.test(digits)) found.add(digits);
  }
  return Object.freeze([...found]);
}
