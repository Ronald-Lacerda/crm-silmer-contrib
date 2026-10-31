import { randomUUID } from 'node:crypto';

import { encryptJson } from './crypto.js';

/**
 * AGENTE-FAIL-01: how long a customer message may wait for the assistant
 * before the CRM hands the conversation to a seller.
 */
export const ASSISTANT_STALL_MINUTES = Object.freeze({
  default: 5,
  max: 60,
  min: 2,
});

/** The fixed summary the seller reads; it never carries customer text. */
export const STALL_HANDOFF_SUMMARY =
  'O assistente não respondeu a tempo. Confira a última mensagem do cliente.';

export const AUTOMATION_STALL_SWEEP_JOB = 'automation.stall.sweep';

const SWEEP_ACTOR = 'system:automation-stall-sweep';
const SLA_MINUTES = 240;
export const ASSISTANT_STALL_LOOKBACK_HOURS = 24;
/** A reply still `sending` after this long did not reach the customer. */
export const ASSISTANT_SENDING_GRACE_MINUTES = 2;

/**
 * `ASSISTANT_STALL_MINUTES`: absent means the default; an integer outside the
 * range is clamped to it; anything else refuses to start.
 *
 * @param {string|undefined} value
 */
export function readAssistantStallMinutes(value) {
  if (value === undefined || value.trim() === '') {
    return ASSISTANT_STALL_MINUTES.default;
  }
  if (!/^[0-9]{1,6}$/u.test(value.trim())) {
    throw Object.assign(new Error('ASSISTANT_STALL_MINUTES_INVALID'), {
      code: 'ASSISTANT_STALL_MINUTES_INVALID',
    });
  }
  return Math.min(
    ASSISTANT_STALL_MINUTES.max,
    Math.max(ASSISTANT_STALL_MINUTES.min, Number(value.trim())),
  );
}

/**
 * The stalled-conversation rule, shared by the sweep, its re-check under the
 * conversation lock and the Painel count. It follows the automation fence,
 * not the clock order of two rows: the assistant owns an open, unarchived
 * conversation without an open handoff, and its latest inbound revision
 *
 * - was never consumed by a turn (`inbound_revision > claimed_revision`), or
 * - was consumed by a reply that did not go out: `failed` or
 *   `outcome_unknown` (status or delivery), or still `sending` after
 *   `$3` (two minutes).
 *
 * The age is that of the customer's latest message (the CRM receive time),
 * older than `$1` and newer than `$2`. The lower bound (24 hours, the
 * WhatsApp service window) keeps the first run after deploy from flooding
 * the queue with long-dead cycles.
 */
const STALLED_CONVERSATIONS = `
  SELECT conversation.id, inbound.received_at
  FROM crm.conversations conversation
  JOIN LATERAL (
    SELECT max(message.created_at) received_at
    FROM crm.messages message
    WHERE message.conversation_id = conversation.id
      AND message.direction = 'inbound'
      AND message.inbound_revision = conversation.inbound_revision
  ) inbound ON true
  WHERE conversation.automation_state = 'assistant'
    AND conversation.terminal_at IS NULL
    AND conversation.archived_at IS NULL
    AND conversation.state NOT IN ('convertida_em_lead', 'sem_lead', 'encerrada')
    AND inbound.received_at IS NOT NULL
    AND inbound.received_at <= $1::timestamptz
    AND inbound.received_at > $2::timestamptz
    AND (
      conversation.inbound_revision > conversation.claimed_revision
      OR NOT EXISTS (
        SELECT 1
        FROM crm.n8n_events reservation
        JOIN crm.messages reply
          ON reply.id = reservation.message_id
         AND reply.conversation_id = conversation.id
        WHERE reservation.conversation_id = conversation.id
          AND reservation.event_type = 'message.send.requested'
          AND reservation.source_revision = conversation.inbound_revision
          AND reply.direction = 'outbound'
          AND reply.author_kind = 'assistant'
          AND reply.status NOT IN ('failed', 'outcome_unknown')
          AND (reply.delivery_status IS NULL
            OR reply.delivery_status NOT IN ('failed', 'outcome_unknown'))
          AND NOT (reply.status = 'sending'
            AND reply.created_at <= $3::timestamptz)))
    AND NOT EXISTS (
      SELECT 1 FROM crm.handoffs open_handoff
      WHERE open_handoff.conversation_id = conversation.id
        AND open_handoff.status IN ('pending', 'accepted'))`;

/**
 * AGENTE-FAIL-01: finds conversations the assistant left without an answer
 * and hands each one to a seller in its own transaction, under the
 * conversation lock: an unassigned handoff `automation_failure`, the
 * conversation in `requer_atencao` with the human, and `automation_epoch + 1`
 * so a late assistant reply fails its fence. The CRM never messages the
 * customer itself. Idempotent: a conversation with an open handoff is no
 * longer a candidate.
 */
export class PostgresAutomationStallSweeper {
  /**
   * @param {{
   *   database: {query: Function, transaction: <T>(work: (client: any) => Promise<T>) => Promise<T>},
   *   envelopeKey: Buffer,
   *   stallMinutes?: number,
   *   clock?: () => Date,
   *   idFactory?: (kind: string) => string,
   *   batchSize?: number,
   * }} options
   */
  constructor({
    database,
    envelopeKey,
    stallMinutes = ASSISTANT_STALL_MINUTES.default,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    batchSize = 50,
  }) {
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
    if (
      !Number.isSafeInteger(stallMinutes) ||
      stallMinutes < ASSISTANT_STALL_MINUTES.min ||
      stallMinutes > ASSISTANT_STALL_MINUTES.max
    ) {
      throw new TypeError('stallMinutes must be between 2 and 60');
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new TypeError('batchSize must be between 1 and 500');
    }
    this.database = database;
    this.envelopeKey = Buffer.from(envelopeKey);
    this.stallMinutes = stallMinutes;
    this.clock = clock;
    this.idFactory = idFactory;
    this.batchSize = batchSize;
  }

  /**
   * One failing conversation (a lock timeout, say) never aborts the batch:
   * its bounded error code is kept and the sweep goes on.
   *
   * @returns {Promise<{candidates: number, handedOff: number, failed: number, errorCodes: readonly string[]}>}
   */
  async sweep() {
    const now = validNow(this.clock);
    const window = stallWindow(now, this.stallMinutes);
    const candidates = (
      await this.database.query(
        `${STALLED_CONVERSATIONS}
         ORDER BY inbound.received_at, conversation.id
         LIMIT $4`,
        [...windowValues(window), this.batchSize],
      )
    ).rows;
    let handedOff = 0;
    /** @type {string[]} */
    const errorCodes = [];
    for (const candidate of candidates) {
      try {
        if (await this.#handOff(candidate.id, window, now)) {
          handedOff += 1;
        }
      } catch (error) {
        errorCodes.push(boundedErrorCode(error));
      }
    }
    return Object.freeze({
      candidates: candidates.length,
      errorCodes: Object.freeze(errorCodes),
      failed: errorCodes.length,
      handedOff,
    });
  }

  /** @param {string} conversationId @param {StallWindow} window @param {Date} now */
  async #handOff(conversationId, window, now) {
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout = '1500ms'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const locked = (
          await client.query(
            'SELECT id FROM crm.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          )
        ).rows[0];
        if (!locked) return false;
        // Re-checked under the lock: a reply or handoff that committed while
        // this sweep waited wins, and nothing is written.
        const still = (
          await client.query(
            `${STALLED_CONVERSATIONS} AND conversation.id = $4`,
            [...windowValues(window), conversationId],
          )
        ).rows[0];
        if (!still) return false;
        const at = now.toISOString();
        const conversation = (
          await client.query(
            `UPDATE crm.conversations
             SET automation_state = 'human',
                 automation_epoch = automation_epoch + 1,
                 claimed_revision = inbound_revision,
                 state = 'requer_atencao', assigned_user_id = NULL,
                 version = version + 1
             WHERE id = $1 AND automation_state = 'assistant'
               AND terminal_at IS NULL
             RETURNING id, automation_epoch, version`,
            [conversationId],
          )
        ).rows[0];
        if (!conversation) return false;
        const handoffId = this.idFactory('handoff');
        const correlationId = `automation-stall:${conversationId}:${conversation.automation_epoch}`;
        const dueAt = new Date(
          now.getTime() + SLA_MINUTES * 60_000,
        ).toISOString();
        await client.query(
          `INSERT INTO crm.handoffs
             (id, deal_id, conversation_id, assigned_user_id, target_role,
              status, version, reason_code, summary_envelope, due_at,
              sla_minutes, sla_policy_version, created_at, updated_at)
           VALUES ($1, NULL, $2, NULL, 'Vendedor', 'pending', 1,
                   'automation_failure', $3::jsonb, $4, $5, 'n8n-mvp-1',
                   $6, $6)`,
          [
            handoffId,
            conversationId,
            JSON.stringify(
              encryptJson(
                STALL_HANDOFF_SUMMARY,
                `${conversationId}:handoff:summary`,
                this.envelopeKey,
              ),
            ),
            dueAt,
            SLA_MINUTES,
            at,
          ],
        );
        await client.query(
          `INSERT INTO crm.handoff_history
             (handoff_id, resulting_version, from_status, to_status,
              assigned_user_id, target_role, actor_id, reason_code,
              correlation_id, occurred_at)
           VALUES ($1, 1, NULL, 'pending', NULL, 'Vendedor', $2,
                   'automation_failure', $3, $4)`,
          [handoffId, SWEEP_ACTOR, correlationId, at],
        );
        await client.query(
          `INSERT INTO crm.audit_events
             (id, actor_id, action, target_type, target_id, version, reason,
              correlation_id, occurred_at)
           VALUES ($1, $2, 'automation.stall.handoff_created', 'conversation',
                   $3, $4, 'ASSISTANT_STALLED', $5, $6)`,
          [
            this.idFactory('audit'),
            SWEEP_ACTOR,
            conversationId,
            String(conversation.version),
            correlationId,
            at,
          ],
        );
        // The Inbox SSE topic follows crm.domain_events (see the n8n
        // repository): open panels learn about the handoff right away.
        await client.query(
          `INSERT INTO crm.domain_events
             (id, aggregate_type, aggregate_id, aggregate_version, event_type,
              payload, correlation_id, occurred_at)
           SELECT $1, 'conversation', $2,
                  COALESCE((SELECT max(existing.aggregate_version)
                            FROM crm.domain_events existing
                            WHERE existing.aggregate_type = 'conversation'
                              AND existing.aggregate_id = $2
                              AND existing.event_type = $3), 0) + 1,
                  $3, $4::jsonb, $5, $6`,
          [
            this.idFactory('event'),
            conversationId,
            'conversation.automation_stalled',
            JSON.stringify({ conversationId }),
            correlationId,
            at,
          ],
        );
        return true;
      });
    } catch (error) {
      // Another path opened a handoff for this conversation concurrently.
      if (/** @type {any} */ (error)?.code === '23505') return false;
      throw error;
    }
  }
}

/**
 * Executable boundary used by the worker: the integration key seals the
 * summary exactly as the n8n handoff does, so the Inbox reads both alike.
 *
 * @param {{database: any, environment?: Record<string, string|undefined>, clock?: () => Date}} options
 */
export function createPostgresAutomationStallSweeper(options) {
  const environment = options?.environment ?? process.env;
  const raw = environment.N8N_INTEGRATION_ENVELOPE_KEY;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new TypeError('N8N_INTEGRATION_ENVELOPE_KEY must use base64url');
  }
  return new PostgresAutomationStallSweeper({
    clock: options.clock,
    database: options.database,
    envelopeKey: Buffer.from(raw, 'base64url'),
    stallMinutes: readAssistantStallMinutes(
      environment.ASSISTANT_STALL_MINUTES,
    ),
  });
}

/**
 * The count the Painel shows as "stalled now" uses the same rule.
 *
 * @param {{query: Function}} database @param {Date} now @param {number} stallMinutes
 */
export async function countStalledConversations(database, now, stallMinutes) {
  const window = stallWindow(now, stallMinutes);
  const row = (
    await database.query(
      `SELECT count(*)::integer AS total FROM (${STALLED_CONVERSATIONS}) stalled`,
      windowValues(window),
    )
  ).rows[0];
  return Number(row?.total ?? 0);
}

/**
 * @typedef {{before: string, after: string, sendingBefore: string}} StallWindow
 * @param {Date} now @param {number} stallMinutes
 * @returns {StallWindow}
 */
function stallWindow(now, stallMinutes) {
  return {
    after: new Date(
      now.getTime() - ASSISTANT_STALL_LOOKBACK_HOURS * 60 * 60_000,
    ).toISOString(),
    before: new Date(now.getTime() - stallMinutes * 60_000).toISOString(),
    sendingBefore: new Date(
      now.getTime() - ASSISTANT_SENDING_GRACE_MINUTES * 60_000,
    ).toISOString(),
  };
}

/** @param {StallWindow} window */
function windowValues(window) {
  return [window.before, window.after, window.sendingBefore];
}

/** @param {unknown} error */
function boundedErrorCode(error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'STALL_HANDOFF_FAILED';
}

/** @param {() => Date} clock */
function validNow(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('clock must return a valid Date');
  }
  return now;
}
