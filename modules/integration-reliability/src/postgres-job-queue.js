import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 300_000;
const DEFAULT_JITTER_RATIO = 0.25;

/**
 * @typedef {{ query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}> }} Queryable
 * @typedef {{ query: Queryable['query'], transaction: <T>(work: (client: Queryable) => Promise<T>) => Promise<T> }} TransactionalDatabase
 */

/**
 * @param {{attemptCount: number, baseMs?: number, jitterRatio?: number, maxMs?: number, random?: () => number}} input
 */
export function calculateRetryDelayMs({
  attemptCount,
  baseMs = DEFAULT_RETRY_BASE_MS,
  jitterRatio = DEFAULT_JITTER_RATIO,
  maxMs = DEFAULT_RETRY_MAX_MS,
  random = Math.random,
}) {
  positiveInteger(attemptCount, 'attemptCount');
  positiveInteger(baseMs, 'baseMs');
  positiveInteger(maxMs, 'maxMs');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError('jitterRatio must be between zero and one');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError('random must return a number between zero and one');
  }
  const exponential = Math.min(maxMs, baseMs * 2 ** (attemptCount - 1));
  const multiplier = 1 + (sample * 2 - 1) * jitterRatio;
  return Math.min(maxMs, Math.max(1, Math.round(exponential * multiplier)));
}

/**
 * @param {{attemptCount: number, maxAttempts: number, retryable: boolean, retrySafe: boolean}} input
 */
export function decideFailedAttempt({
  attemptCount,
  maxAttempts,
  retryable,
  retrySafe,
}) {
  positiveInteger(attemptCount, 'attemptCount');
  positiveInteger(maxAttempts, 'maxAttempts');
  if (!retryable) {
    return {
      reconciliationReason: 'non_retryable_failure',
      status: 'dead_letter',
    };
  }
  if (!retrySafe) {
    return { reconciliationReason: 'unsafe_retry', status: 'dead_letter' };
  }
  if (attemptCount >= maxAttempts) {
    return {
      reconciliationReason: 'attempts_exhausted',
      status: 'dead_letter',
    };
  }
  return { reconciliationReason: null, status: 'retry' };
}

/**
 * @param {{attemptCount: number, attemptState: string, maxAttempts: number}} input
 */
export function decideExpiredAttempt({
  attemptCount,
  attemptState,
  maxAttempts,
}) {
  if (attemptState === 'sending') {
    return {
      attemptOutcome: 'outcome_unknown',
      reconciliationReason: 'lease_expired_after_effect_started',
      status: 'outcome_unknown',
    };
  }
  const decision = decideFailedAttempt({
    attemptCount,
    maxAttempts,
    retryable: true,
    retrySafe: true,
  });
  return { attemptOutcome: 'failed', ...decision };
}

export class PostgresJobQueue {
  /** @type {TransactionalDatabase} */
  #database;
  /** @type {() => number} */
  #random;
  #retryBaseMs;
  #retryMaxMs;

  /**
   * @param {{database: TransactionalDatabase, random?: () => number, retryBaseMs?: number, retryMaxMs?: number}} options
   */
  constructor({
    database,
    random = Math.random,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
  }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError('A transactional PostgreSQL database is required');
    }
    if (typeof random !== 'function') {
      throw new TypeError('random must be a function');
    }
    positiveInteger(retryBaseMs, 'retryBaseMs');
    positiveInteger(retryMaxMs, 'retryMaxMs');
    this.#database = database;
    this.#random = random;
    this.#retryBaseMs = retryBaseMs;
    this.#retryMaxMs = retryMaxMs;
  }

  /**
   * Claims runnable jobs under row locks. Expired leases are classified before
   * selecting new work, so a process death after effect start cannot be
   * mistaken for a safe retry.
   *
   * @param {{workerId: string, now?: string|Date, leaseMs?: number, limit?: number, queue?: string}} input
   */
  async claim({
    workerId,
    now = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    limit = 1,
    queue = 'default',
  }) {
    const normalizedWorkerId = boundedString(workerId, 'workerId', 128);
    const normalizedQueue = boundedString(queue, 'queue', 64);
    const claimedAt = validDate(now, 'now');
    positiveInteger(leaseMs, 'leaseMs');
    positiveInteger(limit, 'limit');
    if (limit > 100) throw new TypeError('limit must not exceed 100');
    const lockedUntil = new Date(claimedAt.getTime() + leaseMs);

    return this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      await this.#recoverExpired(client, claimedAt, normalizedQueue);
      await this.#reconcileConfirmedN8nSends(
        client,
        claimedAt,
        normalizedQueue,
      );
      await this.#reconcileRejectedN8nRecipients(
        client,
        claimedAt,
        normalizedQueue,
      );
      const selected = await client.query(
        `SELECT id, job_type, idempotency_key, channel_event_id,
                transient_media_id, message_id, chat_media_id, queue, priority, available_at,
                attempt_count, max_attempts, effect_policy, deletion_reason
         FROM crm.outbox_jobs
         WHERE queue = $1
           AND status IN ('pending', 'retry')
           AND available_at <= $2
           AND attempt_count < max_attempts
         ORDER BY priority, available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3`,
        [normalizedQueue, claimedAt, limit],
      );
      const jobs = [];
      for (const row of selected.rows) {
        const attemptId = randomUUID();
        const updated = await client.query(
          `UPDATE crm.outbox_jobs
           SET status = 'processing', attempt_count = attempt_count + 1,
               locked_by = $2, locked_until = $3, heartbeat_at = $4,
               updated_at = $4, completed_at = NULL, last_error_code = NULL
           WHERE id = $1
           RETURNING id, job_type, idempotency_key, channel_event_id,
                     transient_media_id, message_id, chat_media_id, queue, priority, available_at,
                     attempt_count, max_attempts, effect_policy,
                     deletion_reason`,
          [row.id, normalizedWorkerId, lockedUntil, claimedAt],
        );
        const job = updated.rows[0];
        await client.query(
          `INSERT INTO crm.processing_attempts
             (id, job_id, attempt_no, worker_id, state, started_at,
              heartbeat_at)
           VALUES ($1, $2, $3, $4, 'claimed', $5, $5)`,
          [attemptId, job.id, job.attempt_count, normalizedWorkerId, claimedAt],
        );
        if (job.channel_event_id) {
          await client.query(
            `UPDATE crm.channel_events
             SET processing_status = 'processing'
             WHERE id = $1 AND disposition = 'process'`,
            [job.channel_event_id],
          );
        }
        jobs.push(normalizeJob(job, attemptId));
      }
      return jobs;
    });
  }

  /** @param {{attemptId: string, jobId: string, workerId: string, now?: string|Date, leaseMs?: number}} input */
  async heartbeat({
    attemptId,
    jobId,
    workerId,
    now = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  }) {
    const heartbeatAt = validDate(now, 'now');
    positiveInteger(leaseMs, 'leaseMs');
    const result = await this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const updated = await client.query(
        `UPDATE crm.outbox_jobs
         SET heartbeat_at = $4, locked_until = $5, updated_at = $4
         WHERE id = $1 AND locked_by = $2 AND status = 'processing'
           AND locked_until > $4
           AND EXISTS (
             SELECT 1 FROM crm.processing_attempts a
             WHERE a.id = $3 AND a.job_id = crm.outbox_jobs.id
               AND a.worker_id = $2 AND a.state IN ('claimed', 'sending')
           )
         RETURNING id`,
        [
          boundedString(jobId, 'jobId', 128),
          boundedString(workerId, 'workerId', 128),
          boundedString(attemptId, 'attemptId', 128),
          heartbeatAt,
          new Date(heartbeatAt.getTime() + leaseMs),
        ],
      );
      if (updated.rows.length === 0) return false;
      await client.query(
        `UPDATE crm.processing_attempts
         SET heartbeat_at = $3
         WHERE id = $1 AND worker_id = $2 AND state IN ('claimed', 'sending')`,
        [attemptId, workerId, heartbeatAt],
      );
      return true;
    });
    return result;
  }

  /** @param {{attemptId: string, jobId: string, workerId: string, provider: string, now?: string|Date}} input */
  async markEffectStarted({
    attemptId,
    jobId,
    workerId,
    provider,
    now = new Date(),
  }) {
    const effectStartedAt = validDate(now, 'now');
    const result = await this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const owned = await client.query(
        `SELECT id FROM crm.outbox_jobs
         WHERE id = $1 AND locked_by = $2 AND status = 'processing'
           AND locked_until > $3
         FOR UPDATE`,
        [
          boundedString(jobId, 'jobId', 128),
          boundedString(workerId, 'workerId', 128),
          effectStartedAt,
        ],
      );
      if (owned.rows.length === 0) return false;
      const updated = await client.query(
        `UPDATE crm.processing_attempts
         SET state = 'sending', provider = $4, effect_started_at = $3,
             heartbeat_at = $3
         WHERE id = $1 AND job_id = $2 AND worker_id = $5
           AND state = 'claimed'
         RETURNING id`,
        [
          boundedString(attemptId, 'attemptId', 128),
          jobId,
          effectStartedAt,
          providerName(provider),
          workerId,
        ],
      );
      return updated.rows.length === 1;
    });
    return result;
  }

  /**
   * @param {{attemptId: string, jobId: string, workerId: string, outcome: 'sent'|'failed'|'outcome_unknown', now?: string|Date, errorCode?: string, providerExternalId?: string, retryable?: boolean, retrySafe?: boolean}} input
   */
  async settle({
    attemptId,
    jobId,
    workerId,
    outcome,
    now = new Date(),
    errorCode,
    providerExternalId,
    retryable = false,
    retrySafe = false,
  }) {
    if (!['sent', 'failed', 'outcome_unknown'].includes(outcome)) {
      throw new TypeError('outcome must be sent, failed or outcome_unknown');
    }
    const settledAt = validDate(now, 'now');
    return this.#database.transaction(async (client) => {
      await setTransactionBounds(client);
      const selected = await client.query(
        `SELECT j.id, j.attempt_count, j.max_attempts, j.channel_event_id,
                a.state AS attempt_state
         FROM crm.outbox_jobs j
         JOIN crm.processing_attempts a ON a.id = $2 AND a.job_id = j.id
         WHERE j.id = $1 AND j.locked_by = $3 AND j.status = 'processing'
           AND j.locked_until > $4
           AND a.worker_id = $3 AND a.state IN ('claimed', 'sending')
         FOR UPDATE OF j, a`,
        [
          boundedString(jobId, 'jobId', 128),
          boundedString(attemptId, 'attemptId', 128),
          boundedString(workerId, 'workerId', 128),
          settledAt,
        ],
      );
      if (selected.rows.length === 0) return false;
      const job = selected.rows[0];
      const normalizedError = errorCode ? errorCodeValue(errorCode) : null;
      const externalId = providerExternalId
        ? boundedString(providerExternalId, 'providerExternalId', 512)
        : null;

      if (outcome === 'sent') {
        await finishAttempt(client, {
          attemptId,
          errorCode: null,
          finishedAt: settledAt,
          outcome,
          providerExternalId: externalId,
          retrySafe: null,
        });
        await finishJob(client, job, 'completed', settledAt, null);
        return true;
      }

      if (outcome === 'outcome_unknown') {
        await finishAttempt(client, {
          attemptId,
          errorCode: normalizedError ?? 'OUTCOME_UNKNOWN',
          finishedAt: settledAt,
          outcome,
          providerExternalId: externalId,
          retrySafe: false,
        });
        await finishJob(
          client,
          job,
          'outcome_unknown',
          settledAt,
          normalizedError ?? 'OUTCOME_UNKNOWN',
        );
        await insertReconciliation(
          client,
          job.id,
          'external_outcome_unknown',
          settledAt,
        );
        return true;
      }

      const decision = decideFailedAttempt({
        attemptCount: Number(job.attempt_count),
        maxAttempts: Number(job.max_attempts),
        retryable,
        retrySafe,
      });
      await finishAttempt(client, {
        attemptId,
        errorCode: normalizedError ?? 'JOB_FAILED',
        finishedAt: settledAt,
        outcome: 'failed',
        providerExternalId: externalId,
        retrySafe,
      });
      if (decision.status === 'retry') {
        const delay = calculateRetryDelayMs({
          attemptCount: Number(job.attempt_count),
          baseMs: this.#retryBaseMs,
          maxMs: this.#retryMaxMs,
          random: this.#random,
        });
        await client.query(
          `UPDATE crm.outbox_jobs
           SET status = 'retry', available_at = $2, locked_by = NULL,
               locked_until = NULL, heartbeat_at = NULL, updated_at = $3,
               last_error_code = $4
           WHERE id = $1`,
          [
            job.id,
            new Date(settledAt.getTime() + delay),
            settledAt,
            normalizedError ?? 'JOB_FAILED',
          ],
        );
        if (job.channel_event_id) {
          await client.query(
            `UPDATE crm.channel_events SET processing_status = 'pending'
             WHERE id = $1 AND disposition = 'process'`,
            [job.channel_event_id],
          );
        }
        return true;
      }

      await finishJob(
        client,
        job,
        'dead_letter',
        settledAt,
        normalizedError ?? 'JOB_FAILED',
      );
      await insertReconciliation(
        client,
        job.id,
        decision.reconciliationReason,
        settledAt,
      );
      return true;
    });
  }

  /**
   * OPS-INBOX-ACK-02: a late, authenticated message.sent can settle the command
   * after its HTTP request timed out. Reconcile the queue on the next poll;
   * never claim that uncertain effect again or rewrite its attempt history.
   * Lock only jobs, so callback transactions need not acquire queue locks.
   * @param {Queryable} client @param {Date} now @param {string} queue
   */
  async #reconcileConfirmedN8nSends(client, now, queue) {
    await client.query(
      `WITH confirmed AS (
         SELECT j.id
         FROM crm.outbox_jobs j
         JOIN crm.n8n_commands c ON c.command_id = j.n8n_command_id
         JOIN crm.messages m ON m.id = c.message_id
         WHERE j.queue = $1 AND j.job_type = 'n8n.command.deliver'
           AND j.status = 'outcome_unknown'
           AND c.action = 'send_message' AND c.status = 'sent'
           AND m.command_id = c.command_id
           AND m.conversation_id = c.conversation_id AND m.status = 'sent'
           AND m.external_message_id IS NOT NULL
           AND m.external_message_id = c.external_message_id
           AND EXISTS (
             SELECT 1 FROM crm.n8n_events e
             WHERE e.message_id = m.id
               AND e.conversation_id = c.conversation_id
               AND e.event_type = 'message.sent'
           )
         ORDER BY j.updated_at, j.id
         FOR UPDATE OF j SKIP LOCKED LIMIT 100
       ), completed AS (
         UPDATE crm.outbox_jobs j
         SET status = 'completed', last_error_code = NULL,
             updated_at = greatest(j.updated_at, $2::timestamptz),
             completed_at = greatest(j.completed_at, $2::timestamptz)
         FROM confirmed WHERE j.id = confirmed.id
         RETURNING j.id
       )
       UPDATE crm.reconciliation_items r
       SET status = 'resolved', resolved_at = greatest(r.created_at, $2::timestamptz)
       FROM completed WHERE r.job_id = completed.id AND r.status = 'open'`,
      [queue, now],
    );
  }

  /**
   * OPS-INBOX-SEND-06: a late recipient preflight can prove that transport
   * never ran. Resolve only its exact authenticated reservation, without
   * replaying the job or rewriting the uncertain processing attempt.
   * @param {Queryable} client @param {Date} now @param {string} queue
   */
  async #reconcileRejectedN8nRecipients(client, now, queue) {
    await client.query(
      `WITH rejected AS (
         SELECT j.id, c.last_error_code
         FROM crm.outbox_jobs j
         JOIN crm.n8n_commands c ON c.command_id = j.n8n_command_id
         JOIN crm.messages m ON m.id = c.message_id
         WHERE j.queue = $1 AND j.job_type = 'n8n.command.deliver'
           AND j.status = 'outcome_unknown'
           AND c.action = 'send_message' AND c.actor_kind = 'human'
           AND c.status = 'failed' AND c.retryable = false AND c.retry_safe = false
           AND m.command_id = c.command_id
           AND m.conversation_id = c.conversation_id AND m.status = 'failed'
           AND m.delivery_status = 'failed' AND m.author_kind = 'human'
           AND m.author_id = c.actor_id
           AND m.automation_epoch = c.automation_epoch
           AND m.external_message_id IS NULL AND c.external_message_id IS NULL
           AND m.delivery_failure_code = c.last_error_code
           AND c.last_error_code IN (
             'EVOLUTION_RECIPIENT_NOT_FOUND',
             'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
             'MEDIA_DOWNLOAD_FAILED',
             'MEDIA_INTEGRITY_MISMATCH',
             'MEDIA_UPLOAD_FAILED',
             'MEDIA_PREFLIGHT_REJECTED',
             'MEDIA_PREFLIGHT_UNAVAILABLE'
           )
           AND EXISTS (
             SELECT 1 FROM crm.n8n_events failure
             JOIN crm.n8n_events reservation
               ON reservation.message_id = failure.message_id
              AND reservation.conversation_id = failure.conversation_id
              AND reservation.event_type = 'message.send.requested'
              AND reservation.execution_id = failure.execution_id
              AND reservation.workflow_key = failure.workflow_key
              AND reservation.workflow_version = failure.workflow_version
              AND reservation.automation_epoch = failure.automation_epoch
              AND reservation.source_revision = failure.source_revision
             WHERE failure.message_id = m.id
               AND failure.conversation_id = c.conversation_id
               AND failure.event_type = 'workflow.failed'
               AND failure.execution_id = m.n8n_execution_id
               AND failure.automation_epoch = c.automation_epoch
               AND failure.outcome->>'failureCode' = c.last_error_code
               AND failure.outcome->>'deliveryStatus' = 'failed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM crm.n8n_events transport
             WHERE transport.message_id = m.id
               AND transport.conversation_id = c.conversation_id
               AND transport.execution_id = m.n8n_execution_id
               AND transport.event_type = 'message.send.unknown'
           )
         ORDER BY j.updated_at, j.id
         FOR UPDATE OF j SKIP LOCKED LIMIT 100
       ), concluded AS (
         UPDATE crm.outbox_jobs j
         SET status = 'dead_letter', last_error_code = rejected.last_error_code,
             updated_at = greatest(j.updated_at, $2::timestamptz),
             completed_at = greatest(j.completed_at, $2::timestamptz)
         FROM rejected WHERE j.id = rejected.id
         RETURNING j.id
       )
       UPDATE crm.reconciliation_items r
       SET status = 'resolved', resolved_at = greatest(r.created_at, $2::timestamptz)
       FROM concluded WHERE r.job_id = concluded.id AND r.status = 'open'`,
      [queue, now],
    );
  }

  /** @param {Queryable} client @param {Date} now @param {string} queue */
  async #recoverExpired(client, now, queue) {
    const expired = await client.query(
      `SELECT j.id, j.attempt_count, j.max_attempts, j.channel_event_id,
              a.id AS attempt_id, a.state AS attempt_state
       FROM crm.outbox_jobs j
       LEFT JOIN crm.processing_attempts a
         ON a.job_id = j.id AND a.attempt_no = j.attempt_count
       WHERE j.queue = $1 AND j.status = 'processing'
         AND j.locked_until <= $2
       ORDER BY j.locked_until, j.id
       FOR UPDATE OF j SKIP LOCKED`,
      [queue, now],
    );
    for (const job of expired.rows) {
      const decision = decideExpiredAttempt({
        attemptCount: Number(job.attempt_count),
        attemptState: String(job.attempt_state ?? 'sending'),
        maxAttempts: Number(job.max_attempts),
      });
      if (job.attempt_id) {
        await finishAttempt(client, {
          attemptId: String(job.attempt_id),
          errorCode: 'WORKER_LEASE_EXPIRED',
          finishedAt: now,
          outcome: decision.attemptOutcome,
          providerExternalId: null,
          retrySafe: decision.status === 'retry',
        });
      }
      if (decision.status === 'retry') {
        await client.query(
          `UPDATE crm.outbox_jobs
           SET status = 'retry', available_at = $2, locked_by = NULL,
               locked_until = NULL, heartbeat_at = NULL, updated_at = $2,
               last_error_code = 'WORKER_LEASE_EXPIRED'
           WHERE id = $1`,
          [job.id, now],
        );
        if (job.channel_event_id) {
          await client.query(
            `UPDATE crm.channel_events SET processing_status = 'pending'
             WHERE id = $1 AND disposition = 'process'`,
            [job.channel_event_id],
          );
        }
      } else {
        await finishJob(
          client,
          job,
          decision.status,
          now,
          'WORKER_LEASE_EXPIRED',
        );
        await insertReconciliation(
          client,
          String(job.id),
          decision.reconciliationReason,
          now,
        );
      }
    }
  }
}

/** @param {Queryable} client */
async function setTransactionBounds(client) {
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL transaction_timeout = '10s'");
}

/** @param {Queryable} client @param {{attemptId: string, outcome: string, finishedAt: Date, errorCode: string|null, providerExternalId: string|null, retrySafe: boolean|null}} input */
async function finishAttempt(client, input) {
  await client.query(
    `UPDATE crm.processing_attempts
     SET state = $2, finished_at = $3, heartbeat_at = $3,
         error_code = $4, provider_external_id = $5, retry_safe = $6
     WHERE id = $1`,
    [
      input.attemptId,
      input.outcome,
      input.finishedAt,
      input.errorCode,
      input.providerExternalId,
      input.retrySafe,
    ],
  );
}

/** @param {Queryable} client @param {Record<string, unknown>} job @param {string} status @param {Date} now @param {string|null} errorCode */
async function finishJob(client, job, status, now, errorCode) {
  await client.query(
    `UPDATE crm.outbox_jobs
     SET status = $2, locked_by = NULL, locked_until = NULL,
         heartbeat_at = NULL, updated_at = $3, completed_at = $3,
         last_error_code = $4
     WHERE id = $1`,
    [job.id, status, now, errorCode],
  );
  if (job.channel_event_id) {
    await client.query(
      `UPDATE crm.channel_events
       SET processing_status = $2
       WHERE id = $1 AND disposition = 'process'`,
      [
        job.channel_event_id,
        status === 'completed' ? 'processed' : 'reconciliation',
      ],
    );
  }
}

/** @param {Queryable} client @param {unknown} jobId @param {unknown} reason @param {Date} now */
async function insertReconciliation(client, jobId, reason, now) {
  await client.query(
    `INSERT INTO crm.reconciliation_items
       (id, job_id, status, reason, created_at)
     VALUES ($1, $2, 'open', $3, $4)
     ON CONFLICT (job_id) DO NOTHING`,
    [randomUUID(), jobId, reason, now],
  );
}

/** @param {Record<string, unknown>} row @param {string} attemptId */
function normalizeJob(row, attemptId) {
  return Object.freeze({
    attemptCount: Number(row.attempt_count),
    attemptId,
    availableAt: new Date(String(row.available_at)),
    channelEventId: nullableString(row.channel_event_id),
    chatMediaId: nullableString(row.chat_media_id),
    commandId: String(row.idempotency_key),
    deletionReason: nullableString(row.deletion_reason),
    effectPolicy: String(row.effect_policy),
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    jobType: String(row.job_type),
    maxAttempts: Number(row.max_attempts),
    messageId: nullableString(row.message_id),
    priority: Number(row.priority),
    queue: String(row.queue),
    transientMediaId: nullableString(row.transient_media_id),
  });
}

/** @param {unknown} value */
function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
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
function validDate(value, field) {
  const date =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return date;
}

/** @param {unknown} value */
function providerName(value) {
  const provider = boundedString(value, 'provider', 64);
  if (!/^[a-z0-9_.-]+$/u.test(provider)) {
    throw new TypeError('provider must be a bounded technical identifier');
  }
  return provider;
}

/** @param {unknown} value */
function errorCodeValue(value) {
  const code = boundedString(value, 'errorCode', 64);
  if (!/^[A-Z0-9_]+$/u.test(code)) {
    throw new TypeError('errorCode must be a bounded technical code');
  }
  return code;
}
