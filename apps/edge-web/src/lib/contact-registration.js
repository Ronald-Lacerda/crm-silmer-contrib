/**
 * The client's registration in the browser (CP-25..28, ADR 047). These rules
 * mirror the contacts domain on purpose: edge-web ships no runtime
 * dependencies, so the seller sees the error next to the field before the
 * request instead of a round trip. The API stays the authority — it
 * normalizes the payload again and answers 400 with the same codes when the
 * two disagree. Nothing here logs, stores or sends a value anywhere.
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

export const BRAZILIAN_STATE_NAMES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    AC: 'Acre',
    AL: 'Alagoas',
    AM: 'Amazonas',
    AP: 'Amapá',
    BA: 'Bahia',
    CE: 'Ceará',
    DF: 'Distrito Federal',
    ES: 'Espírito Santo',
    GO: 'Goiás',
    MA: 'Maranhão',
    MG: 'Minas Gerais',
    MS: 'Mato Grosso do Sul',
    MT: 'Mato Grosso',
    PA: 'Pará',
    PB: 'Paraíba',
    PE: 'Pernambuco',
    PI: 'Piauí',
    PR: 'Paraná',
    RJ: 'Rio de Janeiro',
    RN: 'Rio Grande do Norte',
    RO: 'Rondônia',
    RR: 'Roraima',
    RS: 'Rio Grande do Sul',
    SC: 'Santa Catarina',
    SE: 'Sergipe',
    SP: 'São Paulo',
    TO: 'Tocantins',
  }),
);

/** The 12 registration fields, in the order the form shows them. */
export const REGISTRATION_FIELDS = Object.freeze([
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

/**
 * @typedef {'individual'|'company'} PersonType
 * @typedef {{
 *   personType: PersonType|null, document: string|null,
 *   legalName: string|null, instagram: string|null,
 *   stateRegistration: string|null, postalCode: string|null,
 *   city: string|null, state: string|null, street: string|null,
 *   district: string|null, number: string|null, complement: string|null,
 * }} ContactRegistration
 */

/** @param {string} value */
function allSame(value) {
  return /^(.)\1+$/u.test(value);
}

/** @param {unknown} value */
export function isValidCpf(value) {
  if (typeof value !== 'string' || !/^\d{11}$/u.test(value)) return false;
  if (allSame(value)) return false;
  const digits = [...value].map(Number);
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index += 1)
      sum += digits[index] * (length + 1 - index);
    const rest = (sum * 10) % 11;
    if ((rest === 10 ? 0 : rest) !== digits[length]) return false;
  }
  return true;
}

const CNPJ_WEIGHTS = Object.freeze([
  [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
]);

/**
 * Numeric and alphanumeric CNPJ (IN RFB 2.229/2024): each of the 12 base
 * positions is worth its char code minus 48, so "0".."9" keep their value and
 * "A".."Z" are worth 17..42; the two check digits stay numeric.
 *
 * @param {unknown} value
 */
export function isValidCnpj(value) {
  if (typeof value !== 'string' || !/^[0-9A-Z]{12}\d{2}$/u.test(value))
    return false;
  if (allSame(value)) return false;
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  for (const weights of CNPJ_WEIGHTS) {
    const sum = weights.reduce(
      (total, weight, index) => total + values[index] * weight,
      0,
    );
    const rest = sum % 11;
    if ((rest < 2 ? 0 : 11 - rest) !== values[weights.length]) return false;
  }
  return true;
}

/** @param {string} value */
function compactDocument(value) {
  return value.replace(/[./\-\s]/gu, '').toUpperCase();
}

/** @param {string} value @returns {string|null} */
function normalizeInstagram(value) {
  let handle = value;
  const url =
    /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)\/?(?:[?#].*)?$/iu.exec(
      handle,
    );
  if (url) handle = url[1];
  handle = handle.replace(/^@/u, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/u.test(handle)) return null;
  if (handle.startsWith('.') || handle.endsWith('.') || handle.includes('..'))
    return null;
  return handle;
}

/** @param {string} value @returns {string|null} */
function normalizeStateRegistration(value) {
  if (value.toUpperCase() === 'ISENTO') return 'ISENTO';
  const compact = value.replace(/[.\-/\s]/gu, '').toUpperCase();
  return /^[0-9A-Z]{2,18}$/u.test(compact) ? compact : null;
}

/** @param {string} value @returns {string|null} */
function normalizePostalCode(value) {
  const compact = value.replace(/[.\-\s]/gu, '');
  return /^\d{8}$/u.test(compact) && compact !== '00000000' ? compact : null;
}

export const REGISTRATION_LIMITS = Object.freeze({
  city: 80,
  complement: 80,
  district: 80,
  legalName: 150,
  number: 10,
  street: 150,
});

/**
 * C0 controls (tab and line breaks included), DEL and C1, as the domain
 * refuses them. Surrounding blanks are trimmed before this check.
 *
 * @param {string} text
 */
function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * Trimmed text with collapsed whitespace and a length in code points.
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

/**
 * Same contract as `modules/contacts/src/domain/contact-registration.js`
 * (kept in step by test/contact-registration-parity.test.js).
 *
 * @param {unknown} input
 * @returns {{ok: true, value: ContactRegistration, fieldsComplete: boolean}
 *   | {ok: false, errors: Record<string, string>}}
 */
export function normalizeContactRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { registration: 'INVALID_REQUEST' } };
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, string|null>} */
  const value = {};
  /**
   * @param {string} field @param {string} code
   * @param {(text: string) => string|null} normalize
   */
  const read = (field, code, normalize) => {
    const raw = source[field];
    value[field] = null;
    if (raw === undefined || raw === null) return;
    if (typeof raw !== 'string') {
      errors[field] = code;
      return;
    }
    const trimmed = raw.normalize('NFC').trim();
    if (trimmed === '') return;
    const normalized = normalize(trimmed);
    if (normalized === null) errors[field] = code;
    else value[field] = normalized;
  };

  read('personType', 'INVALID_PERSON_TYPE', (text) =>
    text === 'individual' || text === 'company' ? text : null,
  );
  const personTypeValid = !('personType' in errors);
  read('document', 'INVALID_DOCUMENT', (text) => {
    const compact = compactDocument(text);
    if (!personTypeValid) return compact;
    if (value.personType === 'individual')
      return isValidCpf(compact) ? compact : null;
    if (value.personType === 'company')
      return isValidCnpj(compact) ? compact : null;
    return compact;
  });
  if (value.document !== null && value.personType === null) {
    // A CPF or CNPJ only has meaning with the person type it belongs to.
    if (personTypeValid) errors.personType = 'INVALID_PERSON_TYPE';
    value.document = null;
  }
  read('legalName', 'INVALID_LEGAL_NAME', (text) =>
    readText(text, 2, REGISTRATION_LIMITS.legalName),
  );
  read('instagram', 'INVALID_INSTAGRAM', normalizeInstagram);
  read(
    'stateRegistration',
    'INVALID_STATE_REGISTRATION',
    normalizeStateRegistration,
  );
  read('postalCode', 'INVALID_POSTAL_CODE', normalizePostalCode);
  read('city', 'INVALID_CITY', (text) =>
    readText(text, 1, REGISTRATION_LIMITS.city),
  );
  read('state', 'INVALID_STATE', (text) => {
    const upper = text.toUpperCase();
    return BRAZILIAN_STATES.includes(upper) ? upper : null;
  });
  read('street', 'INVALID_STREET', (text) =>
    readText(text, 1, REGISTRATION_LIMITS.street),
  );
  read('district', 'INVALID_DISTRICT', (text) =>
    readText(text, 1, REGISTRATION_LIMITS.district),
  );
  read('number', 'INVALID_ADDRESS_NUMBER', (text) => {
    const number = readText(text, 1, REGISTRATION_LIMITS.number);
    if (number === null) return null;
    return ['S/N', 'SN'].includes(number.toUpperCase()) ? 'S/N' : number;
  });
  read('complement', 'INVALID_COMPLEMENT', (text) =>
    readText(text, 1, REGISTRATION_LIMITS.complement),
  );

  const failed = REGISTRATION_FIELDS.filter((field) => field in errors);
  if (failed.length) {
    return {
      ok: false,
      errors: Object.fromEntries(failed.map((field) => [field, errors[field]])),
    };
  }
  const registration = /** @type {ContactRegistration} */ (
    Object.fromEntries(
      REGISTRATION_FIELDS.map((field) => [field, value[field] ?? null]),
    )
  );
  return {
    ok: true,
    value: registration,
    fieldsComplete: registrationFieldsComplete(registration),
  };
}

/** @param {Partial<ContactRegistration>|null|undefined} registration */
export function registrationFieldsComplete(registration) {
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
  if (!required.every((field) => Boolean(registration[field]))) return false;
  return (
    registration.personType === 'individual' ||
    Boolean(registration.stateRegistration)
  );
}

/**
 * What still keeps the client from "Cadastro completo" (CP-26), as the labels
 * the form uses.
 *
 * @param {Partial<ContactRegistration>|null|undefined} registration
 * @param {{phone?: unknown, email?: unknown}} [contact]
 */
export function missingRegistrationFields(registration, contact = {}) {
  const data = registration ?? {};
  const company = data.personType === 'company';
  const individual = data.personType === 'individual';
  /** @type {string[]} */
  const missing = [];
  if (!data.personType) missing.push('Tipo de pessoa');
  if (!data.document)
    missing.push(company ? 'CNPJ' : individual ? 'CPF' : 'CPF ou CNPJ');
  if (!data.legalName)
    missing.push(
      company
        ? 'Razão social'
        : individual
          ? 'Nome completo'
          : 'Nome ou razão social',
    );
  if (company && !data.stateRegistration) missing.push('Inscrição estadual');
  if (!data.postalCode) missing.push('CEP');
  if (!data.city) missing.push('Cidade');
  if (!data.state) missing.push('UF');
  if (!data.street) missing.push('Endereço');
  if (!data.district) missing.push('Bairro');
  if (!data.number) missing.push('Número');
  if (!contact.phone) missing.push('Celular');
  if (!contact.email) missing.push('E-mail');
  return missing;
}

/**
 * @param {Partial<ContactRegistration>|null|undefined} registration
 * @param {{phone?: unknown, email?: unknown}} [contact]
 */
export function isRegistrationComplete(registration, contact = {}) {
  return (
    registrationFieldsComplete(registration) &&
    Boolean(contact.phone) &&
    Boolean(contact.email)
  );
}

/**
 * CPF `000.000.000-00`, CNPJ `AA.AAA.AAA/AAAA-00`. Anything that is not a
 * whole document comes back as typed, so a partial entry is never mangled.
 *
 * @param {unknown} personType @param {unknown} value
 */
export function formatDocument(personType, value) {
  if (typeof value !== 'string') return '';
  const compact = compactDocument(value);
  if (
    personType !== 'company' &&
    /^\d{11}$/u.test(compact) &&
    (personType === 'individual' || !personType)
  ) {
    return `${compact.slice(0, 3)}.${compact.slice(3, 6)}.${compact.slice(6, 9)}-${compact.slice(9)}`;
  }
  if (personType !== 'individual' && /^[0-9A-Z]{12}\d{2}$/u.test(compact)) {
    return `${compact.slice(0, 2)}.${compact.slice(2, 5)}.${compact.slice(5, 8)}/${compact.slice(8, 12)}-${compact.slice(12)}`;
  }
  return value.trim();
}

/** @param {unknown} value */
export function formatPostalCode(value) {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/[.\-\s]/gu, '');
  return /^\d{8}$/u.test(compact)
    ? `${compact.slice(0, 5)}-${compact.slice(5)}`
    : value.trim();
}

/** @param {unknown} value */
export function postalCodeDigits(value) {
  return typeof value === 'string' ? value.replace(/\D/gu, '') : '';
}

/**
 * Same rule as `modules/contacts/src/domain/contact-details.js`: a Brazilian
 * number with area code, stored as `55` + 10 or 11 digits.
 *
 * @param {unknown} value
 */
export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^\+?[\d\s().-]+$/u.test(value))
    return null;
  const digits = value.replace(/\D/gu, '');
  const national =
    digits.startsWith('55') && [12, 13].includes(digits.length)
      ? digits.slice(2)
      : digits;
  if (
    ![10, 11].includes(national.length) ||
    national.startsWith('0') ||
    allSame(national)
  )
    return null;
  return `55${national}`;
}

/**
 * `null` for an empty e-mail, `undefined` for an invalid one.
 *
 * @param {unknown} value @returns {string|null|undefined}
 */
export function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed))
    return undefined;
  return trimmed;
}

export const PERSON_TYPE_LABELS = Object.freeze({
  company: 'Pessoa jurídica',
  individual: 'Pessoa física',
});

/** Server and client codes, mapped to the field that shows them. */
export const REGISTRATION_ERROR_FIELDS = Object.freeze(
  /** @type {Record<string, string>} */ ({
    INVALID_ADDRESS_NUMBER: 'number',
    INVALID_CITY: 'city',
    INVALID_COMPLEMENT: 'complement',
    INVALID_DISTRICT: 'district',
    INVALID_DOCUMENT: 'document',
    INVALID_EMAIL: 'email',
    INVALID_INSTAGRAM: 'instagram',
    INVALID_LEGAL_NAME: 'legalName',
    INVALID_PERSON_TYPE: 'personType',
    INVALID_PHONE: 'phone',
    INVALID_POSTAL_CODE: 'postalCode',
    INVALID_STATE: 'state',
    INVALID_STATE_REGISTRATION: 'stateRegistration',
    INVALID_STREET: 'street',
    CONTACT_PHONE_MATCH: 'phone',
  }),
);
