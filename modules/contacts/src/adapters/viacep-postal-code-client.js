import {
  BRAZILIAN_STATES,
  CONTACT_REGISTRATION_LIMITS,
} from '../domain/contact-registration.js';

const DEFAULT_BASE_URL = 'https://viacep.com.br/ws/';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_LENGTH = 16_384;
const STATES = new Set(BRAZILIAN_STATES);

/**
 * Bounded lookup failure. Neither the postal code nor the remote body crosses
 * this boundary (ADR 047 / CP-28).
 */
export class PostalCodeLookupError extends Error {
  /** @param {404|503} statusCode @param {'POSTAL_CODE_NOT_FOUND'|'POSTAL_CODE_UNAVAILABLE'} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'PostalCodeLookupError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * ViaCEP adapter: only the 8-digit postal code leaves the CRM. Any network
 * failure, timeout, unexpected status or body is reported as unavailable so
 * the operator keeps filling the address by hand.
 */
export class ViaCepPostalCodeClient {
  #baseUrl;
  #fetchImpl;
  #timeoutMs;

  /**
   * @param {{
   *   baseUrl?: string|URL,
   *   fetchImpl?: (input: URL, init: RequestInit) => Promise<{status: number, text: () => Promise<string>}>,
   *   timeoutMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    const baseUrl = new URL(String(options.baseUrl ?? DEFAULT_BASE_URL));
    if (baseUrl.protocol !== 'https:') {
      throw new TypeError('ViaCEP base URL must use HTTPS');
    }
    this.#baseUrl = baseUrl.href.endsWith('/')
      ? baseUrl
      : new URL(`${baseUrl.href}/`);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive integer');
    }
  }

  /**
   * @param {string} postalCode 8 digits, already validated by the caller.
   * @returns {Promise<Readonly<{postalCode: string, street: string|null, district: string|null, city: string|null, state: string|null}>>}
   */
  async lookup(postalCode) {
    if (typeof postalCode !== 'string' || !/^\d{8}$/u.test(postalCode)) {
      throw new TypeError('postalCode must contain 8 digits');
    }
    let body;
    try {
      const response = await this.#fetchImpl(
        new URL(`${postalCode}/json/`, this.#baseUrl),
        {
          headers: { accept: 'application/json' },
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
      if (response?.status !== 200) throw new Error('unexpected status');
      const text = await response.text();
      if (typeof text !== 'string' || text.length > MAX_RESPONSE_LENGTH) {
        throw new Error('unexpected body');
      }
      body = JSON.parse(text);
    } catch {
      throw unavailable();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw unavailable();
    }
    if (body.erro === true || body.erro === 'true') {
      throw new PostalCodeLookupError(404, 'POSTAL_CODE_NOT_FOUND');
    }
    if (
      body.cep !== undefined &&
      (typeof body.cep !== 'string' ||
        body.cep.replace(/\D/gu, '') !== postalCode)
    ) {
      throw unavailable();
    }
    const state =
      typeof body.uf === 'string' ? body.uf.trim().toUpperCase() : '';
    return Object.freeze({
      postalCode,
      street: readSuggestion(
        body.logradouro,
        CONTACT_REGISTRATION_LIMITS.street,
      ),
      district: readSuggestion(
        body.bairro,
        CONTACT_REGISTRATION_LIMITS.district,
      ),
      city: readSuggestion(body.localidade, CONTACT_REGISTRATION_LIMITS.city),
      state: STATES.has(state) ? state : null,
    });
  }
}

function unavailable() {
  return new PostalCodeLookupError(503, 'POSTAL_CODE_UNAVAILABLE');
}

/** @param {unknown} value @param {number} limit */
function readSuggestion(value, limit) {
  if (typeof value !== 'string') return null;
  const text = [...value.normalize('NFC')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text === '') return null;
  return [...text].slice(0, limit).join('').trim();
}
