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
  let accountKey = '';
  let expectedDocument = '';
  let validRedirect = false;
  try {
    expectedDocument = normalizeDocument(env.OLIST_EXPECTED_ACCOUNT_DOCUMENT);
    accountKey = identityHash(hmacKey, 'account', expectedDocument);
    const url = new URL(redirectUri);
    validRedirect =
      url.origin === env.APP_ORIGIN &&
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
/** Full replacement; settings never infer a seller.
 * @param {unknown} raw */
export function olistSettings(raw) {
  const value = object(raw, Object.keys(EMPTY_OLIST_SETTINGS));
  if (Object.keys(value).length !== Object.keys(EMPTY_OLIST_SETTINGS).length)
    throw new OlistError('INVALID_REQUEST', 400);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === null
        ? null
        : key.endsWith('Id')
          ? integer(entry)
          : text(entry, 120),
    ]),
  );
}
