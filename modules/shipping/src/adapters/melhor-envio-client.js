import { clearTimeout, setTimeout } from 'node:timers';

import { ShippingError } from '../domain/errors.js';

// Melhor Envio API v2 adapter (RFC 038, sections 2.5, 3 and 9). It speaks
// HTTP only: idempotency, persistence and retries belong to the caller.

export const MELHOR_ENVIO_BASE_URLS = Object.freeze({
  sandbox: 'https://sandbox.melhorenvio.com.br',
  production: 'https://melhorenvio.com.br',
});

export const MELHOR_ENVIO_FILE_FORMATS = Object.freeze(['pdf', 'zpl', 'jpeg']);

// Integrations always cancel with reason 2 (docs: cancelamento-de-etiquetas).
export const MELHOR_ENVIO_CANCEL_REASON_ID = '2';

// TODO(ME-0 sandbox): confirm the Pix top-up fields. The docs list
// gateway "yapay-transparente" with slug "pix" and a decimal string value.
export const MELHOR_ENVIO_PIX_TOP_UP = Object.freeze({
  gateway: 'yapay-transparente',
  slug: 'pix',
});

// TODO(ME-0 sandbox): confirm the status and wording of a checkout refused for
// lack of wallet balance; the docs do not show that error body. Only checkout
// is matched, so a cart validation that mentions money stays `validation`.
const INSUFFICIENT_BALANCE_PATTERN =
  /saldo insuficiente|insufficient balance/iu;

/**
 * Operations whose repetition cannot buy, pay, generate or cancel anything:
 * reads plus the read-only POSTs (calculate, tracking, cancellable). Only
 * these are retried after an unknown outcome; every other POST needs
 * reconciliation (`getOrder`) before a new attempt, or it may buy twice.
 */
export const MELHOR_ENVIO_SAFE_TO_RETRY = Object.freeze([
  'calculate',
  'tracking',
  'cancellable',
  'services',
  'labelFile',
  'daceFile',
  'getOrder',
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ORDER_IDS = 100;
const ORDER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_FIELD_ERRORS = 50;
const MAX_FIELD_MESSAGES = 5;
const MAX_FIELD_MESSAGE_LENGTH = 200;

const STATUS_FOR_KIND = Object.freeze({
  auth: 502,
  insufficient_balance: 409,
  invalid_response: 502,
  rate_limited: 503,
  rejected: 502,
  unavailable: 503,
  validation: 422,
});

/**
 * @typedef {'auth'|'validation'|'rate_limited'|'unavailable'|'rejected'|
 *   'insufficient_balance'|'invalid_response'} MelhorEnvioErrorKind
 */

/**
 * Bounded upstream failure. `statusCode` is what the CRM boundary answers
 * (an upstream 401 must never log the CRM user out); `upstreamStatus` is the
 * Melhor Envio status. Messages are fixed per kind: request bodies, tokens,
 * documents, addresses and phone numbers never reach this object.
 *
 * `retriable` means the same request may simply be sent again.
 * `reconcileRequired` means the outcome of a non-idempotent call is unknown:
 * the caller must read the remote state before any new attempt.
 */
export class MelhorEnvioError extends ShippingError {
  /**
   * @param {MelhorEnvioErrorKind} kind
   * @param {{
   *   upstreamStatus?: number|null,
   *   retryAfterMs?: number|null,
   *   fieldErrors?: Record<string, readonly string[]>,
   *   outcomeKnown?: boolean,
   *   retriable?: boolean,
   *   reconcileRequired?: boolean,
   * }} [options]
   */
  constructor(kind, options = {}) {
    const upstreamStatus = options.upstreamStatus ?? null;
    super(
      upstreamStatus === null
        ? `Melhor Envio request failed: ${kind}`
        : `Melhor Envio request failed: ${kind} (HTTP ${upstreamStatus})`,
      `MELHOR_ENVIO_${kind.toUpperCase()}`,
      STATUS_FOR_KIND[kind] ?? 502,
    );
    this.kind = kind;
    this.upstreamStatus = upstreamStatus;
    this.retriable =
      options.retriable ?? (kind === 'unavailable' || kind === 'rate_limited');
    this.reconcileRequired = options.reconcileRequired ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.outcomeKnown = options.outcomeKnown ?? upstreamStatus !== null;
    this.fieldErrors = Object.freeze({ ...(options.fieldErrors ?? {}) });
  }
}

/**
 * @typedef {{
 *   status: number,
 *   headers?: {get: (name: string) => string|null},
 *   text: () => Promise<string>,
 * }} FetchResponse
 * @typedef {(url: string, init: RequestInit) => Promise<FetchResponse>} FetchLike
 */

/**
 * Shared request primitive, also used by the OAuth adapter. It never echoes
 * the request body or headers in errors. `safeToRetry` (default true, kept by
 * the OAuth token calls) says whether an unknown outcome may be retried as
 * is; when false the error asks for reconciliation instead.
 *
 * @param {{
 *   fetch: FetchLike,
 *   url: string,
 *   method: 'GET'|'POST',
 *   headers: Record<string, string>,
 *   body?: unknown,
 *   timeoutMs: number,
 *   authStatuses?: readonly number[],
 *   safeToRetry?: boolean,
 *   detectInsufficientBalance?: boolean,
 * }} request
 * @returns {Promise<unknown>}
 */
export async function requestMelhorEnvio(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  /** @type {FetchResponse} */
  let response;
  /** @type {string} */
  let text;
  try {
    response = await request.fetch(request.url, {
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      headers: request.headers,
      method: request.method,
      redirect: 'error',
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    // Network failure or timeout: the remote outcome is unknown.
    throw unknownOutcome(null, request.safeToRetry ?? true);
  } finally {
    clearTimeout(timeout);
  }

  const status = Number(response.status);
  const payload = parseJson(text);
  if (status >= 200 && status < 300) {
    if (payload === undefined && text.trim() !== '') {
      // Plain-text success (a file URL, for example) is returned as given.
      return text.trim();
    }
    return payload ?? null;
  }
  throw httpFailure(status, payload, response, request);
}

/**
 * @param {{
 *   baseUrl: string,
 *   getAccessToken: () => Promise<string>|string,
 *   userAgent: string,
 *   fetch?: FetchLike,
 *   timeoutMs?: number,
 * }} options
 */
export function createMelhorEnvioClient(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Melhor Envio client options are required');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const userAgent = requireUserAgent(options.userAgent);
  if (typeof options.getAccessToken !== 'function') {
    throw new TypeError('getAccessToken must be a function');
  }
  const getAccessToken = options.getAccessToken;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  /**
   * @param {string} operation the client method name
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function call(operation, method, path, body) {
    const token = await getAccessToken();
    if (typeof token !== 'string' || token === '' || /[\r\n]/u.test(token)) {
      throw new MelhorEnvioError('auth', { outcomeKnown: true });
    }
    return requestMelhorEnvio({
      body,
      fetch: fetchImpl,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      detectInsufficientBalance: operation === 'checkout',
      method,
      safeToRetry: MELHOR_ENVIO_SAFE_TO_RETRY.includes(operation),
      timeoutMs,
      url: `${baseUrl}${path}`,
    });
  }

  /** @param {string[]} orderIds */
  const ordersBody = (orderIds) => ({ orders: requireOrderIds(orderIds) });

  return Object.freeze({
    /** @param {Record<string, unknown>} body */
    calculate: async (body) =>
      call(
        'calculate',
        'POST',
        '/api/v2/me/shipment/calculate',
        requireObject(body),
      ),

    /**
     * Adds one shipment (one volume) to the cart. The returned `id` is what
     * the caller persists before checkout.
     *
     * @param {Record<string, unknown>} item
     */
    addToCart: async (item) => {
      const result = await call(
        'addToCart',
        'POST',
        '/api/v2/me/cart',
        requireObject(item),
      );
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !ORDER_ID_PATTERN.test(result.id)
      ) {
        // The item may exist without an id we can read: never re-add blindly.
        throw new MelhorEnvioError('invalid_response', {
          outcomeKnown: false,
          reconcileRequired: true,
          upstreamStatus: 200,
        });
      }
      return /** @type {{id: string} & Record<string, unknown>} */ (result);
    },

    /** @param {string[]} orderIds */
    checkout: async (orderIds) =>
      call(
        'checkout',
        'POST',
        '/api/v2/me/shipment/checkout',
        ordersBody(orderIds),
      ),

    /** @param {string[]} orderIds */
    generate: async (orderIds) =>
      call(
        'generate',
        'POST',
        '/api/v2/me/shipment/generate',
        ordersBody(orderIds),
      ),

    /** @param {string[]} orderIds */
    tracking: async (orderIds) =>
      call(
        'tracking',
        'POST',
        '/api/v2/me/shipment/tracking',
        ordersBody(orderIds),
      ),

    /** @param {string[]} orderIds */
    cancellable: async (orderIds) =>
      call(
        'cancellable',
        'POST',
        '/api/v2/me/shipment/cancellable',
        ordersBody(orderIds),
      ),

    /** @param {{orderId: string, description?: string}} input */
    cancel: async (input) => {
      const order = {
        id: requireOrderId(input?.orderId),
        reason_id: MELHOR_ENVIO_CANCEL_REASON_ID,
        description: optionalDescription(input?.description),
      };
      return call('cancel', 'POST', '/api/v2/me/shipment/cancel', { order });
    },

    /** @param {{orderId: string, format: 'pdf'|'zpl'|'jpeg'}} input */
    labelFile: async (input) =>
      call(
        'labelFile',
        'GET',
        `/api/v2/me/imprimir/${requireFormat(input?.format)}/${requireOrderId(
          input?.orderId,
        )}`,
      ),

    /** @param {{orderId: string, format: 'pdf'|'zpl'|'jpeg'}} input */
    daceFile: async (input) =>
      call(
        'daceFile',
        'GET',
        `/api/v2/me/imprimir/dace/${requireFormat(
          input?.format,
        )}/${requireOrderId(input?.orderId)}`,
      ),

    services: async () =>
      call('services', 'GET', '/api/v2/me/shipment/services'),

    /**
     * Reads one order (status, tracking, tags): how the caller reconciles a
     * purchase step that failed with `reconcileRequired`.
     *
     * @param {string} orderId
     */
    getOrder: async (orderId) =>
      call('getOrder', 'GET', `/api/v2/me/orders/${requireOrderId(orderId)}`),

    /** @param {{valueCents: number}} input */
    addBalancePix: async (input) => {
      const valueCents = input?.valueCents;
      if (!Number.isSafeInteger(valueCents) || Number(valueCents) < 1) {
        throw new TypeError('valueCents must be a positive integer');
      }
      return call('addBalancePix', 'POST', '/api/v2/me/balance', {
        ...MELHOR_ENVIO_PIX_TOP_UP,
        value: (Number(valueCents) / 100).toFixed(2),
      });
    },
  });
}

/**
 * 5xx, 408, network failure or timeout: the request may or may not have taken
 * effect upstream.
 *
 * @param {number|null} upstreamStatus
 * @param {boolean} safeToRetry
 */
function unknownOutcome(upstreamStatus, safeToRetry) {
  return new MelhorEnvioError('unavailable', {
    outcomeKnown: false,
    reconcileRequired: !safeToRetry,
    retriable: safeToRetry,
    upstreamStatus,
  });
}

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {FetchResponse} response
 * @param {{authStatuses?: readonly number[], safeToRetry?: boolean,
 *   detectInsufficientBalance?: boolean}} request
 */
function httpFailure(status, payload, response, request) {
  const upstreamStatus = Number.isInteger(status) ? status : null;
  if ((request.authStatuses ?? [401]).includes(status)) {
    return new MelhorEnvioError('auth', { upstreamStatus });
  }
  if (status === 429) {
    // Throttled before processing: retrying is safe for every operation.
    return new MelhorEnvioError('rate_limited', {
      retryAfterMs: retryAfterMs(response),
      upstreamStatus,
    });
  }
  if (status >= 500 || status === 408 || upstreamStatus === null) {
    return unknownOutcome(upstreamStatus, request.safeToRetry ?? true);
  }
  const fieldErrors = fieldErrorsOf(payload);
  if (
    request.detectInsufficientBalance &&
    mentionsInsufficientBalance(payload)
  ) {
    return new MelhorEnvioError('insufficient_balance', {
      fieldErrors,
      upstreamStatus,
    });
  }
  if (status === 422) {
    return new MelhorEnvioError('validation', { fieldErrors, upstreamStatus });
  }
  return new MelhorEnvioError('rejected', { fieldErrors, upstreamStatus });
}

/** @param {unknown} payload */
function mentionsInsufficientBalance(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const texts = [record.message, record.error];
  if (record.errors && typeof record.errors === 'object') {
    for (const value of Object.values(record.errors)) {
      texts.push(...(Array.isArray(value) ? value : [value]));
    }
  }
  return texts.some(
    (text) =>
      typeof text === 'string' && INSUFFICIENT_BALANCE_PATTERN.test(text),
  );
}

/**
 * Laravel-style `{errors: {field: [messages]}}`, bounded and with anything
 * resembling a document, CEP, phone or e-mail redacted.
 *
 * @param {unknown} payload
 * @returns {Record<string, readonly string[]>}
 */
function fieldErrorsOf(payload) {
  /** @type {Record<string, readonly string[]>} */
  const result = {};
  if (!payload || typeof payload !== 'object') return result;
  const errors = /** @type {Record<string, unknown>} */ (payload).errors;
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) {
    return result;
  }
  for (const [field, value] of Object.entries(errors).slice(
    0,
    MAX_FIELD_ERRORS,
  )) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(field)) continue;
    const messages = (Array.isArray(value) ? value : [value])
      .filter((message) => typeof message === 'string')
      .slice(0, MAX_FIELD_MESSAGES)
      .map((message) => redact(message).slice(0, MAX_FIELD_MESSAGE_LENGTH));
    result[field] = Object.freeze(messages);
  }
  return result;
}

/** @param {string} text */
function redact(text) {
  return text
    .replace(/[^\s@]+@[^\s@]+/gu, '[redacted]')
    .replace(/\+?\d[\d.\-/() ]{6,}\d/gu, '[redacted]');
}

/** @param {FetchResponse} response */
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** @param {string} text */
function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {unknown} value */
export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError('A valid Melhor Envio baseUrl is required');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) {
    throw new TypeError('Melhor Envio baseUrl must be credential-free HTTPS');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

/** @param {unknown} value */
export function requireUserAgent(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 256 ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(
      'userAgent is required: "App name (technical contact e-mail)"',
    );
  }
  return value;
}

/** @param {unknown} value */
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A request object is required');
  }
  return value;
}

/** @param {unknown} value */
function requireOrderId(value) {
  if (typeof value !== 'string' || !ORDER_ID_PATTERN.test(value)) {
    throw new TypeError('orderId must be a Melhor Envio order id');
  }
  return value;
}

/** @param {unknown} value */
function requireOrderIds(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ORDER_IDS
  ) {
    throw new TypeError(`orderIds must hold 1 to ${MAX_ORDER_IDS} ids`);
  }
  return value.map(requireOrderId);
}

/** @param {unknown} value */
function requireFormat(value) {
  if (typeof value !== 'string' || !MELHOR_ENVIO_FILE_FORMATS.includes(value)) {
    throw new TypeError('format must be pdf, zpl or jpeg');
  }
  return value;
}

/** @param {unknown} value */
function optionalDescription(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 255) {
    throw new TypeError('description must be a string up to 255 characters');
  }
  return value;
}
