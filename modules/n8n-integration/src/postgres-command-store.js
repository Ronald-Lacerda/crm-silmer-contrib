import { randomUUID } from 'node:crypto';
import { decryptJson } from './crypto.js';

const DEFAULT_LEASE_MS = 300_000;

export class PostgresN8nCommandStore {
  /** @param {{database: any, envelopeKey: Buffer}} options */
  constructor({ database, envelopeKey }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError('A transactional PostgreSQL database is required');
    }
    if (!Buffer.isBuffer(envelopeKey) || envelopeKey.length !== 32) {
      throw new TypeError('envelopeKey must be a 32-byte Buffer');
    }
    this.database = database;
    this.envelopeKey = Buffer.from(envelopeKey);
  }

  /** @param {string} commandId @param {Record<string, any>} [context] */
  async loadForDelivery(commandId, context = {}) {
    technicalId(commandId, 'commandId');
    const now = context.now ? validDate(context.now) : new Date();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await recoverExpired(client, commandId, now);
      const row = (
        await client.query(
          `SELECT command_id, fingerprint, payload_envelope, status,
                  retryable, retry_safe
           FROM crm.n8n_commands WHERE command_id = $1`,
          [commandId],
        )
      ).rows[0];
      if (
        !row ||
        !(
          row.status === 'pending' ||
          (row.status === 'failed' && row.retryable && row.retry_safe)
        )
      ) {
        return null;
      }
      return Object.freeze({
        commandId: row.command_id,
        payload: decryptJson(
          row.payload_envelope,
          `n8n-command:${row.command_id}`,
          this.envelopeKey,
        ),
        payloadHash: row.fingerprint,
      });
    });
  }

  /** @param {string} commandId @param {Record<string, any>} context */
  async markProcessing(commandId, context) {
    const owner = attemptOwner(context);
    const now = context.now ? validDate(context.now) : new Date();
    const leaseMs = context.leaseMs ?? DEFAULT_LEASE_MS;
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 900_000
    ) {
      throw new TypeError('leaseMs must be between 1000 and 900000');
    }
    return this.database.transaction(async (/** @type {any} */ client) => {
      await recoverExpired(client, commandId, now);
      const row = (
        await client.query(
          `SELECT command.command_id, command.action, command.actor_kind,
                  command.automation_epoch, command.fingerprint,
                  command.status, command.retryable, command.retry_safe,
                  conversation.automation_state, conversation.automation_epoch
                    AS current_epoch,
                  conversation.terminal_at
           FROM crm.n8n_commands AS command
           JOIN crm.conversations AS conversation
             ON conversation.id = command.conversation_id
           WHERE command.command_id = $1
           FOR UPDATE OF command, conversation`,
          [commandId],
        )
      ).rows[0];
      if (!row || !isDeliverable(row) || !fenceAllows(row)) return false;
      if (context.payloadHash && context.payloadHash !== row.fingerprint) {
        return false;
      }
      const updated = await client.query(
        `UPDATE crm.n8n_commands
         SET status = 'processing', locked_by = $2, locked_until = $3,
             updated_at = $4, completed_at = NULL, last_error_code = NULL,
             retryable = NULL, retry_safe = NULL
         WHERE command_id = $1 AND status IN ('pending', 'failed')
         RETURNING command_id`,
        [commandId, owner, new Date(now.getTime() + leaseMs), now],
      );
      return updated.rows.length === 1;
    });
  }

  /** @param {string} commandId @param {Record<string, any>} context */
  markDelivered(commandId, context) {
    return this.#settle(commandId, 'sent', context);
  }

  /** @param {string} commandId @param {Record<string, any>} context */
  markFailed(commandId, context) {
    return this.#settle(commandId, 'failed', context);
  }

  /** @param {string} commandId @param {Record<string, any>} context */
  markOutcomeUnknown(commandId, context) {
    return this.#settle(commandId, 'outcome_unknown', {
      ...context,
      retryable: false,
      retrySafe: false,
    });
  }

  /** @param {string} commandId @param {'sent'|'failed'|'outcome_unknown'} status @param {Record<string, any>} context */
  async #settle(commandId, status, context) {
    technicalId(commandId, 'commandId');
    const now = context.now ? validDate(context.now) : new Date();
    const manual = typeof context.reconciledBy === 'string';
    const owner = manual ? null : attemptOwner(context);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await lockCommandConversation(client, commandId);
      const row = (
        await client.query(
          `SELECT command_id, conversation_id, message_id, status, locked_by
           FROM crm.n8n_commands WHERE command_id = $1 FOR UPDATE`,
          [commandId],
        )
      ).rows[0];
      if (!row) return false;
      if (row.status === status) return true;
      const allowed = manual
        ? row.status === 'outcome_unknown'
        : row.status === 'processing' && row.locked_by === owner;
      if (!allowed) return false;
      const externalMessageId = nullableTechnicalId(
        context.providerExternalId,
        'providerExternalId',
        512,
      );
      await client.query(
        `UPDATE crm.n8n_commands
         SET status = $2, locked_by = NULL, locked_until = NULL,
             external_message_id = COALESCE($3, external_message_id),
             last_error_code = $4, retryable = $5, retry_safe = $6,
             updated_at = $7, completed_at = $7
         WHERE command_id = $1`,
        [
          commandId,
          status,
          externalMessageId,
          status === 'sent' ? null : safeError(context.errorCode),
          status === 'failed' ? context.retryable === true : false,
          status === 'failed' ? context.retrySafe === true : false,
          now,
        ],
      );
      if (row.message_id) {
        const deliveryStatus =
          status === 'sent'
            ? 'sent'
            : status === 'outcome_unknown'
              ? 'outcome_unknown'
              : 'failed';
        await client.query(
          `UPDATE crm.messages
           SET external_message_id = COALESCE(external_message_id, $2),
               status = $3, delivery_status = $4, delivery_status_at = $5,
               sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(sent_at, $5)
                              ELSE sent_at END
           WHERE id = $1`,
          [
            row.message_id,
            externalMessageId,
            status === 'sent'
              ? 'sent'
              : status === 'outcome_unknown'
                ? 'outcome_unknown'
                : 'failed',
            deliveryStatus,
            now,
          ],
        );
        await appendMessageDeliveryEvent(
          client,
          row.conversation_id,
          commandId,
          now,
        );
      }
      if (status === 'outcome_unknown') {
        await insertReconciliation(client, commandId, now);
      }
      return true;
    });
  }
}

/** @param {{database: any, environment?: Record<string, unknown>, envelopeKey?: Buffer}} options */
export function createPostgresN8nCommandStore(options) {
  const envelopeKey =
    options?.envelopeKey ??
    decodeEnvironmentKey(options?.environment?.N8N_INTEGRATION_ENVELOPE_KEY);
  return new PostgresN8nCommandStore({
    database: options?.database,
    envelopeKey,
  });
}

/** @param {any} row */
function isDeliverable(row) {
  return (
    row.status === 'pending' ||
    (row.status === 'failed' && row.retryable && row.retry_safe)
  );
}

/** @param {any} row */
function fenceAllows(row) {
  if (Number(row.current_epoch) !== Number(row.automation_epoch)) return false;
  if (row.action === 'close') return row.terminal_at !== null;
  if (row.action === 'return_to_ai') {
    return row.terminal_at === null && row.automation_state === 'assistant';
  }
  if (row.action === 'send_message' && row.actor_kind === 'assistant') {
    return row.terminal_at === null && row.automation_state === 'assistant';
  }
  return row.terminal_at === null && row.automation_state === 'human';
}

/** @param {any} client @param {string} commandId @param {Date} now */
async function recoverExpired(client, commandId, now) {
  await lockCommandConversation(client, commandId);
  const expired = await client.query(
    `UPDATE crm.n8n_commands
     SET status = 'outcome_unknown', locked_by = NULL, locked_until = NULL,
         last_error_code = 'COMMAND_LEASE_EXPIRED', retryable = false,
         retry_safe = false, updated_at = $2, completed_at = $2
     WHERE command_id = $1 AND status = 'processing' AND locked_until <= $2
     RETURNING command_id, conversation_id, message_id`,
    [commandId, now],
  );
  const queueUnknown = await client.query(
    `UPDATE crm.n8n_commands AS command
     SET status = 'outcome_unknown', locked_by = NULL, locked_until = NULL,
         last_error_code = COALESCE(job.last_error_code, 'OUTCOME_UNKNOWN'),
         retryable = false, retry_safe = false, updated_at = job.updated_at,
         completed_at = job.completed_at
     FROM crm.outbox_jobs AS job
     WHERE command.command_id = $1
       AND job.n8n_command_id = command.command_id
       AND job.status = 'outcome_unknown'
       AND (command.status IN ('pending', 'processing')
         OR (command.status = 'failed' AND (command.retryable IS DISTINCT FROM false
           OR command.retry_safe IS DISTINCT FROM false)))
     RETURNING command.command_id, command.conversation_id, command.message_id`,
    [commandId],
  );
  if (expired.rows.length || queueUnknown.rows.length) {
    await insertReconciliation(client, commandId, now);
    for (const command of [...expired.rows, ...queueUnknown.rows]) {
      if (!command.message_id) continue;
      const message = await client.query(
        `UPDATE crm.messages
         SET status = 'outcome_unknown', delivery_status = 'outcome_unknown',
             delivery_status_at = $2
         WHERE id = $1 AND status IN ('queued', 'sending', 'failed')
         RETURNING id`,
        [command.message_id, now],
      );
      if (message.rows.length) {
        await appendMessageDeliveryEvent(
          client,
          command.conversation_id,
          command.command_id,
          now,
        );
      }
    }
  }
}

/**
 * A delivery status change invalidates the authorized Inbox read model. The
 * event contains only the conversation identifier; message content stays in
 * the encrypted message row. Callers lock the conversation before changing the
 * command, serializing event versions and matching the other message writers'
 * lock order.
 *
 * @param {any} client @param {string} conversationId @param {string} commandId @param {Date} now
 */
async function appendMessageDeliveryEvent(
  client,
  conversationId,
  commandId,
  now,
) {
  await client.query(
    `INSERT INTO crm.domain_events
       (id, aggregate_type, aggregate_id, aggregate_version, event_type,
        payload, correlation_id, occurred_at)
     SELECT $1, 'conversation', $2,
            COALESCE((SELECT max(existing.aggregate_version)
                      FROM crm.domain_events AS existing
                      WHERE existing.aggregate_type = 'conversation'
                        AND existing.aggregate_id = $2
                        AND existing.event_type = 'conversation.message_delivery_changed'), 0) + 1,
            'conversation.message_delivery_changed', $3::jsonb, $4, $5`,
    [
      `event-${randomUUID()}`,
      conversationId,
      JSON.stringify({ conversationId }),
      `n8n-command:${commandId}`,
      now,
    ],
  );
}

/** @param {any} client @param {string} commandId */
async function lockCommandConversation(client, commandId) {
  await client.query(
    `SELECT conversation.id
     FROM crm.conversations AS conversation
     JOIN crm.n8n_commands AS command
       ON command.conversation_id = conversation.id
     WHERE command.command_id = $1
     FOR UPDATE OF conversation`,
    [commandId],
  );
}

/** @param {any} client @param {string} commandId @param {Date} now */
async function insertReconciliation(client, commandId, now) {
  await client.query(
    `INSERT INTO crm.reconciliation_items
       (id, job_id, status, reason, created_at)
     SELECT gen_random_uuid()::text, job.id, 'open',
            'external_outcome_unknown', $2
     FROM crm.outbox_jobs AS job
     WHERE job.n8n_command_id = $1
     ON CONFLICT (job_id) DO NOTHING`,
    [commandId, now],
  );
}

/** @param {Record<string, any>} context */
function attemptOwner(context) {
  return technicalId(context?.attemptId ?? context?.workerId, 'attemptId', 128);
}

/** @param {unknown} value @param {string} field @param {number} [max] */
function technicalId(value, field, max = 128) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded technical identifier`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} max */
function nullableTechnicalId(value, field, max) {
  return value === undefined || value === null
    ? null
    : technicalId(value, field, max);
}

/** @param {unknown} value */
function safeError(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value)
    ? value
    : 'N8N_COMMAND_DELIVERY_FAILED';
}

/** @param {unknown} value */
function validDate(value) {
  const date =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime()))
    throw new TypeError('now must be valid');
  return date;
}

/** @param {unknown} value */
function decodeEnvironmentKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('N8N_INTEGRATION_ENVELOPE_KEY is required');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32) {
    throw new TypeError('N8N_INTEGRATION_ENVELOPE_KEY must decode to 32 bytes');
  }
  return decoded;
}
