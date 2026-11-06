import { OlistError } from './errors.js';

export class OlistJsonNumber {
  /** @param {string} lexeme */
  constructor(lexeme) {
    this.lexeme = lexeme;
    Object.freeze(this);
  }
}
/** Bounded JSON parser retaining numeric tokens and rejecting duplicate keys.
 * It never passes money through a binary floating-point representation.
 * @param {string} raw @returns {any} */
export function parseOlistLosslessJson(raw) {
  const fail = () => {
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1048576) fail();
  let at = 0,
    nodes = 0;
  function whitespace() {
    while (/[ \t\r\n]/u.test(raw[at] ?? '') && at < raw.length) at++;
  }
  function string() {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (c === '\\') {
        at++;
        continue;
      }
      if (c === '"') {
        try {
          return JSON.parse(raw.slice(start, at));
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  /** @param {number} depth @returns {any} */
  function value(depth) {
    if (++nodes > 25000 || depth > 40) fail();
    whitespace();
    const c = raw[at];
    if (c === '"') return string();
    if (c === '{') {
      at++;
      whitespace();
      const object = Object.create(null),
        keys = new Set();
      if (raw[at] === '}') {
        at++;
        return object;
      }
      while (at < raw.length) {
        whitespace();
        if (raw[at] !== '"') fail();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (raw[at++] !== ':') fail();
        object[key] = value(depth + 1);
        whitespace();
        const next = raw[at++];
        if (next === '}') return object;
        if (next !== ',') fail();
      }
      return fail();
    }
    if (c === '[') {
      at++;
      whitespace();
      /** @type {any[]} */
      const array = [];
      if (raw[at] === ']') {
        at++;
        return array;
      }
      while (at < raw.length) {
        array.push(value(depth + 1));
        whitespace();
        const next = raw[at++];
        if (next === ']') return array;
        if (next !== ',') fail();
      }
      return fail();
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (raw.startsWith(/** @type {string} */ (token), at)) {
        at += /** @type {string} */ (token).length;
        return result;
      }
    }
    const number =
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
        raw.slice(at),
      );
    if (!number || number[0].length > 80) return fail();
    at += number[0].length;
    return new OlistJsonNumber(number[0]);
  }
  const result = value(0);
  whitespace();
  if (at !== raw.length) fail();
  return result;
}
/** @param {any} value */
export function olistNumberLexeme(value) {
  if (!(value instanceof OlistJsonNumber))
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  return value.lexeme;
}
/** Decode an unsigned integer token without a binary numeric intermediary.
 * @param {any} value */
function integerBigInt(value) {
  const raw = olistNumberLexeme(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(
    raw,
  );
  if (!match) throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  const exponent = BigInt(match[3] ?? '0'),
    fraction = match[2] ?? '';
  if (exponent < -20n || exponent > 20n)
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  let integer = BigInt(match[1] + fraction);
  const power = exponent - BigInt(fraction.length);
  if (power >= 0n) integer *= 10n ** power;
  else {
    const divisor = 10n ** -power;
    if (integer % divisor !== 0n)
      throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    integer /= divisor;
  }
  return integer;
}
/** Preserve observed positive provider identities up to 19 digits, even when
 * the read-only client cannot safely address them. Never use this for money.
 * @param {any} value */
export function olistIdentifierFromJson(value) {
  const integer = integerBigInt(value);
  if (integer < 1n || integer > 9999999999999999999n)
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  return String(integer);
}
/** Integer identities/quantities may be converted only after exact decimal
 * validation; money is never passed to this function.
 * @param {any} value @param {boolean} [zero] */
export function olistIntegerFromJson(value, zero = false) {
  const integer = integerBigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < (zero ? 0n : 1n))
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  return Number(integer);
}
