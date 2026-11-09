import { createHash, randomUUID } from 'node:crypto';

import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';

export class SubjectError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'SubjectError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * @param {any} database
 */
export function createSubjectService(database) {
  if (typeof database?.transaction !== 'function') {
    throw new TypeError('a transactional database is required');
  }
  const audit = new PostgresAuditTrail(database);

  /** @param {any} transaction @param {string} conversationId */
  async function context(transaction, conversationId) {
    const result = await transaction.query(
      `SELECT conversation.id, conversation.terminal_at,
              conversation.assigned_user_id, conversation.contact_identity_id,
              identity.current_contact_id AS contact_id
       FROM crm.conversations conversation
       JOIN crm.contact_identities identity
         ON identity.id = conversation.contact_identity_id
       WHERE conversation.id = $1
       FOR UPDATE OF conversation FOR SHARE OF identity`,
      [conversationId],
    );
    if (!result.rows[0]) throw new SubjectError(404, 'CONVERSATION_NOT_FOUND');
    return result.rows[0];
  }

  /** @param {any} transaction @param {any} conversation @param {any} actor */
  async function requireOwner(transaction, conversation, actor) {
    if (
      actor?.kind !== 'human' ||
      !actor.id ||
      actor.functionName !== 'Vendedor'
    ) {
      throw new SubjectError(403, 'FORBIDDEN');
    }
    if (conversation.terminal_at !== null)
      throw new SubjectError(409, 'CONVERSATION_CLOSED');
    if (conversation.assigned_user_id === actor.id) return;
    if (!(actor.capabilities ?? []).includes('COMMERCIAL_ADMIN')) {
      throw new SubjectError(403, 'FORBIDDEN');
    }
    const grant = await transaction.query(
      `SELECT 1 FROM crm.user_capabilities
       WHERE user_id = $1 AND capability = 'COMMERCIAL_ADMIN' FOR SHARE`,
      [actor.id],
    );
    if (!grant.rows[0]) throw new SubjectError(403, 'FORBIDDEN');
  }

  /** @param {any} transaction @param {string} operation @param {any} input @param {Record<string, unknown>} body @param {() => Promise<any>} work */
  async function command(transaction, operation, input, body, work) {
    const key = requireId(input.idempotencyKey, 'IDEMPOTENCY_KEY');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actorId: input.actor?.id,
          conversationId: input.conversationId,
          ...body,
        }),
      )
      .digest('hex');
    await transaction.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`subject:${operation}:${key}`],
    );
    const replay = await transaction.query(
      'SELECT fingerprint, result FROM crm.subject_commands WHERE operation=$1 AND idempotency_key=$2',
      [operation, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].fingerprint !== fingerprint) {
        throw new SubjectError(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return replay.rows[0].result;
    }
    const result = await work();
    await transaction.query(
      `INSERT INTO crm.subject_commands
         (operation, idempotency_key, fingerprint, result, actor_id, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())`,
      [operation, key, fingerprint, JSON.stringify(result), input.actor.id],
    );
    return result;
  }

  /** @param {any} transaction @param {any} input @param {string} action @param {string} targetType @param {string} targetId @param {number} version @param {Record<string, unknown>} details */
  async function record(
    transaction,
    input,
    action,
    targetType,
    targetId,
    version,
    details,
  ) {
    const occurredAt = new Date().toISOString();
    await audit.append(
      {
        action,
        actor: input.actor.id,
        correlationId: input.correlationId,
        occurredAt,
        reason: 'HUMAN_SUBJECT_ASSIGNMENT',
        target: { id: targetId, type: targetType },
        version,
      },
      { transaction },
    );
    await transaction.query(
      `INSERT INTO crm.domain_events
         (id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload, correlation_id, occurred_at)
       SELECT $1, 'conversation', $2,
              COALESCE((SELECT max(existing.aggregate_version)
                        FROM crm.domain_events existing
                        WHERE existing.aggregate_type='conversation'
                          AND existing.aggregate_id=$2), 0)+1,
              'conversation.subjects_changed', $3::jsonb, $4, $5`,
      [
        `event-${randomUUID()}`,
        input.conversationId,
        JSON.stringify({ conversationId: input.conversationId, ...details }),
        input.correlationId,
        occurredAt,
      ],
    );
  }

  return Object.freeze({
    /** @param {string} conversationId @param {string} [orderQuery] */
    async list(conversationId, orderQuery = '') {
      const id = requireId(conversationId, 'CONVERSATION_ID');
      const query = orderQuery.trim();
      if (query.length > 40) throw new SubjectError(400, 'INVALID_ORDER_QUERY');
      const conversation = await database.query(
        `SELECT identity.current_contact_id AS contact_id,
                conversation.contact_identity_id
         FROM crm.conversations conversation
         JOIN crm.contact_identities identity
           ON identity.id=conversation.contact_identity_id
         WHERE conversation.id=$1`,
        [id],
      );
      if (!conversation.rows[0])
        throw new SubjectError(404, 'CONVERSATION_NOT_FOUND');
      const contactId = conversation.rows[0].contact_id;
      const identityId = conversation.rows[0].contact_identity_id;
      const [subjects, orders, links, reviews] = await Promise.all([
        database.query(
          `SELECT subject.id, subject.kind, subject.order_id, subject.position,
                  subject.is_current, subject.selected_source, subject.version,
                  orders.number AS order_number,
                  CASE WHEN orders.cancelled_at IS NOT NULL THEN 'cancelado'
                       ELSE orders.status END AS order_status
           FROM crm.conversation_subjects subject
           LEFT JOIN crm.orders orders ON orders.id=subject.order_id
           WHERE subject.conversation_id=$1
           ORDER BY subject.position`,
          [id],
        ),
        database.query(
          `SELECT id, number, status FROM crm.orders
           WHERE origin='atendimento'
             AND (contact_id=$1 OR contact_id IN (
               SELECT source_contact_id FROM crm.identity_links
               WHERE contact_identity_id=$3 AND target_contact_id=$1
                 AND status='active'))
             AND ($2='' OR position(lower($2) in lower(number))>0)
           ORDER BY (status='pendente' AND cancelled_at IS NULL) DESC,
                    created_at DESC, id DESC
           LIMIT 101`,
          [contactId, query, identityId],
        ),
        database.query(
          `SELECT message_id, subject_id, assigned_by_kind
           FROM crm.message_subject_links
           WHERE conversation_id=$1 ORDER BY message_id, subject_id`,
          [id],
        ),
        // CP-16: only messages the agent flagged as ambiguous, still without
        // any subject and without a human decision, ask the seller.
        database.query(
          `SELECT review.message_id FROM crm.message_subject_reviews review
           WHERE review.conversation_id=$1 AND review.resolved_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM crm.message_subject_links link
               WHERE link.message_id=review.message_id)
           ORDER BY review.message_id`,
          [id],
        ),
      ]);
      return {
        currentSubjectId:
          subjects.rows.find((/** @type {any} */ row) => row.is_current)?.id ??
          null,
        links: links.rows.map((/** @type {any} */ row) => ({
          messageId: row.message_id,
          subjectId: row.subject_id,
          assignedByKind: row.assigned_by_kind,
        })),
        // UXA-14: reviews only open while the conversation has a subject,
        // so "one order + also another one" still reaches the seller.
        needsSubjectMessageIds: reviews.rows.map(
          (/** @type {any} */ row) => row.message_id,
        ),
        orders: orders.rows.slice(0, 100).map((/** @type {any} */ row) => ({
          id: row.id,
          number: row.number,
          status: row.status,
        })),
        ordersHasMore: orders.rows.length > 100,
        subjects: subjects.rows.map(presentSubject),
      };
    },

    /** @param {any} input */
    async create(input) {
      const conversationId = requireId(input.conversationId, 'CONVERSATION_ID');
      const orderId =
        input.orderId === null ? null : requireId(input.orderId, 'ORDER_ID');
      // CP-31: `select: false` ("separar como novo assunto") creates the
      // subject without moving the conversation's current subject.
      const select = input.select ?? true;
      if (typeof select !== 'boolean') {
        throw new SubjectError(400, 'INVALID_REQUEST');
      }
      // The default keeps the original fingerprint, so keys already stored
      // for `select: true` still replay; `select: false` is a distinct body.
      const body = select ? { orderId } : { orderId, select };
      return database.transaction((/** @type {any} */ transaction) =>
        command(transaction, 'create', input, body, async () => {
          const conversation = await context(transaction, conversationId);
          await requireOwner(transaction, conversation, input.actor);
          let orderNumber = null;
          let orderStatus = null;
          let subjectContactId = conversation.contact_id;
          if (orderId) {
            const order = await transaction.query(
              `SELECT number, contact_id,
                      CASE WHEN cancelled_at IS NOT NULL THEN 'cancelado'
                           ELSE status END AS status
               FROM crm.orders
               WHERE id=$1 AND origin='atendimento'
                 AND (contact_id=$2 OR contact_id IN (
                   SELECT source_contact_id FROM crm.identity_links
                   WHERE contact_identity_id=$3 AND target_contact_id=$2
                     AND status='active'))
               FOR SHARE`,
              [
                orderId,
                conversation.contact_id,
                conversation.contact_identity_id,
              ],
            );
            if (!order.rows[0])
              throw new SubjectError(409, 'ORDER_CONTACT_MISMATCH');
            const duplicate = await transaction.query(
              `SELECT 1 FROM crm.conversation_subjects
               WHERE conversation_id=$1 AND order_id=$2`,
              [conversationId, orderId],
            );
            if (duplicate.rows[0])
              throw new SubjectError(409, 'SUBJECT_EXISTS');
            orderNumber = order.rows[0].number;
            orderStatus = order.rows[0].status;
            subjectContactId = order.rows[0].contact_id;
          }
          const position = await transaction.query(
            `SELECT COALESCE(max(position), 0)+1 AS next
             FROM crm.conversation_subjects WHERE conversation_id=$1`,
            [conversationId],
          );
          const now = new Date().toISOString();
          const subjectId = randomUUID();
          const previous = select
            ? await transaction.query(
                `UPDATE crm.conversation_subjects SET is_current=false,
                        version=version+1, updated_at=$2
                 WHERE conversation_id=$1 AND is_current RETURNING id`,
                [conversationId, now],
              )
            : { rows: [] };
          await transaction.query(
            `INSERT INTO crm.conversation_subjects
               (id, conversation_id, contact_id, order_id, kind, position,
                is_current, selected_source, selected_by, selected_at,
                created_by, created_by_kind, version, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$9::boolean,
                     CASE WHEN $9::boolean THEN 'human' END,
                     CASE WHEN $9::boolean THEN $7 END,
                     CASE WHEN $9::boolean THEN $8::timestamptz END,
                     $7,'human',1,$8,$8)`,
            [
              subjectId,
              conversationId,
              subjectContactId,
              orderId,
              orderId ? 'pedido' : 'geral',
              Number(position.rows[0].next),
              input.actor.id,
              now,
              select,
            ],
          );
          await record(
            transaction,
            input,
            'conversation.subject_created',
            'conversation_subject',
            subjectId,
            1,
            {
              subjectId,
              orderId,
              previousSubjectId: previous.rows[0]?.id ?? null,
            },
          );
          return {
            subject: {
              id: subjectId,
              kind: orderId ? 'pedido' : 'geral',
              orderId,
              orderNumber,
              orderStatus,
              position: Number(position.rows[0].next),
              isCurrent: select,
              selectedSource: select ? 'human' : null,
              version: 1,
            },
          };
        }),
      );
    },

    /** @param {any} input */
    async select(input) {
      const conversationId = requireId(input.conversationId, 'CONVERSATION_ID');
      const subjectId = requireId(input.subjectId, 'SUBJECT_ID');
      return database.transaction((/** @type {any} */ transaction) =>
        command(transaction, 'select', input, { subjectId }, async () => {
          const conversation = await context(transaction, conversationId);
          await requireOwner(transaction, conversation, input.actor);
          const selected = await transaction.query(
            `SELECT subject.id, subject.version FROM crm.conversation_subjects subject
             WHERE subject.id=$1 AND subject.conversation_id=$2
               AND (subject.contact_id=$3 OR EXISTS (
                 SELECT 1 FROM crm.identity_links link
                 WHERE link.contact_identity_id=$4
                   AND link.source_contact_id=subject.contact_id
                   AND link.target_contact_id=$3 AND link.status='active'))
             FOR UPDATE OF subject`,
            [
              subjectId,
              conversationId,
              conversation.contact_id,
              conversation.contact_identity_id,
            ],
          );
          if (!selected.rows[0]) {
            throw new SubjectError(404, 'SUBJECT_NOT_FOUND');
          }
          const previous = await transaction.query(
            `SELECT id FROM crm.conversation_subjects
             WHERE conversation_id=$1 AND is_current`,
            [conversationId],
          );
          const now = new Date().toISOString();
          await transaction.query(
            `UPDATE crm.conversation_subjects SET is_current=false,
                    version=version+1, updated_at=$2
             WHERE conversation_id=$1 AND is_current AND id<>$3`,
            [conversationId, now, subjectId],
          );
          const changed = await transaction.query(
            `UPDATE crm.conversation_subjects SET is_current=true,
                    selected_source='human', selected_by=$3, selected_at=$4,
                    version=version+1, updated_at=$4
             WHERE id=$1 AND conversation_id=$2 RETURNING version`,
            [subjectId, conversationId, input.actor.id, now],
          );
          const version = Number(changed.rows[0].version);
          await record(
            transaction,
            input,
            'conversation.subject_selected',
            'conversation_subject',
            subjectId,
            version,
            {
              subjectId,
              previousSubjectId: previous.rows[0]?.id ?? null,
            },
          );
          return { currentSubjectId: subjectId, version };
        }),
      );
    },

    /** @param {any} input */
    async tagMessage(input) {
      const conversationId = requireId(input.conversationId, 'CONVERSATION_ID');
      const messageId = requireId(input.messageId, 'MESSAGE_ID');
      if (
        !Array.isArray(input.subjectIds) ||
        input.subjectIds.length > 20 ||
        new Set(input.subjectIds).size !== input.subjectIds.length
      ) {
        throw new SubjectError(400, 'INVALID_SUBJECTS');
      }
      const subjectIds = input.subjectIds
        .map((/** @type {unknown} */ id) => requireId(id, 'SUBJECT_ID'))
        .sort();
      return database.transaction((/** @type {any} */ transaction) =>
        command(
          transaction,
          'tag',
          input,
          { messageId, subjectIds },
          async () => {
            const conversation = await context(transaction, conversationId);
            await requireOwner(transaction, conversation, input.actor);
            const message = await transaction.query(
              'SELECT id FROM crm.messages WHERE id=$1 AND conversation_id=$2',
              [messageId, conversationId],
            );
            if (!message.rows[0])
              throw new SubjectError(404, 'MESSAGE_NOT_FOUND');
            if (subjectIds.length) {
              const found = await transaction.query(
                `SELECT subject.id FROM crm.conversation_subjects subject
                 WHERE subject.conversation_id=$1
                   AND subject.id=ANY($2::text[])
                   AND (subject.contact_id=$3 OR EXISTS (
                     SELECT 1 FROM crm.identity_links link
                     WHERE link.contact_identity_id=$4
                       AND link.source_contact_id=subject.contact_id
                       AND link.target_contact_id=$3 AND link.status='active'))`,
                [
                  conversationId,
                  subjectIds,
                  conversation.contact_id,
                  conversation.contact_identity_id,
                ],
              );
              if (found.rows.length !== subjectIds.length) {
                throw new SubjectError(409, 'SUBJECT_CONTACT_MISMATCH');
              }
            }
            const previous = await transaction.query(
              `SELECT subject_id, assigned_by_kind
               FROM crm.message_subject_links
               WHERE message_id=$1 ORDER BY subject_id FOR UPDATE`,
              [messageId],
            );
            await transaction.query(
              'DELETE FROM crm.message_subject_links WHERE message_id=$1',
              [messageId],
            );
            for (const subjectId of subjectIds) {
              await transaction.query(
                `INSERT INTO crm.message_subject_links
                 (message_id, subject_id, conversation_id, assigned_by,
                  assigned_by_kind, assigned_at)
               VALUES ($1,$2,$3,$4,'human',now())`,
                [messageId, subjectId, conversationId, input.actor.id],
              );
            }
            // A human decision, including "no subject", resolves the review
            // and keeps later agent turns from overwriting it. It does not
            // resolve the handoff nor change automation state or epoch.
            const review = await transaction.query(
              `SELECT reason, resolved_at FROM crm.message_subject_reviews
               WHERE message_id=$1 FOR UPDATE`,
              [messageId],
            );
            const reviewResolved = Boolean(
              review.rows[0] && review.rows[0].resolved_at === null,
            );
            if (review.rows[0]) {
              await transaction.query(
                `UPDATE crm.message_subject_reviews
                 SET resolved_at=now(), resolved_by=$2 WHERE message_id=$1`,
                [messageId, input.actor.id],
              );
            } else {
              await transaction.query(
                `INSERT INTO crm.message_subject_reviews
                   (message_id, conversation_id, handoff_id, source_revision,
                    reason, requested_at, resolved_at, resolved_by)
                 SELECT message.id, message.conversation_id, NULL,
                        message.inbound_revision, 'human_review', now(), now(),
                        $3
                 FROM crm.messages message
                 WHERE message.id=$1 AND message.conversation_id=$2
                   AND message.direction='inbound'
                   AND message.inbound_revision > 0
                 ON CONFLICT (message_id) DO NOTHING`,
                [messageId, conversationId, input.actor.id],
              );
            }
            await record(
              transaction,
              input,
              'conversation.message_subjects_assigned',
              'message',
              messageId,
              1,
              {
                messageId,
                previousSubjectIds: previous.rows.map(
                  (/** @type {any} */ row) => row.subject_id,
                ),
                previousLinks: previous.rows.map((/** @type {any} */ row) => ({
                  subjectId: row.subject_id,
                  assignedByKind: row.assigned_by_kind,
                })),
                reviewResolved,
                subjectIds,
              },
            );
            return { messageId, subjectIds };
          },
        ),
      );
    },
  });
}

/** @param {any} row */
function presentSubject(row) {
  return {
    id: row.id,
    kind: row.kind,
    orderId: row.order_id,
    orderNumber: row.order_number ?? null,
    orderStatus: row.order_status ?? null,
    position: Number(row.position),
    isCurrent: Boolean(row.is_current),
    selectedSource: row.selected_source ?? null,
    version: Number(row.version),
  };
}

/** @param {unknown} value @param {string} code */
function requireId(value, code) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SubjectError(400, `INVALID_${code}`);
  }
  return value.trim();
}
