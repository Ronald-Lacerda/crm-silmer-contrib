import { createHash, timingSafeEqual } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PATH = '/webhook/silmer/panel-command';
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const DIAGNOSTIC_REJECTION_CODES = new Map([
  [401, 'N8N_COMMAND_HTTP_401'],
  [403, 'N8N_COMMAND_HTTP_403'],
  [404, 'N8N_COMMAND_HTTP_404'],
  [405, 'N8N_COMMAND_HTTP_405'],
]);

/**
 * Bounded technical error. Remote bodies, URLs, credentials and command
 * payloads never cross this boundary.
 */
export class N8nCommandDeliveryError extends Error {
  /**
   * @param {string} code
   * @param {{outcomeKnown?: boolean, retryable?: boolean, retrySafe?: boolean, statusCode?: number}} [options]
   */
  constructor(code, options = {}) {
    super(code);
    this.name = 'N8nCommandDeliveryError';
    this.code = technicalCode(code);
    this.outcomeKnown = options.outcomeKnown ?? false;
    this.retryable = options.retryable ?? false;
    this.retrySafe = options.retrySafe ?? false;
    this.statusCode = options.statusCode;
  }
}

export class N8nCommandDeliveryClient {
  #authorization;
  #endpoint;
  #fetchImpl;
  #replaySafe;
  #timeoutMs;

  /**
   * @param {{
   *   clientId: string,
   *   clientSecret: string,
   *   endpoint?: string|URL,
   *   baseUrl?: string|URL,
   *   allowInsecureLocal?: boolean,
   *   fetchImpl?: (input: URL, init: RequestInit) => Promise<{status: number, json: () => Promise<unknown>}>,
   *   replaySafe?: boolean,
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('n8n command client options are required');
    }
    const clientId = credentialPart(options.clientId, 'clientId', 256);
    if (clientId.includes(':')) {
      throw new TypeError('clientId must not contain a colon');
    }
    const clientSecret = credentialPart(
      options.clientSecret,
      'clientSecret',
      1_024,
    );
    this.#endpoint = commandEndpoint(
      options.endpoint,
      options.baseUrl,
      options.allowInsecureLocal === true,
    );
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    this.#replaySafe = options.replaySafe === true;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    positiveInteger(this.#timeoutMs, 'timeoutMs');
    this.#authorization = `Basic ${Buffer.from(
      `${clientId}:${clientSecret}`,
      'utf8',
    ).toString('base64')}`;
  }

  /**
   * Performs all deterministic validation before any remote effect. The
   * returned body is stable and can be reused byte-for-byte on a safe replay.
   *
   * @param {{commandId: string, payload: Record<string, unknown>, payloadHash: string}} command
   */
  prepareDelivery(command) {
    if (!command || typeof command !== 'object') {
      throw new N8nCommandDeliveryError('N8N_COMMAND_INVALID');
    }
    const commandId = boundedString(command.commandId, 'commandId', 128);
    if (!isPlainObject(command.payload)) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
    }
    const body = canonicalJsonStringify(command.payload);
    const payloadHash = sha256Hex(body);
    if (!equalHexDigest(command.payloadHash, payloadHash)) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_CHANGED', {
        outcomeKnown: true,
      });
    }
    if (
      typeof command.payload.command_id !== 'string' ||
      command.payload.command_id !== commandId
    ) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_ID_MISMATCH', {
        outcomeKnown: true,
      });
    }

    return Object.freeze({
      body,
      commandId,
      execute: () => this.#execute({ body, commandId }),
      payloadHash,
    });
  }

  /**
   * Convenience entry point. Worker handlers should normally call
   * prepareDelivery before marking the external-effect boundary.
   *
   * @param {{commandId: string, payload: Record<string, unknown>, payloadHash: string}} command
   */
  async deliver(command) {
    return this.prepareDelivery(command).execute();
  }

  /** @param {{body: string, commandId: string}} request */
  async #execute(request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    /** @type {{status: number, json: () => Promise<unknown>}} */
    let response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        body: request.body,
        headers: {
          accept: 'application/json',
          authorization: this.#authorization,
          'content-type': 'application/json',
          'idempotency-key': request.commandId,
        },
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        (error &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'AbortError');
      throw new N8nCommandDeliveryError(
        timedOut ? 'N8N_COMMAND_TIMEOUT' : 'N8N_COMMAND_NETWORK_ERROR',
        {
          retryable: true,
          retrySafe: this.#replaySafe,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    const statusCode = Number(response.status);
    if (statusCode === 200 || statusCode === 202) {
      const acknowledgement = await safeAcknowledgement(response);
      if (acknowledgement.accepted === false) {
        throw new N8nCommandDeliveryError('N8N_COMMAND_REJECTED', {
          outcomeKnown: true,
          statusCode,
        });
      }
      if (
        acknowledgement.accepted !== true ||
        typeof acknowledgement.command_id !== 'string'
      ) {
        throw new N8nCommandDeliveryError('N8N_COMMAND_ACK_INVALID', {
          statusCode,
        });
      }
      if (acknowledgement.command_id !== request.commandId) {
        throw new N8nCommandDeliveryError('N8N_COMMAND_ACK_MISMATCH', {
          statusCode,
        });
      }
      return Object.freeze({
        duplicate: acknowledgement.duplicate === true,
        providerExternalId: opaqueExternalId(
          acknowledgement,
          request.commandId,
        ),
        statusCode,
      });
    }

    const retryable =
      RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500;
    throw new N8nCommandDeliveryError(
      retryable
        ? 'N8N_COMMAND_REMOTE_UNAVAILABLE'
        : (DIAGNOSTIC_REJECTION_CODES.get(statusCode) ??
            'N8N_COMMAND_REJECTED'),
      {
        outcomeKnown: !retryable,
        retryable,
        retrySafe: retryable && this.#replaySafe,
        statusCode,
      },
    );
  }
}

/** @param {ConstructorParameters<typeof N8nCommandDeliveryClient>[0]} options */
export function createN8nCommandDeliveryClient(options) {
  return new N8nCommandDeliveryClient(options);
}

/**
 * RFC 8785 is intentionally not claimed here. This is the CRM's small,
 * deterministic JSON encoding contract: object keys are sorted recursively,
 * arrays preserve order, and non-JSON values are rejected.
 *
 * @param {unknown} value
 */
export function canonicalJsonStringify(value) {
  const seen = new Set();
  const normalized = normalizeJson(value, seen);
  return JSON.stringify(normalized);
}

/** @param {string} body */
export function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** @param {unknown} value @param {Set<object>} seen @returns {unknown} */
function normalizeJson(value, seen) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
    }
    seen.add(value);
    /** @type {unknown[]} */
    const result = value.map((entry) => normalizeJson(entry, seen));
    seen.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
    }
    seen.add(value);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined || typeof entry === 'function') {
        throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
      }
      result[key] = normalizeJson(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new N8nCommandDeliveryError('N8N_COMMAND_PAYLOAD_INVALID');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} supplied @param {string} calculated */
function equalHexDigest(supplied, calculated) {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(supplied, 'hex'),
    Buffer.from(calculated, 'hex'),
  );
}

/** @param {{json: () => Promise<unknown>}} response */
async function safeAcknowledgement(response) {
  try {
    const payload = await response.json();
    return isPlainObject(payload) ? payload : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} acknowledgement @param {string} fallback */
function opaqueExternalId(acknowledgement, fallback) {
  for (const key of ['message_id', 'command_id']) {
    const value = acknowledgement[key];
    if (
      typeof value === 'string' &&
      value.length >= 1 &&
      value.length <= 512 &&
      !/[\r\n]/u.test(value)
    ) {
      return value;
    }
  }
  return fallback;
}

/**
 * HTTP is deliberately limited to an explicit loopback-only local development
 * runtime. Every deployed endpoint continues to require HTTPS.
 *
 * @param {unknown} endpoint
 * @param {unknown} baseUrl
 * @param {boolean} allowInsecureLocal
 */
function commandEndpoint(endpoint, baseUrl, allowInsecureLocal = false) {
  let url;
  try {
    url = endpoint
      ? new URL(String(endpoint))
      : new URL(DEFAULT_PATH, `${String(baseUrl).replace(/\/$/u, '')}/`);
  } catch {
    throw new TypeError('A valid n8n command endpoint is required');
  }
  const permitsLocalHttp =
    allowInsecureLocal &&
    url.protocol === 'http:' &&
    isLoopbackHost(url.hostname);
  if (
    (url.protocol !== 'https:' && !permitsLocalHttp) ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new TypeError('n8n command endpoint must be credential-free HTTPS');
  }
  url.hash = '';
  return url;
}

/** @param {string} hostname */
function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

/** @param {unknown} value @param {string} field @param {number} maximum */
function credentialPart(value, field, maximum) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded credential value`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} maximum */
function boundedString(value, field, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new N8nCommandDeliveryError('N8N_COMMAND_INVALID');
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

/** @param {unknown} value */
function technicalCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value)
    ? value
    : 'N8N_COMMAND_DELIVERY_FAILED';
}
