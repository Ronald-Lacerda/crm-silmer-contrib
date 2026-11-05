import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import { InboxConflictError, InboxForbiddenError } from '../domain/errors.js';
import {
  assertConversationMutation,
  assertProductionHumanSend,
  freezeInboxRecord,
  isTerminalInboxState,
} from '../domain/inbox.js';

const ADMIN_CAPABILITY = 'COMMERCIAL_ADMIN';

/** @type {Readonly<Record<string, string>>} */
const STREAM_EVENT_TYPES = Object.freeze({
  archive: 'conversation.archived',
  unarchive: 'conversation.unarchived',
  send: 'conversation.message_queued',
  takeover: 'conversation.taken_over',
  transfer: 'conversation.transferred',
  transition: 'conversation.state_changed',
});

/**
 * Publishes a conversation change onto the shared domain event stream so the
 * `inbox` SSE topic can push it to open panels. Written inside the caller's
 * transaction: no event is visible unless the change committed. Payloads carry
 * identifiers only — message bodies stay encrypted at rest and are re-read
 * through the authorized read model.
 *
 * `aggregate_version` counts occurrences of this event type for this
 * conversation rather than mirroring `conversations.version`. The unique
 * constraint on (aggregate_type, aggregate_id, aggregate_version, event_type)
 * would otherwise drop a second event at an unchanged conversation version, and
 * a dropped event is a panel that silently stops updating.
 *
 * @param {Queryable} transaction
 * @param {{conversationId: string, correlationId: string, occurredAt: string, type: string}} event
 */
async function appendConversationStreamEvent(transaction, event) {
  await transaction.query(
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
      `event-${randomUUID()}`,
      event.conversationId,
      event.type,
      JSON.stringify({ conversationId: event.conversationId }),
      event.correlationId,
      event.occurredAt,
    ],
  );
}

/**
 * A conversation belongs to whoever took it over. Another seller must not be
 * able to answer, close or re-take it; only an administrator may override, and
 * only a transfer moves ownership on purpose.
 *
 * @param {string} kind
 * @param {{assigned_user_id: string|null}} current
 * @param {{capabilities?: readonly string[], id: string}} actor
 */
function assertConversationOwnership(kind, current, actor) {
  const owner = current.assigned_user_id;
  const isAdmin = [...(actor.capabilities ?? [])].includes(ADMIN_CAPABILITY);
  if (
    (kind === 'archive' || kind === 'unarchive') &&
    owner === null &&
    !isAdmin
  ) {
    throw new InboxForbiddenError(
      'Conversation must be taken over before it can be archived',
    );
  }
  if (owner === null || owner === actor.id || isAdmin) return;
  throw new InboxForbiddenError(
    `Conversation is assigned to another operator and cannot be ${kind === 'transfer' ? 'transferred' : 'mutated'} by this actor`,
  );
}

const CIPHER = 'aes-256-gcm';
const ALGORITHM = 'AES-256-GCM';

/**
 * @typedef {{query: (sql: string, values?: unknown[]) => Promise<{rows: any[]}>}} Queryable
 * @typedef {{query: Queryable['query'], transaction: <T>(work: (transaction: Queryable) => Promise<T>) => Promise<T>}} TransactionalDatabase
 * @typedef {{enqueueChannelMessage: (input: {id: string, idempotencyKey: string, messageId: string, availableAt: string|Date}, context: {transaction: Queryable}) => Promise<void>, enqueuePanelCommand?: (input: Record<string, any>, context: {transaction: Queryable}) => Promise<unknown>}} OutboundMessageOutbox
 */

export class PostgresInboxRepository {
  /** @type {TransactionalDatabase} */
  #database;
  /** @type {Buffer} */
  #envelopeKey;
  /** @type {OutboundMessageOutbox} */
  #outboundMessageOutbox;

  /** @param {{database: TransactionalDatabase, envelopeKey: Buffer, outboundMessageOutbox: OutboundMessageOutbox}} options */
  constructor({ database, envelopeKey, outboundMessageOutbox }) {
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
      !outboundMessageOutbox ||
      typeof outboundMessageOutbox.enqueueChannelMessage !== 'function'
    ) {
      throw new TypeError('An outbound message outbox port is required');
    }
    this.#database = database;
    this.#envelopeKey = Buffer.from(envelopeKey);
    this.#outboundMessageOutbox = outboundMessageOutbox;
  }

  /** @param {any} input @param {any} runtime */
  async receiveInbound(input, runtime) {
    return this.#database.transaction(async (transaction) => {
      await advisoryLock(
        transaction,
        `inbound:${input.provider}:${input.providerAccountId}:${input.externalConversationId}`,
      );
      const replay = await transaction.query(
        `SELECT ${MESSAGE_SELECT}
         FROM crm.messages
         WHERE provider = $1 AND provider_account_id = $2
           AND external_message_id = $3`,
        [input.provider, input.providerAccountId, input.externalMessageId],
      );
      if (replay.rows[0]) {
        const replayConversation = await transaction.query(
          `SELECT ${CONVERSATION_SELECT} FROM crm.conversations WHERE id = $1`,
          [replay.rows[0].conversation_id],
        );
        return freezeInboxRecord({
          conversation: mapConversation(replayConversation.rows[0]),
          message: mapMessage(replay.rows[0], this.#envelopeKey),
        });
      }

      let selected = await transaction.query(
        `SELECT ${CONVERSATION_SELECT}
         FROM crm.conversations
         WHERE provider = $1 AND provider_account_id = $2
           AND external_conversation_id = $3 AND terminal_at IS NULL
         FOR UPDATE`,
        [input.provider, input.providerAccountId, input.externalConversationId],
      );
      const hadActiveConversation = Boolean(selected.rows[0]);
      if (!selected.rows[0]) {
        const last = await transaction.query(
          `SELECT id, cycle_number
           FROM crm.conversations
           WHERE provider = $1 AND provider_account_id = $2
             AND external_conversation_id = $3
           ORDER BY cycle_number DESC LIMIT 1`,
          [
            input.provider,
            input.providerAccountId,
            input.externalConversationId,
          ],
        );
        const previous = last.rows[0] ?? null;
        const conversationId = runtime.idFactory('conversation');
        selected = await transaction.query(
          `INSERT INTO crm.conversations
             (id, contact_identity_id, provider, provider_account_id,
              external_conversation_id, cycle_number, previous_conversation_id,
              state, automation_state, automation_epoch, version, opened_at,
              last_message_at, terminal_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'nova', 'assistant', 0, 1,
                   $8, $8, NULL)
           RETURNING ${CONVERSATION_SELECT}`,
          [
            conversationId,
            input.identityId,
            input.provider,
            input.providerAccountId,
            input.externalConversationId,
            Number(previous?.cycle_number ?? 0) + 1,
            previous?.id ?? null,
            input.occurredAt,
          ],
        );
      }
      let conversation = selected.rows[0];
      if (conversation.contact_identity_id !== input.identityId) {
        throw new InboxConflictError(
          'An active conversation cannot change its anchored identity',
        );
      }
      if (hadActiveConversation) {
        const updated = await transaction.query(
          `UPDATE crm.conversations
           SET last_message_at = GREATEST(last_message_at, $2),
               archived_at = NULL,
               version = version + 1
           WHERE id = $1
           RETURNING ${CONVERSATION_SELECT}`,
          [conversation.id, input.occurredAt],
        );
        conversation = updated.rows[0];
      }
      const messageId = runtime.idFactory('message');
      const envelope = encryptJson(
        input.message.content,
        `message:${messageId}`,
        this.#envelopeKey,
      );
      const inserted = await transaction.query(
        `INSERT INTO crm.messages
           (id, conversation_id, channel_event_id, provider,
            provider_account_id, external_message_id, command_id, direction,
            author_kind, author_id, message_type, content_envelope, key_version,
            status, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'inbound', 'contact', $7, $8,
                 $9::jsonb, 1, 'received', $10, $10)
         RETURNING ${MESSAGE_SELECT}`,
        [
          messageId,
          conversation.id,
          input.channelEventId ?? null,
          input.provider,
          input.providerAccountId,
          input.externalMessageId,
          input.identityId,
          input.message.type,
          JSON.stringify(envelope),
          input.occurredAt,
        ],
      );
      if (input.channelEventId) {
        await transaction.query(
          `INSERT INTO crm.attachments (message_id, transient_media_id)
           SELECT $1, media.transient_media_id
           FROM crm.channel_event_media AS media
           WHERE media.channel_event_id = $2
           ON CONFLICT DO NOTHING`,
          [messageId, input.channelEventId],
        );
      }
      await appendConversationStreamEvent(transaction, {
        conversationId: conversation.id,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
        type: 'conversation.message_received',
      });
      return freezeInboxRecord({
        conversation: mapConversation(conversation),
        message: mapMessage(inserted.rows[0], this.#envelopeKey),
      });
    });
  }

  /** @param {string} kind @param {any} input @param {any} runtime */
  async mutateConversation(kind, input, runtime) {
    // ADR 015: refused before any lock or read, so the former `reactivate`
    // cannot touch the conversation, the audit trail or the n8n outbox.
    assertConversationMutation(kind);
    const semanticInput = { ...input };
    delete semanticInput.correlationId;
    const fingerprint = hashJson(
      canonicalCommandValue(JSON.parse(JSON.stringify(semanticInput))),
    );
    return this.#database.transaction(async (transaction) => {
      await advisoryLock(
        transaction,
        `command:${kind}:${input.idempotencyKey}`,
      );
      const replay = await transaction.query(
        `SELECT fingerprint, result FROM crm.inbox_commands
         WHERE operation = $1 AND idempotency_key = $2`,
        [kind, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].fingerprint !== fingerprint &&
          replay.rows[0].fingerprint !== hashJson(input)
        ) {
          throw new InboxConflictError(
            'Idempotency key was reused with another command',
          );
        }
        return this.#hydrateCommand(transaction, replay.rows[0].result);
      }

      if (
        kind === 'send' &&
        input.messageType !== 'text' &&
        runtime.mediaEnabled === false
      )
        throw new InboxForbiddenError('New chat media sends are disabled');
      const selected = await transaction.query(
        `SELECT ${CONVERSATION_SELECT} FROM crm.conversations
         WHERE id = $1 FOR UPDATE`,
        [input.conversationId],
      );
      const current = selected.rows[0];
      if (!current) throw new InboxConflictError('Conversation was not found');
      if (Number(current.version) !== input.expectedVersion) {
        throw new InboxConflictError(
          `Expected conversation version ${input.expectedVersion}, current version is ${current.version}`,
        );
      }
      if (current.terminal_at !== null) {
        throw new InboxConflictError(
          'Terminal conversations cannot be mutated',
        );
      }
      if (kind === 'unarchive' && current.archived_at === null) {
        throw new InboxConflictError('Conversation is not archived');
      }
      assertConversationOwnership(kind, current, input.actor);
      if (kind === 'send')
        assertProductionHumanSend(
          current.provider,
          current.provider_account_id,
        );
      if (kind === 'transition' && input.state === 'encerrada') {
        if (
          current.assigned_user_id === null &&
          !(input.actor.capabilities ?? []).includes(ADMIN_CAPABILITY)
        ) {
          throw new InboxForbiddenError(
            'Take over the conversation before closing it',
          );
        }
        const pending = await transaction.query(
          `SELECT EXISTS (
             SELECT 1 FROM crm.orders
             WHERE conversation_id = $1 AND status = 'pendente'
             UNION ALL
             SELECT 1 FROM crm.conversation_subjects subject
             JOIN crm.orders orders ON orders.id = subject.order_id
             WHERE subject.conversation_id = $1 AND orders.status = 'pendente'
           ) AS present`,
          [input.conversationId],
        );
        if (pending.rows[0]?.present && !input.acknowledgePending) {
          throw new InboxConflictError(
            'Pending order requires acknowledgement',
          );
        }
      }
      if (kind === 'transfer') {
        const target = await transaction.query(
          `SELECT users.id
           FROM crm.users users
           JOIN crm.user_functions functions ON functions.user_id = users.id
           WHERE users.id = $1 AND users.disabled_at IS NULL`,
          [input.targetUserId],
        );
        if (!target.rows[0]) {
          throw new InboxForbiddenError(
            'Target user is not an active operator',
          );
        }
      }
      const occurredAt = runtime.clock().toISOString();
      let result;
      let commandResult;

      if (kind === 'send') {
        let media;
        if (['image', 'audio', 'video'].includes(input.messageType)) {
          const mediaId = input.content?.mediaId;
          if (
            typeof mediaId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
              mediaId,
            )
          )
            throw new InboxConflictError('Media reference is invalid');
          media = (
            await transaction.query(
              'SELECT * FROM crm.chat_media WHERE id=$1 FOR UPDATE',
              [mediaId],
            )
          ).rows[0];
          if (
            media &&
            media.conversation_id === current.id &&
            media.uploaded_by !== input.actor.id
          )
            throw new InboxForbiddenError('Media belongs to another uploader');
          const size = Number(media?.size_bytes);
          const allowedMime = {
            image: ['image/jpeg', 'image/png'],
            audio: ['audio/mpeg', 'audio/mp4', 'audio/ogg'],
            video: ['video/mp4'],
          };
          if (
            !media ||
            media.conversation_id !== current.id ||
            media.state !== 'ready' ||
            media.message_id !== null ||
            media.validation_status !== 'clean' ||
            media.kind !== input.messageType ||
            !/^[a-f0-9]{64}$/u.test(media.content_sha256 ?? '') ||
            !/^[a-f0-9]{64}$/u.test(media.original_sha256 ?? '') ||
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > (input.messageType === 'image' ? 5 : 16) * 1024 * 1024 ||
            Number(media.reservation_bytes) !== size ||
            !allowedMime[
              /** @type {'image'|'audio'|'video'} */ (input.messageType)
            ].includes(media.detected_mime_type)
          )
            throw new InboxConflictError(
              'Media is not ready for this human message',
            );
          const quota = (
            await transaction.query(
              'SELECT * FROM crm.chat_media_quotas WHERE bucket_alias=$1 FOR UPDATE',
              [media.storage_bucket_alias],
            )
          ).rows[0];
          if (!quota || Number(quota.reserved_bytes) < size)
            throw new InboxConflictError('Media reservation is inconsistent');
        }
        const updated = await transaction.query(
          `UPDATE crm.conversations SET automation_state = 'human',
             automation_epoch = automation_epoch
               + CASE WHEN automation_state = 'assistant' THEN 1 ELSE 0 END,
             assigned_user_id = $3, state = 'em_atendimento',
             version = version + 1, last_message_at = GREATEST(last_message_at, $2)
           WHERE id = $1 RETURNING ${CONVERSATION_SELECT}`,
          [input.conversationId, occurredAt, input.actor.id],
        );
        const conversation = updated.rows[0];
        const messageId = runtime.idFactory('message');
        const envelope = encryptJson(
          input.content,
          `message:${messageId}`,
          this.#envelopeKey,
        );
        const message = await transaction.query(
          `INSERT INTO crm.messages
             (id, conversation_id, provider, provider_account_id, command_id,
              direction, author_kind, author_id, message_type, content_envelope,
              key_version, status, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'outbound', 'human', $6, $7, $8::jsonb,
                   1, 'queued', $9, $9)
           RETURNING ${MESSAGE_SELECT}`,
          [
            messageId,
            conversation.id,
            conversation.provider,
            conversation.provider_account_id,
            input.idempotencyKey,
            input.actor.id,
            input.messageType,
            JSON.stringify(envelope),
            occurredAt,
          ],
        );
        if (media) {
          const bound = await transaction.query(
            `UPDATE crm.chat_media SET state='attached',message_id=$2,attached_at=$3,reservation_bytes=0,version=version+1 WHERE id=$1 AND version=$4 AND state='ready' AND message_id IS NULL RETURNING id`,
            [media.id, messageId, occurredAt, media.version],
          );
          if (!bound.rows.length)
            throw new InboxConflictError('Media binding changed concurrently');
          await transaction.query(
            `UPDATE crm.chat_media_quotas SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$2,version=version+1,updated_at=now() WHERE bucket_alias=$1`,
            [media.storage_bucket_alias, Number(media.size_bytes)],
          );
        }
        await this.#outboundMessageOutbox.enqueueChannelMessage(
          {
            availableAt: occurredAt,
            id: runtime.idFactory('job'),
            idempotencyKey: input.idempotencyKey,
            messageId,
          },
          { transaction },
        );
        result = mapMessage(
          message.rows[0],
          this.#envelopeKey,
          conversation.version,
        );
        commandResult = {
          conversationVersion: Number(conversation.version),
          entityId: messageId,
          entityType: 'message',
        };
      } else {
        const assignments = mutationAssignments(kind, input, occurredAt);
        const updated = await transaction.query(
          `UPDATE crm.conversations SET ${assignments.sql}, version = version + 1
           WHERE id = $1 RETURNING ${CONVERSATION_SELECT}`,
          [input.conversationId, ...assignments.values],
        );
        result = mapConversation(updated.rows[0]);
        if (kind === 'transition' && isTerminalInboxState(input.state)) {
          await resolveOpenHandoff(transaction, input, occurredAt);
        }
        commandResult = {
          entityId: result.id,
          entityType: 'conversation',
          version: result.version,
        };
      }
      await runtime.appendAudit(createAudit(kind, input, result, occurredAt), {
        transaction,
      });
      await appendConversationStreamEvent(transaction, {
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        occurredAt,
        type: STREAM_EVENT_TYPES[kind] ?? 'conversation.changed',
      });
      const panelAction =
        kind === 'takeover'
          ? 'take_over'
          : kind === 'transition' && isTerminalInboxState(input.state)
            ? 'close'
            : null;
      if (
        panelAction !== null &&
        typeof this.#outboundMessageOutbox.enqueuePanelCommand === 'function'
      ) {
        await this.#outboundMessageOutbox.enqueuePanelCommand(
          {
            action: panelAction,
            actor: input.actor,
            availableAt: occurredAt,
            commandId: input.idempotencyKey,
            conversationId: input.conversationId,
            jobId: runtime.idFactory('job'),
          },
          { transaction },
        );
      }
      await transaction.query(
        `INSERT INTO crm.inbox_commands
           (operation, idempotency_key, fingerprint, result, created_at, completed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
        [
          kind,
          input.idempotencyKey,
          fingerprint,
          JSON.stringify(commandResult),
          occurredAt,
        ],
      );
      return result;
    });
  }

  /** @param {any} input @param {any} runtime */
  async recordSuggestion(input, runtime) {
    return this.#database.transaction(async (transaction) => {
      await advisoryLock(
        transaction,
        `suggestion:${input.sourceMessageId}:${input.proposedStage}`,
      );
      const existing = await transaction.query(
        `SELECT s.*, c.state AS conversation_state
         FROM crm.ai_suggestions s JOIN crm.conversations c ON c.id = s.conversation_id
         WHERE source_message_id = $1 AND proposed_stage = $2`,
        [input.sourceMessageId, input.proposedStage],
      );
      if (existing.rows[0])
        return mapSuggestion(existing.rows[0], this.#envelopeKey);
      const source = await transaction.query(
        `SELECT c.id, c.automation_epoch
         FROM crm.conversations c JOIN crm.messages m ON m.conversation_id = c.id
         WHERE c.id = $1 AND m.id = $2 FOR UPDATE OF c`,
        [input.conversationId, input.sourceMessageId],
      );
      if (!source.rows[0]) {
        throw new InboxConflictError(
          'Suggestion source is not in the conversation',
        );
      }
      const id = runtime.idFactory('suggestion');
      const occurredAt = runtime.clock().toISOString();
      const envelope = encryptJson(
        input.question,
        `suggestion:${id}`,
        this.#envelopeKey,
      );
      const inserted = await transaction.query(
        `INSERT INTO crm.ai_suggestions
           (id, conversation_id, source_message_id, automation_epoch,
            proposed_stage, question_envelope, key_version, status, created_by,
            created_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, 'pending', $7, $8, NULL)
         RETURNING *`,
        [
          id,
          input.conversationId,
          input.sourceMessageId,
          source.rows[0].automation_epoch,
          input.proposedStage,
          JSON.stringify(envelope),
          input.actor.id,
          occurredAt,
        ],
      );
      return mapSuggestion(inserted.rows[0], this.#envelopeKey);
    });
  }

  /** @param {Queryable} transaction @param {any} rawResult */
  async #hydrateCommand(transaction, rawResult) {
    const stored =
      typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    if (stored.entityType === 'conversation') {
      const selected = await transaction.query(
        `SELECT ${CONVERSATION_SELECT} FROM crm.conversations WHERE id = $1`,
        [stored.entityId],
      );
      return mapConversation(selected.rows[0]);
    }
    const selected = await transaction.query(
      `SELECT ${MESSAGE_SELECT} FROM crm.messages WHERE id = $1`,
      [stored.entityId],
    );
    return mapMessage(
      selected.rows[0],
      this.#envelopeKey,
      stored.conversationVersion,
    );
  }
}

const CONVERSATION_SELECT = `id, contact_identity_id, provider,
  provider_account_id, external_conversation_id, cycle_number,
  previous_conversation_id, state, automation_state, automation_epoch,
  assigned_user_id, version, opened_at, last_message_at, terminal_at,
  archived_at, closure_outcome, closed_by`;
const MESSAGE_SELECT = `id, conversation_id, provider, provider_account_id,
  external_message_id, command_id, direction, author_kind, author_id,
  message_type, content_envelope, status, occurred_at, created_at`;

/**
 * INBOX-HANDOFF-02: closing the conversation (any path that sets
 * `terminal_at`) resolves its open handoff in the same transaction, so the
 * "Aguardando vendedor" queue and the Painel never count a closed cycle.
 * A handoff nobody claimed is resolved in the name of the person closing it,
 * because a resolved handoff always has an owner (0013). Its human task, when
 * the legacy Deal flow created one, is completed alongside.
 *
 * @param {Queryable} transaction @param {any} input @param {string} occurredAt
 */
async function resolveOpenHandoff(transaction, input, occurredAt) {
  const resolved = await transaction.query(
    `WITH open AS (
       SELECT id, status FROM crm.handoffs
       WHERE conversation_id = $1 AND status IN ('pending', 'accepted')
       FOR UPDATE
     )
     UPDATE crm.handoffs AS handoff
     SET status = 'resolved', resolved_at = $2,
         updated_at = GREATEST(handoff.created_at, $2::timestamptz),
         assigned_user_id = COALESCE(handoff.assigned_user_id, $3),
         version = handoff.version + 1
     FROM open
     WHERE handoff.id = open.id
     RETURNING handoff.id, handoff.version, handoff.assigned_user_id,
               handoff.target_role, open.status AS from_status`,
    [input.conversationId, occurredAt, input.actor.id],
  );
  for (const handoff of resolved.rows) {
    await transaction.query(
      `INSERT INTO crm.handoff_history
         (handoff_id, resulting_version, from_status, to_status,
          assigned_user_id, target_role, actor_id, reason_code,
          correlation_id, occurred_at)
       VALUES ($1, $2, $3, 'resolved', $4, $5, $6, 'conversation_closed', $7,
               $8)`,
      [
        handoff.id,
        Number(handoff.version),
        handoff.from_status,
        handoff.assigned_user_id,
        handoff.target_role,
        input.actor.id,
        input.correlationId,
        occurredAt,
      ],
    );
    const tasks = await transaction.query(
      `UPDATE crm.tasks AS task
       SET status = 'completed', completed_at = $2,
           updated_at = GREATEST(task.created_at, $2::timestamptz),
           version = task.version + 1
       FROM (SELECT id, status FROM crm.tasks
             WHERE handoff_id = $1 AND status IN ('pending', 'in_progress')
             FOR UPDATE) AS previous
       WHERE task.id = previous.id
       RETURNING task.id, task.version, previous.status AS from_status`,
      [handoff.id, occurredAt],
    );
    for (const task of tasks.rows) {
      await transaction.query(
        `INSERT INTO crm.task_history
           (task_id, resulting_version, from_status, to_status, actor_id,
            reason_code, correlation_id, occurred_at)
         VALUES ($1, $2, $3, 'completed', $4, 'conversation_closed', $5, $6)`,
        [
          task.id,
          Number(task.version),
          task.from_status,
          input.actor.id,
          input.correlationId,
          occurredAt,
        ],
      );
    }
  }
}

/** @param {string} kind @param {any} input @param {string} occurredAt */
function mutationAssignments(kind, input, occurredAt) {
  if (kind === 'archive') {
    return { sql: 'archived_at = $2', values: [occurredAt] };
  }
  if (kind === 'unarchive') {
    return { sql: 'archived_at = NULL', values: [] };
  }
  if (kind === 'transition') {
    if (input.state === 'encerrada') {
      return {
        sql: `state = $2, terminal_at = $3, closure_outcome = $4,
              closed_by = $5, automation_epoch = automation_epoch + 1`,
        values: [input.state, occurredAt, input.outcome, input.actor.id],
      };
    }
    return {
      sql: 'state = $2, terminal_at = $3',
      values: [
        input.state,
        isTerminalInboxState(input.state) ? occurredAt : null,
      ],
    };
  }
  if (kind === 'takeover') {
    return {
      sql: `automation_state = 'human', automation_epoch = automation_epoch + 1,
            state = 'em_atendimento', assigned_user_id = $2`,
      values: [input.actor.id],
    };
  }
  if (kind === 'transfer') {
    // Ownership moves; the automation epoch is untouched because the channel
    // side of the conversation does not change.
    return {
      sql: `assigned_user_id = $2, automation_state = 'human',
            state = 'em_atendimento'`,
      values: [input.targetUserId],
    };
  }
  // ADR 015: no change hands the conversation back to the assistant.
  throw new TypeError(`Unsupported conversation mutation: ${kind}`);
}

/** @param {any} row */
function mapConversation(row) {
  if (!row) throw new InboxConflictError('Stored conversation was not found');
  return freezeInboxRecord({
    assignedUserId: row.assigned_user_id,
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    automationEpoch: Number(row.automation_epoch),
    automationState: row.automation_state,
    createdAt: iso(row.opened_at),
    cycleNumber: Number(row.cycle_number),
    closureOutcome: row.closure_outcome ?? null,
    closedBy: row.closed_by ?? null,
    externalConversationId: row.external_conversation_id,
    id: row.id,
    identityId: row.contact_identity_id,
    previousConversationId: row.previous_conversation_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    state: row.state,
    terminalAt: row.terminal_at === null ? null : iso(row.terminal_at),
    updatedAt: iso(row.last_message_at),
    version: Number(row.version),
  });
}

/** @param {any} row @param {Buffer} key @param {number} [conversationVersion] */
function mapMessage(row, key, conversationVersion) {
  if (!row) throw new InboxConflictError('Stored message was not found');
  return freezeInboxRecord({
    authorId: row.author_id,
    content: decryptJson(row.content_envelope, `message:${row.id}`, key),
    conversationId: row.conversation_id,
    ...(conversationVersion === undefined
      ? {}
      : { conversationVersion: Number(conversationVersion) }),
    createdAt: iso(row.created_at),
    direction: row.direction,
    externalMessageId: row.external_message_id,
    id: row.id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    status: row.status,
    type: row.message_type,
  });
}

/** @param {any} row @param {Buffer} key */
function mapSuggestion(row, key) {
  return freezeInboxRecord({
    automationEpoch: Number(row.automation_epoch),
    conversationId: row.conversation_id,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    id: row.id,
    proposedStage: row.proposed_stage,
    question: decryptJson(row.question_envelope, `suggestion:${row.id}`, key),
    resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at),
    sourceMessageId: row.source_message_id,
    status: row.status,
  });
}

/** @param {unknown} value @param {string} context @param {Buffer} key */
function encryptJson(value, context, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    keyVersion: 1,
    tag: cipher.getAuthTag().toString('base64url'),
    version: 1,
  };
}

/** @param {any} raw @param {string} context @param {Buffer} key */
function decryptJson(raw, context, key) {
  const envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (
    envelope?.algorithm !== ALGORITHM ||
    envelope?.version !== 1 ||
    envelope?.keyVersion !== 1
  ) {
    throw new Error('Unsupported inbox content envelope');
  }
  try {
    const decipher = createDecipheriv(
      CIPHER,
      key,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch (error) {
    throw new Error('Unable to authenticate or decrypt inbox content', {
      cause: error,
    });
  }
}

/** @param {unknown} raw @param {string} id @param {Buffer} key @param {boolean} [contextIsComplete] */
export function decryptInboxMessageEnvelope(
  raw,
  id,
  key,
  contextIsComplete = false,
) {
  return decryptJson(raw, contextIsComplete ? id : `message:${id}`, key);
}

/** @param {Queryable} transaction @param {string} identity */
async function advisoryLock(transaction, identity) {
  await transaction.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [identity],
  );
}

/** @param {unknown} value */
function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Canonical JSON projection preserves JSON semantics without another module dependency. @param {any} value @returns {any} */
function canonicalCommandValue(value) {
  if (Array.isArray(value)) return value.map(canonicalCommandValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalCommandValue(value[key])]),
    );
  return value;
}

/** @param {string|Date} value */
function iso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** @param {string} kind @param {any} input @param {any} result @param {string} occurredAt */
function createAudit(kind, input, result, occurredAt) {
  const actions = {
    archive: 'conversation.archived',
    unarchive: 'conversation.unarchived',
    send: 'conversation.human_message_queued',
    takeover: 'conversation.takeover',
    transfer: 'conversation.transferred',
    transition: 'conversation.state_transitioned',
  };
  return freezeInboxRecord({
    action: actions[/** @type {keyof typeof actions} */ (kind)],
    actor: input.actor.id,
    correlationId: input.correlationId,
    occurredAt,
    reason:
      kind === 'transfer'
        ? `${input.reason} (repasse para ${input.targetUserId})`
        : input.reason,
    target: { id: input.conversationId, type: 'conversation' },
    version: result.conversationVersion ?? result.version,
  });
}
