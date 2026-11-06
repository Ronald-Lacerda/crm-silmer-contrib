import { decryptSiteContactClaim } from '@crm-silmer/contacts';
import { decryptContactIdentityEnvelope } from '@crm-silmer/contacts/identity-envelope';
import {
  INBOX_BUCKETS,
  SILENT_AFTER_HOURS,
  activeLeadLossSql,
} from '../turn-policy.js';
import { decryptInboxMessageEnvelope } from './postgres-inbox-repository.js';

// PNL-06: sellers with the same count read in alphabetical order, the same
// on every server whatever the database collation.
const SELLER_NAME_ORDER = new Intl.Collator('pt-BR', { sensitivity: 'base' });

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
  // INBOX-DELIVERY-02: the assistant's send outcome as the workflow reports
  // it; the two generic codes are the CRM defaults.
  'META_SEND_OUTCOME_UNKNOWN',
  'SEND_FAILED',
  'SEND_OUTCOME_UNKNOWN',
]);

/**
 * The conversation's open handoff (at most one is pending or accepted) and,
 * INBOX-HANDOFF-02, the first name of the seller the customer asked for.
 */
const OPEN_HANDOFF_JOIN = `LEFT JOIN LATERAL (
             SELECT candidate.id, candidate.status, candidate.version,
                    candidate.target_role,
                    candidate.due_at, candidate.reason_code,
                    candidate.created_at,
                    split_part(preferred.name, ' ', 1) preferred_first_name
             FROM crm.handoffs candidate
             LEFT JOIN crm.users preferred
               ON preferred.id=candidate.preferred_user_id
             WHERE candidate.conversation_id=conversation.id
               AND candidate.status IN ('pending','accepted')
             ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
           ) handoff ON true`;

/**
 * The order the Inbox shows for a conversation: the pending one, otherwise the
 * most recently confirmed (same rule as GET /conversations/:id/order). Only
 * plain columns are read; the ficha stays encrypted.
 */
const CURRENT_ORDER_JOIN = `LEFT JOIN LATERAL (
             SELECT candidate_order.id, candidate_order.number,
                    candidate_order.status, candidate_order.created_at,
                    (candidate_order.status='pendente'
                      AND NOT candidate_order.is_test
                      AND cardinality(candidate_order.missing_fields)=0
                      AND candidate_order.total_pieces>0
                      AND candidate_order.final_amount_cents>0
                      AND candidate_order.payment_condition IS NOT NULL) ready_for_confirmation
             FROM crm.orders candidate_order
             WHERE candidate_order.conversation_id=conversation.id
               AND candidate_order.cancelled_at IS NULL
             ORDER BY (candidate_order.status = 'pendente') DESC,
                      candidate_order.confirmed_at DESC NULLS LAST,
                      candidate_order.number_sequence DESC
             LIMIT 1
           ) current_order ON true`;

// CP-10 / INBOX-UX-03: mirror the closure guard, including pending orders
// linked only by a subject. Do not change the canonical order or expose data
// from another cycle: this projection is only an acknowledgement signal.
const HAS_PENDING_ORDER = `EXISTS (
             SELECT 1 FROM crm.orders pending_order
             WHERE pending_order.conversation_id=conversation.id
               AND pending_order.status='pendente' AND pending_order.cancelled_at IS NULL
             UNION ALL
             SELECT 1 FROM crm.conversation_subjects pending_subject
             JOIN crm.orders linked_order ON linked_order.id=pending_subject.order_id
             WHERE pending_subject.conversation_id=conversation.id
               AND linked_order.status='pendente' AND linked_order.cancelled_at IS NULL
           ) has_pending_order`;

// The canonical header order remains unchanged. Review chooses one explicit,
// actionable ready order across this conversation's orders and linked subjects.
// A link to another cycle never transfers that order's ownership.
const REVIEW_ORDER_JOIN = `LEFT JOIN LATERAL (
             SELECT candidate.id, candidate.number, candidate.status, candidate.created_at
             FROM crm.orders candidate
             LEFT JOIN crm.conversations order_conversation ON order_conversation.id=candidate.conversation_id
             WHERE candidate.status='pendente' AND NOT candidate.is_test
               AND candidate.cancelled_at IS NULL
               AND cardinality(candidate.missing_fields)=0 AND candidate.total_pieces>0
               AND candidate.final_amount_cents>0 AND candidate.payment_condition IS NOT NULL
               AND (candidate.conversation_id=conversation.id OR EXISTS (
                 SELECT 1 FROM crm.conversation_subjects linked
                 WHERE linked.conversation_id=conversation.id AND linked.order_id=candidate.id))
               AND ((candidate.conversation_id=conversation.id
                    AND (conversation.assigned_user_id IS NOT NULL OR handoff.status='pending'))
                 OR (conversation.assigned_user_id IS NOT NULL
                   AND ((candidate.conversation_id<>conversation.id
                         AND order_conversation.assigned_user_id=conversation.assigned_user_id)
                     OR (candidate.conversation_id IS NULL
                         AND candidate.manual_owner_id=conversation.assigned_user_id))))
             ORDER BY EXISTS (SELECT 1 FROM crm.conversation_subjects selected
                        WHERE selected.conversation_id=conversation.id AND selected.order_id=candidate.id
                          AND selected.is_current) DESC,
                      candidate.created_at ASC,candidate.number_sequence ASC,candidate.id ASC
             LIMIT 1
           ) review_order ON true`;

// INBOX-UX-02: an automatic acknowledgement never resets a person's wait.
// Only a successfully sent human reply ends the current inbound sequence.
const HUMAN_WAIT_JOIN = `LEFT JOIN LATERAL (
             SELECT reply.occurred_at, reply.id
             FROM crm.messages reply
             WHERE reply.conversation_id=conversation.id
               AND reply.direction='outbound' AND reply.author_kind='human'
               AND COALESCE(reply.delivery_status,reply.status) IN ('sent','delivered','read')
             ORDER BY reply.occurred_at DESC, reply.id DESC LIMIT 1
           ) human_reply ON true
           LEFT JOIN LATERAL (
             SELECT min(inbound.occurred_at) since
             FROM crm.messages inbound
             WHERE inbound.conversation_id=conversation.id AND inbound.direction='inbound'
               AND (human_reply.id IS NULL
                 OR (inbound.occurred_at,inbound.id) > (human_reply.occurred_at,human_reply.id))
           ) unanswered ON true
           LEFT JOIN LATERAL (
             SELECT event.occurred_at
             FROM crm.audit_events event
             WHERE event.target_type='conversation' AND event.target_id=conversation.id
               AND event.action='conversation.takeover'
             ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1
           ) takeover ON true`;
// The send outcome of a conversation: its last effective send and a failure
// or uncertain result after it. Shared with the INBOX-VEZ-01 tabs, where a
// failure keeps the turn with the Silmer.
const DELIVERY_JOIN = `LEFT JOIN LATERAL (
             SELECT sent.id,sent.occurred_at
             FROM crm.messages sent
             WHERE sent.conversation_id=conversation.id AND sent.direction='outbound'
               AND COALESCE(sent.delivery_status,sent.status) IN ('sent','delivered','read')
             ORDER BY sent.occurred_at DESC, sent.id DESC LIMIT 1
           ) successful_outbound ON true
           LEFT JOIN LATERAL (
             SELECT failed.status,failed.delivery_status,failed.occurred_at
             FROM crm.messages failed
             WHERE failed.conversation_id=conversation.id AND failed.direction='outbound'
               AND COALESCE(failed.delivery_status,failed.status) IN ('failed','outcome_unknown')
               AND (successful_outbound.id IS NULL
                 OR (failed.occurred_at,failed.id)>(successful_outbound.occurred_at,successful_outbound.id))
             ORDER BY failed.occurred_at DESC,failed.id DESC LIMIT 1
           ) last_outbound ON true`;
const WAITING_JOIN = `${HUMAN_WAIT_JOIN}
           ${DELIVERY_JOIN}`;
const WAITING_SINCE = `CASE WHEN handoff.status='pending' THEN handoff.created_at
  WHEN conversation.automation_state='human' THEN
    CASE WHEN handoff.status='accepted'
              AND (human_reply.id IS NULL OR human_reply.occurred_at<handoff.created_at)
           THEN handoff.created_at
         WHEN handoff.id IS NULL AND takeover.occurred_at IS NOT NULL
              AND (human_reply.id IS NULL OR human_reply.occurred_at<takeover.occurred_at)
           THEN takeover.occurred_at
         WHEN human_reply.id IS NOT NULL THEN unanswered.since END END`;
// A legacy human conversation can owe a reply without a reliable start for
// its displayed wait. Keep that action distinct from inventing a duration.
const AWAITING_HUMAN = `(handoff.status='pending'
  OR (conversation.automation_state='human'
    AND ((${WAITING_SINCE}) IS NOT NULL OR unanswered.since IS NOT NULL)))`;
const DELIVERY_ISSUE = `CASE
  WHEN COALESCE(last_outbound.delivery_status,last_outbound.status) IN ('failed','outcome_unknown')
  THEN COALESCE(last_outbound.delivery_status,last_outbound.status) END`;
const QUEUE_POSITION = `COALESCE(${WAITING_SINCE},
  CASE WHEN ${DELIVERY_ISSUE} IS NOT NULL THEN last_outbound.occurred_at END,
  review_order.created_at,current_order.created_at,conversation.opened_at)`;
const PRIORITY_PROJECTION = `${WAITING_SINCE} waiting_since,
  ${QUEUE_POSITION} queue_position, ${DELIVERY_ISSUE} delivery_issue_status,
  last_outbound.occurred_at delivery_issue_at`;

// PCX-17 / INBOX-UX-05: urgency is an ordering, never an ownership filter.
// All inputs are official plain projections; no summary or ficha is decrypted
// to infer urgency, deadlines or commercial readiness. Terminal/archive state
// wins over stale handoffs, delivery failures and ready orders.
const URGENCY_RANK = `CASE
  WHEN conversation.archived_at IS NOT NULL OR conversation.terminal_at IS NOT NULL
    OR conversation.state IN ('convertida_em_lead','sem_lead','encerrada') THEN 6
  WHEN ${DELIVERY_ISSUE} IS NOT NULL THEN 0
  WHEN handoff.reason_code='urgency'
    AND ${AWAITING_HUMAN} THEN 1
  WHEN ${AWAITING_HUMAN} THEN 2
  WHEN review_order.id IS NOT NULL THEN 3
  WHEN conversation.automation_state='human' THEN 4
  ELSE 5 END`;
const URGENCY_JOIN = `LEFT JOIN LATERAL (
  SELECT ${URGENCY_RANK} rank, date_trunc('milliseconds', ${QUEUE_POSITION}) position
) urgency ON true`;

// The list's joins from the conversation outwards (the page shows all of them).
const SUMMARY_JOINS = `JOIN crm.contact_identities identity
             ON identity.id=conversation.contact_identity_id
           JOIN crm.contacts contact ON contact.id=identity.current_contact_id
           LEFT JOIN crm.site_contact_claims site_claim
             ON site_claim.conversation_id=conversation.id
           LEFT JOIN crm.user_functions assigned_function
             ON assigned_function.user_id=conversation.assigned_user_id
           LEFT JOIN crm.users assigned_user ON assigned_user.id=conversation.assigned_user_id
           ${OPEN_HANDOFF_JOIN}
           ${CURRENT_ORDER_JOIN}
           ${REVIEW_ORDER_JOIN}
           ${WAITING_JOIN}`;
const LAST_MESSAGE_JOIN = `LEFT JOIN LATERAL (
             SELECT message.id, message.direction, message.message_type,
                    message.content_envelope, message.status,
                    message.delivery_status, message.occurred_at,
                    ${MEDIA_PROJECTION}
             FROM crm.messages message
             ${MEDIA_JOIN}
             WHERE message.conversation_id=conversation.id
             ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1
           ) last_message ON true`;

/** @param {boolean} byUrgency */
function listProjection(byUrgency) {
  return `conversation.id, conversation.state,
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
                  assigned_function.function_name, assigned_user.name assigned_user_name,
                  handoff.id handoff_id, handoff.status handoff_status,
                  handoff.version handoff_version,
                  handoff.target_role, handoff.due_at handoff_due_at,
                  handoff.reason_code handoff_reason_code,
                  handoff.created_at handoff_created_at,
                  handoff.preferred_first_name handoff_preferred_first_name,
                  current_order.id order_id, current_order.number order_number,
                  current_order.status order_status,
                  current_order.ready_for_confirmation order_ready_for_confirmation,
                  ${HAS_PENDING_ORDER},
                  review_order.id review_order_id,review_order.number review_order_number,
                  review_order.status review_order_status,
                  ${PRIORITY_PROJECTION},
                  ${byUrgency ? 'urgency.rank urgency_rank, urgency.position urgency_position,' : ''}
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
                  last_message.reserved_workflow_version`;
}

// INBOX-VEZ-01 / RFC 052: "whose turn is it". Every open conversation belongs
// to exactly one tab. The rule is written once, here: the list, its total and
// `bucketCounts` all join `turnJoins` and read `turn_state.bucket`.
const OPEN_UNIVERSE = `conversation.archived_at IS NULL AND conversation.terminal_at IS NULL
  AND conversation.state NOT IN ('convertida_em_lead','sem_lead','encerrada')`;

const TURN_COLUMNS = `turn_state.bucket turn_bucket, turn.rank turn_rank,
  turn.since turn_since, turn_state.stalled turn_stalled,
  loss.reason_code lost_reason_code, loss.occurred_at lost_occurred_at,
  loss.version lost_version,
  reminder.remind_at reminder_remind_at, reminder.mine reminder_mine`;
const TURN_NAMES = [
  'turn_bucket',
  'turn_rank',
  'turn_since',
  'turn_stalled',
  'lost_reason_code',
  'lost_occurred_at',
  'lost_version',
  'reminder_remind_at',
  'reminder_mine',
];

/** @param {string} since @param {{now: string}} p */
function businessMinutes(since, p) {
  return `floor(crm.business_minutes_v1(${since}, ${p.now}::timestamptz))::integer turn_business_minutes`;
}

/**
 * D2: the reminder is per person. One row per conversation, computed once per
 * query (the key starts with the user, so no per-row lookup): the reader's own
 * first, then the nearest. A reminder holds while it is in the future and the
 * conversation has not changed since it was set.
 * @param {{now: string, actor: string, ids?: string}} p
 */
function reminderCte(p) {
  return `reminders AS MATERIALIZED (
           SELECT DISTINCT ON (decision.target_id)
                  decision.target_id conversation_id, decision.remind_at,
                  COALESCE(decision.user_id=${p.actor}::text, false) mine
           FROM crm.dashboard_action_decisions decision
           JOIN crm.conversations decided ON decided.id=decision.target_id
           WHERE decision.target_type='conversation'
             AND decision.decision IN ('schedule','snooze')
             AND decision.remind_at > ${p.now}::timestamptz
             AND decision.action_id='conversation:' || decision.target_id
             AND decision.target_version=decided.version
             ${p.ids ? `AND decision.target_id = ANY(${p.ids}::text[])` : ''}
           ORDER BY decision.target_id,
                    COALESCE(decision.user_id=${p.actor}::text, false) DESC,
                    decision.remind_at ASC, decision.user_id ASC)`;
}

/**
 * Needs `conversation` and `handoff` (OPEN_HANDOFF_JOIN) in scope and the
 * `reminders` CTE. Aliases it defines: `turn_state` (bucket, stalled),
 * `turn` (rank, since), `loss` and `reminder`.
 *
 * Precedence, first that matches: send failure (respond, rank 0) > active
 * loss > pending handoff (respond) > the customer wrote last (respond, or
 * awaiting while the assistant is still inside its window) > the customer's
 * turn for 72 h (silent, unless the reader set a reminder) > awaiting.
 * @param {{now: string, stalled: string, silent: string}} p
 */
function turnJoins(p) {
  return `LEFT JOIN LATERAL (
             SELECT m.id, m.occurred_at FROM crm.messages m
             WHERE m.conversation_id=conversation.id
               AND m.direction='inbound' AND m.author_kind='contact'
             ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1
           ) last_inbound ON true
           LEFT JOIN LATERAL (
             SELECT m.id, m.occurred_at FROM crm.messages m
             WHERE m.conversation_id=conversation.id AND m.direction='outbound'
               AND COALESCE(m.delivery_status,m.status) IN ('sent','delivered','read')
               AND (m.author_kind='human'
                 OR (m.author_kind='assistant'
                   AND conversation.automation_state='assistant'))
             ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1
           ) effective_reply ON true
           ${DELIVERY_JOIN}
           LEFT JOIN LATERAL (
             SELECT latest.reason_code, latest.occurred_at, latest.version
             FROM crm.lead_outcome_events latest
             WHERE latest.conversation_id=conversation.id AND latest.outcome='lost'
               AND ${activeLeadLossSql('conversation.id')}
             ORDER BY latest.version DESC LIMIT 1
           ) loss ON true
           LEFT JOIN reminders reminder ON reminder.conversation_id=conversation.id
           LEFT JOIN LATERAL (
             SELECT f.failed, f.handoff_pending, f.customer_turn,
               CASE WHEN NOT f.in_universe THEN NULL
                 WHEN f.failed THEN 'respond'
                 WHEN f.lost_active THEN 'lost'
                 WHEN f.handoff_pending THEN 'respond'
                 WHEN f.customer_turn THEN
                   CASE WHEN f.agent_alone
                          AND last_inbound.occurred_at > ${p.stalled}::timestamptz
                     THEN 'awaiting' ELSE 'respond' END
                 WHEN effective_reply.id IS NOT NULL
                   AND effective_reply.occurred_at <= ${p.silent}::timestamptz
                   AND NOT f.own_reminder THEN 'silent'
                 ELSE 'awaiting' END bucket,
               (f.in_universe AND f.agent_alone AND f.customer_turn
                 AND last_inbound.occurred_at <= ${p.stalled}::timestamptz) stalled
             FROM (SELECT
                 (${OPEN_UNIVERSE}) in_universe,
                 (${DELIVERY_ISSUE}) IS NOT NULL failed,
                 loss.version IS NOT NULL lost_active,
                 COALESCE(handoff.status='pending', false) handoff_pending,
                 (conversation.automation_state='assistant' AND handoff.id IS NULL) agent_alone,
                 (last_inbound.id IS NOT NULL AND (effective_reply.id IS NULL
                   OR (last_inbound.occurred_at,last_inbound.id)
                     > (effective_reply.occurred_at,effective_reply.id))) customer_turn,
                 COALESCE(reminder.mine, false) own_reminder) f
           ) turn_state ON true
           LEFT JOIN LATERAL (
             SELECT
               CASE turn_state.bucket
                 WHEN 'respond' THEN CASE WHEN turn_state.failed THEN 0 ELSE 1 END
                 ELSE 0 END rank,
               date_trunc('milliseconds', CASE turn_state.bucket
                 WHEN 'respond' THEN CASE WHEN turn_state.failed
                   THEN last_outbound.occurred_at
                   ELSE COALESCE(LEAST(
                     (SELECT min(m.occurred_at) FROM crm.messages m
                      WHERE m.conversation_id=conversation.id
                        AND m.direction='inbound' AND m.author_kind='contact'
                        AND (effective_reply.id IS NULL
                          OR (m.occurred_at,m.id)
                            > (effective_reply.occurred_at,effective_reply.id))),
                     CASE WHEN turn_state.handoff_pending THEN handoff.created_at END),
                     conversation.opened_at) END
                 WHEN 'awaiting' THEN CASE WHEN turn_state.customer_turn
                   THEN last_inbound.occurred_at
                   ELSE COALESCE(effective_reply.occurred_at, conversation.opened_at) END
                 WHEN 'silent' THEN effective_reply.occurred_at
                 WHEN 'lost' THEN loss.occurred_at END) since
           ) turn ON true`;
}

/**
 * Per tab: the order (SQL, before LIMIT) and the cursor comparator. Positions
 * are truncated to milliseconds, as in URGENCY_JOIN, so the cursor round-trips.
 * @type {Record<string, {orderBy: (columns: string[]) => string, after: (columns: string[], first: number) => string}>}
 */
const BUCKET_ORDER = {
  respond: {
    orderBy: ([, since, id]) => `${since} DESC, ${id} DESC`,
    after: ([, since, id], first) =>
      `(${since}, ${id}) < ($${first}::timestamptz, $${first + 1})`,
  },
  awaiting: {
    orderBy: ([, since, id]) => `${since} DESC, ${id} DESC`,
    after: ([, since, id], first) =>
      `(${since}, ${id}) < ($${first}::timestamptz, $${first + 1})`,
  },
  silent: {
    orderBy: ([, since, id]) => `${since} ASC, ${id} ASC`,
    after: ([, since, id], first) =>
      `(${since}, ${id}) > ($${first}::timestamptz, $${first + 1})`,
  },
  lost: {
    orderBy: ([, since, id]) => `${since} DESC, ${id} DESC`,
    after: ([, since, id], first) =>
      `(${since}, ${id}) < ($${first}::timestamptz, $${first + 1})`,
  },
};

/**
 * The reader and the server instant the turn is worked out on, with the
 * thresholds as instants. `null` when the caller gave none.
 * @param {{actorId?: string|null, now?: Date, stallMinutes?: number}} reader
 * @param {string|undefined} fallbackActor
 */
function turnContext(reader, fallbackActor) {
  const now = reader?.now;
  const stallMinutes = reader?.stallMinutes;
  if (
    !(now instanceof Date) ||
    Number.isNaN(now.getTime()) ||
    typeof stallMinutes !== 'number' ||
    !(stallMinutes > 0)
  ) {
    return null;
  }
  return Object.freeze({
    actorId: reader.actorId ?? fallbackActor ?? null,
    nowIso: now.toISOString(),
    silentBefore: new Date(
      now.getTime() - SILENT_AFTER_HOURS * 3_600_000,
    ).toISOString(),
    stalledBefore: new Date(
      now.getTime() - stallMinutes * 60_000,
    ).toISOString(),
  });
}

/**
 * Appends the four query parameters of the turn and names them.
 * @param {unknown[]} values @param {NonNullable<ReturnType<typeof turnContext>>} turn
 */
function turnParameters(values, turn) {
  const first = values.length;
  values.push(turn.nowIso, turn.stalledBefore, turn.silentBefore, turn.actorId);
  return {
    now: `$${first + 1}`,
    stalled: `$${first + 2}`,
    silent: `$${first + 3}`,
    actor: `$${first + 4}`,
  };
}

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

  /**
   * @param {Record<string, any>} input
   * @param {{actorId?: string|null, now?: Date, stallMinutes?: number}} [reader]
   *   INBOX-VEZ-01: the reader and the server instant the turn is worked out
   *   on. Without it the item carries no turn fields.
   */
  async list(input, reader = {}) {
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
      if (input.workQueue) {
        values.push(input.actorId);
        const actor = `$${values.length}`;
        predicates.push(
          "conversation.state NOT IN ('convertida_em_lead','sem_lead','encerrada')",
          'conversation.archived_at IS NULL',
          `(conversation.assigned_user_id=${actor}
            OR (conversation.assigned_user_id IS NULL AND
              (handoff.status='pending'${input.workQueue === 'attention' ? ` OR ${DELIVERY_ISSUE} IS NOT NULL` : ''})))`,
        );
        if (input.workQueue === 'closing') {
          predicates.push('review_order.id IS NOT NULL');
        } else {
          predicates.push(`(${AWAITING_HUMAN}
            OR ${DELIVERY_ISSUE} IS NOT NULL)`);
        }
      }
      if (input.terminal) {
        // D7: "Encerradas", a consultation outside the tabs.
        predicates.push(
          `(conversation.state IN ('convertida_em_lead','sem_lead','encerrada')
            OR conversation.terminal_at IS NOT NULL)`,
        );
      }
      if (input.owner === 'mine') {
        values.push(input.actorId ?? reader.actorId);
        predicates.push(`conversation.assigned_user_id = $${values.length}`);
      } else if (input.owner === 'unassigned') {
        predicates.push('conversation.assigned_user_id IS NULL');
      }
      const turn = turnContext(reader, input.actorId);
      if (input.bucket) {
        if (!turn || !INBOX_BUCKETS.includes(input.bucket)) {
          throw new TypeError(
            'bucket reads need a valid bucket, now and stall',
          );
        }
        return this.#listByBucket(database, input, turn, values, predicates);
      }
      const countValues = [...values];
      const countWhere = predicates.join(' AND ');
      // "Aguardando vendedor" puts the longest wait first; every other view
      // keeps the most recent message first.
      const byUrgency = input.sort === 'urgency';
      const byWaitingTime =
        Boolean(input.workQueue) || input.pendingHandoff === true;
      const position = input.workQueue ? QUEUE_POSITION : 'handoff.created_at';
      const pagePredicates = [...predicates];
      if (input.after) {
        if (byUrgency) {
          values.push(input.after.rank, input.after.updatedAt, input.after.id);
          pagePredicates.push(
            `(urgency.rank, urgency.position, conversation.id) > ($${values.length - 2}::integer, $${values.length - 1}::timestamptz, $${values.length})`,
          );
        } else {
          values.push(input.after.updatedAt, input.after.id);
          pagePredicates.push(
            byWaitingTime
              ? `(${position}, conversation.id) > ($${values.length - 1}::timestamptz, $${values.length})`
              : `(conversation.last_message_at, conversation.id) < ($${values.length - 1}, $${values.length})`,
          );
        }
      }
      const where = pagePredicates.join(' AND ');
      const orderBy = byUrgency
        ? 'urgency.rank ASC, urgency.position ASC, conversation.id ASC'
        : byWaitingTime
          ? `${position} ASC, conversation.id ASC`
          : 'conversation.last_message_at DESC, conversation.id DESC';
      values.push(input.limit + 1);
      const [page, count] = await Promise.all([
        database.query(
          `SELECT ${listProjection(byUrgency)}
           FROM crm.conversations conversation
           ${SUMMARY_JOINS}
           ${byUrgency ? URGENCY_JOIN : ''}
           ${LAST_MESSAGE_JOIN}
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
           ${input.workQueue ? `${OPEN_HANDOFF_JOIN} ${CURRENT_ORDER_JOIN} ${REVIEW_ORDER_JOIN} ${WAITING_JOIN}` : ''}
           WHERE ${countWhere}`,
          countValues,
        ),
      ]);
      const hasMore = page.rows.length > input.limit;
      const rows = page.rows.slice(0, input.limit);
      const last = rows.at(-1);
      // INBOX-VEZ-01: the turn fields of the page, worked out by the same
      // fragment as the tabs, for the rows already chosen.
      const turnRows = await this.#turnRows(
        database,
        rows.map((/** @type {any} */ row) => row.id),
        turn,
      );
      return {
        hasMore,
        items: rows.map((/** @type {any} */ row) =>
          mapConversationSummary(
            { ...row, ...turnRows.get(row.id) },
            this,
            turn?.nowIso ?? null,
          ),
        ),
        ...(byUrgency && last
          ? {
              nextPosition: {
                rank: Number(last.urgency_rank),
                updatedAt: new Date(last.urgency_position).toISOString(),
              },
            }
          : {}),
        totalCount: Number(count.rows[0]?.count ?? 0),
      };
    });
  }

  /**
   * @param {string} conversationId
   * @param {{actorId?: string|null, now?: Date, stallMinutes?: number}} [reader]
   *   INBOX-VEZ-01: without it the turn fields stay empty.
   */
  async get(conversationId, reader = {}) {
    const turn = turnContext(reader, undefined);
    return this.#snapshot(async (database) => {
      const [conversation, messages, suggestion, turnRows] =
        await runSequential([
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
                    assigned_function.function_name, assigned_user.name assigned_user_name,
                    handoff.id handoff_id, handoff.status handoff_status,
                    handoff.version handoff_version,
                    handoff.target_role, handoff.due_at handoff_due_at,
                    handoff.reason_code handoff_reason_code,
                    handoff.created_at handoff_created_at,
                  handoff.preferred_first_name handoff_preferred_first_name,
                    current_order.id order_id,
                    current_order.number order_number,
                    current_order.status order_status,
                    current_order.ready_for_confirmation order_ready_for_confirmation,
                    ${HAS_PENDING_ORDER},
                    review_order.id review_order_id,review_order.number review_order_number,
                    review_order.status review_order_status,
                    ${PRIORITY_PROJECTION}
             FROM crm.conversations conversation
             JOIN crm.contact_identities identity
               ON identity.id=conversation.contact_identity_id
             JOIN crm.contacts contact ON contact.id=identity.current_contact_id
             LEFT JOIN crm.site_contact_claims site_claim
               ON site_claim.conversation_id=conversation.id
             LEFT JOIN crm.user_functions assigned_function
               ON assigned_function.user_id=conversation.assigned_user_id
             LEFT JOIN crm.users assigned_user ON assigned_user.id=conversation.assigned_user_id
             ${OPEN_HANDOFF_JOIN}
             ${CURRENT_ORDER_JOIN}
             ${REVIEW_ORDER_JOIN}
             ${WAITING_JOIN}
             WHERE conversation.id=$1`,
              [conversationId],
            ),
          () =>
            database.query(
              `SELECT message.id, message.conversation_id, message.direction,
                    message.author_kind, message.author_id, message.message_type,
                    message.content_envelope, message.status, message.delivery_status,
                    CASE WHEN message.delivery_status NOT IN ('failed', 'outcome_unknown')
                           OR message.delivery_status IS NULL THEN NULL
                         -- INBOX-DELIVERY-02: the assistant's own code.
                         WHEN message.author_kind = 'assistant'
                           THEN message.delivery_failure_code
                         WHEN command.status IN ('failed', 'outcome_unknown')
                               AND command.last_error_code ~ '^[A-Z0-9_]{1,64}$'
                         THEN command.last_error_code ELSE NULL END delivery_error_code,
                    message.transcript_status, message.transcript_envelope,
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
          () => this.#turnRows(database, [conversationId], turn),
        ]);
      const row = conversation.rows[0];
      if (!row) throw notFound('CONVERSATION_NOT_FOUND');
      return {
        conversation: mapConversationSummary(
          { ...row, ...turnRows.get(row.id) },
          this,
          turn?.nowIso ?? null,
        ),
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
   * - `unanswered` (PNL-06, manager only): open conversations assigned to a
   *   seller whose last message is the client's and is `unansweredMinutes`
   *   old or older, per seller. Only the caller decides who may read it: a
   *   null `unansweredMinutes` returns null and runs no query. Seller ids,
   *   seller names and counts only; nothing about the customer.
   *
   * @param {{actorId: string, now: Date, stallMinutes: number, unansweredMinutes?: number|null}} input
   */
  async summary({ actorId, now, stallMinutes, unansweredMinutes = null }) {
    const at = now.toISOString();
    const stalledBefore = new Date(
      now.getTime() - stallMinutes * 60_000,
    ).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    if (
      unansweredMinutes !== null &&
      (!Number.isSafeInteger(unansweredMinutes) || unansweredMinutes < 1)
    ) {
      throw new TypeError('unansweredMinutes must be a positive integer');
    }
    return this.#snapshot(async (database) => {
      const [queue, myOrders, sends, unanswered] = await Promise.all([
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
             AND orders.cancelled_at IS NULL
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
        unansweredMinutes === null
          ? null
          : database.query(
              `SELECT conversation.assigned_user_id user_id, seller.name,
                      count(*)::integer unanswered_count
               FROM crm.conversations conversation
               JOIN crm.users seller
                 ON seller.id = conversation.assigned_user_id
               JOIN LATERAL (
                 SELECT message.direction, message.occurred_at
                 FROM crm.messages message
                 WHERE message.conversation_id=conversation.id
                 ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1
               ) last_message ON true
               WHERE conversation.archived_at IS NULL
                 AND conversation.state NOT IN
                   ('convertida_em_lead','sem_lead','encerrada')
                 AND conversation.assigned_user_id IS NOT NULL
                 AND last_message.direction='inbound'
                 AND last_message.occurred_at <= $1::timestamptz
               GROUP BY conversation.assigned_user_id, seller.name`,
              [
                new Date(
                  now.getTime() - unansweredMinutes * 60_000,
                ).toISOString(),
              ],
            ),
      ]);
      const row = queue.rows[0] ?? {};
      const sent = sends.rows[0] ?? {};
      /** @type {Array<{userId: string, name: string, count: number}>} */
      const bySeller = (unanswered?.rows ?? [])
        .map((/** @type {any} */ seller) =>
          Object.freeze({
            userId: String(seller.user_id),
            name: String(seller.name),
            count: Number(seller.unanswered_count),
          }),
        )
        .sort(
          (
            /** @type {{userId: string, name: string, count: number}} */ left,
            /** @type {{userId: string, name: string, count: number}} */ right,
          ) =>
            right.count - left.count ||
            SELLER_NAME_ORDER.compare(left.name, right.name) ||
            (left.userId < right.userId
              ? -1
              : left.userId > right.userId
                ? 1
                : 0),
        );
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
        unanswered:
          unansweredMinutes === null
            ? null
            : Object.freeze({
                bySeller: Object.freeze(bySeller),
                count: bySeller.reduce(
                  (/** @type {number} */ total, seller) => total + seller.count,
                  0,
                ),
                thresholdMinutes: unansweredMinutes,
              }),
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

  /**
   * AGENTE-OBS-01: "Desempenho do Vendedor", aggregates only, read in one
   * snapshot over `(from, to]`. Nothing here identifies a conversation, a
   * customer or a seller; `null` stands for "no sample".
   *
   * @param {{from: Date, to: Date}} input
   */
  async assistantPerformance({ from, to }) {
    const window = [from.toISOString(), to.toISOString()];
    return this.#snapshot(async (database) => {
      const [activity, reasons, ficha, claim, resolve, failures, versions] =
        await runSequential([
          () =>
            database.query(
              `SELECT
                 (SELECT count(*)::integer FROM crm.messages
                  WHERE direction='outbound' AND author_kind='assistant'
                    AND created_at > $1 AND created_at <= $2) replies,
                 (SELECT count(DISTINCT conversation_id)::integer FROM (
                    SELECT conversation_id FROM crm.messages
                    WHERE direction='outbound' AND author_kind='assistant'
                      AND created_at > $1 AND created_at <= $2
                    UNION ALL
                    SELECT conversation_id FROM crm.automation_turns
                    WHERE occurred_at > $1 AND occurred_at <= $2
                    UNION ALL
                    SELECT conversation_id FROM crm.handoffs
                    WHERE created_at > $1 AND created_at <= $2
                      AND (automation_workflow_key IS NOT NULL
                        OR reason_code = 'automation_failure')
                  ) touched) conversations`,
              window,
            ),
          () =>
            database.query(
              `SELECT reason_code, count(*)::integer total
               FROM crm.handoffs
               WHERE created_at > $1 AND created_at <= $2
               GROUP BY reason_code
               ORDER BY total DESC, reason_code`,
              window,
            ),
          () =>
            database.query(
              `SELECT count(*)::integer samples,
                      round(avg(ficha_filled::numeric / ficha_total), 2) ratio
               FROM crm.automation_turns
               WHERE event_type='handoff.requested' AND ficha_total > 0
                 AND occurred_at > $1 AND occurred_at <= $2`,
              window,
            ),
          () =>
            database.query(
              `SELECT count(*)::integer samples,
                      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1) median,
                      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes))::numeric, 1) p90
               FROM (
                 SELECT extract(epoch FROM claimed.at - handoff.created_at) / 60 minutes
                 FROM crm.handoffs handoff
                 JOIN LATERAL (
                   SELECT min(history.occurred_at) at
                   FROM crm.handoff_history history
                   WHERE history.handoff_id=handoff.id
                     AND history.to_status='accepted'
                 ) claimed ON claimed.at IS NOT NULL
                 WHERE handoff.created_at > $1 AND handoff.created_at <= $2
               ) waits`,
              window,
            ),
          () =>
            database.query(
              `SELECT count(*)::integer samples,
                      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1) median
               FROM (
                 SELECT extract(epoch FROM resolved_at - created_at) / 60 minutes
                 FROM crm.handoffs
                 WHERE created_at > $1 AND created_at <= $2
                   AND resolved_at IS NOT NULL
               ) durations`,
              window,
            ),
          () =>
            database.query(
              `WITH workflow AS (
                 SELECT count(*)::integer workflow_failed,
                   max(processed_at) workflow_last_at,
                   count(*) FILTER (
                     WHERE processed_at > $2::timestamptz - interval '1 hour'
                   )::integer workflow_last_hour,
                   count(*) FILTER (
                     WHERE processed_at > $2::timestamptz - interval '24 hours'
                   )::integer workflow_last_24_hours
                 FROM crm.n8n_events
                  WHERE event_type='workflow.failed'
                    AND processed_at > $1 AND processed_at <= $2
               ) SELECT workflow.*,
                 (SELECT count(*)::integer FROM crm.messages
                  WHERE direction='outbound' AND author_kind='assistant'
                    AND created_at > $1 AND created_at <= $2
                    AND (status='outcome_unknown'
                      OR delivery_status='outcome_unknown')) send_unknown,
                 (SELECT count(*)::integer FROM crm.messages
                  WHERE direction='outbound' AND author_kind='assistant'
                    AND created_at > $1 AND created_at <= $2
                    AND (status='failed' OR delivery_status='failed')) send_failed,
                 (SELECT count(*)::integer FROM crm.audit_events
                  WHERE action='integration.n8n.stale_fence'
                    AND occurred_at > $1 AND occurred_at <= $2) stale_fence,
                 (SELECT count(*)::integer FROM crm.n8n_events
                  WHERE event_type='message.transcribed'
                    AND outcome->>'transcriptStatus'='failed'
                    AND processed_at > $1 AND processed_at <= $2) transcription_failed,
                 (SELECT count(*)::integer FROM crm.handoffs
                  WHERE reason_code='automation_failure'
                    AND created_at > $1 AND created_at <= $2) automation_failure_handoffs
               FROM workflow`,
              window,
            ),
          () =>
            database.query(
              `SELECT workflow_version, count(*)::integer turns,
                      count(*) FILTER (WHERE event_type='handoff.requested')::integer handoffs
               FROM crm.automation_turns
               WHERE occurred_at > $1 AND occurred_at <= $2
               GROUP BY workflow_version
               ORDER BY turns DESC, workflow_version
               LIMIT 20`,
              window,
            ),
        ]);
      const counts = activity.rows[0] ?? {};
      const fails = failures.rows[0] ?? {};
      const fichaRow = ficha.rows[0] ?? {};
      const claimRow = claim.rows[0] ?? {};
      const resolveRow = resolve.rows[0] ?? {};
      const byReason = reasons.rows.map((/** @type {any} */ row) =>
        Object.freeze({
          count: Number(row.total),
          reason_code: row.reason_code,
        }),
      );
      return Object.freeze({
        conversations_with_assistant: Number(counts.conversations ?? 0),
        assistant_replies: Number(counts.replies ?? 0),
        handoffs: Object.freeze({
          by_reason: Object.freeze(byReason),
          total: byReason.reduce(
            (/** @type {number} */ sum, /** @type {{count: number}} */ row) =>
              sum + row.count,
            0,
          ),
        }),
        ficha_at_handoff: Object.freeze({
          avg_ratio: nullableNumber(fichaRow.ratio),
          samples: Number(fichaRow.samples ?? 0),
        }),
        time_to_claim_minutes: Object.freeze({
          median: nullableNumber(claimRow.median),
          p90: nullableNumber(claimRow.p90),
          samples: Number(claimRow.samples ?? 0),
        }),
        time_to_resolve_minutes: Object.freeze({
          median: nullableNumber(resolveRow.median),
          samples: Number(resolveRow.samples ?? 0),
        }),
        failures: Object.freeze({
          workflow_failed: Number(fails.workflow_failed ?? 0),
          send_unknown: Number(fails.send_unknown ?? 0),
          send_failed: Number(fails.send_failed ?? 0),
          stale_fence: Number(fails.stale_fence ?? 0),
          transcription_failed: Number(fails.transcription_failed ?? 0),
          automation_failure_handoffs: Number(
            fails.automation_failure_handoffs ?? 0,
          ),
        }),
        // OPS-INBOX-ACK-04 / OPS-ERR-08: recurrence uses the same server
        // instant as the selected window; historical totals are not a queue.
        workflow_failure_activity: Object.freeze({
          last_at: fails.workflow_last_at
            ? new Date(fails.workflow_last_at).toISOString()
            : null,
          last_hour: Number(fails.workflow_last_hour ?? 0),
          last_24_hours: Number(fails.workflow_last_24_hours ?? 0),
          measured_at: to.toISOString(),
        }),
        by_workflow_version: Object.freeze(
          versions.rows.map((/** @type {any} */ row) =>
            Object.freeze({
              handoffs: Number(row.handoffs),
              turns: Number(row.turns),
              workflow_version: row.workflow_version,
            }),
          ),
        ),
      });
    });
  }

  /**
   * AGENTE-OBS-01 / INBOX-HANDOFF-02: what the assistant knew at its last
   * turn, for the seller who takes the conversation over. Codes and counts
   * only; 404 when the conversation does not exist.
   *
   * @param {string} conversationId
   */
  async assistantContext(conversationId) {
    return this.#snapshot(async (database) => {
      const [conversation, turn, messages] = await runSequential([
        () =>
          database.query('SELECT id FROM crm.conversations WHERE id=$1', [
            conversationId,
          ]),
        () =>
          database.query(
            `SELECT asked_field, answer_status, ficha_filled, ficha_total,
                    trigger, occurred_at
             FROM crm.automation_turns
             WHERE conversation_id=$1
             ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [conversationId],
          ),
        () =>
          database.query(
            `SELECT count(*)::integer total FROM crm.messages
             WHERE conversation_id=$1 AND direction='outbound'
               AND author_kind='assistant'`,
            [conversationId],
          ),
      ]);
      if (!conversation.rows[0]) throw notFound('CONVERSATION_NOT_FOUND');
      const last = turn.rows[0];
      return Object.freeze({
        assistantMessages: Number(messages.rows[0]?.total ?? 0),
        lastTurn: last
          ? Object.freeze({
              answer_status: last.answer_status,
              asked_field: last.asked_field,
              ficha_filled: Number(last.ficha_filled),
              ficha_total: Number(last.ficha_total),
              occurred_at: iso(last.occurred_at),
              trigger: last.trigger,
            })
          : null,
      });
    });
  }

  /**
   * INBOX-VEZ-01: one tab, ordered and cut in SQL before LIMIT. The tab is
   * worked out once (`turnJoins`) and used by the page, the total and
   * `bucketCounts`; the heavy projection only runs for the rows chosen.
   * @param {any} database @param {Record<string, any>} input
   * @param {NonNullable<ReturnType<typeof turnContext>>} turn
   * @param {unknown[]} values @param {string[]} predicates
   */
  async #listByBucket(database, input, turn, values, predicates) {
    const p = turnParameters(values, turn);
    values.push(input.bucket);
    predicates.push(`turn_state.bucket = $${values.length}`);
    if (input.orderReady) predicates.push('review_order.id IS NOT NULL');
    const baseValues = [...values];
    const baseWhere = predicates.join(' AND ');
    const order = BUCKET_ORDER[input.bucket];
    // INBOX-VEZ-08: recency is independent of the first unanswered message.
    // Keep turn_since for the wait clock and all other tabs' ordering.
    const position =
      input.bucket === 'respond'
        ? "date_trunc('milliseconds', conversation.last_message_at)"
        : 'turn.since';
    let cursor = '';
    if (input.after) {
      const first = values.length + 1;
      values.push(input.after.updatedAt, input.after.id);
      cursor = `WHERE ${order.after(['base.turn_rank', 'base.sort_position', 'base.id'], first)}`;
    }
    values.push(input.limit + 1);
    // The tab is evaluated once, into `base`: the page is cut from it and the
    // total counts it, so the two can never disagree.
    const withBase = `${reminderCte(p)},
         base AS MATERIALIZED (
           SELECT conversation.id, ${TURN_COLUMNS}, ${position} sort_position
           FROM crm.conversations conversation
           JOIN crm.contact_identities identity
             ON identity.id=conversation.contact_identity_id
           ${OPEN_HANDOFF_JOIN}
           ${input.orderReady ? REVIEW_ORDER_JOIN : ''}
           ${turnJoins(p)}
           WHERE ${baseWhere})`;
    const page = await database.query(
      `WITH ${withBase},
         ranked AS (
           SELECT base.* FROM base
           ${cursor}
           ORDER BY ${order.orderBy(['base.turn_rank', 'base.sort_position', 'base.id'])}
           LIMIT $${values.length})
         SELECT ${listProjection(false)},
                ${TURN_NAMES.map((name) => `ranked.${name}`).join(', ')}, ranked.sort_position,
                ${businessMinutes('ranked.turn_since', p)},
                (SELECT count(*)::integer FROM base) total_count
         FROM ranked
         JOIN crm.conversations conversation ON conversation.id=ranked.id
         ${SUMMARY_JOINS}
         ${LAST_MESSAGE_JOIN}
         ORDER BY ${order.orderBy(['ranked.turn_rank', 'ranked.sort_position', 'ranked.id'])}`,
      values,
    );
    // Past the last page there is no row to carry the total.
    const count =
      page.rows.length === 0
        ? await database.query(
            `WITH ${withBase}
             SELECT count(*)::integer count FROM base`,
            baseValues,
          )
        : null;
    const hasMore = page.rows.length > input.limit;
    const rows = page.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      hasMore,
      items: rows.map((/** @type {any} */ row) =>
        mapConversationSummary(row, this, turn.nowIso),
      ),
      ...(last
        ? {
            nextPosition: {
              rank: Number(last.turn_rank),
              updatedAt: iso(last.sort_position),
            },
          }
        : {}),
      totalCount: Number(
        count ? count.rows[0]?.count : (page.rows[0]?.total_count ?? 0),
      ),
    };
  }

  /**
   * INBOX-VEZ-01: `{respond, awaiting, silent, lost}` in one statement, hence
   * one snapshot and one evaluation of the tab. `owner`, `orderReady` and
   * `assignedUserId` narrow it exactly as they narrow the list.
   *
   * @param {{owner?: string, orderReady?: boolean, assignedUserId?: string, actorId?: string}} input
   * @param {{actorId?: string|null, now?: Date, stallMinutes?: number}} reader
   */
  async bucketCounts(input, reader) {
    const turn = turnContext(reader, input.actorId);
    if (!turn) throw new TypeError('now and stallMinutes are required');
    return this.#snapshot(async (database) => {
      const values = /** @type {unknown[]} */ ([]);
      const predicates = [
        'conversation.archived_at IS NULL',
        'conversation.terminal_at IS NULL',
        "conversation.state NOT IN ('convertida_em_lead','sem_lead','encerrada')",
      ];
      if (input.assignedUserId !== undefined) {
        values.push(input.assignedUserId);
        predicates.push(`conversation.assigned_user_id = $${values.length}`);
      }
      if (input.owner === 'mine') {
        values.push(turn.actorId);
        predicates.push(`conversation.assigned_user_id = $${values.length}`);
      } else if (input.owner === 'unassigned') {
        predicates.push('conversation.assigned_user_id IS NULL');
      }
      if (input.orderReady) predicates.push('review_order.id IS NOT NULL');
      const p = turnParameters(values, turn);
      const result = await database.query(
        `WITH ${reminderCte(p)}
         SELECT ${INBOX_BUCKETS.map(
           (bucket) =>
             `count(*) FILTER (WHERE turn_state.bucket='${bucket}')::integer ${bucket}`,
         ).join(', ')}
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id=conversation.contact_identity_id
         ${OPEN_HANDOFF_JOIN}
         ${input.orderReady ? REVIEW_ORDER_JOIN : ''}
         ${turnJoins(p)}
         WHERE ${predicates.join(' AND ')}`,
        values,
      );
      const row = result.rows[0] ?? {};
      return Object.freeze({
        respond: Number(row.respond ?? 0),
        awaiting: Number(row.awaiting ?? 0),
        silent: Number(row.silent ?? 0),
        lost: Number(row.lost ?? 0),
      });
    });
  }

  /**
   * The turn fields of the given conversations, keyed by id (the list of an
   * old filter and the detail). Empty when the reader gave no instant.
   * @param {any} database @param {string[]} ids
   * @param {ReturnType<typeof turnContext>} turn
   */
  async #turnRows(database, ids, turn) {
    /** @type {Map<string, Record<string, any>>} */
    const byId = new Map();
    if (!turn || ids.length === 0) return byId;
    const values = /** @type {unknown[]} */ ([]);
    const p = turnParameters(values, turn);
    values.push(ids);
    const result = await database.query(
      `WITH ${reminderCte({ ...p, ids: `$${values.length}` })}
       SELECT conversation.id, ${TURN_COLUMNS}, ${businessMinutes('turn.since', p)}
       FROM crm.conversations conversation
       ${OPEN_HANDOFF_JOIN}
       ${turnJoins(p)}
       WHERE conversation.id = ANY($${values.length}::text[])`,
      values,
    );
    for (const row of result.rows) byId.set(row.id, row);
    return byId;
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

/**
 * @param {any} row @param {PostgresInboxReadRepository} repository
 * @param {string|null} [turnAsOf] the server instant of the turn fields
 */
function mapConversationSummary(row, repository, turnAsOf = null) {
  const bucket = row.turn_bucket ?? null;
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
      ? {
          functionName: row.function_name,
          id: row.assigned_user_id,
          name: row.assigned_user_name ?? null,
        }
      : null,
    assistantStalled: row.turn_stalled === true,
    automationEpoch: Number(row.automation_epoch),
    automationState: row.automation_state,
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    // INBOX-VEZ-01: null outside the open universe. The loss note never
    // leaves the lead-outcome log.
    bucket,
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
          preferredSellerFirstName: row.handoff_preferred_first_name ?? null,
          status: row.handoff_status,
          createdAt: iso(row.handoff_created_at),
          reasonCode: row.handoff_reason_code,
          targetRole: row.target_role,
          version: Number(row.handoff_version),
        }
      : null,
    id: row.id,
    hasPendingOrder: row.has_pending_order === true,
    lastMessage,
    lostOutcome:
      row.lost_version === null || row.lost_version === undefined
        ? null
        : {
            occurredAt: iso(row.lost_occurred_at),
            reasonCode: row.lost_reason_code,
            version: Number(row.lost_version),
          },
    reminder: row.reminder_remind_at
      ? {
          mine: row.reminder_mine === true,
          remindAt: iso(row.reminder_remind_at),
        }
      : null,
    turnAsOf: bucket ? turnAsOf : null,
    turnBusinessMinutes:
      bucket &&
      row.turn_business_minutes !== null &&
      row.turn_business_minutes !== undefined
        ? Number(row.turn_business_minutes)
        : null,
    turnSince: bucket && row.turn_since ? iso(row.turn_since) : null,
    deliveryIssue: row.delivery_issue_status
      ? {
          status: row.delivery_issue_status,
          occurredAt: iso(row.delivery_issue_at),
        }
      : null,
    openedAt: iso(row.opened_at),
    order: row.order_id
      ? {
          id: row.order_id,
          number: row.order_number,
          status: row.order_status,
          readyForConfirmation: row.order_ready_for_confirmation === true,
        }
      : null,
    waitingSince: row.waiting_since ? iso(row.waiting_since) : null,
    reviewOrder: row.review_order_id
      ? {
          id: row.review_order_id,
          number: row.review_order_number,
          status: row.review_order_status,
          readyForConfirmation: true,
        }
      : null,
    queuePosition: row.queue_position
      ? iso(row.queue_position)
      : iso(row.opened_at),
    requiresAttention:
      row.state === 'requer_atencao' ||
      row.handoff_status === 'pending' ||
      Boolean(row.delivery_issue_status) ||
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
    // INBOX-AUDIO-TRANSCRIPT-01: what the customer said in an audio.
    transcript:
      row.message_type === 'audio' && row.transcript_status
        ? Object.freeze({
            status: row.transcript_status,
            text:
              row.transcript_status === 'ok'
                ? String(
                    decryptInboxMessageEnvelope(
                      row.transcript_envelope,
                      `message-transcript:${row.id}`,
                      repository.messageEnvelopeKey,
                      true,
                    ).text ?? '',
                  )
                : null,
          })
        : null,
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

/** @param {unknown} value */
function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

/** @param {string} code */
function notFound(code) {
  return Object.assign(new Error(code), { code, statusCode: 404 });
}
