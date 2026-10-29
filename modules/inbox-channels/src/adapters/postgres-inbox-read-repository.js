import { decryptSiteContactClaim } from '@crm-silmer/contacts';
import { decryptContactIdentityEnvelope } from '@crm-silmer/contacts/identity-envelope';
import { decryptInboxMessageEnvelope } from './postgres-inbox-repository.js';

const DOCUMENT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MEDIA_PROJECTION = `COALESCE(media.id::text, inbound_media.id) media_id,
  COALESCE(media.kind, CASE WHEN inbound_media.media_type='document'
    AND inbound_media.detected_mime_type IN ('image/jpeg','image/png','image/webp','image/gif')
    THEN 'image' ELSE inbound_media.media_type END) media_kind,
  CASE WHEN media.id IS NOT NULL THEN media.state
    WHEN inbound_media.availability_status='lost' THEN 'lost'
    WHEN inbound_media.availability_status='available'
      AND inbound_media.validation_status='clean'
      AND inbound_media.expires_at > now()
      AND inbound_media.terminal_at IS NULL THEN 'attached'
    ELSE 'unavailable' END media_state,
  COALESCE(media.detected_mime_type, inbound_media.detected_mime_type) media_mime_type,
  COALESCE(media.size_bytes, inbound_media.size_bytes) media_size_bytes,
  media.duration_ms media_duration_ms,
  COALESCE(media.validation_status, inbound_media.validation_status) media_validation_status,
  reservation.workflow_version reserved_workflow_version`;
// Persisted binding, never a payload URL or a storage request. One original
// reservation is authoritative; contradictory provenance fails closed.
const MEDIA_JOIN = `LEFT JOIN crm.chat_media media
  ON media.message_id=message.id AND media.conversation_id=message.conversation_id
    AND media.kind=message.message_type
  LEFT JOIN LATERAL (
    SELECT transient.*, inbound_conversation.terminal_at
    FROM crm.attachments attachment
    JOIN crm.transient_media transient ON transient.id=attachment.transient_media_id
    JOIN crm.conversations inbound_conversation ON inbound_conversation.id=message.conversation_id
    WHERE attachment.message_id=message.id AND message.direction='inbound'
      AND transient.media_type=message.message_type
      AND (message.message_type IN ('image','audio','video')
        OR (message.message_type='document' AND transient.detected_mime_type
          IN ('image/jpeg','image/png','image/webp','image/gif')))
    ORDER BY attachment.created_at DESC, transient.id DESC LIMIT 1
  ) inbound_media ON media.id IS NULL
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*)=1 THEN max(workflow_version) END workflow_version
    FROM crm.n8n_events
    WHERE message_id=message.id AND conversation_id=message.conversation_id
      AND event_type='message.send.requested'
  ) reservation ON true`;

const DELIVERY_ERROR_CODES = new Set([
  'COMMAND_LEASE_EXPIRED',
  'N8N_COMMAND_ACK_MISMATCH',
  'N8N_COMMAND_DELIVERY_FAILED',
  'N8N_COMMAND_HTTP_401',
  'N8N_COMMAND_HTTP_403',
  'N8N_COMMAND_HTTP_404',
  'N8N_COMMAND_HTTP_405',
  'N8N_COMMAND_ID_MISMATCH',
  'N8N_COMMAND_INVALID',
  'N8N_COMMAND_NETWORK_ERROR',
  'N8N_COMMAND_NOT_FOUND',
  'N8N_COMMAND_PAYLOAD_CHANGED',
  'N8N_COMMAND_PAYLOAD_INVALID',
  'N8N_COMMAND_RECONCILED_FAILED',
  'N8N_COMMAND_REJECTED',
  'N8N_COMMAND_REMOTE_UNAVAILABLE',
  'N8N_COMMAND_STALE',
  'N8N_COMMAND_TIMEOUT',
  'OUTCOME_UNKNOWN',
]);

/**
 * The order the Inbox shows for a conversation: the pending one, otherwise the
 * most recently confirmed (same rule as GET /conversations/:id/order). Only
 * plain columns are read; the ficha stays encrypted.
 */
const CURRENT_ORDER_JOIN = `LEFT JOIN LATERAL (
             SELECT candidate_order.id, candidate_order.number,
                    candidate_order.status
             FROM crm.orders candidate_order
             WHERE candidate_order.conversation_id=conversation.id
             ORDER BY (candidate_order.status = 'pendente') DESC,
                      candidate_order.confirmed_at DESC NULLS LAST,
                      candidate_order.number_sequence DESC
             LIMIT 1
           ) current_order ON true`;

export class PostgresInboxReadRepository {
  /** @param {{database: {query: Function, transaction?: Function}, contactEnvelopeKey: Buffer, messageEnvelopeKey: Buffer}} options */
  constructor({ database, contactEnvelopeKey, messageEnvelopeKey }) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database.query is required');
    }
    for (const [value, name] of [
      [contactEnvelopeKey, 'contactEnvelopeKey'],
      [messageEnvelopeKey, 'messageEnvelopeKey'],
    ]) {
      if (!Buffer.isBuffer(value) || value.length !== 32) {
        throw new TypeError(`${name} must be a 32-byte Buffer`);
      }
    }
    this.database = database;
    this.contactEnvelopeKey = Buffer.from(contactEnvelopeKey);
    this.messageEnvelopeKey = Buffer.from(messageEnvelopeKey);
  }

  /** @param {Record<string, any>} input */
  async list(input) {
    return this.#snapshot(async (database) => {
      const values = [];
      const predicates = [];
      predicates.push(
        input.archived
          ? 'conversation.archived_at IS NOT NULL'
          : 'conversation.archived_at IS NULL',
      );
      for (const [field, column] of [
        ['state', 'conversation.state'],
        ['channel', 'identity.channel'],
        ['automationState', 'conversation.automation_state'],
        ['assignedUserId', 'conversation.assigned_user_id'],
      ]) {
        if (input[field] === undefined) continue;
        values.push(input[field]);
        predicates.push(`${column} = $${values.length}`);
      }
      if (input.unassignedHumanHandoff) {
        predicates.push('conversation.assigned_user_id IS NULL');
      }
      if (input.pendingHandoff !== undefined) {
        // At most one handoff per conversation is open (pending or accepted).
        predicates.push(
          `${input.pendingHandoff ? '' : 'NOT '}EXISTS (
             SELECT 1 FROM crm.handoffs waiting
             WHERE waiting.conversation_id=conversation.id
               AND waiting.status='pending')`,
        );
      }
      const countValues = [...values];
      const countWhere = predicates.join(' AND ');
      // "Aguardando vendedor" puts the longest wait first; every other view
      // keeps the most recent message first.
      const byWaitingTime = input.pendingHandoff === true;
      const pagePredicates = [...predicates];
      if (input.after) {
        values.push(input.after.updatedAt, input.after.id);
        pagePredicates.push(
          byWaitingTime
            ? `(handoff.created_at, conversation.id) > ($${values.length - 1}::timestamptz, $${values.length})`
            : `(conversation.last_message_at, conversation.id) < ($${values.length - 1}, $${values.length})`,
        );
      }
      const where = pagePredicates.join(' AND ');
      const orderBy = byWaitingTime
        ? 'handoff.created_at ASC, conversation.id ASC'
        : 'conversation.last_message_at DESC, conversation.id DESC';
      values.push(input.limit + 1);
      const [page, count] = await Promise.all([
        database.query(
          `SELECT conversation.id, conversation.state,
                  conversation.automation_state, conversation.automation_epoch,
                  conversation.assigned_user_id, conversation.version,
                  conversation.opened_at, conversation.last_message_at,
                  conversation.terminal_at, conversation.archived_at,
                  conversation.closure_outcome, conversation.closed_by,
                  identity.current_contact_id contact_id, identity.channel,
                  identity.external_identity_lookup_hash,
                  identity.identity_envelope, contact.display_name,
                  contact.version contact_version,
                  site_claim.id site_claim_id, site_claim.version site_claim_version,
                  site_claim.details_envelope site_claim_envelope,
                  assigned_function.function_name,
                  handoff.id handoff_id, handoff.status handoff_status,
                  handoff.version handoff_version,
                  handoff.target_role, handoff.due_at handoff_due_at,
                  handoff.reason_code handoff_reason_code,
                  handoff.created_at handoff_created_at,
                  current_order.id order_id, current_order.number order_number,
                  current_order.status order_status,
                  last_message.id last_message_id,
                  last_message.direction last_message_direction,
                  last_message.message_type last_message_type,
                  last_message.content_envelope last_message_content_envelope,
                  last_message.status last_message_status,
                  last_message.delivery_status last_message_delivery_status,
                  last_message.occurred_at last_message_occurred_at,
                  last_message.media_id, last_message.media_kind,
                  last_message.media_state, last_message.media_mime_type,
                  last_message.media_size_bytes, last_message.media_duration_ms,
                  last_message.media_validation_status,
                  last_message.reserved_workflow_version
           FROM crm.conversations conversation
           JOIN crm.contact_identities identity
             ON identity.id=conversation.contact_identity_id
           JOIN crm.contacts contact ON contact.id=identity.current_contact_id
           LEFT JOIN crm.site_contact_claims site_claim
             ON site_claim.conversation_id=conversation.id
           LEFT JOIN crm.user_functions assigned_function
             ON assigned_function.user_id=conversation.assigned_user_id
           LEFT JOIN LATERAL (
             SELECT candidate.id, candidate.status, candidate.version,
                    candidate.target_role,
                    candidate.due_at, candidate.reason_code,
                    candidate.created_at
             FROM crm.handoffs candidate
             WHERE candidate.conversation_id=conversation.id
               AND candidate.status IN ('pending','accepted')
             ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
           ) handoff ON true
           ${CURRENT_ORDER_JOIN}
           LEFT JOIN LATERAL (
             SELECT message.id, message.direction, message.message_type,
                    message.content_envelope, message.status,
                    message.delivery_status, message.occurred_at,
                    ${MEDIA_PROJECTION}
             FROM crm.messages message
             ${MEDIA_JOIN}
             WHERE message.conversation_id=conversation.id
             ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1
           ) last_message ON true
           WHERE ${where}
           ORDER BY ${orderBy}
           LIMIT $${values.length}`,
          values,
        ),
        database.query(
          `SELECT count(*)::integer count
           FROM crm.conversations conversation
           JOIN crm.contact_identities identity
             ON identity.id=conversation.contact_identity_id
           WHERE ${countWhere}`,
          countValues,
        ),
      ]);
      const hasMore = page.rows.length > input.limit;
      return {
        hasMore,
        items: page.rows
          .slice(0, input.limit)
          .map((/** @type {any} */ row) => mapConversationSummary(row, this)),
        totalCount: Number(count.rows[0]?.count ?? 0),
      };
    });
  }

  /** @param {string} conversationId */
  async get(conversationId) {
    return this.#snapshot(async (database) => {
      const [conversation, messages, suggestion] = await runSequential([
        () =>
          database.query(
            `SELECT conversation.id, conversation.state,
                    conversation.automation_state, conversation.automation_epoch,
                    conversation.assigned_user_id, conversation.version,
                    conversation.opened_at, conversation.last_message_at,
                    conversation.terminal_at, conversation.archived_at,
                    conversation.closure_outcome, conversation.closed_by,
                    identity.current_contact_id contact_id, identity.channel,
                    identity.external_identity_lookup_hash,
                    identity.identity_envelope, contact.display_name,
                    contact.version contact_version,
                    site_claim.id site_claim_id, site_claim.version site_claim_version,
                    site_claim.details_envelope site_claim_envelope,
                    assigned_function.function_name,
                    handoff.id handoff_id, handoff.status handoff_status,
                    handoff.version handoff_version,
                    handoff.target_role, handoff.due_at handoff_due_at,
                    handoff.reason_code handoff_reason_code,
                    handoff.created_at handoff_created_at,
                    current_order.id order_id,
                    current_order.number order_number,
                    current_order.status order_status
             FROM crm.conversations conversation
             JOIN crm.contact_identities identity
               ON identity.id=conversation.contact_identity_id
             JOIN crm.contacts contact ON contact.id=identity.current_contact_id
             LEFT JOIN crm.site_contact_claims site_claim
               ON site_claim.conversation_id=conversation.id
             LEFT JOIN crm.user_functions assigned_function
               ON assigned_function.user_id=conversation.assigned_user_id
             LEFT JOIN LATERAL (
               SELECT candidate.id, candidate.status, candidate.version,
                      candidate.target_role,
                      candidate.due_at, candidate.reason_code,
                      candidate.created_at
               FROM crm.handoffs candidate
               WHERE candidate.conversation_id=conversation.id
                 AND candidate.status IN ('pending','accepted')
               ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
             ) handoff ON true
             ${CURRENT_ORDER_JOIN}
             WHERE conversation.id=$1`,
            [conversationId],
          ),
        () =>
          database.query(
            `SELECT message.id, message.conversation_id, message.direction,
                    message.author_kind, message.author_id, message.message_type,
                    message.content_envelope, message.status, message.delivery_status,
                    CASE WHEN message.delivery_status IN ('failed', 'outcome_unknown')
                               AND command.status IN ('failed', 'outcome_unknown')
                               AND command.last_error_code ~ '^[A-Z0-9_]{1,64}$'
                         THEN command.last_error_code ELSE NULL END delivery_error_code,
                    message.occurred_at, message.created_at, ${MEDIA_PROJECTION}
             FROM crm.messages message ${MEDIA_JOIN}
             LEFT JOIN crm.n8n_commands command ON command.message_id=message.id
             WHERE message.conversation_id=$1
             ORDER BY message.occurred_at, message.id`,
            [conversationId],
          ),
        () =>
          database.query(
            `SELECT id, conversation_id, source_message_id, automation_epoch,
                    proposed_stage, question_envelope, status, created_by,
                    created_at, resolved_at
             FROM crm.ai_suggestions
             WHERE conversation_id=$1 AND status='pending'
             ORDER BY created_at DESC, id DESC LIMIT 1`,
            [conversationId],
          ),
      ]);
      const row = conversation.rows[0];
      if (!row) throw notFound('CONVERSATION_NOT_FOUND');
      return {
        conversation: mapConversationSummary(row, this),
        messages: messages.rows.map((/** @type {any} */ message) =>
          mapMessage(message, this),
        ),
        suggestion: suggestion.rows[0]
          ? mapSuggestion(suggestion.rows[0], this)
          : null,
      };
    });
  }

  /**
   * Painel: what waits for a person right now, read in one snapshot. Only
   * counts and instants leave here; no envelope is opened.
   *
   * - `waitingHandoff`: handoffs nobody took yet; `overdueCount` are the ones
   *   past the `due_at` their SLA set when they opened.
   * - `mine`: the open conversations assigned to the reader, how many end
   *   on a client message (the client waits for an answer) and the reader's
   *   pending orders.
   * - `assistant`: conversations with the assistant, the ones whose last
   *   client message got no answer for `stallMinutes`, conversations with a
   *   failed or unknown send in the last 24 hours and the assistant's last
   *   reply in that window.
   *
   * @param {{actorId: string, now: Date, stallMinutes: number}} input
   */
  async summary({ actorId, now, stallMinutes }) {
    const at = now.toISOString();
    const stalledBefore = new Date(
      now.getTime() - stallMinutes * 60_000,
    ).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    return this.#snapshot(async (database) => {
      const [queue, myOrders, sends] = await Promise.all([
        database.query(
          `SELECT
             count(*) FILTER (WHERE handoff.status='pending')::integer waiting_count,
             count(*) FILTER (WHERE handoff.status='pending'
               AND handoff.due_at <= $2::timestamptz)::integer waiting_overdue_count,
             min(handoff.created_at) FILTER (WHERE handoff.status='pending') waiting_oldest_since,
             count(*) FILTER (WHERE conversation.assigned_user_id=$1)::integer mine_count,
             count(*) FILTER (WHERE conversation.assigned_user_id=$1
               AND last_message.direction='inbound')::integer mine_awaiting_count,
             min(last_message.occurred_at) FILTER (WHERE conversation.assigned_user_id=$1
               AND last_message.direction='inbound') mine_oldest_awaiting_since,
             count(*) FILTER (WHERE conversation.automation_state='assistant'
               AND handoff.id IS NULL)::integer assistant_active_count,
             count(*) FILTER (WHERE conversation.automation_state='assistant'
               AND handoff.id IS NULL AND last_message.direction='inbound'
               AND last_message.occurred_at <= $3::timestamptz)::integer assistant_stalled_count
           FROM crm.conversations conversation
           LEFT JOIN LATERAL (
             SELECT candidate.id, candidate.status, candidate.due_at,
                    candidate.created_at
             FROM crm.handoffs candidate
             WHERE candidate.conversation_id=conversation.id
               AND candidate.status IN ('pending','accepted')
             ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
           ) handoff ON true
           LEFT JOIN LATERAL (
             SELECT message.direction, message.occurred_at
             FROM crm.messages message
             WHERE message.conversation_id=conversation.id
             ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1
           ) last_message ON true
           WHERE conversation.archived_at IS NULL
             AND conversation.state NOT IN
               ('convertida_em_lead','sem_lead','encerrada')`,
          [actorId, at, stalledBefore],
        ),
        database.query(
          // The seller's pending orders, by the rule that names the seller:
          // the manual order they own, or the order of their conversation.
          `SELECT count(*)::integer pending_count
           FROM crm.orders orders
           LEFT JOIN crm.conversations conversation
             ON conversation.id = orders.conversation_id
           WHERE orders.status = 'pendente' AND NOT orders.is_test
             AND (orders.manual_owner_id = $1
               OR conversation.assigned_user_id = $1)`,
          [actorId],
        ),
        database.query(
          `SELECT
             count(DISTINCT message.conversation_id) FILTER (
               WHERE message.status IN ('failed','outcome_unknown')
                  OR message.delivery_status IN ('failed','outcome_unknown')
             )::integer failed_conversation_count,
             max(message.occurred_at) FILTER (
               WHERE message.author_kind='assistant'
             ) last_assistant_reply_at
           FROM crm.messages message
           WHERE message.direction='outbound'
             AND message.occurred_at > $1::timestamptz
             AND message.occurred_at <= $2::timestamptz`,
          [dayAgo, at],
        ),
      ]);
      const row = queue.rows[0] ?? {};
      const sent = sends.rows[0] ?? {};
      return Object.freeze({
        assistant: Object.freeze({
          activeCount: Number(row.assistant_active_count ?? 0),
          failedDeliveryCount: Number(sent.failed_conversation_count ?? 0),
          lastReplyAt: sent.last_assistant_reply_at
            ? iso(sent.last_assistant_reply_at)
            : null,
          stalledCount: Number(row.assistant_stalled_count ?? 0),
          stallMinutes,
        }),
        generatedAt: at,
        mine: Object.freeze({
          awaitingReplyCount: Number(row.mine_awaiting_count ?? 0),
          count: Number(row.mine_count ?? 0),
          pendingOrderCount: Number(myOrders.rows[0]?.pending_count ?? 0),
          oldestAwaitingSince: row.mine_oldest_awaiting_since
            ? iso(row.mine_oldest_awaiting_since)
            : null,
        }),
        waitingHandoff: Object.freeze({
          count: Number(row.waiting_count ?? 0),
          oldestSince: row.waiting_oldest_since
            ? iso(row.waiting_oldest_since)
            : null,
          overdueCount: Number(row.waiting_overdue_count ?? 0),
        }),
      });
    });
  }

  /** @template T @param {(database: any) => Promise<T>} work */
  async #snapshot(work) {
    if (typeof this.database.transaction !== 'function') {
      return work(this.database);
    }
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return work(client);
    });
  }
}

/** @param {any} row @param {PostgresInboxReadRepository} repository */
function mapConversationSummary(row, repository) {
  const identity = decryptContactIdentityEnvelope(
    row.identity_envelope,
    row.external_identity_lookup_hash,
    repository.contactEnvelopeKey,
  );
  const siteClaim =
    row.channel === 'site_chat' && row.site_claim_id
      ? decryptSiteContactClaim(
          row.site_claim_envelope,
          row.site_claim_id,
          Number(row.site_claim_version),
          repository.contactEnvelopeKey,
        )
      : null;
  const lastMessage = row.last_message_id
    ? mapMessage(
        {
          ...row,
          id: row.last_message_id,
          conversation_id: row.id,
          direction: row.last_message_direction,
          message_type: row.last_message_type,
          content_envelope: row.last_message_content_envelope,
          status: row.last_message_status,
          delivery_status: row.last_message_delivery_status,
          occurred_at: row.last_message_occurred_at,
        },
        repository,
      )
    : null;
  return Object.freeze({
    assignedUser: row.assigned_user_id
      ? { functionName: row.function_name, id: row.assigned_user_id }
      : null,
    automationEpoch: Number(row.automation_epoch),
    automationState: row.automation_state,
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    channel: row.channel,
    contact: {
      displayHandle: identity.displayHandle ?? null,
      displayName: row.display_name ?? null,
      externalId: identity.externalIdentityId,
      id: row.contact_id,
      phone: siteClaim?.phone ?? null,
      phoneSource: siteClaim ? 'site_unverified' : null,
      // Operator-chosen name wins; the channel handle is only the fallback.
      label:
        row.display_name ??
        identity.displayHandle ??
        identity.externalIdentityId ??
        `Contato ${row.contact_id}`,
      version:
        row.contact_version === undefined ? null : Number(row.contact_version),
    },
    handoff: row.handoff_id
      ? {
          dueAt: iso(row.handoff_due_at),
          id: row.handoff_id,
          status: row.handoff_status,
          createdAt: iso(row.handoff_created_at),
          reasonCode: row.handoff_reason_code,
          targetRole: row.target_role,
          version: Number(row.handoff_version),
        }
      : null,
    id: row.id,
    lastMessage,
    openedAt: iso(row.opened_at),
    order: row.order_id
      ? { id: row.order_id, number: row.order_number, status: row.order_status }
      : null,
    requiresAttention:
      row.state === 'requer_atencao' ||
      row.handoff_status === 'pending' ||
      ['failed', 'outcome_unknown'].includes(
        String(row.last_message_delivery_status ?? row.last_message_status),
      ),
    state: row.state,
    closureOutcome: row.closure_outcome ?? null,
    closedBy: row.closed_by ?? null,
    terminalAt: row.terminal_at ? iso(row.terminal_at) : null,
    updatedAt: iso(row.last_message_at),
    version: Number(row.version),
  });
}

/** @param {any} row @param {PostgresInboxReadRepository} repository */
function mapMessage(row, repository) {
  const content = decryptInboxMessageEnvelope(
    row.content_envelope,
    row.id,
    repository.messageEnvelopeKey,
  );
  const missingDocumentImage =
    row.direction === 'inbound' &&
    row.message_type === 'document' &&
    DOCUMENT_IMAGE_MIME_TYPES.has(content.mimeType)
      ? Object.freeze({
          mediaId: null,
          kind: 'image',
          state: 'unavailable',
          mimeType: content.mimeType,
          sizeBytes: null,
          durationMs: null,
          contentUrl: null,
        })
      : null;
  return Object.freeze({
    authorId: row.author_id,
    authorKind: row.author_kind,
    createdAt: row.created_at ? iso(row.created_at) : iso(row.occurred_at),
    deliveryErrorCode: DELIVERY_ERROR_CODES.has(row.delivery_error_code)
      ? row.delivery_error_code
      : null,
    deliveryStatus: row.delivery_status ?? null,
    direction: row.direction,
    id: row.id,
    media: row.media_id
      ? Object.freeze({
          mediaId: row.media_id,
          kind: row.media_kind,
          state: row.media_state,
          mimeType: row.media_mime_type ?? null,
          sizeBytes:
            row.media_size_bytes === null || row.media_size_bytes === undefined
              ? null
              : Number(row.media_size_bytes),
          durationMs:
            row.media_duration_ms === null ||
            row.media_duration_ms === undefined
              ? null
              : Number(row.media_duration_ms),
          contentUrl:
            row.media_state === 'attached' &&
            row.media_validation_status === 'clean'
              ? `/api/v1/conversations/${encodeURIComponent(row.conversation_id)}/media/${encodeURIComponent(row.media_id)}/content`
              : null,
        })
      : missingDocumentImage,
    deliveryMode: row.reserved_workflow_version
      ? /^dev-mvp-simple-\d+$/u.test(row.reserved_workflow_version)
        ? 'dev'
        : 'official'
      : null,
    occurredAt: iso(row.occurred_at),
    preview: messagePreview(content, row.message_type),
    status: row.status,
    type: row.message_type,
  });
}

/** @param {any} row @param {PostgresInboxReadRepository} repository */
function mapSuggestion(row, repository) {
  const question = decryptInboxMessageEnvelope(
    row.question_envelope,
    `suggestion:${row.id}`,
    repository.messageEnvelopeKey,
    true,
  );
  return Object.freeze({
    automationEpoch: Number(row.automation_epoch),
    createdAt: iso(row.created_at),
    id: row.id,
    proposedStage: row.proposed_stage,
    question: messagePreview(question, 'text'),
    sourceMessageId: row.source_message_id,
    status: row.status,
  });
}

/** @param {Record<string, any>} content @param {string} type */
function messagePreview(content, type) {
  const candidate = content.text ?? content.caption;
  if (typeof candidate === 'string' && candidate.trim())
    return candidate.trim();
  const labels = /** @type {Record<string, string>} */ ({
    audio: 'Áudio',
    document: 'Documento',
    image: 'Imagem',
    template: 'Mensagem de modelo',
    video: 'Vídeo',
  });
  return labels[type] ?? 'Mensagem';
}

/** @param {Array<() => Promise<any>>} operations */
async function runSequential(operations) {
  const results = [];
  for (const operation of operations) results.push(await operation());
  return results;
}

/** @param {any} value */
function iso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** @param {string} code */
function notFound(code) {
  return Object.assign(new Error(code), { code, statusCode: 404 });
}
