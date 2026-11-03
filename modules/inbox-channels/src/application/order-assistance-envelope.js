import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** @param {any} value @param {string} aad @param {Buffer} key */
export function encryptAssistance(value, aad, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'AES-256-GCM',
    version: 1,
    keyVersion: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

/** @param {any} value @param {string} aad @param {Buffer} key */
export function decryptAssistance(value, aad, key) {
  if (
    value?.algorithm !== 'AES-256-GCM' ||
    value.version !== 1 ||
    value.keyVersion !== 1
  )
    throw new Error('INVALID_ASSISTANCE_ENVELOPE');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(value.iv, 'base64url'),
  );
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, 'base64url')),
      cipher.final(),
    ]).toString('utf8'),
  );
}
