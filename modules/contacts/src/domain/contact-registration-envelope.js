import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { CONTACT_REGISTRATION_FIELDS } from './contact-registration.js';

/** ADR 047: its own AAD, so a details envelope can never pass for this one. */
const AAD = 'crm.contacts.registration.v1';

/**
 * @param {import('./contact-registration.js').ContactRegistration} registration
 * @param {Buffer} key
 */
export function encryptContactRegistration(registration, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(AAD));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(pickFields(registration)), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'AES-256-GCM',
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * @param {unknown} value @param {Buffer} key
 * @returns {Readonly<import('./contact-registration.js').ContactRegistration>|null}
 */
export function decryptContactRegistration(value, key) {
  if (!value) return null;
  const envelope = /** @type {any} */ (
    typeof value === 'string' ? JSON.parse(value) : value
  );
  if (envelope?.algorithm !== 'AES-256-GCM' || envelope?.version !== 1) {
    throw new Error('Stored contact registration is invalid');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(AAD));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return pickFields(
    JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ),
  );
}

/** @param {any} source */
function pickFields(source) {
  return /** @type {Readonly<import('./contact-registration.js').ContactRegistration>} */ (
    Object.freeze(
      Object.fromEntries(
        CONTACT_REGISTRATION_FIELDS.map((field) => [
          field,
          typeof source?.[field] === 'string' ? source[field] : null,
        ]),
      ),
    )
  );
}
