import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}> }} Queryable
 * @typedef {{ query: Queryable['query'], transaction: <T>(work: (client: Queryable) => Promise<T>) => Promise<T> }} TransactionalDatabase
 */

export class PostgresTransientMediaRepository {
  /** @type {TransactionalDatabase} */
  #database;

  /** @param {{database: TransactionalDatabase}} options */
  constructor({ database }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError('A transactional PostgreSQL database is required');
    }
    this.#database = database;
  }

  /** @param {{mediaId: string, storageKey: string, sizeBytes: number, contentSha256: string, detectedMimeType: string, now: string|Date}} input */
  async markAvailable(input) {
    await this.#markStored(input, {
      availabilityStatus: 'available',
      validationStatus: 'clean',
    });
  }

  /** @param {{mediaId: string, storageKey: string, sizeBytes: number, contentSha256: string, detectedMimeType: string, now: string|Date}} input */
  async markQuarantined(input) {
    await this.#markStored(input, {
      availabilityStatus: 'quarantined',
      validationStatus: 'stale_signatures',
    });
  }

  /** @param {{mediaId: string, sizeBytes: number, contentSha256: string, detectedMimeType: string, reason: string, now: string|Date}} input */
  async markRejected(input) {
    const validationStatus =
      input.reason === 'infected' ? 'infected' : 'invalid_type';
    const result = await this.#database.query(
      `UPDATE crm.transient_media
       SET availability_status = 'rejected', validation_status = $2,
           size_bytes = $3, content_sha256 = $4, detected_mime_type = $5,
           unavailable_reason = NULL
       WHERE id = $1 AND availability_status IN (
         'metadata_only', 'quarantined', 'lost', 'unavailable'
       )
       RETURNING id`,
      [
        boundedString(input.mediaId, 'mediaId', 128),
        validationStatus,
        nonnegativeInteger(input.sizeBytes, 'sizeBytes'),
        sha256(input.contentSha256),
        boundedString(input.detectedMimeType, 'detectedMimeType', 255),
      ],
    );
    requireSingleMutation(result, 'Transient media cannot be rejected');
  }

  /** @param {{mediaId: string, reason: string, now: string|Date}} input */
  async markUnavailable({ mediaId, reason }) {
    const normalizedReason = reasonCode(reason);
    const availabilityStatus =
      normalizedReason === 'lost' ? 'lost' : 'unavailable';
    const result = await this.#database.query(
      `UPDATE crm.transient_media
       SET availability_status = $2, unavailable_reason = $3,
           validation_status = CASE
             WHEN validation_status = 'pending' THEN 'error'
             ELSE validation_status
           END
       WHERE id = $1 AND availability_status <> 'deleted'
       RETURNING id`,
      [
        boundedString(mediaId, 'mediaId', 128),
        availabilityStatus,
        normalizedReason,
      ],
    );
    requireSingleMutation(
      result,
      'Transient media cannot be marked unavailable',
    );
  }

  /** @param {{mediaId: string, reason: string, now: string|Date}} input */
  async markDeleted({ mediaId, reason, now }) {
    const deletedAt = validDate(now, 'now');
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    if (!['expired', 'journey_terminal'].includes(reason)) {
      throw new TypeError('reason must be expired or journey_terminal');
    }
    await this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const result = await client.query(
        `UPDATE crm.transient_media
         SET availability_status = 'deleted', deleted_at = $2,
             unavailable_reason = NULL
         WHERE id = $1 AND availability_status <> 'deleted'
         RETURNING id`,
        [normalizedMediaId, deletedAt],
      );
      if (result.rows.length > 1) {
        throw new Error('Transient media identity is not unique');
      }
      if (result.rows.length === 1) {
        const auditId = randomUUID();
        await client.query(
          `INSERT INTO crm.audit_events
             (id, actor_id, action, target_type, target_id, version, reason,
              correlation_id, occurred_at)
           VALUES ($1, 'system:media-retention', 'media.transient.deleted',
             'transient_media', $2, '1', $3, $1, $4)`,
          [auditId, normalizedMediaId, reason, deletedAt],
        );
      }
    });
  }

  /** @param {{mediaId: string}} input */
  async readForDeletion({ mediaId }) {
    const result = await this.#database.query(
      `SELECT id, storage_key, availability_status
       FROM crm.transient_media WHERE id = $1`,
      [boundedString(mediaId, 'mediaId', 128)],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new Error('Transient media identity is not unique');
    }
    return Object.freeze({
      availabilityStatus: String(result.rows[0].availability_status),
      id: String(result.rows[0].id),
      storageKey:
        result.rows[0].storage_key === null
          ? null
          : String(result.rows[0].storage_key),
    });
  }

  /** @param {{mediaId: string, operatorId: string, occurredAt?: string|Date, result: 'success'|'failure'|'limitation'|'archive_missed'}} input */
  async recordValidFileHandoff({
    mediaId,
    operatorId,
    occurredAt = new Date(),
    result,
  }) {
    if (
      !['success', 'failure', 'limitation', 'archive_missed'].includes(result)
    ) {
      throw new TypeError(
        'result must be a canonical valid-file handoff outcome',
      );
    }
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    const normalizedOperatorId = boundedString(operatorId, 'operatorId', 128);
    const timestamp = validDate(occurredAt, 'occurredAt');
    return this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const selected = await client.query(
        `SELECT content_sha256, availability_status, validation_status
         FROM crm.transient_media WHERE id = $1 FOR UPDATE`,
        [normalizedMediaId],
      );
      if (selected.rows.length !== 1) {
        throw new Error('Transient media is not available for handoff');
      }
      const media = selected.rows[0];
      if (
        media.availability_status !== 'available' ||
        media.validation_status !== 'clean'
      ) {
        throw new Error(
          'Only clean available media can receive a handoff receipt',
        );
      }
      const contentSha256 = sha256(media.content_sha256);
      const receiptId = randomUUID();
      await client.query(
        `INSERT INTO crm.media_handoff_receipts
           (id, transient_media_id, destination, content_sha256,
            operator_id, occurred_at, result)
         VALUES ($1, $2, 'rustfs', $3, $4, $5, $6)`,
        [
          receiptId,
          normalizedMediaId,
          contentSha256,
          normalizedOperatorId,
          timestamp,
          result,
        ],
      );
      await client.query(
        `INSERT INTO crm.audit_events
           (id, actor_id, action, target_type, target_id, version, reason,
            correlation_id, occurred_at)
         VALUES ($1, $2, 'media.valid_file_handoff.recorded', 'transient_media',
           $3, '1', $4, $5, $6)`,
        [
          randomUUID(),
          normalizedOperatorId,
          normalizedMediaId,
          `valid-file-${result}`,
          receiptId,
          timestamp,
        ],
      );
      return Object.freeze({ contentSha256, id: receiptId, result });
    });
  }

  /** @param {{mediaId: string, reason: 'expired'|'journey_terminal', now?: string|Date}} input */
  async scheduleImmediateDeletion({ mediaId, reason, now = new Date() }) {
    return this.#scheduleDeletion({
      client: this.#database,
      mediaId,
      now: validDate(now, 'now'),
      reason,
    });
  }

  /** @param {{now?: string|Date, limit?: number}} [input] */
  async scheduleExpiredDeletions({ now = new Date(), limit = 100 } = {}) {
    const timestamp = validDate(now, 'now');
    positiveInteger(limit, 'limit');
    if (limit > 1_000) throw new TypeError('limit must not exceed 1000');
    return this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const selected = await client.query(
        `SELECT id FROM crm.transient_media
         WHERE expires_at <= $1
           AND availability_status <> 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM crm.outbox_jobs j
             WHERE j.job_type = 'media.delete'
               AND j.transient_media_id = crm.transient_media.id
           )
         ORDER BY expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [timestamp, limit],
      );
      let scheduled = 0;
      for (const row of selected.rows) {
        if (
          await this.#scheduleDeletion({
            client,
            mediaId: String(row.id),
            now: timestamp,
            reason: 'expired',
          })
        ) {
          scheduled += 1;
        }
      }
      return scheduled;
    });
  }

  /** @param {{now?: string|Date, limit?: number}} [input] */
  async scheduleTerminalJourneyDeletions({
    now = new Date(),
    limit = 100,
  } = {}) {
    const timestamp = validDate(now, 'now');
    positiveInteger(limit, 'limit');
    if (limit > 1_000) throw new TypeError('limit must not exceed 1000');
    return this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const selected = await client.query(
        `SELECT media.id
         FROM crm.transient_media AS media
         JOIN crm.attachments AS attachment
           ON attachment.transient_media_id = media.id
         JOIN crm.messages AS message ON message.id = attachment.message_id
         JOIN crm.conversations AS conversation
           ON conversation.id = message.conversation_id
         WHERE conversation.terminal_at IS NOT NULL
           AND conversation.terminal_at <= $1
           AND media.availability_status <> 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM crm.outbox_jobs AS job
             WHERE job.job_type = 'media.delete'
               AND job.transient_media_id = media.id
               AND job.status NOT IN ('dead_letter', 'completed')
           )
         ORDER BY conversation.terminal_at, media.id
         FOR UPDATE OF media SKIP LOCKED
         LIMIT $2`,
        [timestamp, limit],
      );
      let scheduled = 0;
      for (const row of selected.rows) {
        if (
          await this.#scheduleDeletion({
            client,
            mediaId: String(row.id),
            now: timestamp,
            reason: 'journey_terminal',
          })
        ) {
          scheduled += 1;
        }
      }
      return scheduled;
    });
  }

  /**
   * @param {{client: Queryable, mediaId: string, reason: 'expired'|'journey_terminal', now: Date}} input
   */
  async #scheduleDeletion({ client, mediaId, reason, now }) {
    if (!['expired', 'journey_terminal'].includes(reason)) {
      throw new TypeError('reason must be expired or journey_terminal');
    }
    const normalizedMediaId = boundedString(mediaId, 'mediaId', 128);
    const result = await client.query(
      `INSERT INTO crm.outbox_jobs
         (id, job_type, idempotency_key, transient_media_id, status, queue,
          priority, available_at, created_at, updated_at, max_attempts,
          effect_policy, deletion_reason)
       VALUES ($1, 'media.delete', $2, $3, 'pending', 'media-retention', 0,
         $4, $4, $4, 8, 'internal', $5)
       ON CONFLICT (job_type, idempotency_key)
       DO UPDATE SET
         available_at = LEAST(crm.outbox_jobs.available_at, EXCLUDED.available_at),
         deletion_reason = CASE
           WHEN EXCLUDED.deletion_reason = 'journey_terminal'
             THEN 'journey_terminal'
           ELSE crm.outbox_jobs.deletion_reason
         END,
         updated_at = EXCLUDED.updated_at
       WHERE crm.outbox_jobs.status IN ('pending', 'retry')
       RETURNING id`,
      [
        randomUUID(),
        `media.delete:${normalizedMediaId}`,
        normalizedMediaId,
        now,
        reason,
      ],
    );
    return result.rows.length === 1;
  }

  /** @param {Record<string, unknown>} input @param {{availabilityStatus: string, validationStatus: string}} state */
  async #markStored(input, state) {
    const result = await this.#database.query(
      `UPDATE crm.transient_media
       SET availability_status = $2, validation_status = $3,
           storage_key = $4, size_bytes = $5, content_sha256 = $6,
           detected_mime_type = $7, stored_at = $8,
           unavailable_reason = NULL
       WHERE id = $1 AND (
         availability_status IN ('metadata_only', 'quarantined')
         OR (availability_status = 'unavailable' AND unavailable_reason IN (
           'storage_or_scan_failed', 'quota_exceeded', 'volume_unavailable'
         ))
       )
       RETURNING id`,
      [
        boundedString(input.mediaId, 'mediaId', 128),
        state.availabilityStatus,
        state.validationStatus,
        storageKey(input.storageKey),
        nonnegativeInteger(input.sizeBytes, 'sizeBytes'),
        sha256(input.contentSha256),
        boundedString(input.detectedMimeType, 'detectedMimeType', 255),
        validDate(input.now, 'now'),
      ],
    );
    requireSingleMutation(result, 'Transient media cannot be stored');
  }
}

/** @param {Queryable} client */
async function setTransactionBounds(client) {
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL transaction_timeout = '10s'");
}

/** @param {{rows: Array<Record<string, unknown>>}} result @param {string} message */
function requireSingleMutation(result, message) {
  if (result.rows.length !== 1) throw new Error(message);
}

/** @param {unknown} value */
function sha256(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('contentSha256 must be a lowercase SHA-256 digest');
  }
  return value;
}

/** @param {unknown} value */
function storageKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value)) {
    throw new TypeError('storageKey must be an opaque UUID');
  }
  return value;
}

/** @param {unknown} value */
function reasonCode(value) {
  const reason = boundedString(value, 'reason', 64);
  if (!/^[a-z0-9_]+$/u.test(reason)) {
    throw new TypeError('reason must be a bounded technical code');
  }
  return reason;
}

/** @param {unknown} value @param {string} field @param {number} maximum */
function boundedString(value, field, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${field} must be between 1 and ${maximum} characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

/** @param {unknown} value @param {string} field */
function nonnegativeInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a nonnegative integer`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function validDate(value, field) {
  const date =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return date;
}
