import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { appendConversationStreamEvent } from '@crm-silmer/inbox-channels';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';

import { lockDashboardReader } from './dashboard-access.js';
import { LAST_MESSAGE_JOIN, sourceRevision } from './dashboard-runtime.js';

const CLOSED_STATES = ['encerrada', 'sem_lead', 'convertida_em_lead'];
const MAX_REMINDER_DAYS = 90;
/** Same shape as ACT-05: ISO local date-time with an explicit offset. */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:[0-5]\d)$/u;

export class ConversationReminderError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'ConversationReminderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value */
export function reminderIdempotencyKey(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ConversationReminderError(400, 'INVALID_IDEMPOTENCY_KEY');
  return value;
}

/** Wall-clock shape only; the future/90-day window is judged against the
 * server clock inside the command so a replay still answers identically.
 * @param {unknown} value */
function isoWithOffset(value) {
  if (
    typeof value !== 'string' ||
    !ISO_WITH_OFFSET.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
      value.slice(0, 10)
  )
    throw new ConversationReminderError(422, 'INVALID_REMINDER_DATE');
  return new Date(value);
}

/**
 * Strict body of `POST /conversations/:id/reminder` (INBOX-VEZ-01). Unknown or
 * missing keys are 400; a malformed or offset-less date is 422.
 * @param {unknown} body
 * @returns {{remindAt:string,expectedVersion:number}}
 */
export function parseConversationReminderCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ConversationReminderError(400, 'INVALID_REQUEST');
  const input = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes('remindAt') ||
    !keys.includes('expectedVersion')
  )
    throw new ConversationReminderError(400, 'INVALID_REQUEST');
  const expectedVersion = input.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)
    throw new ConversationReminderError(400, 'INVALID_REQUEST');
  return {
    remindAt: isoWithOffset(input.remindAt).toISOString(),
    expectedVersion: Number(expectedVersion),
  };
}

/** @param {any} database @param {{access:any,idempotencyEnvelopeKey:Buffer,clock?:()=>Date}} options */
export function createConversationReminderRuntime(database, options) {
  const clock = options.clock ?? (() => new Date());
  if (
    !Buffer.isBuffer(options.idempotencyEnvelopeKey) ||
    options.idempotencyEnvelopeKey.length !== 32
  )
    throw new TypeError('idempotency key must be a 32-byte Buffer');
  const envelopeKey = Buffer.from(options.idempotencyEnvelopeKey);
  return Object.freeze({
    /** @param {any} input */
    authorizeWrite: (input) => options.access.authorizeWrite(input),

    /** Personal reminder (D2): only the acting seller's decision row changes.
     * @param {{actor:any,conversationId:unknown,body:unknown,idempotencyKey:unknown,correlationId:string}} input */
    async set(input) {
      const command = parseConversationReminderCommand(input.body);
      const conversationId = input.conversationId;
      if (
        typeof conversationId !== 'string' ||
        !conversationId.trim() ||
        conversationId.length > 255 ||
        /[\u0000-\u001f\u007f]/u.test(conversationId)
      )
        throw new ConversationReminderError(400, 'INVALID_REQUEST');
      const key = reminderIdempotencyKey(input.idempotencyKey);
      const now = clock();
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockDashboardReader(
          client,
          input.actor,
          'conversation.transition',
        );
        const row = (
          await client.query(
            `SELECT c.*, last_message.* FROM crm.conversations c ${LAST_MESSAGE_JOIN}
             WHERE c.id = $1 FOR UPDATE OF c`,
            [conversationId],
          )
        ).rows[0];
        if (!row)
          throw new ConversationReminderError(404, 'CONVERSATION_NOT_FOUND');
        const bound = {
          query: client.query.bind(client),
          transaction: async (/** @type {any} */ work) => work(client),
        };
        return new PostgresIdempotencyRecordStore({
          database: bound,
          envelopeKey,
        }).execute(
          {
            scope: `conversation.reminder:${actor.id}`,
            key,
            fingerprint: fingerprintCommand({
              conversationId,
              remindAt: command.remindAt,
              expectedVersion: command.expectedVersion,
            }),
            actor: actor.id,
            action: 'conversation.reminder.set',
            target: { type: 'conversation', id: conversationId },
            version: String(command.expectedVersion),
            reason: 'INBOX_REMINDER_SET',
            correlationId: input.correlationId,
          },
          async () => {
            if (Number(row.version) !== command.expectedVersion)
              throw new ConversationReminderError(409, 'VERSION_CONFLICT');
            if (
              row.archived_at ||
              row.terminal_at ||
              CLOSED_STATES.includes(row.state)
            )
              throw new ConversationReminderError(409, 'ACTION_NOT_AVAILABLE');
            const at = Date.parse(command.remindAt);
            if (
              at <= now.getTime() ||
              at > now.getTime() + MAX_REMINDER_DAYS * 86_400_000
            )
              throw new ConversationReminderError(422, 'INVALID_REMINDER_DATE');
            const actionId = `conversation:${conversationId}`;
            const saved = (
              await client.query(
                `INSERT INTO crm.dashboard_action_decisions
                   (user_id,action_id,target_type,target_id,target_version,source_revision,decision,remind_at,version,created_at,updated_at)
                 VALUES ($1,$2,'conversation',$3,$4,$5,'schedule',$6,1,$7,$7)
                 ON CONFLICT (user_id,action_id) DO UPDATE SET target_type=EXCLUDED.target_type,
                   target_id=EXCLUDED.target_id,target_version=EXCLUDED.target_version,
                   source_revision=EXCLUDED.source_revision,decision='schedule',remind_at=EXCLUDED.remind_at,
                   version=dashboard_action_decisions.version+1,updated_at=EXCLUDED.updated_at
                 RETURNING version,remind_at`,
                [
                  actor.id,
                  actionId,
                  conversationId,
                  Number(row.version),
                  sourceRevision(row),
                  command.remindAt,
                  now.toISOString(),
                ],
              )
            ).rows[0];
            const decisionVersion = Number(saved.version);
            await new PostgresAuditTrail(client, { clock: () => now }).append({
              actor: actor.id,
              action: 'conversation.reminder.set',
              target: { type: 'conversation', id: conversationId },
              version: decisionVersion,
              reason: 'INBOX_REMINDER_SET',
              correlationId: input.correlationId,
            });
            await appendConversationStreamEvent(client, {
              conversationId,
              type: 'conversation.reminder_set',
              correlationId: input.correlationId,
              occurredAt: now.toISOString(),
            });
            return {
              conversationId,
              remindAt: new Date(saved.remind_at).toISOString(),
              decisionVersion,
            };
          },
        );
      });
    },
  });
}

/** @param {string|undefined} value */
function key(value) {
  const decoded = Buffer.from(value ?? '', 'base64');
  if (decoded.length !== 32)
    throw new Error('IDEMPOTENCY_ENVELOPE_KEY must decode to 32 bytes');
  return decoded;
}

/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date}} options */
export function createConversationReminderApiRuntime(database, options) {
  const environment = options.environment ?? process.env;
  return createConversationReminderRuntime(database, {
    access: options.access,
    clock: options.clock,
    idempotencyEnvelopeKey: key(environment.IDEMPOTENCY_ENVELOPE_KEY),
  });
}
