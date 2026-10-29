import {
  MelhorEnvioError,
  normalizeBaseUrl,
  requestMelhorEnvio,
  requireUserAgent,
} from './melhor-envio-client.js';

// OAuth 2.0 authorization-code flow of the Melhor Envio app (RFC 038, 3).
// Access tokens last 30 days and refresh tokens 45; secrets and tokens never
// reach an error message.

/** Only the scopes the CRM uses (the docs require the minimum set). */
export const MELHOR_ENVIO_SCOPES = Object.freeze([
  'cart-read',
  'cart-write',
  'shipping-calculate',
  'shipping-checkout',
  'shipping-generate',
  'shipping-print',
  'shipping-preview',
  'shipping-tracking',
  'shipping-cancel',
  'shipping-companies',
  'orders-read',
  'purchases-read',
  'transactions-read',
  'users-read',
  'notifications-read',
]);

// TODO(ME-0 sandbox): confirm the token body encoding. The OpenAPI reference
// declares JSON, while the API introduction says OAuth routes are the
// exception to the JSON Content-Type rule.
export const MELHOR_ENVIO_TOKEN_CONTENT_TYPE = 'application/json';

export const MELHOR_ENVIO_TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 15_000;
// invalid_grant / invalid_client come back as 400 or 401.
const TOKEN_AUTH_STATUSES = Object.freeze([400, 401]);

/**
 * @param {{
 *   baseUrl: string,
 *   clientId: string,
 *   redirectUri: string,
 *   state: string,
 *   scopes?: readonly string[],
 * }} input
 */
export function buildAuthorizeUrl(input) {
  const baseUrl = normalizeBaseUrl(input?.baseUrl);
  const scopes = input?.scopes ?? MELHOR_ENVIO_SCOPES;
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    !scopes.every((scope) => /^[a-z-]{1,64}$/u.test(scope))
  ) {
    throw new TypeError('scopes must be Melhor Envio permission names');
  }
  // Spaces are encoded as %20, matching the documented space-joined scope.
  const query = [
    ['client_id', requireText(input?.clientId, 'clientId')],
    ['redirect_uri', requireText(input?.redirectUri, 'redirectUri')],
    ['response_type', 'code'],
    ['state', requireText(input?.state, 'state')],
    ['scope', scopes.join(' ')],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `${baseUrl}/oauth/authorize?${query}`;
}

/**
 * @typedef {{
 *   baseUrl: string,
 *   clientId: string,
 *   clientSecret: string,
 *   userAgent: string,
 *   fetch?: import('./melhor-envio-client.js').FetchLike,
 *   now?: () => Date|number,
 *   timeoutMs?: number,
 * }} TokenRequestBase
 * @typedef {{accessToken: string, refreshToken: string, expiresAt: Date}} TokenSet
 */

/**
 * @param {TokenRequestBase & {redirectUri: string, code: string}} input
 * @returns {Promise<TokenSet>}
 */
export async function exchangeAuthorizationCode(input) {
  return requestToken(input, {
    grant_type: 'authorization_code',
    redirect_uri: requireText(input?.redirectUri, 'redirectUri'),
    code: requireText(input?.code, 'code'),
  });
}

/**
 * @param {TokenRequestBase & {refreshToken: string, redirectUri?: string}} input
 * @returns {Promise<TokenSet>}
 */
export async function refreshAccessToken(input) {
  /** @type {Record<string, string>} */
  const grant = {
    grant_type: 'refresh_token',
    refresh_token: requireText(input?.refreshToken, 'refreshToken'),
  };
  if (input?.redirectUri !== undefined) {
    grant.redirect_uri = requireText(input.redirectUri, 'redirectUri');
  }
  return requestToken(input, grant);
}

/**
 * True when the token is gone or expires within the margin. An unreadable
 * expiry counts as expiring, so the caller refreshes instead of failing.
 *
 * @param {{expiresAt: Date|number|string, now?: Date|number|(() => Date|number), marginMs?: number}} input
 */
export function isTokenExpiring({
  expiresAt,
  now = () => new Date(),
  marginMs = MELHOR_ENVIO_TOKEN_REFRESH_MARGIN_MS,
}) {
  const expires = toMillis(expiresAt);
  const current = toMillis(typeof now === 'function' ? now() : now);
  if (expires === null || current === null) return true;
  return expires - current <= marginMs;
}

/**
 * @param {TokenRequestBase} input
 * @param {Record<string, string>} grant
 * @returns {Promise<TokenSet>}
 */
async function requestToken(input, grant) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Token request options are required');
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const userAgent = requireUserAgent(input.userAgent);
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  const now = input.now ?? (() => new Date());
  const body = {
    ...grant,
    client_id: requireText(input.clientId, 'clientId'),
    client_secret: requireText(input.clientSecret, 'clientSecret'),
  };

  const payload = await requestMelhorEnvio({
    authStatuses: TOKEN_AUTH_STATUSES,
    body,
    fetch: fetchImpl,
    headers: {
      Accept: 'application/json',
      'Content-Type': MELHOR_ENVIO_TOKEN_CONTENT_TYPE,
      'User-Agent': userAgent,
    },
    method: 'POST',
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    url: `${baseUrl}/oauth/token`,
  });

  const record =
    payload && typeof payload === 'object'
      ? /** @type {Record<string, unknown>} */ (payload)
      : {};
  const issuedAt = toMillis(now());
  const expiresIn = Number(record.expires_in);
  if (
    typeof record.access_token !== 'string' ||
    record.access_token === '' ||
    typeof record.refresh_token !== 'string' ||
    record.refresh_token === '' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    issuedAt === null
  ) {
    throw new MelhorEnvioError('invalid_response', {
      outcomeKnown: false,
      upstreamStatus: 200,
    });
  }
  return Object.freeze({
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    expiresAt: new Date(issuedAt + expiresIn * 1000),
  });
}

/** @param {unknown} value @returns {number|null} */
function toMillis(value) {
  const millis =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Date.parse(value)
          : Number.NaN;
  return Number.isFinite(millis) ? millis : null;
}

/** @param {unknown} value @param {string} field */
function requireText(value, field) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > 4096 ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}
