import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { OlistError } from './errors.js';
/** @param {Buffer} key */
function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new OlistError('OLIST_NOT_CONFIGURED', 503);
}
/** Olist envelopes use independent purpose/account/entity AAD and key namespace.
 * @param {unknown} value @param {Buffer} key @param {string} purpose @param {string} account @param {string} entity */
export function seal(value, key, purpose, account, entity) {
  requireKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(
    Buffer.from(JSON.stringify(['olist', 1, purpose, account, entity])),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'AES-256-GCM',
    keyVersion: 1,
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}
/** @param {any} envelope @param {Buffer} key @param {string} purpose @param {string} account @param {string} entity */
export function open(envelope, key, purpose, account, entity) {
  requireKey(key);
  try {
    if (
      envelope?.algorithm !== 'AES-256-GCM' ||
      envelope.keyVersion !== 1 ||
      envelope.version !== 1
    )
      throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(
      Buffer.from(JSON.stringify(['olist', 1, purpose, account, entity])),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw new OlistError('OLIST_ENVELOPE_INVALID');
  }
}
/** @param {Buffer} key @param {string} kind @param {unknown} identity */
export function identityHash(key, kind, identity) {
  requireKey(key);
  return createHmac('sha256', key)
    .update(JSON.stringify(['olist-identity', 1, kind, identity]))
    .digest('hex');
}
