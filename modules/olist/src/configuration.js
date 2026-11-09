import { createHash } from 'node:crypto';
import { identityHash } from './crypto.js';
import { OlistError, object, integer, text } from './errors.js';
export const OLIST_API = 'https://api.tiny.com.br/public-api/v3';
export const OLIST_AUTH =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
export const OLIST_TOKEN =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
/** @param {unknown} value */
export function normalizeDocument(value) {
  if (typeof value !== 'string') throw new OlistError('OLIST_ACCOUNT_MISMATCH');
  const result = value.replace(/[.\-/\s]/gu, '').toUpperCase();
  if (!/^(?:[0-9]{11}|[A-Z0-9]{12}[0-9]{2})$/u.test(result))
    throw new OlistError('OLIST_ACCOUNT_MISMATCH');
  return result;
}
/** Missing or invalid configuration leaves startup operational and Olist off.
 * @param {Record<string,string|undefined>} env */
export function olistConfiguration(env) {
  const envelopeKey = Buffer.from(env.OLIST_ENVELOPE_KEY ?? '', 'base64');
  const hmacKey = Buffer.from(env.OLIST_IDENTITY_HMAC_KEY ?? '', 'base64');
  const clientId = env.OLIST_CLIENT_ID ?? '';
  const clientSecret = env.OLIST_CLIENT_SECRET ?? '';
  const redirectUri = env.OLIST_REDIRECT_URI ?? '';
  // Private, explicit IDs only. Missing/malformed allowlists never enable writes.
  const rawPilotIds = (env.OLIST_PILOT_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim());
  const pilotUserIds = Object.freeze(
    rawPilotIds.length <= 16 &&
      rawPilotIds.every((id) => /^[A-Za-z0-9:_-]{1,200}$/u.test(id))
      ? [...new Set(rawPilotIds)]
      : [],
  );
  let accountKey = '';
  let expectedDocument = '';
  let validRedirect = false;
  try {
    expectedDocument = normalizeDocument(env.OLIST_EXPECTED_ACCOUNT_DOCUMENT);
    accountKey = identityHash(hmacKey, 'account', expectedDocument);
    const url = new URL(redirectUri);
    // Identity accepts a comma-separated list and canonicalizes every entry
    // with URL.origin. Use that same set; one invalid entry fails closed.
    const allowedOrigins = (env.APP_ORIGIN ?? '')
      .split(',')
      .map((candidate) => new URL(candidate).origin);
    validRedirect =
      allowedOrigins.every((origin) => origin.startsWith('https://')) &&
      allowedOrigins.includes(url.origin) &&
      url.protocol === 'https:' &&
      url.pathname === '/olist' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    /* Never echo incomplete deployment configuration. */
  }
  const configured =
    env.OLIST_ENABLED === 'true' &&
    envelopeKey.length === 32 &&
    hmacKey.length === 32 &&
    envelopeKey.compare(hmacKey) !== 0 &&
    validRedirect &&
    Boolean(accountKey) &&
    /^[a-zA-Z0-9_-]{1,200}$/u.test(clientId) &&
    clientSecret.length > 0 &&
    clientSecret.length <= 4096 &&
    !/[\u0000-\u0020\u007f]/u.test(clientSecret);
  const contextKey = createHash('sha256')
    .update(
      JSON.stringify([
        'olist',
        'production',
        clientId,
        redirectUri,
        accountKey,
      ]),
    )
    .digest('hex');
  return Object.freeze({
    configured,
    accountKey,
    expectedDocument,
    envelopeKey,
    hmacKey,
    clientId,
    clientSecret,
    redirectUri,
    contextKey,
    pilotUserIds,
    // Environment alone never activates account creation.
    creationEnabled: false,
    environment: 'production',
  });
}
export const EMPTY_OLIST_SETTINGS = Object.freeze({
  sellerId: null,
  operationNatureId: null,
  warehouseId: null,
  paymentMethodId: null,
  priceListId: null,
  originId: null,
  paymentTerms: null,
  purchaseOrder: null,
});
/** Explicit account policy; no fiscal or catalog defaults.
 * @param {unknown} raw */
export function olistProductFiscal(raw) {
  const value = object(raw, ['ncm', 'origin', 'unit']);
  if (
    Object.keys(value).length !== 3 ||
    typeof value.ncm !== 'string' ||
    !/^[0-9]{8}$/u.test(value.ncm) ||
    !Number.isInteger(value.origin) ||
    value.origin < 0 ||
    value.origin > 8 ||
    typeof value.unit !== 'string' ||
    !/^[A-Z0-9]{1,6}$/u.test(value.unit)
  )
    throw new OlistError('OLIST_PRODUCT_FISCAL_REQUIRED', 400);
  return { ncm: value.ncm, origin: value.origin, unit: value.unit };
}
/** Explicit single due date, never derived from a free-text payment term.
 * @param {unknown} value */
function paymentDueOn(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return value;
}
/** Full replacement; settings never infer a seller.
 * @param {unknown} raw */
export function olistSettings(raw) {
  const fields = Object.keys(EMPTY_OLIST_SETTINGS);
  const value = object(raw, [
    ...fields,
    'productFiscal',
    'paymentDueOn',
    'paymentDuePolicy',
    'receivingMethodId',
  ]);
  if (fields.some((field) => !Object.hasOwn(value, field)))
    throw new OlistError('INVALID_REQUEST', 400);
  if (
    (Object.hasOwn(value, 'paymentDuePolicy') &&
      !['fixed_date', 'per_order'].includes(value.paymentDuePolicy)) ||
    (value.paymentDuePolicy === 'per_order' &&
      value.paymentDueOn !== null &&
      value.paymentDueOn !== undefined)
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === null
        ? null
        : key === 'paymentDueOn'
          ? paymentDueOn(entry)
          : key === 'productFiscal'
            ? olistProductFiscal(entry)
            : key.endsWith('Id')
              ? integer(entry)
              : text(entry, 120),
    ]),
  );
}
