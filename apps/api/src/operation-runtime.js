import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { PostgresIdempotencyRecordStore } from '@crm-silmer/integration-reliability';
import {
  CONTACT_REGISTRATION_FIELDS,
  PostalCodeLookupError,
  PostgresContactReadRepository,
  ViaCepPostalCodeClient,
  contactPhoneHash,
  decryptContactIdentityEnvelope,
  decryptContactDetails,
  encryptContactDetails,
  encryptContactRegistration,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactRegistration,
} from '@crm-silmer/contacts';
import { CAPABILITIES } from '@crm-silmer/identity-access';
import {
  INBOX_BUCKETS,
  PostgresInboxReadRepository,
} from '@crm-silmer/inbox-channels';
import {
  ASSISTANT_STALL_MINUTES as ASSISTANT_STALL_RANGE,
  AUTOMATION_MESSAGE_CAP,
  countStalledConversations,
  readAssistantStallMinutes,
} from '@crm-silmer/n8n-integration';
import { PostgresHandoffReadRepository } from '@crm-silmer/work-management';

const DISPLAY_NAME_MAX_LENGTH = 120;

const CONVERSATION_STATES = new Set([
  'nova',
  'em_analise',
  'em_atendimento',
  'requer_atencao',
  'convertida_em_lead',
  'sem_lead',
  'encerrada',
]);
const CHANNELS = new Set(['instagram', 'whatsapp', 'site_chat']);
const AUTOMATION_STATES = new Set(['assistant', 'human']);
// Painel: a client message the assistant left unanswered this long counts as
// a stalled conversation in the assistant's health. AGENTE-FAIL-01: the same
// `ASSISTANT_STALL_MINUTES` the worker sweep uses (default 5), so the Painel
// card and the sweep never disagree.
export const ASSISTANT_STALL_MINUTES = ASSISTANT_STALL_RANGE.default;
// PNL-06: a seller's conversation whose last message is the client's and is
// this old is "sem resposta" in the manager's "Atendimento agora".
export const SELLER_UNANSWERED_MINUTES = 15;

export class OperationReadError extends Error {
  /** @param {number} statusCode @param {string} code @param {string} [field] */
  constructor(statusCode, code, field) {
    super(code);
    this.name = 'OperationReadError';
    this.code = code;
    this.statusCode = statusCode;
    // Only a form field name (never its value) may accompany the code.
    if (field !== undefined) this.field = field;
  }
}

// AGENTE-OBS-01: the "Desempenho do Vendedor" window, in days.
export const ASSISTANT_PERFORMANCE_DAYS = Object.freeze({
  default: 7,
  max: 90,
  min: 1,
});

/** @param {{clock?: () => Date, contactRepository: any, cursorKey: Buffer, database?: any, handoffRepository: any, inboxRepository: any, countStalled?: ((now: Date) => Promise<number>) | null, assistantMessageCap?: number, stallMinutes?: number}} dependencies */
export function createOperationReadService({
  clock = () => new Date(),
  contactRepository,
  cursorKey,
  database,
  handoffRepository,
  inboxRepository,
  countStalled = null,
  assistantMessageCap = AUTOMATION_MESSAGE_CAP,
  stallMinutes = ASSISTANT_STALL_MINUTES,
}) {
  if (!contactRepository || typeof contactRepository !== 'object') {
    throw new TypeError('contactRepository is required');
  }
  if (!inboxRepository || typeof inboxRepository !== 'object') {
    throw new TypeError('inboxRepository is required');
  }
  if (!handoffRepository || typeof handoffRepository !== 'object') {
    throw new TypeError('handoffRepository is required');
  }
  if (!Buffer.isBuffer(cursorKey) || cursorKey.length < 32) {
    throw new TypeError('cursorKey must contain at least 32 bytes');
  }

  /** @param {{actorId?: string}} access */
  const readerFor = (access) => ({
    actorId: access?.actorId ?? null,
    now: clock(),
    stallMinutes,
  });

  return Object.freeze({
    /**
     * Painel: the reader's queue, the handoffs past their SLA and the
     * assistant's health, all worked out on the server clock. PNL-06: the
     * per-seller "sem resposta" breakdown names team members, so it is read
     * only for a COMMERCIAL_ADMIN reader; anyone else gets `unanswered:
     * null` and the query never runs.
     *
     * @param {{actorId: string, capabilities?: readonly string[]}} input
     */
    async summarizeInbox(input) {
      const now = clock();
      const manager =
        Array.isArray(input?.capabilities) &&
        input.capabilities.includes(CAPABILITIES.COMMERCIAL_ADMIN);
      const read = await inboxRepository.summary({
        actorId: requireId(input?.actorId, 'ACTOR_ID'),
        now,
        stallMinutes,
        unansweredMinutes: manager ? SELLER_UNANSWERED_MINUTES : null,
      });
      const summary = Object.freeze({
        ...read,
        unanswered: manager ? (read.unanswered ?? null) : null,
      });
      if (!countStalled) return summary;
      // The sweep's own rule (revision fence and failed replies).
      return Object.freeze({
        ...summary,
        assistant: Object.freeze({
          ...summary.assistant,
          stalledCount: await countStalled(now),
        }),
      });
    },
    /**
     * AGENTE-OBS-01: aggregates of the assistant over the last `days`, on
     * the server clock. Counts, ratios and minutes only.
     *
     * @param {{days?: unknown}} [input]
     */
    async assistantPerformance(input = {}) {
      rejectUnknownKeys(input, ['days']);
      const days =
        input.days === undefined
          ? ASSISTANT_PERFORMANCE_DAYS.default
          : Number(input.days);
      if (
        !Number.isSafeInteger(days) ||
        days < ASSISTANT_PERFORMANCE_DAYS.min ||
        days > ASSISTANT_PERFORMANCE_DAYS.max
      ) {
        throw new OperationReadError(400, 'INVALID_DAYS');
      }
      const to = clock();
      const from = new Date(to.getTime() - days * 24 * 60 * 60_000);
      const aggregates = await inboxRepository.assistantPerformance({
        from,
        to,
      });
      return Object.freeze({
        window: Object.freeze({
          days,
          from: from.toISOString(),
          to: to.toISOString(),
        }),
        ...aggregates,
        stalled_now: countStalled ? await countStalled(to) : 0,
      });
    },
    /**
     * AGENTE-OBS-01: the assistant's last turn on one conversation and how
     * much of its message budget it used.
     *
     * @param {any} input
     */
    async getAssistantContext(input) {
      const context = await inboxRepository.assistantContext(
        requireId(input?.conversationId, 'CONVERSATION_ID'),
      );
      return Object.freeze({
        last_turn: context.lastTurn,
        assistant_messages: context.assistantMessages,
        assistant_message_cap: assistantMessageCap,
      });
    },
    /** @param {any} input */
    async getContact(input) {
      return contactRepository.get(requireId(input?.contactId, 'CONTACT_ID'));
    },
    /**
     * INBOX-VEZ-01: the detail carries the turn fields, worked out for the
     * session's reader on the server clock.
     * @param {any} input @param {{actorId?: string}} [access]
     */
    async getConversation(input, access = {}) {
      return inboxRepository.get(
        requireId(input?.conversationId, 'CONVERSATION_ID'),
        readerFor(access),
      );
    },
    /**
     * INBOX-VEZ-01: the four tab counts in one snapshot. Same `owner`,
     * `orderReady` and `assignedUserId` rules as the list.
     * @param {any} input @param {{actorId?: string}} [access]
     */
    async countInboxBuckets(input = {}, access = {}) {
      rejectUnknownKeys(input, ['assignedUserId', 'orderReady', 'owner']);
      const owner = readOwner(input);
      if (input.assignedUserId !== undefined && owner !== 'all') {
        throw new OperationReadError(400, 'INVALID_FILTER');
      }
      const filters = /** @type {Record<string, any>} */ ({
        actorId: requireId(access.actorId, 'ACTOR_ID'),
        owner,
        orderReady:
          input.orderReady === undefined
            ? false
            : readBooleanFilter(input.orderReady),
      });
      if (input.assignedUserId !== undefined) {
        filters.assignedUserId = requireId(
          input.assignedUserId,
          'ASSIGNED_USER_ID',
        );
      }
      return inboxRepository.bucketCounts(filters, readerFor(access));
    },
    /**
     * INBOX-HANDOFF-01 / AGT-03: the open handoff's summary, read apart from
     * the conversation so only `handoff.read` decrypts it.
     *
     * @param {any} input
     */
    async getConversationHandoff(input) {
      const open = await handoffRepository.getOpenForConversation(
        requireId(input?.conversationId, 'CONVERSATION_ID'),
      );
      if (!open)
        return Object.freeze({ handoff: null, preferred_seller: null });
      const { preferredSeller, ...handoff } = open;
      return Object.freeze({
        handoff: Object.freeze(handoff),
        // INBOX-HANDOFF-02: the seller the customer asked for by name. It is
        // a hint for the queue; the claim stays open to any Vendedor.
        preferred_seller: preferredSeller
          ? Object.freeze({
              first_name: preferredSeller.firstName,
              id: preferredSeller.id,
            })
          : null,
      });
    },
    /** @param {any} input */
    async listContacts(input = {}) {
      rejectUnknownKeys(input, ['cursor', 'limit', 'q']);
      const q = input.q === undefined ? '' : String(input.q).trim();
      if (
        q.length > 120 ||
        (input.q !== undefined && typeof input.q !== 'string')
      ) {
        throw new OperationReadError(400, 'INVALID_REQUEST');
      }
      const limit = readLimit(input.limit);
      const filters = q ? { q } : {};
      const after = readCursor(input.cursor, {
        cursorKey,
        fingerprint: filterFingerprint(filters),
        scope: 'contacts',
      });
      const result = await contactRepository.list({ after, limit, ...filters });
      return pageResponse(result, {
        cursorKey,
        fingerprint: filterFingerprint(filters),
        scope: 'contacts',
      });
    },
    /** @param {any} input @param {{actorId?: string}} [access] */
    async listInbox(input = {}, access = {}) {
      rejectUnknownKeys(input, [
        'assignedUserId',
        'archived',
        'automationState',
        'bucket',
        'channel',
        'cursor',
        'limit',
        'orderReady',
        'owner',
        'pendingHandoff',
        'sort',
        'state',
        'terminal',
        'unassignedHumanHandoff',
        'workQueue',
      ]);
      const filters = /** @type {Record<string, any>} */ ({});
      const owner = readOwner(input);
      const orderReady =
        input.orderReady === undefined
          ? false
          : readBooleanFilter(input.orderReady);
      const terminal =
        input.terminal === undefined
          ? false
          : readBooleanFilter(input.terminal);
      if (orderReady && input.bucket === undefined) {
        throw new OperationReadError(400, 'INVALID_FILTER');
      }
      if (input.bucket !== undefined) {
        // RFC 052: a tab is a query of its own; the old shortcuts and the
        // consultations (archived, terminal) never combine with it.
        for (const key of [
          'automationState',
          'channel',
          'pendingHandoff',
          'sort',
          'state',
          'unassignedHumanHandoff',
          'workQueue',
        ]) {
          if (input[key] !== undefined) {
            throw new OperationReadError(400, 'INVALID_FILTER');
          }
        }
        if (
          terminal ||
          (input.archived !== undefined && readBooleanFilter(input.archived))
        ) {
          throw new OperationReadError(400, 'INVALID_FILTER');
        }
        // The cursor binds, in this order, reader, tab, owner, order-ready
        // chip and seller. The channel never combines with a tab.
        filters.actorId = requireId(access.actorId, 'ACTOR_ID');
        filters.bucket = requireChoice(input.bucket, new Set(INBOX_BUCKETS));
        filters.owner = owner;
        filters.orderReady = orderReady;
        if (input.assignedUserId !== undefined) {
          filters.assignedUserId = requireId(
            input.assignedUserId,
            'ASSIGNED_USER_ID',
          );
        }
      } else if (input.workQueue !== undefined) {
        filters.workQueue = requireChoice(
          input.workQueue,
          new Set(['attention', 'closing']),
        );
        // The route supplies the current session, never a query parameter.
        filters.actorId = requireId(access.actorId, 'ACTOR_ID');
        if (input.archived === true || input.archived === 'true') {
          throw new OperationReadError(400, 'INVALID_FILTER');
        }
      }
      if (input.sort !== undefined) {
        filters.sort = requireChoice(input.sort, new Set(['urgency']));
        // Bind ranked cursors to the authenticated reader without restricting
        // the all-conversations universe to that person's ownership.
        filters.actorId = requireId(access.actorId, 'ACTOR_ID');
      }
      if (input.assignedUserId !== undefined) {
        filters.assignedUserId = requireId(
          input.assignedUserId,
          'ASSIGNED_USER_ID',
        );
      }
      if (input.archived !== undefined && input.bucket === undefined) {
        if (
          input.archived !== true &&
          input.archived !== false &&
          input.archived !== 'true' &&
          input.archived !== 'false'
        ) {
          throw new OperationReadError(400, 'INVALID_FILTER');
        }
        filters.archived = input.archived === true || input.archived === 'true';
      }
      if (input.automationState !== undefined) {
        filters.automationState = requireChoice(
          input.automationState,
          AUTOMATION_STATES,
        );
      }
      if (input.channel !== undefined) {
        filters.channel = requireChoice(input.channel, CHANNELS);
      }
      if (input.pendingHandoff !== undefined) {
        // "Aguardando vendedor": the agent stopped and nobody picked it up.
        filters.pendingHandoff = readBooleanFilter(input.pendingHandoff);
      }
      if (input.state !== undefined) {
        filters.state = requireChoice(input.state, CONVERSATION_STATES);
      }
      if (input.unassignedHumanHandoff !== undefined) {
        if (
          input.unassignedHumanHandoff !== true &&
          input.unassignedHumanHandoff !== false &&
          input.unassignedHumanHandoff !== 'true' &&
          input.unassignedHumanHandoff !== 'false'
        ) {
          throw new OperationReadError(400, 'INVALID_FILTER');
        }
        filters.unassignedHumanHandoff =
          input.unassignedHumanHandoff === true ||
          input.unassignedHumanHandoff === 'true';
      }
      if (input.assignedUserId !== undefined && owner !== 'all') {
        // A seller picked by id already says whose conversations to show.
        throw new OperationReadError(400, 'INVALID_FILTER');
      }
      if (input.bucket === undefined) {
        // Added last and only when set, so the fingerprint of every older
        // request (and the cursor it issued) stays what it was.
        if (terminal) {
          if (filters.workQueue || filters.state || filters.archived === true) {
            throw new OperationReadError(400, 'INVALID_FILTER');
          }
          filters.terminal = true;
        }
        if (owner !== 'all') {
          if (owner === 'mine') {
            filters.actorId ??= requireId(access.actorId, 'ACTOR_ID');
          }
          filters.owner = owner;
        }
      }
      const ranked = filters.sort === 'urgency' || input.bucket !== undefined;
      // Reject cursors from Responder's former oldest-wait/failure-first order.
      const fingerprint = filterFingerprint(
        filters.bucket === 'respond'
          ? { ...filters, orderVersion: 'latest-message-v1' }
          : filters,
      );
      const limit = readLimit(input.limit);
      const after = readCursor(input.cursor, {
        cursorKey,
        fingerprint,
        scope: 'inbox',
        ranked,
      });
      const result = await inboxRepository.list(
        { after, ...filters, limit },
        readerFor(access),
      );
      return pageResponse(result, {
        cursorKey,
        fingerprint,
        scope: 'inbox',
        ranked,
        // The waiting list is ordered by how long the handoff has waited,
        // so its cursor continues from that instant instead of the last message.
        ...(filters.workQueue
          ? { position: (/** @type {any} */ item) => item.queuePosition }
          : filters.pendingHandoff === true
            ? { position: (/** @type {any} */ item) => item.handoff.createdAt }
            : {}),
      });
    },
    /** @param {{after?: unknown}} [input] */
    async readLiveEvents(input = {}) {
      if (!database || typeof database.query !== 'function') {
        throw new TypeError('database is required');
      }
      const after =
        input.after === undefined || input.after === ''
          ? 0
          : Number(input.after);
      if (!Number.isSafeInteger(after) || after < 0) {
        return Object.freeze({ cursor: 0, events: [], reset: true });
      }
      const result = await database.query(
        `SELECT stream_cursor, aggregate_type, aggregate_id, payload
         FROM crm.domain_events
         WHERE stream_cursor > $1
           AND aggregate_type IN ('contact', 'conversation', 'order', 'user')
         ORDER BY stream_cursor LIMIT 101`,
        [after],
      );
      if (result.rows.length > 100) {
        // A fresh SSE connection can be further than one batch behind. Jump to
        // the latest committed event and tell the UI to reload its authorized
        // read model. Keeping `after` here traps the dispatcher in a reset loop.
        const latest = await database.query(
          `SELECT max(stream_cursor) cursor
           FROM crm.domain_events
           WHERE stream_cursor > $1
             AND aggregate_type IN ('contact', 'conversation', 'order', 'user')`,
          [after],
        );
        return Object.freeze({
          cursor: Number(latest.rows[0].cursor),
          events: [],
          reset: true,
        });
      }
      if (result.rows.length === 0 && after > 0) {
        // A restored database can be behind a cursor retained by EventSource
        // or by the shared dispatcher. Reset to its current head so later
        // events are not hidden until their cursors pass the old value.
        const head = await database.query(
          'SELECT COALESCE(max(stream_cursor), 0) cursor FROM crm.domain_events',
        );
        const cursor = Number(head.rows[0].cursor);
        if (cursor < after) {
          return Object.freeze({ cursor, events: [], reset: true });
        }
      }
      const events = result.rows.map((/** @type {any} */ row) =>
        Object.freeze({
          cursor: Number(row.stream_cursor),
          ...liveEventFor(row),
        }),
      );
      return Object.freeze({
        cursor: events.at(-1)?.cursor ?? after,
        events: Object.freeze(events),
        reset: false,
      });
    },
    /** @param {any} input */
    async listOpenHandoffs(input = {}) {
      rejectUnknownKeys(input, ['cursor', 'limit']);
      const limit = readLimit(input.limit);
      const after = readCursor(input.cursor, {
        cursorKey,
        fingerprint: filterFingerprint({ status: 'pending' }),
        scope: 'handoffs',
      });
      const result = await handoffRepository.listOpen({ after, limit });
      return pageResponse(result, {
        cursorKey,
        fingerprint: filterFingerprint({ status: 'pending' }),
        scope: 'handoffs',
      });
    },
  });
}

/**
 * @param {any} database
 * @param {{identity?: any, environment?: Record<string, string|undefined>, postalCodeClient?: {lookup: (postalCode: string) => Promise<any>}}} [options]
 */
export function createOperationReadRuntime(database, options = {}) {
  const environment = options.environment ?? process.env;
  // ADR 047 / CP-28: created lazily so a runtime without lookups never needs fetch.
  /** @type {{lookup: (postalCode: string) => Promise<any>}|undefined} */
  let postalCodeClient = options.postalCodeClient;
  const contactKey = readKey(
    environment.CONTACT_IDENTITY_ENVELOPE_KEY,
    'CONTACT_IDENTITY_ENVELOPE_KEY',
  );
  const contactLookupKey = readKey(
    environment.CONTACT_IDENTITY_LOOKUP_KEY,
    'CONTACT_IDENTITY_LOOKUP_KEY',
  );
  const contactDetailsIdempotency = new PostgresIdempotencyRecordStore({
    database,
    envelopeKey: readKey(
      environment.IDEMPOTENCY_ENVELOPE_KEY,
      'IDEMPOTENCY_ENVELOPE_KEY',
    ),
  });
  const stallMinutes = readAssistantStallMinutes(
    environment.ASSISTANT_STALL_MINUTES,
  );
  const service = createOperationReadService({
    countStalled: (now) =>
      countStalledConversations(database, now, stallMinutes),
    stallMinutes,
    contactRepository: new PostgresContactReadRepository({
      database,
      envelopeKey: contactKey,
      lookupKey: contactLookupKey,
    }),
    database,
    cursorKey: readKey(
      environment.OPERATION_CURSOR_HMAC_KEY,
      'OPERATION_CURSOR_HMAC_KEY',
    ),
    handoffRepository: new PostgresHandoffReadRepository({
      contactEnvelopeKey: readKey(
        environment.CONTACT_IDENTITY_ENVELOPE_KEY,
        'CONTACT_IDENTITY_ENVELOPE_KEY',
      ),
      database,
      handoffEnvelopeKey: readKey(
        environment.HANDOFF_ENVELOPE_KEY,
        'HANDOFF_ENVELOPE_KEY',
      ),
      n8nEnvelopeKey: environment.N8N_INTEGRATION_ENVELOPE_KEY
        ? readKey(
            environment.N8N_INTEGRATION_ENVELOPE_KEY,
            'N8N_INTEGRATION_ENVELOPE_KEY',
          )
        : undefined,
    }),
    inboxRepository: new PostgresInboxReadRepository({
      contactEnvelopeKey: readKey(
        environment.CONTACT_IDENTITY_ENVELOPE_KEY,
        'CONTACT_IDENTITY_ENVELOPE_KEY',
      ),
      database,
      messageEnvelopeKey: readKey(
        environment.INBOX_MESSAGE_ENVELOPE_KEY,
        'INBOX_MESSAGE_ENVELOPE_KEY',
      ),
    }),
  });

  const auditPort = new PostgresAuditTrail(database);

  /**
   * CP-26 also needs celular and e-mail, resolved as the Contact read does:
   * e-mail only from the details envelope; celular from it, from a confirmed
   * WhatsApp identity or from a site declaration.
   * @param {any} transaction @param {string} contactId @param {unknown} detailsEnvelope
   */
  async function hasRegistrationContactData(
    transaction,
    contactId,
    detailsEnvelope,
  ) {
    const details = decryptContactDetails(detailsEnvelope, contactKey);
    if (!details.email) return false;
    if (details.phone) return true;
    const phone = await transaction.query(
      `SELECT EXISTS (
         SELECT 1 FROM crm.contact_identities
         WHERE current_contact_id = $1 AND channel = 'whatsapp'
           AND identity_kind = 'phone' AND phone_status = 'confirmed'
         UNION ALL
         SELECT 1 FROM crm.site_contact_claims claim
         JOIN crm.conversations conversation
           ON conversation.id = claim.conversation_id
         JOIN crm.contact_identities identity
           ON identity.id = conversation.contact_identity_id
         WHERE identity.current_contact_id = $1
       ) AS found`,
      [contactId],
    );
    return phone.rows[0]?.found === true;
  }

  return Object.freeze({
    ...service,

    /** A manual contact has no unverified channel identity (CP-01).
     * @param {{actor: {id: string}, correlationId: string, displayName: unknown, email?: unknown, phone: unknown, idempotencyKey: string}} input
     */
    async createContact(input) {
      const displayName = readDisplayName(input.displayName);
      if (!displayName)
        throw new OperationReadError(400, 'INVALID_DISPLAY_NAME');
      const phone = normalizeContactPhone(input.phone);
      if (!phone) throw new OperationReadError(400, 'INVALID_PHONE');
      const email = normalizeContactEmail(input.email);
      if (email === undefined)
        throw new OperationReadError(400, 'INVALID_EMAIL');
      const phoneHash = contactPhoneHash(phone, contactLookupKey);
      const key = requireId(input.idempotencyKey, 'IDEMPOTENCY_KEY');
      if (!input.actor?.id) throw new OperationReadError(403, 'FORBIDDEN');
      return database.transaction(async (/** @type {any} */ transaction) => {
        const occurredAt = new Date().toISOString();
        const contactId = randomUUID();
        await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          phoneHash,
        ]);
        const replay = (
          await transaction.query(
            `SELECT id, display_name, version, manually_created_by,
                    contact_phone_hash, contact_details_envelope
             FROM crm.contacts WHERE manual_create_key = $1`,
            [key],
          )
        ).rows[0];
        if (!replay) {
          const candidates = await transaction.query(
            `SELECT EXISTS (
               SELECT 1 FROM crm.contacts WHERE contact_phone_hash = $1
               UNION ALL
               SELECT 1 FROM crm.contact_phone_lookup WHERE phone_hash = $1
               UNION ALL
               SELECT 1 FROM crm.site_contact_claims WHERE phone_hash = $1
             ) AS found`,
            [phoneHash],
          );
          if (candidates.rows[0]?.found) {
            throw new OperationReadError(409, 'CONTACT_PHONE_MATCH');
          }
        }
        const inserted = replay
          ? { rows: [] }
          : await transaction.query(
              `INSERT INTO crm.contacts
             (id, provisional, version, created_at, updated_at,
              display_name, display_name_source, manual_create_key,
              manually_created_by, contact_phone_hash, contact_details_envelope)
           VALUES ($1, false, 1, $2, $2, $3, 'manual', $4, $5, $6, $7::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id, display_name, version, manually_created_by, contact_phone_hash, contact_details_envelope`,
              [
                contactId,
                occurredAt,
                displayName,
                key,
                input.actor.id,
                phoneHash,
                JSON.stringify(
                  encryptContactDetails({ email, phone }, contactKey),
                ),
              ],
            );
        const created = Boolean(inserted.rows[0]);
        const row =
          inserted.rows[0] ??
          replay ??
          (
            await transaction.query(
              `SELECT id, display_name, version, manually_created_by,
                      contact_phone_hash, contact_details_envelope
             FROM crm.contacts WHERE manual_create_key = $1`,
              [key],
            )
          ).rows[0];
        const storedDetails = row?.contact_details_envelope
          ? decryptContactDetails(row.contact_details_envelope, contactKey)
          : null;
        if (
          !row ||
          row.display_name !== displayName ||
          row.manually_created_by !== input.actor.id ||
          row.contact_phone_hash !== phoneHash ||
          storedDetails?.email !== email ||
          storedDetails?.phone !== phone
        ) {
          throw new OperationReadError(409, 'CONTACT_CONFLICT');
        }
        if (created) {
          await transaction.query(
            `INSERT INTO crm.contact_phone_lookup (contact_id, phone_hash, source)
             VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
            [row.id, phoneHash],
          );
          await auditPort.append(
            {
              action: 'contact.created',
              actor: input.actor.id,
              correlationId: input.correlationId,
              occurredAt,
              reason: 'MANUAL_CONTACT',
              target: { id: row.id, type: 'contact' },
              version: 1,
            },
            { transaction },
          );
          await transaction.query(
            `INSERT INTO crm.domain_events
               (id, aggregate_type, aggregate_id, aggregate_version,
                event_type, payload, correlation_id, occurred_at)
             VALUES ($1, 'contact', $2, 1, 'contact.created', $3::jsonb, $4, $5)`,
            [
              `event-${randomUUID()}`,
              row.id,
              JSON.stringify({ contactId: row.id }),
              input.correlationId,
              occurredAt,
            ],
          );
        }
        return {
          created,
          contact: {
            displayName: row.display_name,
            id: row.id,
            label: row.display_name,
            phone,
            email,
            version: Number(row.version),
          },
        };
      });
    },

    /** Completes a legacy contact before a new manual order without changing channel identity. */
    /** @param {{actor: {id: string}, contactId: unknown, correlationId: string, email?: unknown, expectedVersion: unknown, idempotencyKey: unknown, phone: unknown}} input */
    async setContactDetails(input) {
      const contactId = requireId(input.contactId, 'CONTACT_ID');
      const phone = normalizeContactPhone(input.phone);
      if (!phone) throw new OperationReadError(400, 'INVALID_PHONE');
      const email = normalizeContactEmail(input.email);
      if (email === undefined)
        throw new OperationReadError(400, 'INVALID_EMAIL');
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new OperationReadError(400, 'INVALID_REQUEST');
      }
      if (!input.actor?.id) throw new OperationReadError(403, 'FORBIDDEN');
      const phoneHash = contactPhoneHash(phone, contactLookupKey);
      const key = requireId(input.idempotencyKey, 'IDEMPOTENCY_KEY');
      try {
        return await contactDetailsIdempotency.execute(
          {
            scope: 'contact.details.complete',
            key,
            fingerprint: createHmac('sha256', contactLookupKey)
              .update(
                JSON.stringify({
                  actorId: input.actor.id,
                  contactId,
                  email,
                  expectedVersion,
                  phoneHash,
                }),
              )
              .digest('hex'),
            actor: input.actor.id,
            action: 'contact.details.complete',
            target: { type: 'contact', id: contactId },
            version: expectedVersion,
            reason: 'MANUAL_ORDER_CONTACT_PHONE',
            correlationId: input.correlationId,
          },
          async (/** @type {any} */ transaction) => {
            await transaction.query(
              'SELECT pg_advisory_xact_lock(hashtext($1))',
              [phoneHash],
            );
            const current = (
              await transaction.query(
                `SELECT id, display_name, manual_create_key, contact_phone_hash,
                    contact_details_envelope, contact_details_key,
                    contact_details_actor_id, version
             FROM crm.contacts WHERE id = $1 FOR UPDATE`,
                [contactId],
              )
            ).rows[0];
            if (!current)
              throw new OperationReadError(404, 'CONTACT_NOT_FOUND');
            if (current.contact_details_key === key) {
              const saved = decryptContactDetails(
                current.contact_details_envelope,
                contactKey,
              );
              if (
                current.contact_details_actor_id !== input.actor.id ||
                saved.phone !== phone ||
                saved.email !== email ||
                Number(current.version) !== expectedVersion + 1
              ) {
                throw new OperationReadError(409, 'CONTACT_CONFLICT');
              }
              return {
                id: contactId,
                label: current.display_name,
                displayName: current.display_name,
                phone,
                email,
                version: Number(current.version),
              };
            }
            if (
              Number(current.version) !== expectedVersion ||
              (current.contact_phone_hash &&
                current.contact_phone_hash !== phoneHash)
            ) {
              throw new OperationReadError(409, 'CONTACT_CONFLICT');
            }
            const candidates = await transaction.query(
              `SELECT EXISTS (
                 SELECT 1 FROM crm.contacts
                 WHERE contact_phone_hash = $1 AND id <> $2
                 UNION ALL
                 SELECT 1 FROM crm.contact_phone_lookup lookup
                 LEFT JOIN crm.contact_identities identity
                   ON identity.id = lookup.identity_id
                 WHERE lookup.phone_hash = $1
                   AND CASE WHEN lookup.source = 'whatsapp'
                     THEN identity.current_contact_id <> $2
                     ELSE lookup.contact_id <> $2 END
                 UNION ALL
                 SELECT 1 FROM crm.site_contact_claims claim
                 JOIN crm.conversations conversation
                   ON conversation.id = claim.conversation_id
                 JOIN crm.contact_identities identity
                   ON identity.id = conversation.contact_identity_id
                 WHERE claim.phone_hash = $1
                   AND identity.current_contact_id <> $2
               ) AS found`,
              [phoneHash, contactId],
            );
            if (candidates.rows[0]?.found) {
              throw new OperationReadError(409, 'CONTACT_PHONE_MATCH');
            }
            const identities = await transaction.query(
              `SELECT external_identity_lookup_hash, identity_envelope
             FROM crm.contact_identities
             WHERE current_contact_id = $1 AND identity_kind = 'phone'
               AND phone_status = 'confirmed'`,
              [contactId],
            );
            for (const identity of identities.rows) {
              const saved = decryptContactIdentityEnvelope(
                identity.identity_envelope,
                identity.external_identity_lookup_hash,
                contactKey,
              );
              const confirmedPhone = normalizeContactPhone(
                saved.externalIdentityId,
              );
              if (confirmedPhone && confirmedPhone !== phone) {
                throw new OperationReadError(409, 'CONTACT_CONFLICT');
              }
            }
            const occurredAt = new Date().toISOString();
            const row = (
              await transaction.query(
                `UPDATE crm.contacts
             SET contact_phone_hash = $2, contact_details_envelope = $3::jsonb,
                 contact_details_key = $4, contact_details_actor_id = $5,
                 version = version + 1, updated_at = $6
             WHERE id = $1 RETURNING id, display_name, version`,
                [
                  contactId,
                  phoneHash,
                  JSON.stringify(
                    encryptContactDetails({ email, phone }, contactKey),
                  ),
                  key,
                  input.actor.id,
                  occurredAt,
                ],
              )
            ).rows[0];
            await transaction.query(
              `INSERT INTO crm.contact_phone_lookup (contact_id, phone_hash, source)
               VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
              [contactId, phoneHash],
            );
            await auditPort.append(
              {
                action: 'contact.details.completed',
                actor: input.actor.id,
                correlationId: input.correlationId,
                occurredAt,
                reason: 'MANUAL_ORDER_CONTACT_PHONE',
                target: { id: contactId, type: 'contact' },
                version: Number(row.version),
              },
              { transaction },
            );
            await transaction.query(
              `INSERT INTO crm.domain_events
               (id, aggregate_type, aggregate_id, aggregate_version,
                event_type, payload, correlation_id, occurred_at)
             VALUES ($1, 'contact', $2, $3, 'contact.details.completed', $4::jsonb, $5, $6)`,
              [
                `event-${randomUUID()}`,
                contactId,
                Number(row.version),
                JSON.stringify({ contactId }),
                input.correlationId,
                occurredAt,
              ],
            );
            return {
              id: contactId,
              label: row.display_name,
              displayName: row.display_name,
              phone,
              email,
              version: Number(row.version),
            };
          },
        );
      } catch (cause) {
        if (/** @type {any} */ (cause)?.code === '23505')
          throw new OperationReadError(409, 'CONTACT_CONFLICT');
        throw cause;
      }
    },

    /**
     * ADR 047 / CP-25..27: replaces the whole optional registration. The
     * values live only in their envelope; the immutable idempotency record
     * keeps just id, version and status, and audit, event, logs and errors
     * carry identifiers and codes.
     * @param {{actor: {id: string}, contactId: unknown, correlationId: string, expectedVersion: unknown, idempotencyKey: unknown, registration: unknown}} input
     */
    async setContactRegistration(input) {
      const contactId = requireId(input.contactId, 'CONTACT_ID');
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new OperationReadError(400, 'INVALID_REQUEST');
      }
      const submitted = input.registration;
      if (
        !submitted ||
        typeof submitted !== 'object' ||
        Array.isArray(submitted) ||
        Object.keys(submitted).some(
          (field) => !CONTACT_REGISTRATION_FIELDS.includes(field),
        )
      ) {
        throw new OperationReadError(400, 'INVALID_REQUEST');
      }
      const normalized = normalizeContactRegistration(submitted);
      if (!normalized.ok) {
        const [field, code] = Object.entries(normalized.errors)[0];
        throw new OperationReadError(400, code, field);
      }
      if (!input.actor?.id) throw new OperationReadError(403, 'FORBIDDEN');
      const key = requireId(input.idempotencyKey, 'IDEMPOTENCY_KEY');
      const registration = normalized.value;
      const stored = await contactDetailsIdempotency.execute(
        {
          scope: 'contact.registration.update',
          key,
          // Keyed digest: the idempotency row never holds the values in clear.
          fingerprint: createHmac('sha256', contactLookupKey)
            .update(
              JSON.stringify({
                actorId: input.actor.id,
                contactId,
                expectedVersion,
                registration,
              }),
            )
            .digest('hex'),
          actor: input.actor.id,
          action: 'contact.registration.update',
          target: { type: 'contact', id: contactId },
          version: expectedVersion,
          reason: 'CONTACT_REGISTRATION',
          correlationId: input.correlationId,
        },
        async (/** @type {any} */ transaction) => {
          const current = (
            await transaction.query(
              `SELECT id, version, contact_details_envelope
               FROM crm.contacts WHERE id = $1 FOR UPDATE`,
              [contactId],
            )
          ).rows[0];
          if (!current) throw new OperationReadError(404, 'CONTACT_NOT_FOUND');
          if (Number(current.version) !== expectedVersion) {
            throw new OperationReadError(409, 'CONTACT_CONFLICT');
          }
          const occurredAt = new Date().toISOString();
          const row = (
            await transaction.query(
              `UPDATE crm.contacts
               SET registration_envelope = $2::jsonb,
                   registration_fields_complete = $3,
                   version = version + 1, updated_at = $4
               WHERE id = $1 RETURNING id, version`,
              [
                contactId,
                JSON.stringify(
                  encryptContactRegistration(registration, contactKey),
                ),
                normalized.fieldsComplete,
                occurredAt,
              ],
            )
          ).rows[0];
          const version = Number(row.version);
          await auditPort.append(
            {
              action: 'contact.registration.updated',
              actor: input.actor.id,
              correlationId: input.correlationId,
              occurredAt,
              reason: 'CONTACT_REGISTRATION',
              target: { id: contactId, type: 'contact' },
              version,
            },
            { transaction },
          );
          await transaction.query(
            `INSERT INTO crm.domain_events
               (id, aggregate_type, aggregate_id, aggregate_version,
                event_type, payload, correlation_id, occurred_at)
             VALUES ($1, 'contact', $2, $3, 'contact.registration.updated', $4::jsonb, $5, $6)`,
            [
              `event-${randomUUID()}`,
              contactId,
              version,
              JSON.stringify({ contactId }),
              input.correlationId,
              occurredAt,
            ],
          );
          const complete =
            normalized.fieldsComplete &&
            (await hasRegistrationContactData(
              transaction,
              contactId,
              current.contact_details_envelope,
            ));
          return {
            id: contactId,
            registrationStatus: complete ? 'complete' : 'incomplete',
            version,
          };
        },
      );
      // Same key => same fingerprint => same normalized registration, so the
      // first answer and every replay rebuild the body from the request.
      return {
        id: stored.id,
        registration,
        registrationStatus: stored.registrationStatus,
        version: stored.version,
      };
    },

    /**
     * ADR 047 / CP-28: only the 8-digit postal code leaves the CRM; any
     * failure keeps the address editable by hand.
     * @param {{postalCode: unknown}} input
     */
    async lookupPostalCode(input) {
      const raw = input?.postalCode;
      if (typeof raw !== 'string' || !/^\d{5}-?\d{3}$/u.test(raw)) {
        throw new OperationReadError(400, 'INVALID_POSTAL_CODE');
      }
      const postalCode = raw.replace('-', '');
      if (postalCode === '00000000') {
        throw new OperationReadError(400, 'INVALID_POSTAL_CODE');
      }
      postalCodeClient ??= new ViaCepPostalCodeClient();
      try {
        const suggestion = await postalCodeClient.lookup(postalCode);
        return {
          city: suggestion.city ?? null,
          district: suggestion.district ?? null,
          postalCode,
          state: suggestion.state ?? null,
          street: suggestion.street ?? null,
        };
      } catch (cause) {
        if (
          cause instanceof PostalCodeLookupError &&
          cause.code === 'POSTAL_CODE_NOT_FOUND'
        ) {
          throw new OperationReadError(404, 'POSTAL_CODE_NOT_FOUND');
        }
        throw new OperationReadError(503, 'POSTAL_CODE_UNAVAILABLE');
      }
    },

    /**
     * Renames a contact. The channel handle in contact_identities keeps
     * mirroring the provider; only crm.contacts.display_name is operator-owned,
     * so a rename never desynchronises the identity envelope.
     * @param {{actor: {id: string}, contactId: unknown, correlationId: string, displayName: unknown, expectedVersion: unknown, reason: string}} input
     */
    async renameContact(input) {
      const contactId = requireId(input.contactId, 'CONTACT_ID');
      const displayName = readDisplayName(input.displayName);
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new OperationReadError(400, 'INVALID_REQUEST');
      }
      return database.transaction(async (/** @type {any} */ transaction) => {
        const current = await transaction.query(
          'SELECT id, version FROM crm.contacts WHERE id = $1 FOR UPDATE',
          [contactId],
        );
        if (!current.rows[0]) {
          throw new OperationReadError(404, 'CONTACT_NOT_FOUND');
        }
        if (Number(current.rows[0].version) !== expectedVersion) {
          throw new OperationReadError(409, 'CONTACT_CONFLICT');
        }
        const occurredAt = new Date().toISOString();
        const updated = await transaction.query(
          `UPDATE crm.contacts
           SET display_name = $2, display_name_source = 'manual',
               version = version + 1, updated_at = $3
           WHERE id = $1 RETURNING id, display_name, version`,
          [contactId, displayName, occurredAt],
        );
        const row = updated.rows[0];
        await auditPort.append(
          {
            action: 'contact.renamed',
            actor: input.actor.id,
            correlationId: input.correlationId,
            occurredAt,
            reason: input.reason,
            target: { id: contactId, type: 'contact' },
            version: Number(row.version),
          },
          { transaction },
        );
        await transaction.query(
          `INSERT INTO crm.domain_events
             (id, aggregate_type, aggregate_id, aggregate_version, event_type,
              payload, correlation_id, occurred_at)
           VALUES ($1, 'contact', $2, $3, 'contact.renamed', $4::jsonb, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            `event-${randomUUID()}`,
            contactId,
            Number(row.version),
            JSON.stringify({ contactId }),
            input.correlationId,
            occurredAt,
          ],
        );
        return Object.freeze({
          displayName: row.display_name,
          id: row.id,
          version: Number(row.version),
        });
      });
    },

    /**
     * Write counterpart of authorizeRead: mutations additionally require the
     * CSRF token, so they go through authorizeOperational.
     * @param {any} input
     */
    async authorizeWrite(input) {
      if (input.authorization !== undefined) {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      if (!options.identity) {
        throw new OperationReadError(503, 'IDENTITY_UNAVAILABLE');
      }
      if (
        typeof input.origin !== 'string' ||
        !options.identity.allowedOrigins.includes(input.origin)
      ) {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      const sessionToken = parseCookies(input.cookie).get('crm_session');
      if (typeof sessionToken !== 'string') {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      return options.identity.authorizeOperational({
        action: input.action,
        csrfToken: input.csrfToken,
        sessionToken,
      });
    },

    /** @param {any} input */
    async authorizeRead(input) {
      if (input.authorization !== undefined) {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      if (!options.identity) {
        throw new OperationReadError(503, 'IDENTITY_UNAVAILABLE');
      }
      if (
        (input.origin !== undefined &&
          (typeof input.origin !== 'string' ||
            !options.identity.allowedOrigins.includes(input.origin))) ||
        (input.origin === undefined &&
          !['same-origin', 'none'].includes(input.secFetchSite))
      ) {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      const sessionToken = parseCookies(input.cookie).get('crm_session');
      if (typeof sessionToken !== 'string') {
        throw new OperationReadError(403, 'FORBIDDEN');
      }
      return options.identity.authorizeOperationalRead({
        action: input.action,
        sessionToken,
        ...(input.authenticationFailureStatus === 401
          ? { authenticationFailureStatus: 401 }
          : {}),
      });
    },
  });
}

/**
 * Live events carry identifiers only; the page re-reads through the
 * authorized API. An order names its conversation so the Inbox drawer and
 * the order list can both tell whether the change is theirs.
 *
 * @param {{aggregate_type: string, aggregate_id: string, payload: any}} row
 */
function liveEventFor(row) {
  if (row.aggregate_type === 'contact') {
    return {
      payload: { contactId: row.aggregate_id },
      type: 'inbox.contact.changed',
    };
  }
  if (row.aggregate_type === 'order') {
    return {
      payload: {
        conversationId: String(row.payload?.conversationId ?? ''),
        orderId: row.aggregate_id,
      },
      type: 'inbox.order.changed',
    };
  }
  if (row.aggregate_type === 'user') {
    return {
      payload: { userId: row.aggregate_id },
      type: 'identity.user.changed',
    };
  }
  return {
    payload: { conversationId: row.aggregate_id },
    type: 'inbox.conversation.changed',
  };
}

const OWNERS = new Set(['all', 'mine', 'unassigned']);

/** @param {Record<string, any>} input */
function readOwner(input) {
  return input.owner === undefined
    ? 'all'
    : String(requireChoice(input.owner, OWNERS));
}

/** @param {unknown} value */
function readBooleanFilter(value) {
  if (
    value !== true &&
    value !== false &&
    value !== 'true' &&
    value !== 'false'
  ) {
    throw new OperationReadError(400, 'INVALID_FILTER');
  }
  return value === true || value === 'true';
}

/** @param {any} result @param {{cursorKey: Buffer, fingerprint: string, scope: string, ranked?: boolean, position?: (item: any) => string}} context */
function pageResponse(result, context) {
  const items = result.items ?? [];
  const last = items.at(-1);
  return Object.freeze({
    items,
    nextCursor:
      result.hasMore && items.length > 0
        ? encodeCursor(
            context.ranked
              ? { id: last.id, ...result.nextPosition }
              : context.position
                ? { id: last.id, updatedAt: context.position(last) }
                : last,
            context,
          )
        : null,
    totalCount: Number(result.totalCount ?? items.length),
  });
}

/** @param {any} value @param {{cursorKey: Buffer, fingerprint: string, scope: string, ranked?: boolean}} context */
function encodeCursor(value, context) {
  const payload = Buffer.from(
    JSON.stringify({
      fingerprint: context.fingerprint,
      id: value.id,
      ...(context.ranked ? { rank: value.rank } : {}),
      scope: context.scope,
      updatedAt: value.updatedAt,
    }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', context.cursorKey)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

/** @param {unknown} value @param {{cursorKey: Buffer, fingerprint: string, scope: string, ranked?: boolean}} context */
function readCursor(value, context) {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac('sha256', context.cursorKey)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error();
    }
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (
      !parsed ||
      Object.keys(parsed).sort().join(',') !==
        (context.ranked
          ? 'fingerprint,id,rank,scope,updatedAt'
          : 'fingerprint,id,scope,updatedAt') ||
      (context.ranked &&
        (!Number.isSafeInteger(parsed.rank) || parsed.rank < 0)) ||
      parsed.fingerprint !== context.fingerprint ||
      parsed.scope !== context.scope ||
      requireId(parsed.id, 'CURSOR_ID') !== parsed.id ||
      new Date(parsed.updatedAt).toISOString() !== parsed.updatedAt
    ) {
      throw new Error();
    }
    return Object.freeze({
      id: parsed.id,
      updatedAt: parsed.updatedAt,
      ...(context.ranked ? { rank: parsed.rank } : {}),
    });
  } catch {
    throw new OperationReadError(400, 'INVALID_CURSOR');
  }
}

/** @param {unknown} value */
function readLimit(value) {
  const limit = value === undefined ? 50 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OperationReadError(400, 'INVALID_LIMIT');
  }
  return limit;
}

/**
 * An empty string clears the operator-chosen name and lets readers fall back to
 * the channel handle.
 * @param {unknown} value
 */
function readDisplayName(value) {
  if (typeof value !== 'string') {
    throw new OperationReadError(400, 'INVALID_DISPLAY_NAME');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH || hasControlCharacter) {
    throw new OperationReadError(400, 'INVALID_DISPLAY_NAME');
  }
  return trimmed;
}

/** @param {unknown} value @param {Set<string>} accepted */
function requireChoice(value, accepted) {
  if (typeof value !== 'string' || !accepted.has(value)) {
    throw new OperationReadError(400, 'INVALID_FILTER');
  }
  return value;
}

/** @param {unknown} value @param {string} code */
function requireId(value, code) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)
  ) {
    throw new OperationReadError(400, `INVALID_${code}`);
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function rejectUnknownKeys(value, allowed) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new OperationReadError(400, 'INVALID_FILTER');
  }
}

/** @param {Record<string, unknown>} filters */
function filterFingerprint(filters) {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}

/** @param {unknown} raw */
function parseCookies(raw) {
  if (typeof raw !== 'string') return new Map();
  const cookies = new Map();
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (cookies.has(name)) throw new OperationReadError(400, 'INVALID_REQUEST');
    cookies.set(name, value);
  }
  return cookies;
}

/** @param {string|undefined} value @param {string} name */
function readKey(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${name} must use base64url`);
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return key;
}
