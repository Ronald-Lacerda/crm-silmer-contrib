import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { IdempotencyConflictError } from './idempotency.js';

const CIPHER = 'aes-256-gcm';
const ENVELOPE_ALGORITHM = 'AES-256-GCM';
const ENVELOPE_VERSION = 1;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * @typedef {{ type: string, id: string }} CommandTarget
 * @typedef {{
 *   scope: string,
 *   key: string,
 *   fingerprint: string,
 *   actor: string,
 *   action: string,
 *   target: CommandTarget,
 *   version: string | number,
 *   reason: string,
 *   correlationId: string,
 * }} IdempotencyIdentity
 * @typedef {{
 *   query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}>
 * }} Queryable
 * @typedef {Queryable & { release?: () => void }} TransactionClient
 * @typedef {{
 *   query: Queryable['query'],
 *   transaction: <T>(work: (client: TransactionClient) => Promise<T>) => Promise<T>,
 * }} TransactionalDatabase
 * @typedef {{
 *   action: string,
 *   actor_id: string,
 *   correlation_id: string,
 *   fingerprint: string,
 *   reason: string,
 *   response: unknown,
 *   status: 'pending'|'completed',
 *   target_id: string,
 *   target_type: string,
 *   version: string,
 * }} StoredRecord
 */

/**
 * PostgreSQL idempotency port. The pending row, domain effect, audit append,
 * encrypted response and completion update share the transaction opened by the
 * injected database port. The operation receives that exact client so callers
 * cannot accidentally commit the effect through a different connection.
 */
export class PostgresIdempotencyRecordStore {
  /** @type {TransactionalDatabase} */
  #database;

  /** @type {Buffer} */
  #envelopeKey;

  /**
   * @param {{ database: TransactionalDatabase, envelopeKey: Buffer }} options
   */
  constructor({ database, envelopeKey }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError(
        'A transactional PostgreSQL database port is required',
      );
    }
    if (!Buffer.isBuffer(envelopeKey) || envelopeKey.length !== 32) {
      throw new TypeError(
        'A 32-byte idempotency response envelope key is required',
      );
    }
    this.#database = database;
    this.#envelopeKey = Buffer.from(envelopeKey);
  }

  /**
   * @template T
   * @param {IdempotencyIdentity} identity
   * @param {(client: TransactionClient) => Promise<T>} operation
   * @param {(client: TransactionClient) => Promise<unknown>} [beforeExecute]
   * @returns {Promise<T>}
   */
  async execute(identity, operation, beforeExecute) {
    validateIdentity(identity);
    if (typeof operation !== 'function') {
      throw new TypeError('operation must be a function');
    }

    return this.#database.transaction(async (client) => {
      // Hold current domain authority through both effect and receipt replay.
      await beforeExecute?.(client);
      if (!client || typeof client.query !== 'function') {
        throw new TypeError('transaction must provide a queryable client');
      }

      const inserted = await client.query(
        `INSERT INTO crm.idempotency_records
           (scope, idempotency_key, fingerprint, actor_id, action, target_type,
            target_id, version, reason, correlation_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         ON CONFLICT (scope, idempotency_key) DO NOTHING
         RETURNING true AS inserted`,
        identityValues(identity),
      );

      if (inserted.rows.length === 0) {
        const existing = await selectRecord(client, identity, true);
        if (!existing) {
          throw new Error('Idempotency conflict disappeared before replay');
        }
        if (existing.fingerprint !== identity.fingerprint) {
          throw new IdempotencyConflictError(identity.scope, identity.key);
        }
        if (existing.status !== 'completed') {
          const error = /** @type {Error & {code: string}} */ (
            new Error(
              'A committed pending idempotency record cannot be replayed safely',
            )
          );
          error.code = 'IDEMPOTENCY_RECORD_PENDING';
          throw error;
        }
        return /** @type {T} */ (
          decryptResponse(existing.response, identity, this.#envelopeKey)
        );
      }

      const normalized = normalizeResponse(await operation(client));
      const encrypted = encryptResponse(
        normalized.serialized,
        identity,
        this.#envelopeKey,
      );
      const completed = await client.query(
        `UPDATE crm.idempotency_records
         SET status = 'completed', response = $3::jsonb, completed_at = now()
         WHERE scope = $1 AND idempotency_key = $2 AND status = 'pending'
         RETURNING true AS completed`,
        [identity.scope, identity.key, JSON.stringify(encrypted)],
      );
      if (completed.rows.length !== 1) {
        throw new Error('Pending idempotency record could not be completed');
      }
      return /** @type {T} */ (structuredClone(normalized.value));
    });
  }

  /**
   * @param {{ scope: string, key: string }} identity
   * @returns {Promise<Readonly<{
   *   fingerprint: string,
   *   actor: string,
   *   action: string,
   *   target: CommandTarget,
   *   version: string | number,
   *   reason: string,
   *   correlationId: string,
   *   status: string,
   *   response?: unknown,
   * }> | null>}
   */
  async get(identity) {
    requireNonEmpty(identity.scope, 'scope');
    requireNonEmpty(identity.key, 'key');
    const row = await selectRecord(this.#database, identity, false);
    if (!row) return null;

    const record = {
      action: row.action,
      actor: row.actor_id,
      correlationId: row.correlation_id,
      fingerprint: row.fingerprint,
      reason: row.reason,
      status: row.status,
      target: { id: row.target_id, type: row.target_type },
      version: row.version,
      ...(row.status === 'completed'
        ? {
            response: decryptResponse(
              row.response,
              {
                fingerprint: row.fingerprint,
                key: identity.key,
                scope: identity.scope,
              },
              this.#envelopeKey,
            ),
          }
        : {}),
    };
    return Object.freeze(structuredClone(record));
  }
}

/** @param {IdempotencyIdentity} identity */
function identityValues(identity) {
  return [
    identity.scope,
    identity.key,
    identity.fingerprint,
    identity.actor,
    identity.action,
    identity.target.type,
    identity.target.id,
    String(identity.version),
    identity.reason,
    identity.correlationId,
  ];
}

/**
 * @param {Queryable} database
 * @param {{scope: string, key: string}} identity
 * @param {boolean} lock
 */
async function selectRecord(database, identity, lock) {
  const result = await database.query(
    `SELECT scope, idempotency_key, fingerprint, actor_id, action, target_type,
            target_id, version, reason, correlation_id, status, response
     FROM crm.idempotency_records
     WHERE scope = $1 AND idempotency_key = $2${lock ? ' FOR UPDATE' : ''}`,
    [identity.scope, identity.key],
  );
  const row = result.rows[0];
  if (!row) return null;
  const status = storedString(row.status, 'status');
  if (status !== 'pending' && status !== 'completed') {
    throw new Error('Invalid persisted idempotency status');
  }
  return /** @type {StoredRecord} */ ({
    action: storedString(row.action, 'action'),
    actor_id: storedString(row.actor_id, 'actor_id'),
    correlation_id: storedString(row.correlation_id, 'correlation_id'),
    fingerprint: storedString(row.fingerprint, 'fingerprint'),
    reason: storedString(row.reason, 'reason'),
    response: row.response,
    status,
    target_id: storedString(row.target_id, 'target_id'),
    target_type: storedString(row.target_type, 'target_type'),
    version: storedString(row.version, 'version'),
  });
}

/** @param {IdempotencyIdentity} identity */
function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('identity must be an object');
  }
  requireNonEmpty(identity.scope, 'scope');
  requireNonEmpty(identity.key, 'key');
  requireNonEmpty(identity.actor, 'actor');
  requireNonEmpty(identity.action, 'action');
  requireNonEmpty(identity.reason, 'reason');
  requireNonEmpty(identity.correlationId, 'correlationId');
  if (!FINGERPRINT_PATTERN.test(identity.fingerprint)) {
    throw new TypeError('fingerprint must be a lowercase SHA-256 digest');
  }
  if (!identity.target || typeof identity.target !== 'object') {
    throw new TypeError('target must identify a type and id');
  }
  requireNonEmpty(identity.target.type, 'target.type');
  requireNonEmpty(identity.target.id, 'target.id');
  if (
    (typeof identity.version !== 'string' &&
      typeof identity.version !== 'number') ||
    identity.version === '' ||
    (typeof identity.version === 'number' && !Number.isFinite(identity.version))
  ) {
    throw new TypeError('version must be a string or number');
  }
}

/** @param {unknown} response */
function normalizeResponse(response) {
  /** @type {string | undefined} */
  let serialized;
  try {
    serialized = JSON.stringify(response);
  } catch (error) {
    throw new TypeError('Idempotency response must be valid JSON', {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new TypeError('Idempotency response must be valid JSON');
  }
  return { serialized, value: JSON.parse(serialized) };
}

/**
 * @param {string} serialized
 * @param {{scope: string, key: string, fingerprint: string}} identity
 * @param {Buffer} key
 */
function encryptResponse(serialized, identity, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([
    cipher.update(serialized, 'utf8'),
    cipher.final(),
  ]);
  return Object.freeze({
    algorithm: ENVELOPE_ALGORITHM,
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    version: ENVELOPE_VERSION,
  });
}

/**
 * @param {unknown} rawEnvelope
 * @param {{scope: string, key: string, fingerprint: string}} identity
 * @param {Buffer} key
 */
function decryptResponse(rawEnvelope, identity, key) {
  const envelope = parseEnvelope(rawEnvelope);
  try {
    const decipher = createDecipheriv(CIPHER, key, envelope.iv);
    decipher.setAAD(aad(identity));
    decipher.setAuthTag(envelope.tag);
    const plaintext = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    throw new Error('Unable to authenticate or decrypt idempotency response', {
      cause: error,
    });
  }
}

/** @param {unknown} raw */
function parseEnvelope(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== ENVELOPE_VERSION ||
    value.algorithm !== ENVELOPE_ALGORITHM
  ) {
    throw new Error('Unsupported idempotency response envelope');
  }
  const encoded = /** @type {Record<string, unknown>} */ (value);
  const iv = decodeBase64Url(encoded.iv, 'iv');
  const tag = decodeBase64Url(encoded.tag, 'tag');
  const ciphertext = decodeBase64Url(encoded.ciphertext, 'ciphertext');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid idempotency response envelope');
  }
  return { ciphertext, iv, tag };
}

/** @param {unknown} value @param {string} field */
function decodeBase64Url(value, field) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error(`Invalid idempotency response envelope ${field}`);
  }
  return Buffer.from(value, 'base64url');
}

/** @param {{scope: string, key: string, fingerprint: string}} identity */
function aad(identity) {
  return Buffer.from(
    JSON.stringify([identity.scope, identity.key, identity.fingerprint]),
    'utf8',
  );
}

/** @param {unknown} value @param {string} field */
function requireNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

/** @param {unknown} value @param {string} field */
function storedString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Invalid persisted idempotency ${field}`);
  }
  return value;
}
