import { createHmac, randomUUID } from 'node:crypto';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { appendConversationStreamEvent } from '@crm-silmer/inbox-channels';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import { decryptJson, encryptJson } from '@crm-silmer/n8n-integration';

import { lockDashboardReader } from './dashboard-access.js';
import { LEAD_LOSS_REASONS } from './dashboard-metrics-runtime.js';
import { EFFECTIVE_HUMAN_SEND } from './lead-outcome-sql.js';

/** MET-06: the `outro` note, after trimming, in Unicode characters. */
export const LEAD_NOTE_MAX_LENGTH = 140;
const TERMINAL_STATES = ['encerrada', 'sem_lead', 'convertida_em_lead'];
/** Control, format (bidi, zero-width), private use, unassigned, lone
 * surrogate and line/paragraph separators: none of them is readable text. */
const FORBIDDEN_NOTE_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

/** At least one letter or digit: punctuation or symbols alone say nothing. */
const READABLE_NOTE = /[\p{L}\p{N}]/u;

export class LeadOutcomeError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'LeadOutcomeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** @param {unknown} value @param {number} minimum */
function version(value, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new LeadOutcomeError(400, 'INVALID_REQUEST');
  return Number(value);
}

/** @param {unknown} value @param {string} code */
function identifier(value, code) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new LeadOutcomeError(400, code);
  return value;
}

/**
 * Strict body of `POST /conversations/:id/lead-outcome` (MET-06). Unknown
 * keys, a forged actor and a note outside `outro` are refused; the reason
 * list is closed and the `outro` note is 1–140 characters without controls.
 * @param {unknown} body
 * @returns {{outcome:'lost'|'reopened',reasonCode:string|null,note:string|null,expectedConversationVersion:number,expectedOutcomeVersion:number}}
 */
export function parseLeadOutcomeCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new LeadOutcomeError(400, 'INVALID_REQUEST');
  const input = /** @type {Record<string, unknown>} */ (body);
  if (input.outcome !== 'lost' && input.outcome !== 'reopened')
    throw new LeadOutcomeError(400, 'INVALID_REQUEST');
  const lost = input.outcome === 'lost';
  const allowed = lost
    ? [
        'outcome',
        'reasonCode',
        'note',
        'expectedConversationVersion',
        'expectedOutcomeVersion',
      ]
    : ['outcome', 'expectedConversationVersion', 'expectedOutcomeVersion'];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new LeadOutcomeError(400, 'INVALID_REQUEST');
  const expectedConversationVersion = version(
    input.expectedConversationVersion,
    1,
  );
  const expectedOutcomeVersion = version(
    input.expectedOutcomeVersion,
    lost ? 0 : 1,
  );
  if (!lost)
    return {
      outcome: 'reopened',
      reasonCode: null,
      note: null,
      expectedConversationVersion,
      expectedOutcomeVersion,
    };
  const reasonCode = input.reasonCode;
  if (typeof reasonCode !== 'string' || !LEAD_LOSS_REASONS.includes(reasonCode))
    throw new LeadOutcomeError(422, 'INVALID_LOSS_REASON');
  if (reasonCode !== 'outro') {
    if (Object.hasOwn(input, 'note'))
      throw new LeadOutcomeError(400, 'INVALID_REQUEST');
    return {
      outcome: 'lost',
      reasonCode,
      note: null,
      expectedConversationVersion,
      expectedOutcomeVersion,
    };
  }
  if (typeof input.note !== 'string')
    throw new LeadOutcomeError(422, 'INVALID_LOSS_NOTE');
  // NFC first, so the length and the stored text are the canonical form.
  const note = input.note.normalize('NFC').trim();
  const length = [...note].length;
  if (
    length < 1 ||
    length > LEAD_NOTE_MAX_LENGTH ||
    FORBIDDEN_NOTE_CHARACTERS.test(note) ||
    !READABLE_NOTE.test(note)
  )
    throw new LeadOutcomeError(422, 'INVALID_LOSS_NOTE');
  return {
    outcome: 'lost',
    reasonCode,
    note,
    expectedConversationVersion,
    expectedOutcomeVersion,
  };
}

/** @param {unknown} value */
export function leadIdempotencyKey(value) {
  return identifier(value, 'INVALID_IDEMPOTENCY_KEY');
}

/** @param {string} eventId */
const noteAad = (eventId) => `lead-outcome-note:${eventId}`;

/** @param {Date|string|null|undefined} value */
function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

/** MET-07: derived state; the inbound path never writes an outcome.
 * @param {any} latest @param {string|null} lastInboundId */
function deriveState(latest, lastInboundId) {
  if (!latest) return 'open';
  if (latest.outcome === 'reopened') return 'reopened_manual';
  return (latest.last_inbound_message_id ?? null) === (lastInboundId ?? null)
    ? 'lost'
    : 'reopened_by_customer';
}

/** @param {any} client @param {string} conversationId */
async function lastCustomerMessage(client, conversationId) {
  return (
    (
      await client.query(
        `SELECT id, occurred_at FROM crm.messages
         WHERE conversation_id = $1 AND direction = 'inbound' AND author_kind = 'contact'
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [conversationId],
      )
    ).rows[0] ?? null
  );
}

/** @param {any} client @param {string} conversationId @param {number} limit */
async function latestEvents(client, conversationId, limit) {
  return (
    await client.query(
      `SELECT id, version, outcome, reason_code, note_envelope, owner_id, actor_id,
              last_inbound_message_id, occurred_at
       FROM crm.lead_outcome_events WHERE conversation_id = $1
       ORDER BY version DESC LIMIT $2`,
      [conversationId, limit],
    )
  ).rows;
}

/** @param {any} database @param {{access:any,noteEnvelopeKey:Buffer,idempotencyEnvelopeKey:Buffer,clock?:()=>Date,idFactory?:()=>string}} options */
export function createLeadOutcomeRuntime(database, options) {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `lead-outcome-${randomUUID()}`);
  for (const key of [options.noteEnvelopeKey, options.idempotencyEnvelopeKey])
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new TypeError('lead outcome keys must be 32-byte Buffers');
  const noteKey = Buffer.from(options.noteEnvelopeKey);
  const idempotencyKey = Buffer.from(options.idempotencyEnvelopeKey);
  /** The idempotency fingerprint carries a keyed digest of the note, never
   * the note or a plain hash a short text could be guessed from.
   * @param {string|null} note */
  const noteDigest = (note) =>
    note === null
      ? null
      : createHmac('sha256', idempotencyKey)
          .update(`lead-outcome-note:${note}`, 'utf8')
          .digest('hex');
  return Object.freeze({
    /** @param {any} input */
    authorizeRead: (input) => options.access.authorizeRead(input),
    /** @param {any} input */
    authorizeWrite: (input) => options.access.authorizeWrite(input),

    /** MET-06/07: declare a lead lost, or correct a loss by reopening it.
     * @param {{actor:any,conversationId:unknown,body:unknown,idempotencyKey:unknown,correlationId:string}} input */
    async record(input) {
      const command = parseLeadOutcomeCommand(input.body);
      const conversationId = identifier(
        input.conversationId,
        'INVALID_REQUEST',
      );
      const key = leadIdempotencyKey(input.idempotencyKey);
      const now = clock();
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await lockDashboardReader(
          client,
          input.actor,
          'conversation.transition',
        );
        // The conversation lock serializes every outcome command of the
        // conversation; the (conversation_id, version) key is the last fence.
        const conversation = (
          await client.query(
            `SELECT id, version, assigned_user_id, automation_state, state, terminal_at
             FROM crm.conversations WHERE id = $1 FOR UPDATE`,
            [conversationId],
          )
        ).rows[0];
        // A seller cannot tell a missing conversation from someone else's:
        // both are 403. Only an administrator learns that it does not exist.
        if (!conversation && actor.scope !== 'team')
          throw new LeadOutcomeError(403, 'FORBIDDEN');
        if (!conversation)
          throw new LeadOutcomeError(404, 'CONVERSATION_NOT_FOUND');
        if (
          actor.scope !== 'team' &&
          conversation.assigned_user_id !== actor.id
        )
          throw new LeadOutcomeError(403, 'FORBIDDEN');
        const bound = {
          query: client.query.bind(client),
          transaction: async (/** @type {any} */ work) => work(client),
        };
        const reason =
          command.outcome === 'lost'
            ? `LEAD_LOST_${String(command.reasonCode).toUpperCase()}`
            : 'LEAD_REOPENED';
        return new PostgresIdempotencyRecordStore({
          database: bound,
          envelopeKey: idempotencyKey,
        }).execute(
          {
            scope: `lead.outcome:${actor.id}`,
            key,
            fingerprint: fingerprintCommand({
              conversationId,
              outcome: command.outcome,
              reasonCode: command.reasonCode,
              noteDigest: noteDigest(command.note),
              expectedConversationVersion: command.expectedConversationVersion,
              expectedOutcomeVersion: command.expectedOutcomeVersion,
            }),
            actor: actor.id,
            action: 'lead.outcome.record',
            target: { type: 'conversation', id: conversationId },
            version: `${command.expectedConversationVersion}:${command.expectedOutcomeVersion}`,
            reason,
            correlationId: input.correlationId,
          },
          async () => {
            if (
              Number(conversation.version) !==
              command.expectedConversationVersion
            )
              throw new LeadOutcomeError(409, 'VERSION_CONFLICT');
            if (
              !conversation.assigned_user_id ||
              conversation.automation_state !== 'human' ||
              conversation.terminal_at ||
              TERMINAL_STATES.includes(conversation.state)
            )
              throw new LeadOutcomeError(409, 'LEAD_NOT_ELIGIBLE');
            const [latest] = await latestEvents(client, conversationId, 1);
            const lastInbound = await lastCustomerMessage(
              client,
              conversationId,
            );
            if (Number(latest?.version ?? 0) !== command.expectedOutcomeVersion)
              throw new LeadOutcomeError(409, 'VERSION_CONFLICT');
            const state = deriveState(latest, lastInbound?.id ?? null);
            if (command.outcome === 'reopened') {
              if (state !== 'lost')
                throw new LeadOutcomeError(409, 'LEAD_NOT_LOST');
            } else {
              if (state === 'lost')
                throw new LeadOutcomeError(409, 'LEAD_ALREADY_LOST');
              const blocked = (
                await client.query(
                  `SELECT
                     EXISTS (SELECT 1 FROM crm.orders o WHERE o.conversation_id = $1
                             AND o.status IN ('pendente','confirmado')) AS has_order,
                     $2::timestamptz IS NOT NULL AND NOT EXISTS (
                       SELECT 1 FROM crm.messages r WHERE r.conversation_id = $1
                         AND ${EFFECTIVE_HUMAN_SEND('r')}
                         AND coalesce(r.sent_at, r.occurred_at) > $2::timestamptz
                     ) AS awaiting_reply`,
                  [conversationId, lastInbound?.occurred_at ?? null],
                )
              ).rows[0];
              if (blocked.has_order)
                throw new LeadOutcomeError(409, 'LEAD_HAS_ORDER');
              // ACT-06: a customer who is waiting never leaves the queue; the
              // seller answers before declaring the loss.
              if (blocked.awaiting_reply)
                throw new LeadOutcomeError(409, 'LEAD_AWAITING_REPLY');
            }
            const eventId = idFactory();
            const outcomeVersion = command.expectedOutcomeVersion + 1;
            const envelope =
              command.note === null
                ? null
                : encryptJson(command.note, noteAad(eventId), noteKey);
            await client.query(
              `INSERT INTO crm.lead_outcome_events
                 (id, conversation_id, version, outcome, reason_code, note_envelope,
                  owner_id, actor_id, last_inbound_message_id, correlation_id, occurred_at)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
              [
                eventId,
                conversationId,
                outcomeVersion,
                command.outcome,
                command.reasonCode,
                envelope === null ? null : JSON.stringify(envelope),
                conversation.assigned_user_id,
                actor.id,
                command.outcome === 'lost' ? (lastInbound?.id ?? null) : null,
                input.correlationId,
                now.toISOString(),
              ],
            );
            await new PostgresAuditTrail(client, { clock: () => now }).append({
              actor: actor.id,
              action: 'lead.outcome.recorded',
              target: { type: 'conversation', id: conversationId },
              version: outcomeVersion,
              reason,
              correlationId: input.correlationId,
            });
            // INBOX-VEZ-01: open panels re-read the bucket; ids only.
            await appendConversationStreamEvent(client, {
              conversationId,
              type: 'conversation.lead_outcome_recorded',
              correlationId: input.correlationId,
              occurredAt: now.toISOString(),
            });
            return {
              conversationId,
              outcome: command.outcome,
              outcomeVersion,
              reasonCode: command.reasonCode,
              hasNote: command.note !== null,
              ownerId: conversation.assigned_user_id,
              markedBy: actor.id,
              markedAt: now.toISOString(),
            };
          },
        );
      });
    },

    /** The only read that returns the `outro` note: to the current owner or
     * an administrator.
     * @param {{actor:any,conversationId:unknown}} input */
    async detail(input) {
      const conversationId = identifier(
        input.conversationId,
        'INVALID_REQUEST',
      );
      return database.transaction(async (/** @type {any} */ client) => {
        const reader = await lockDashboardReader(client, input.actor);
        const conversation = (
          await client.query(
            'SELECT id, assigned_user_id FROM crm.conversations WHERE id = $1',
            [conversationId],
          )
        ).rows[0];
        if (!conversation && reader.scope !== 'team')
          throw new LeadOutcomeError(403, 'FORBIDDEN');
        if (!conversation)
          throw new LeadOutcomeError(404, 'CONVERSATION_NOT_FOUND');
        if (
          reader.scope !== 'team' &&
          conversation.assigned_user_id !== reader.id
        )
          throw new LeadOutcomeError(403, 'FORBIDDEN');
        const [latest, previous] = await latestEvents(
          client,
          conversationId,
          2,
        );
        const lastInbound = await lastCustomerMessage(client, conversationId);
        const state = deriveState(latest, lastInbound?.id ?? null);
        if (!latest)
          return {
            state,
            outcomeVersion: 0,
            reasonCode: null,
            ownerId: null,
            markedBy: null,
            markedAt: null,
            reopenedAt: null,
          };
        // A manual reopening describes the loss it corrected.
        const loss = latest.outcome === 'reopened' ? previous : latest;
        let reopenedAt = null;
        if (state === 'reopened_manual') reopenedAt = iso(latest.occurred_at);
        if (state === 'reopened_by_customer')
          reopenedAt = iso(
            (
              await client.query(
                `SELECT customer.occurred_at FROM crm.messages customer
                 WHERE customer.conversation_id = $1
                   AND customer.direction = 'inbound' AND customer.author_kind = 'contact'
                   AND ($2::text IS NULL OR (customer.occurred_at, customer.id) >
                        (SELECT marked.occurred_at, marked.id FROM crm.messages marked
                         WHERE marked.id = $2))
                 ORDER BY customer.occurred_at, customer.id LIMIT 1`,
                [conversationId, latest.last_inbound_message_id],
              )
            ).rows[0]?.occurred_at,
          );
        return {
          state,
          outcomeVersion: Number(latest.version),
          reasonCode: loss?.reason_code ?? null,
          ...(loss?.note_envelope
            ? {
                note: String(
                  decryptJson(loss.note_envelope, noteAad(loss.id), noteKey),
                ),
              }
            : {}),
          ownerId: loss?.owner_id ?? null,
          markedBy: loss?.actor_id ?? null,
          markedAt: iso(loss?.occurred_at),
          reopenedAt,
        };
      });
    },
  });
}

/** @param {string|undefined} value @param {string} name */
function key(value, name) {
  const decoded = Buffer.from(value ?? '', 'base64');
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return decoded;
}

/** The note shares the ficha's AES-256-GCM envelope and key; the AAD binds it
 * to its event, so a ciphertext copied onto another event fails.
 * @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date}} options */
export function createLeadOutcomeApiRuntime(database, options) {
  const environment = options.environment ?? process.env;
  return createLeadOutcomeRuntime(database, {
    access: options.access,
    clock: options.clock,
    noteEnvelopeKey: key(
      environment.N8N_INTEGRATION_ENVELOPE_KEY,
      'N8N_INTEGRATION_ENVELOPE_KEY',
    ),
    idempotencyEnvelopeKey: key(
      environment.IDEMPOTENCY_ENVELOPE_KEY,
      'IDEMPOTENCY_ENVELOPE_KEY',
    ),
  });
}
