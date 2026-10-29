/**
 * ADR 047 / CP-25..26: the optional customer registration of a Contact.
 * Pure validation and normalization; no I/O and no Node built-ins, so the
 * same rules can be reasoned about without a database or a cipher.
 */

export const BRAZILIAN_STATES = Object.freeze([
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
]);

/** Form order: the first invalid field in this order is reported first. */
export const CONTACT_REGISTRATION_FIELDS = Object.freeze([
  'personType',
  'document',
  'legalName',
  'instagram',
  'stateRegistration',
  'postalCode',
  'city',
  'state',
  'street',
  'district',
  'number',
  'complement',
]);

export const CONTACT_REGISTRATION_LIMITS = Object.freeze({
  city: 80,
  complement: 80,
  district: 80,
  legalName: 150,
  number: 10,
  street: 150,
});

const STATES = new Set(BRAZILIAN_STATES);
const PERSON_TYPES = new Set(['individual', 'company']);
const NO_NUMBER = new Set(['S/N', 'SN']);
const INSTAGRAM_URL =
  /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)\/?(?:[?#].*)?$/iu;

/**
 * @typedef {'individual'|'company'} PersonType
 * @typedef {{
 *   personType: PersonType|null,
 *   document: string|null,
 *   legalName: string|null,
 *   instagram: string|null,
 *   stateRegistration: string|null,
 *   postalCode: string|null,
 *   city: string|null,
 *   state: string|null,
 *   street: string|null,
 *   district: string|null,
 *   number: string|null,
 *   complement: string|null,
 * }} ContactRegistration
 */

/**
 * Every field is optional; `undefined`, `null`, `''` and blank text mean
 * "not informed". Values are returned normalized (documents without mask).
 *
 * @param {unknown} input
 * @returns {{ok: true, value: Readonly<ContactRegistration>, fieldsComplete: boolean}
 *   | {ok: false, errors: Readonly<Record<string, string>>}}
 */
export function normalizeContactRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: Object.freeze({ registration: 'INVALID_REQUEST' }),
    };
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, string|null>} */
  const value = {};

  /**
   * @param {string} field
   * @param {string} code
   * @param {(text: string) => string|null} normalize
   */
  const read = (field, code, normalize) => {
    const raw = source[field];
    if (raw === undefined || raw === null) {
      value[field] = null;
      return;
    }
    if (typeof raw !== 'string') {
      value[field] = null;
      errors[field] = code;
      return;
    }
    const trimmed = raw.normalize('NFC').trim();
    if (trimmed === '') {
      value[field] = null;
      return;
    }
    const normalized = normalize(trimmed);
    if (normalized === null) {
      value[field] = null;
      errors[field] = code;
      return;
    }
    value[field] = normalized;
  };

  read('personType', 'INVALID_PERSON_TYPE', (text) =>
    PERSON_TYPES.has(text) ? text : null,
  );
  const personTypeValid = !('personType' in errors);
  read('document', 'INVALID_DOCUMENT', (text) => {
    const document = text.replace(/[./\-\s]/gu, '').toUpperCase();
    if (!personTypeValid) return document;
    if (value.personType === 'individual')
      return isValidCpf(document) ? document : null;
    if (value.personType === 'company')
      return isValidCnpj(document) ? document : null;
    return document;
  });
  if (value.document !== null && value.personType === null) {
    // A CPF or CNPJ only has meaning with the person type it belongs to.
    if (personTypeValid) errors.personType = 'INVALID_PERSON_TYPE';
    value.document = null;
  }
  if (!personTypeValid) value.document = null;
  read('legalName', 'INVALID_LEGAL_NAME', (text) =>
    readText(text, 2, CONTACT_REGISTRATION_LIMITS.legalName),
  );
  read('instagram', 'INVALID_INSTAGRAM', readInstagram);
  read('stateRegistration', 'INVALID_STATE_REGISTRATION', (text) => {
    const upper = text.toUpperCase();
    if (upper === 'ISENTO') return 'ISENTO';
    const compact = upper.replace(/[./\-\s]/gu, '');
    return /^[0-9A-Z]{2,18}$/u.test(compact) ? compact : null;
  });
  read('postalCode', 'INVALID_POSTAL_CODE', normalizePostalCode);
  read('city', 'INVALID_CITY', (text) =>
    readText(text, 1, CONTACT_REGISTRATION_LIMITS.city),
  );
  read('state', 'INVALID_STATE', (text) => {
    const upper = text.toUpperCase();
    return STATES.has(upper) ? upper : null;
  });
  read('street', 'INVALID_STREET', (text) =>
    readText(text, 1, CONTACT_REGISTRATION_LIMITS.street),
  );
  read('district', 'INVALID_DISTRICT', (text) =>
    readText(text, 1, CONTACT_REGISTRATION_LIMITS.district),
  );
  read('number', 'INVALID_ADDRESS_NUMBER', (text) => {
    const number = readText(text, 1, CONTACT_REGISTRATION_LIMITS.number);
    if (number === null) return null;
    return NO_NUMBER.has(number.toUpperCase()) ? 'S/N' : number;
  });
  read('complement', 'INVALID_COMPLEMENT', (text) =>
    readText(text, 1, CONTACT_REGISTRATION_LIMITS.complement),
  );

  const ordered = CONTACT_REGISTRATION_FIELDS.filter(
    (field) => field in errors,
  );
  if (ordered.length > 0) {
    return {
      ok: false,
      errors: Object.freeze(
        Object.fromEntries(ordered.map((field) => [field, errors[field]])),
      ),
    };
  }
  const registration = /** @type {ContactRegistration} */ (
    Object.fromEntries(
      CONTACT_REGISTRATION_FIELDS.map((field) => [field, value[field] ?? null]),
    )
  );
  return {
    ok: true,
    value: Object.freeze(registration),
    fieldsComplete: isContactRegistrationFieldsComplete(registration),
  };
}

/**
 * CP-26 without the contact data: celular and e-mail live in the details
 * envelope (ADR 033) and are combined by the reader.
 *
 * @param {ContactRegistration|null|undefined} registration
 */
export function isContactRegistrationFieldsComplete(registration) {
  if (!registration) return false;
  const required = /** @type {const} */ ([
    'personType',
    'document',
    'legalName',
    'postalCode',
    'city',
    'state',
    'street',
    'district',
    'number',
  ]);
  if (required.some((field) => registration[field] === null)) return false;
  return (
    registration.personType === 'individual' ||
    registration.stateRegistration !== null
  );
}

/** @param {unknown} value */
export function isValidCpf(value) {
  if (typeof value !== 'string' || !/^\d{11}$/u.test(value)) return false;
  if (/^(\d)\1{10}$/u.test(value)) return false;
  const digits = [...value].map(Number);
  const check = (/** @type {number} */ length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += digits[index] * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === digits[9] && check(10) === digits[10];
}

/**
 * Numeric and alphanumeric CNPJ (Receita Federal, in force since July 2026):
 * 12 base characters in [0-9A-Z] and 2 numeric check digits, each character
 * worth its ASCII code minus 48.
 *
 * @param {unknown} value
 */
export function isValidCnpj(value) {
  if (typeof value !== 'string' || !/^[0-9A-Z]{12}\d{2}$/u.test(value))
    return false;
  if (/^(.)\1{13}$/u.test(value)) return false;
  const values = [...value].map((character) => character.charCodeAt(0) - 48);
  const check = (/** @type {number[]} */ weights) => {
    let sum = 0;
    weights.forEach((weight, index) => {
      sum += values[index] * weight;
    });
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = check([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = check([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === values[12] && second === values[13];
}

/**
 * Accepts `12345678` or `12345-678`; returns the 8 digits or null.
 * @param {unknown} value
 */
export function normalizePostalCode(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[.\-\s]/gu, '');
  if (!/^\d{8}$/u.test(compact) || compact === '00000000') return null;
  return compact;
}

/** @param {string} text */
function readInstagram(text) {
  const fromUrl = INSTAGRAM_URL.exec(text);
  const handle = (fromUrl ? fromUrl[1] : text).replace(/^@/u, '').toLowerCase();
  if (
    !/^[a-z0-9._]{1,30}$/u.test(handle) ||
    handle.startsWith('.') ||
    handle.endsWith('.') ||
    handle.includes('..')
  ) {
    return null;
  }
  return handle;
}

/**
 * Trimmed text with collapsed whitespace, no control characters, and a length
 * measured in code points.
 *
 * @param {string} text @param {number} min @param {number} max
 */
function readText(text, min, max) {
  if (hasControlCharacter(text)) return null;
  const collapsed = text.replace(/\s+/gu, ' ');
  const length = [...collapsed].length;
  if (length < min || length > max) return null;
  return collapsed;
}

/** @param {string} text */
function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}
