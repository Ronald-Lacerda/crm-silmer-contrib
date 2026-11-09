import {
  decryptJson,
  encryptJson,
  fingerprint,
  identityLookupHash,
} from './crypto.js';
import {
  contactPhoneHash,
  decryptSiteContactClaim,
  encryptSiteContactClaim,
  normalizeContactPhone,
} from '@crm-silmer/contacts';
import {
  N8nConflictError,
  N8nNotFoundError,
  N8nValidationError,
} from './errors.js';
import { retainedMediaReference } from './retained-media-reference.js';

/** @typedef {{query(sql: string, values?: unknown[]): Promise<{rows: any[]}>}} Queryable */
/**
 * The `order` answer of an event that asked `open_order` (ADR 014).
 * @typedef {{opened: true, id: string, subject_id: string, created: boolean} | {opened: false, error: string}} OrderOpening
 */

const CONTACT_DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * Mirrors the conversation change onto the shared domain event stream so the
 * `inbox` SSE topic pushes it to open panels. The n8n integration owns its own
 * persistence path, so without this the Inbox would stay live for human
 * commands but go quiet for everything arriving from WhatsApp.
 *
 * `aggregate_version` counts occurrences of this event type for this
 * conversation: the unique constraint on
 * (aggregate_type, aggregate_id, aggregate_version, event_type) would otherwise
 * drop events that land while the conversation version is unchanged.
 *
 * @param {Queryable} client
 * @param {any} runtime
 * @param {{conversationId: string, correlationId: string, occurredAt: string, type: string}} event
 */
async function appendConversationStreamEvent(client, runtime, event) {
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
      runtime.idFactory('event'),
      event.conversationId,
      event.type,
      JSON.stringify({ conversationId: event.conversationId }),
      event.correlationId,
      event.occurredAt,
    ],
  );
}

const EVENTS_WITH_TURNS = new Set([
  'handoff.requested',
  'message.send.requested',
]);

const AUTOMATION_FAILURE_SUMMARY =
  'O assistente falhou ao responder. Confira a última mensagem do cliente.';

/** ADR 009: automated messages per Conversation; the last one is the handoff notice. */
export const AUTOMATION_MESSAGE_CAP = 15;

export class PostgresN8nIntegrationRepository {
  /**
   * @param {{
   *   database: {query: Queryable['query'], transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T>},
   *   envelopeKey: Buffer,
   *   contactEnvelopeKey?: Buffer,
   *   contactLookupKey?: Buffer,
   *   messageEnvelopeKey?: Buffer,
   *   orders?: {
   *     ensurePendingFromIntent?(input: {conversationId: string, correlationId: string}): Promise<{created: boolean, order: {id: string}}>,
   *     projectAgentBriefing(input: {conversationId: string, correlationId: string, briefing: Record<string, unknown>, automationState: string, orderId?: string|null, subjectId?: string|null, automationEpoch?: number|null, sourceRevision?: number|null, eventId?: string|null, eventType?: string|null, expectedSubjectVersion?: number|null, expectedOrderVersion?: number|null, recovery?: boolean}): Promise<any>,
   *   } | null,
   *   automationMessageCap?: number,
   *   requireHumanOrderCreation?: boolean,
   * }} options
   */
  constructor({
    database,
    envelopeKey,
    contactEnvelopeKey = envelopeKey,
    contactLookupKey = envelopeKey,
    messageEnvelopeKey = envelopeKey,
    orders = null,
    automationMessageCap = AUTOMATION_MESSAGE_CAP,
    requireHumanOrderCreation = false,
  }) {
    if (
      !database ||
      typeof database.query !== 'function' ||
      typeof database.transaction !== 'function'
    ) {
      throw new TypeError('A transactional PostgreSQL database is required');
    }
    for (const [key, name] of [
      [envelopeKey, 'envelopeKey'],
      [contactEnvelopeKey, 'contactEnvelopeKey'],
      [contactLookupKey, 'contactLookupKey'],
      [messageEnvelopeKey, 'messageEnvelopeKey'],
    ]) {
      if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new TypeError(`${name} must be a 32-byte Buffer`);
      }
    }
    this.database = database;
    this.envelopeKey = Buffer.from(envelopeKey);
    this.contactEnvelopeKey = Buffer.from(contactEnvelopeKey);
    this.contactLookupKey = Buffer.from(contactLookupKey);
    this.messageEnvelopeKey = Buffer.from(messageEnvelopeKey);
    this.orders = orders;
    this.requireHumanOrderCreation = requireHumanOrderCreation;
    if (!Number.isInteger(automationMessageCap) || automationMessageCap < 2) {
      throw new TypeError(
        'automationMessageCap must be an integer of at least 2',
      );
    }
    this.automationMessageCap = automationMessageCap;
  }

  /**
   * The UUID generated by the site chat is the only bearer for its own
   * synthetic identity. A typed phone never enters this lookup.
   * @param {{sessionId: string}} input
   */
  async readSiteMessages(input) {
    const session = String(input?.sessionId ?? '')
      .trim()
      .toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        session,
      )
    ) {
      throw new N8nValidationError('Invalid site session');
    }
    const externalIdentityId = `999${BigInt(`0x${session.replaceAll('-', '')}`)
      .toString(10)
      .padStart(39, '0')}`;
    const lookupHash = identityLookupHash(
      {
        channel: 'site_chat',
        externalIdentityId,
        provider: 'site',
        providerAccountId: 'silmer-site',
      },
      this.contactLookupKey,
    );
    const rows = (
      await this.database.query(
        `SELECT message.id, message.direction, message.author_kind,
                message.message_type, message.content_envelope,
                message.occurred_at
         FROM crm.messages AS message
         JOIN crm.conversations AS conversation
           ON conversation.id = message.conversation_id
         JOIN crm.contact_identities AS identity
           ON identity.id = conversation.contact_identity_id
         WHERE identity.provider = 'site'
           AND identity.provider_account_id = 'silmer-site'
           AND identity.channel = 'site_chat'
           AND identity.external_identity_lookup_hash = $1
           AND identity.channel = 'site_chat'
           AND message.message_type = 'text'
           AND ((message.direction = 'inbound' AND message.status = 'received')
             OR (message.direction = 'outbound'
               AND message.status IN ('sent', 'delivered', 'read')))
         ORDER BY message.occurred_at DESC, message.id DESC LIMIT 100`,
        [lookupHash],
      )
    ).rows.reverse();
    return {
      messages: rows.map((row) => {
        const content = decryptJson(
          row.content_envelope,
          `message:${row.id}`,
          this.messageEnvelopeKey,
        );
        return {
          id: row.id,
          direction: row.direction,
          sender: row.direction === 'inbound' ? 'customer' : row.author_kind,
          text: String(content.text ?? '').slice(0, 4096),
          occurred_at: iso(row.occurred_at),
        };
      }),
    };
  }

  /** @param {any} input @param {any} runtime */
  async receiveInbound(input, runtime) {
    return this.database.transaction(async (client) => {
      await transactionBounds(client);
      await advisoryLock(
        client,
        `n8n-inbound:${input.provider}:${input.providerAccountId}:${input.externalEventId}`,
      );
      const replay = await selectReceipt(
        client,
        'n8n.messages.inbound',
        input.technical.idempotencyKey,
      );
      if (replay) {
        assertFingerprint(replay, input.eventFingerprint);
        return this.#inboundResponse(client, replay.conversation_id, true);
      }

      const lookupHash = identityLookupHash(
        {
          channel: input.channel,
          externalIdentityId: input.externalIdentityId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
        this.contactLookupKey,
      );
      let identity = (
        await client.query(
          `SELECT id, current_contact_id
           FROM crm.contact_identities
           WHERE provider = $1 AND provider_account_id = $2 AND channel = $3
             AND external_identity_lookup_hash = $4
           FOR UPDATE`,
          [input.provider, input.providerAccountId, input.channel, lookupHash],
        )
      ).rows[0];
      const now = validClock(runtime.clock);
      if (!identity) {
        const contactId = runtime.idFactory('contact');
        const identityId = runtime.idFactory('identity');
        await client.query(
          `INSERT INTO crm.contacts
             (id, provisional, version, created_at, updated_at)
           VALUES ($1, true, 1, $2, $2)`,
          [contactId, now],
        );
        const identityEnvelope = encryptJson(
          {
            displayHandle: input.displayHandle,
            externalIdentityId: input.externalIdentityId,
          },
          JSON.stringify(['crm.contact_identities', 1, lookupHash]),
          this.contactEnvelopeKey,
        );
        identity = (
          await client.query(
            `INSERT INTO crm.contact_identities
               (id, current_contact_id, provider, provider_account_id, channel,
                external_identity_lookup_hash, identity_kind, phone_status,
                identity_envelope, key_version, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, 1, $10, $10)
             RETURNING id, current_contact_id`,
            [
              identityId,
              contactId,
              input.provider,
              input.providerAccountId,
              input.channel,
              lookupHash,
              input.identityKind,
              input.phoneStatus,
              JSON.stringify(identityEnvelope),
              now,
            ],
          )
        ).rows[0];
      }

      // A verified WhatsApp identity makes the same contact searchable by
      // phone. This never merges contacts by a number a person typed.
      const confirmedPhone =
        input.channel === 'whatsapp' && input.phoneStatus === 'confirmed'
          ? normalizeContactPhone(input.externalIdentityId)
          : null;
      if (confirmedPhone) {
        await client.query(
          `INSERT INTO crm.contact_phone_lookup
             (contact_id, identity_id, phone_hash, source)
           VALUES ($1, $2, $3, 'whatsapp')
           ON CONFLICT DO NOTHING`,
          [
            identity.current_contact_id,
            identity.id,
            contactPhoneHash(confirmedPhone, this.contactLookupKey),
          ],
        );
      }

      let conversation = (
        await client.query(
          `SELECT * FROM crm.conversations
           WHERE provider = $1 AND provider_account_id = $2
             AND external_conversation_id = $3 AND terminal_at IS NULL
           FOR UPDATE`,
          [
            input.provider,
            input.providerAccountId,
            input.externalConversationId,
          ],
        )
      ).rows[0];
      if (conversation && conversation.contact_identity_id !== identity.id) {
        throw new N8nConflictError(
          'Open conversation is anchored to another identity',
        );
      }
      if (!conversation) {
        const previous = (
          await client.query(
            `SELECT id, cycle_number FROM crm.conversations
             WHERE provider = $1 AND provider_account_id = $2
               AND external_conversation_id = $3
             ORDER BY cycle_number DESC LIMIT 1`,
            [
              input.provider,
              input.providerAccountId,
              input.externalConversationId,
            ],
          )
        ).rows[0];
        conversation = (
          await client.query(
            `INSERT INTO crm.conversations
               (id, contact_identity_id, provider, provider_account_id,
                external_conversation_id, cycle_number, previous_conversation_id,
                state, automation_state, automation_epoch, version, opened_at,
                last_message_at, terminal_at, inbound_revision,
                claimed_revision, briefing_version, last_inbound_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'nova', 'assistant', 0, 1,
                     $8, $8, NULL, 1, 0, 0, $9)
             RETURNING *`,
            [
              runtime.idFactory('conversation'),
              identity.id,
              input.provider,
              input.providerAccountId,
              input.externalConversationId,
              Number(previous?.cycle_number ?? 0) + 1,
              previous?.id ?? null,
              input.occurredAt,
              input.externalEventId,
            ],
          )
        ).rows[0];
      } else {
        conversation = (
          await client.query(
            `UPDATE crm.conversations
             SET inbound_revision = inbound_revision + 1,
                 last_inbound_event_id = $2,
                 last_message_at = GREATEST(last_message_at, $3),
                 archived_at = NULL,
                 version = version + 1
             WHERE id = $1
             RETURNING *`,
            [conversation.id, input.externalEventId, input.occurredAt],
          )
        ).rows[0];
      }

      if (input.channel === 'site_chat') {
        await this.#storeSiteContactClaim(
          client,
          input,
          conversation,
          identity,
          runtime,
          now,
        );
      }

      const messageId = runtime.idFactory('message');
      await client.query(
        `INSERT INTO crm.messages
           (id, conversation_id, provider, provider_account_id,
            external_message_id, direction, author_kind, author_id,
            message_type, content_envelope, key_version, status, occurred_at,
            created_at, inbound_revision, automation_epoch, n8n_execution_id)
         VALUES ($1, $2, $3, $4, $5, 'inbound', 'contact', $6, $7, $8::jsonb,
                 1, 'received', $9, $10, $11, $12, $13)`,
        [
          messageId,
          conversation.id,
          input.provider,
          input.providerAccountId,
          input.externalMessageId,
          identity.id,
          input.message.type,
          JSON.stringify(
            encryptJson(
              input.message.content,
              `message:${messageId}`,
              this.messageEnvelopeKey,
            ),
          ),
          input.occurredAt,
          now,
          Number(conversation.inbound_revision),
          Number(conversation.automation_epoch),
          input.technical.executionId,
        ],
      );
      await insertReceipt(client, runtime, {
        automationEpoch: Number(conversation.automation_epoch),
        conversationId: conversation.id,
        correlationId: input.correlationId,
        eventId: input.externalEventId,
        eventType: 'message.inbound',
        fingerprint: input.eventFingerprint,
        idempotencyKey: input.technical.idempotencyKey,
        idempotencyScope: 'n8n.messages.inbound',
        messageId,
        occurredAt: input.occurredAt,
        outcome: { sourceRevision: Number(conversation.inbound_revision) },
        processedAt: now,
        sourceRevision: Number(conversation.inbound_revision),
        technical: input.technical,
      });
      await appendAudit(client, runtime, {
        action: 'integration.n8n.message.inbound',
        actor: input.technical.actor,
        correlationId: input.correlationId,
        occurredAt: now,
        reason: 'canonical inbound message accepted',
        targetId: conversation.id,
        targetType: 'conversation',
        version: conversation.version,
      });
      await appendConversationStreamEvent(client, runtime, {
        conversationId: conversation.id,
        correlationId: input.correlationId,
        occurredAt: now,
        type: 'conversation.message_received',
      });
      return this.#inboundResponse(client, conversation.id, false);
    });
  }

  /**
   * A site claim belongs only to its synthetic conversation. The number is
   * searchable by staff, but never changes the contact identity or matches an
   * existing customer's orders for the agent.
   * @param {Queryable} client @param {any} input @param {any} conversation
   * @param {any} identity @param {any} runtime @param {string} now
   */
  async #storeSiteContactClaim(
    client,
    input,
    conversation,
    identity,
    runtime,
    now,
  ) {
    const existing = (
      await client.query(
        `SELECT * FROM crm.site_contact_claims WHERE conversation_id = $1 FOR UPDATE`,
        [conversation.id],
      )
    ).rows[0];
    if (!input.siteContact && !existing) {
      throw new N8nConflictError(
        'Site contact details are required',
        'SITE_CONTACT_REQUIRED',
      );
    }
    if (!input.siteContact) return;
    const next = input.siteContact;
    const old = existing
      ? decryptSiteContactClaim(
          existing.details_envelope,
          existing.id,
          Number(existing.version),
          this.contactEnvelopeKey,
        )
      : null;
    if (old && (old.name !== next.name || old.phone !== next.phone)) {
      throw new N8nConflictError(
        'Site contact details changed in an existing conversation',
        'SITE_CONTACT_CONFLICT',
      );
    }
    if (!existing) {
      const id = runtime.idFactory('site-contact-claim');
      const version = 1;
      const envelope = encryptSiteContactClaim(
        next,
        id,
        version,
        this.contactEnvelopeKey,
      );
      const phoneHash = contactPhoneHash(next.phone, this.contactLookupKey);
      await client.query(
        `INSERT INTO crm.site_contact_claims
           (id, conversation_id, contact_id, phone_hash, details_envelope,
            source, source_event_id, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'site_chat', $6, $7, $8, $8)`,
        [
          id,
          conversation.id,
          identity.current_contact_id,
          phoneHash,
          JSON.stringify(envelope),
          input.externalEventId,
          version,
          now,
        ],
      );
    }
    // The synthetic contact gets a human-readable name. A seller's rename
    // remains authoritative, as in guided WhatsApp name collection.
    await this.#promoteCustomerName(
      client,
      conversation,
      next.name,
      runtime,
      now,
    );
    if (!this.#readBriefing(conversation).customer_name) {
      await this.#mergeBriefing(
        client,
        conversation,
        { customer_name: next.name },
        runtime,
        now,
        null,
        false,
      );
    }
  }

  /** @param {any} input @param {any} runtime */
  async storeAttachment(input, runtime) {
    return this.database.transaction(async (client) => {
      await transactionBounds(client);
      await advisoryLock(
        client,
        `n8n-attachment:${input.technical.idempotencyKey}`,
      );
      const replay = await selectReceipt(
        client,
        'n8n.attachments.store',
        input.technical.idempotencyKey,
      );
      if (replay) {
        assertFingerprint(replay, input.eventFingerprint);
        return attachmentResponse(replay.outcome, true);
      }
      const message = (
        await client.query(
          `SELECT id FROM crm.messages
           WHERE conversation_id = $1 AND external_message_id = $2
           FOR UPDATE`,
          [input.conversationId, input.externalId],
        )
      ).rows[0];
      if (!message) {
        const conversation = await client.query(
          'SELECT id FROM crm.conversations WHERE id = $1',
          [input.conversationId],
        );
        if (!conversation.rows[0]) {
          throw new N8nNotFoundError('Conversation was not found');
        }
        throw new N8nNotFoundError('Message was not found in the conversation');
      }
      const media = (
        await client.query(
          `SELECT id, content_sha256, detected_mime_type, size_bytes
           FROM crm.transient_media WHERE id = $1 FOR UPDATE`,
          [input.transientMediaId],
        )
      ).rows[0];
      if (!media) throw new N8nNotFoundError('Transient media was not found');
      if (
        media.content_sha256 !== input.contentSha256 ||
        Number(media.size_bytes) !== input.size ||
        media.detected_mime_type !== input.mimeType
      ) {
        throw new N8nConflictError(
          'Attachment metadata does not match stored media',
        );
      }
      const createdAt = validClock(runtime.clock);
      await client.query(
        `INSERT INTO crm.attachments
           (message_id, transient_media_id, filename_envelope, key_version,
            created_at)
         VALUES ($1, $2, $3::jsonb, 1, $4)
         ON CONFLICT (message_id, transient_media_id) DO NOTHING`,
        [
          message.id,
          media.id,
          JSON.stringify(
            encryptJson(
              { filename: input.filename },
              `attachment:${message.id}:${media.id}:filename`,
              this.envelopeKey,
            ),
          ),
          createdAt,
        ],
      );
      const outcome = {
        attachment_id: media.id,
        conversation_id: input.conversationId,
        created_at: createdAt,
        external_id: input.externalId,
        filename: input.filename,
        mime_type: input.mimeType,
        sha256: input.contentSha256,
        size: input.size,
      };
      await insertReceipt(client, runtime, {
        automationEpoch: null,
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        eventId: `${input.externalId}:attachment`,
        eventType: 'attachment.stored',
        fingerprint: input.eventFingerprint,
        idempotencyKey: input.technical.idempotencyKey,
        idempotencyScope: 'n8n.attachments.store',
        messageId: message.id,
        occurredAt: createdAt,
        outcome,
        processedAt: createdAt,
        sourceRevision: null,
        technical: input.technical,
      });
      await appendAudit(client, runtime, {
        action: 'integration.n8n.attachment.stored',
        actor: input.technical.actor,
        correlationId: input.correlationId,
        occurredAt: createdAt,
        reason: 'transient attachment linked to canonical message',
        targetId: media.id,
        targetType: 'transient_media',
        version: 1,
      });
      return attachmentResponse(outcome, false);
    });
  }

  /** @param {any} input @param {any} runtime */
  /** Read the immutable bound variant under the same lock order as reservation. @param {any} input */
  async readReservedMedia(input) {
    return this.database.transaction(async (client) => {
      await transactionBounds(client);
      const target = (
        await client.query(
          'SELECT conversation_id FROM crm.n8n_commands WHERE command_id=$1',
          [input.commandId],
        )
      ).rows[0];
      if (!target) throw new N8nNotFoundError('Command not found');
      const conversation = (
        await client.query(
          'SELECT * FROM crm.conversations WHERE id=$1 FOR UPDATE',
          [target.conversation_id],
        )
      ).rows[0];
      const command = await selectPanelCommand(client, input.commandId);
      const lateMedia = await assertReservedExecution(
        client,
        command,
        input,
        false,
        'read',
      );
      if (!['image', 'audio', 'video'].includes(command.message_type))
        throw new N8nConflictError('Command has no retained media');
      const payload = decryptJson(
        command.payload_envelope,
        `n8n-command:${command.command_id}`,
        this.envelopeKey,
      );
      const bound = (
        await client.query(
          'SELECT * FROM crm.chat_media WHERE message_id=$1 AND conversation_id=$2 FOR UPDATE',
          [command.message_id, target.conversation_id],
        )
      ).rows[0];
      if (!bound) throw new N8nConflictError('Bound media is missing');
      assertPanelSendFence(
        command,
        conversation,
        {
          automationEpoch: payload.automation_epoch,
          sourceRevision: payload.source_revision,
          message: payload.message,
        },
        this.envelopeKey,
        bound,
        this.messageEnvelopeKey,
        lateMedia ? 'outcome_unknown' : 'sending',
        lateMedia ? 'outcome_unknown' : 'processing',
      );
      return bound;
    });
  }

  /** @param {any} input @param {any} runtime */
  async recordEvent(input, runtime) {
    // Order projection opens its own transaction (PostgresOrderRepository
    // owns that) and both it and this transaction can insert into
    // crm.domain_events, whose BEFORE INSERT trigger takes one global
    // advisory lock to assign the stream cursor. Calling it from inside
    // this transaction risks a cross-connection deadlock Postgres cannot
    // detect (this connection would hold the lock while idle, waiting on
    // the nested connection, which waits on that same lock) — a real
    // transaction_timeout hang was reproduced. Deferring the call to after
    // commit avoids the shared lock entirely; it already runs best-effort.
    // Opening the pending order (ADR 014, `open_order`) follows the same
    // rule: it runs after commit, so it reads the briefing this event merged,
    // and its outcome is reported in the response without failing the event.
    /** @type {any} */
    let projectionTarget = null;
    // CP-12: the inbound revisions this automated turn answered, so the
    // order bootstrap after commit can record their subject too.
    /** @type {{fromRevision: number, toRevision: number} | null} */
    let answeredTurn = null;
    /** @type {(work: (client: Queryable) => Promise<any>) => Promise<any>} */
    const transaction = (work) =>
      this.#traceStaleFence(input, runtime, () =>
        this.database.transaction(work),
      );
    const result = await transaction(async (client) => {
      await transactionBounds(client);
      await advisoryLock(client, `n8n-event:${input.technical.idempotencyKey}`);
      const replay = await selectReceipt(
        client,
        'n8n.events',
        input.technical.idempotencyKey,
      );
      if (replay) {
        assertFingerprint(replay, input.eventFingerprint);
        const previous = jsonObject(replay.outcome);
        if (
          Number.isInteger(previous.turnFromRevision) &&
          Number.isInteger(input.sourceRevision)
        ) {
          answeredTurn = {
            fromRevision: previous.turnFromRevision,
            toRevision: input.sourceRevision,
          };
        }
        if (input.subjectId && input.briefingPatch && input.conversationId) {
          const conversation = (
            await client.query(
              'SELECT * FROM crm.conversations WHERE id = $1',
              [input.conversationId],
            )
          ).rows[0];
          const subject = (
            await client.query(
              `SELECT subject.id, briefing.version AS briefing_version,
                      briefing.envelope AS briefing_envelope,
                      briefing.legacy_conversation_id
               FROM crm.conversation_subjects AS subject
               JOIN crm.subject_briefings AS briefing
                 ON briefing.subject_id = subject.id
               WHERE subject.id = $1 AND subject.conversation_id = $2
                 AND subject.order_id = $3`,
              [input.subjectId, input.conversationId, input.orderId],
            )
          ).rows[0];
          if (conversation && subject) {
            projectionTarget = {
              conversation,
              correlationId: input.correlationId,
              orderId: input.orderId,
              subjectId: input.subjectId,
              briefing: this.#readSubjectBriefing(subject),
              automationEpoch: input.automationEpoch,
              sourceRevision: input.sourceRevision,
              eventId: input.eventId,
              eventType: input.eventType,
              expectedSubjectVersion: Number(previous.projectionSubjectVersion),
              expectedOrderVersion: Number(previous.projectionOrderVersion),
              recovery: true,
            };
          }
        }
        return {
          accepted: true,
          duplicate: true,
          event_id: replay.external_event_id,
          processed_at: iso(replay.processed_at),
          ...(replay.event_type === 'message.send.requested'
            ? { send_authorized: false }
            : {}),
          ...(previous.handoffId ? { handoff_id: previous.handoffId } : {}),
          // A replay never authorizes a second notice send.
          ...('noticeCommandId' in previous
            ? {
                notice: {
                  send_authorized: false,
                  command_id: previous.noticeCommandId,
                },
              }
            : {}),
        };
      }

      const processedAt = validClock(runtime.clock);
      const commandCallback = ['message.sent', 'message.send.unknown'].includes(
        input.eventType,
      );
      const canonicalConversationId = commandCallback
        ? await resolveEventConversation(client, input)
        : null;
      if (
        commandCallback &&
        input.conversationId &&
        input.conversationId !== canonicalConversationId
      ) {
        throw new N8nConflictError(
          'Callback conversation does not match its command',
          'COMMAND_PAYLOAD_MISMATCH',
        );
      }
      const resolvedConversationId =
        canonicalConversationId ??
        input.conversationId ??
        (input.eventType === 'workflow.failed'
          ? null
          : await resolveEventConversation(client, input));
      const eventInput = { ...input, conversationId: resolvedConversationId };
      let conversation = null;
      if (resolvedConversationId) {
        conversation = (
          await client.query(
            'SELECT * FROM crm.conversations WHERE id = $1 FOR UPDATE',
            [resolvedConversationId],
          )
        ).rows[0];
        if (!conversation) {
          throw new N8nNotFoundError('Conversation was not found');
        }
      }

      const explicitTarget = eventInput.subjectId
        ? await this.#validateExplicitTarget(client, conversation, eventInput)
        : null;
      const panelCommand =
        eventInput.eventType === 'message.send.requested'
          ? await selectPanelCommand(client, eventInput.commandId)
          : null;
      // CP-14/CP-18: the legacy workflow only knows the conversation's one
      // pending order. A selected different subject makes that target unsafe.
      // Stop before reserving a reply, merging briefing or opening an order.
      // A handoff without a patch or order request remains a safe escape.
      // OPS-INBOX-SEND-07: human replies are bound to their persisted command,
      // not the agent's pending-order target. #reserveSend still validates its
      // author, payload and current fence before authorizing any effect.
      if (
        conversation &&
        !explicitTarget &&
        ((eventInput.eventType === 'message.send.requested' && !panelCommand) ||
          (eventInput.eventType === 'handoff.requested' &&
            (eventInput.briefingPatch || eventInput.openOrder === true)))
      ) {
        const target = (
          await client.query(
            `SELECT
               (SELECT count(*)::integer FROM crm.orders
                WHERE conversation_id=$1 AND status='pendente' AND cancelled_at IS NULL) AS pending_count,
               (SELECT id FROM crm.orders
                WHERE conversation_id=$1 AND status='pendente' AND cancelled_at IS NULL LIMIT 1)
                 AS pending_id,
               (SELECT id FROM crm.conversation_subjects
                WHERE conversation_id=$1 AND is_current) AS subject_id,
               (SELECT count(*)::integer FROM crm.conversation_subjects
                WHERE conversation_id=$1) AS subject_count,
               (SELECT order_id FROM crm.conversation_subjects
                WHERE conversation_id=$1 AND is_current) AS subject_order_id,
               (SELECT count(DISTINCT link.subject_id)::integer
                FROM crm.message_subject_links AS link
                JOIN crm.messages AS message ON message.id = link.message_id
                WHERE message.conversation_id=$1 AND message.direction='inbound'
                  AND message.inbound_revision=$2) AS source_subject_count`,
            [conversation.id, eventInput.sourceRevision],
          )
        ).rows[0];
        if (
          (eventInput.allowConversationBriefing &&
            eventInput.briefingPatch &&
            (Number(target.subject_count) > 1 ||
              Number(target.pending_count) > 0)) ||
          (eventInput.subjectContractRequired &&
            eventInput.openOrder === true &&
            (target.pending_count > 0 || target.subject_count > 0)) ||
          target.pending_count > 1 ||
          target.source_subject_count > 1 ||
          (target.subject_id && target.subject_order_id !== target.pending_id)
        ) {
          throw new N8nConflictError(
            'The selected subject requires an explicit order target',
            'SUBJECT_TARGET_REQUIRED',
          );
        }
      }

      let messageId = null;
      const outcome = {};
      if (eventInput.eventType === 'message.send.requested') {
        const reservation = await this.#reserveSend(
          client,
          eventInput,
          runtime,
          conversation,
          processedAt,
          explicitTarget,
          panelCommand,
        );
        messageId = reservation.messageId;
        // The snapshot was read FOR UPDATE before the fence moved
        // claimed_revision: the turn answers (claimed, sourceRevision].
        const turn = reservation.automated
          ? {
              fromRevision: Number(conversation.claimed_revision),
              toRevision: Number(eventInput.sourceRevision),
            }
          : null;
        if (turn) {
          answeredTurn = turn;
          outcome.turnFromRevision = turn.fromRevision;
        }
        if (explicitTarget) {
          await client.query(
            `INSERT INTO crm.message_subject_links
               (message_id, subject_id, conversation_id, assigned_by,
                assigned_by_kind, assigned_at)
             VALUES ($1, $2, $3, 'AUTOMATION_EXECUTOR', 'agent', $4)
             ON CONFLICT (message_id, subject_id) DO NOTHING`,
            [messageId, explicitTarget.id, conversation.id, processedAt],
          );
          if (turn) {
            await this.#linkTurnInbound(
              client,
              runtime,
              eventInput,
              conversation.id,
              turn,
              explicitTarget.id,
              processedAt,
            );
          }
        }
        outcome.sendAuthorized = true;
        if (eventInput.briefingPatch) {
          projectionTarget = {
            conversation,
            correlationId: eventInput.correlationId,
            orderId: eventInput.orderId,
            subjectId: eventInput.subjectId,
            briefing: explicitTarget
              ? this.#readSubjectBriefing(explicitTarget)
              : null,
            automationEpoch: eventInput.automationEpoch,
            sourceRevision: eventInput.sourceRevision,
            eventId: eventInput.eventId,
            eventType: eventInput.eventType,
            expectedSubjectVersion: explicitTarget
              ? Number(explicitTarget.briefing_version)
              : null,
            expectedOrderVersion: explicitTarget
              ? Number(explicitTarget.order_version)
              : null,
          };
          if (explicitTarget) {
            outcome.projectionSubjectVersion =
              projectionTarget.expectedSubjectVersion;
            outcome.projectionOrderVersion =
              projectionTarget.expectedOrderVersion;
            outcome.projectionSubjectId = eventInput.subjectId;
            outcome.projectionOrderId = eventInput.orderId;
          }
        }
      } else if (eventInput.eventType === 'message.sent') {
        const sent = await confirmReservedSend(client, eventInput, processedAt);
        messageId = sent.messageId;
        outcome.deliveryStatus = sent.status;
      } else if (
        ['message.delivered', 'message.read', 'message.failed'].includes(
          eventInput.eventType,
        )
      ) {
        const delivery = await updateDeliveryStatus(client, eventInput);
        messageId = delivery.messageId;
        outcome.deliveryStatus = delivery.status;
        outcome.changed = delivery.changed;
      } else if (eventInput.eventType === 'message.send.unknown') {
        const uncertain = await markSendUnknown(
          client,
          eventInput,
          processedAt,
        );
        messageId = uncertain.messageId;
        outcome.deliveryStatus = 'outcome_unknown';
      } else if (eventInput.eventType === 'handoff.requested') {
        assertCurrentAutomatedTurn(conversation, eventInput);
        if (eventInput.briefingPatch) {
          await this.#mergeBriefing(
            client,
            conversation,
            eventInput.briefingPatch,
            runtime,
            processedAt,
            explicitTarget,
          );
          projectionTarget = {
            conversation,
            correlationId: eventInput.correlationId,
            orderId: eventInput.orderId,
            subjectId: eventInput.subjectId,
            briefing: explicitTarget
              ? this.#readSubjectBriefing(explicitTarget)
              : null,
            automationEpoch: eventInput.automationEpoch,
            sourceRevision: eventInput.sourceRevision,
            eventId: eventInput.eventId,
            eventType: eventInput.eventType,
            expectedSubjectVersion: explicitTarget
              ? Number(explicitTarget.briefing_version)
              : null,
            expectedOrderVersion: explicitTarget
              ? Number(explicitTarget.order_version)
              : null,
          };
          if (explicitTarget) {
            outcome.projectionSubjectVersion =
              projectionTarget.expectedSubjectVersion;
            outcome.projectionOrderVersion =
              projectionTarget.expectedOrderVersion;
            outcome.projectionSubjectId = eventInput.subjectId;
            outcome.projectionOrderId = eventInput.orderId;
          }
        }
        const handoff = await createUnassignedHandoff(
          client,
          eventInput,
          runtime,
          this.envelopeKey,
          conversation,
          processedAt,
        );
        outcome.handoffId = handoff.id;
        outcome.targetRole = handoff.target_role;
        outcome.handoffReason = handoff.reason_code;
        const turn = {
          fromRevision: Number(conversation.claimed_revision),
          toRevision: Number(eventInput.sourceRevision),
        };
        answeredTurn = turn;
        outcome.turnFromRevision = turn.fromRevision;
        if (explicitTarget) {
          await this.#linkTurnInbound(
            client,
            runtime,
            eventInput,
            conversation.id,
            turn,
            explicitTarget.id,
            processedAt,
          );
        } else if (
          eventInput.subjectContractRequired &&
          isLowConfidenceHandoff(eventInput)
        ) {
          // CP-16: the agent could not tell which subject the turn is about.
          // Ask the seller for those messages only; no order or briefing.
          await this.#requestSubjectReview(
            client,
            runtime,
            eventInput,
            conversation.id,
            turn,
            handoff.id,
            processedAt,
          );
        }
        if (eventInput.handoff?.notice) {
          outcome.noticeCommandId = await this.#reserveHandoffNotice(
            client,
            eventInput,
            runtime,
            conversation,
            processedAt,
          );
        }
      } else if (eventInput.eventType === 'message.transcribed') {
        messageId = await this.#recordTranscript(
          client,
          eventInput,
          processedAt,
        );
        outcome.transcriptStatus = eventInput.transcript.status;
      } else if (eventInput.eventType === 'workflow.failed') {
        outcome.failureCode = safeFailureCode(eventInput.failure?.code);
        if (eventInput.failure?.phase === 'before_message_send') {
          const command = await selectPanelCommand(
            client,
            eventInput.commandId,
          );
          const lateRecipientCheck = await assertReservedExecution(
            client,
            command,
            eventInput,
            true,
          );
          if (command.conversation_id !== eventInput.conversationId)
            throw new N8nConflictError('Failure target mismatch');
          const message = await client.query(
            `UPDATE crm.messages SET status='failed',delivery_status='failed',delivery_status_at=$2,delivery_failure_code=$3 WHERE id=$1 AND status=$4 AND external_message_id IS NULL RETURNING id`,
            [
              command.message_id,
              processedAt,
              eventInput.failure.code,
              lateRecipientCheck ? 'outcome_unknown' : 'sending',
            ],
          );
          if (!message.rows[0])
            throw new N8nConflictError('Send already concluded');
          const completed = await client.query(
            `UPDATE crm.n8n_commands SET status='failed',retryable=false,retry_safe=false,last_error_code=$3,locked_by=NULL,locked_until=NULL,completed_at=$2,updated_at=$2 WHERE command_id=$1 AND status=$4 AND external_message_id IS NULL RETURNING command_id`,
            [
              eventInput.commandId,
              processedAt,
              eventInput.failure.code,
              lateRecipientCheck ? 'outcome_unknown' : 'processing',
            ],
          );
          if (!completed.rows[0])
            throw new N8nConflictError('Command already concluded');
          messageId = command.message_id;
          outcome.deliveryStatus = 'failed';
        }
      }

      const receiptId = await insertReceipt(client, runtime, {
        automationEpoch: eventInput.automationEpoch,
        conversationId: resolvedConversationId,
        correlationId: eventInput.correlationId,
        eventId: eventInput.eventId,
        eventType: eventInput.eventType,
        fingerprint: eventInput.eventFingerprint,
        idempotencyKey: eventInput.technical.idempotencyKey,
        idempotencyScope: 'n8n.events',
        messageId,
        occurredAt: eventInput.occurredAt,
        outcome,
        processedAt,
        sourceRevision: eventInput.sourceRevision,
        technical: eventInput.technical,
      });
      if (eventInput.turn && resolvedConversationId) {
        await insertAutomationTurn(
          client,
          runtime,
          eventInput,
          receiptId,
          resolvedConversationId,
          outcome.handoffReason ?? null,
        );
      }
      await appendAudit(client, runtime, {
        action: `integration.n8n.${eventInput.eventType}`,
        actor: eventInput.technical.actor,
        correlationId: eventInput.correlationId,
        occurredAt: processedAt,
        reason: 'n8n MVP event accepted',
        targetId: resolvedConversationId ?? eventInput.eventId,
        targetType: resolvedConversationId ? 'conversation' : 'n8n_workflow',
        version: eventInput.automationEpoch ?? 1,
      });
      if (resolvedConversationId) {
        await appendConversationStreamEvent(client, runtime, {
          conversationId: resolvedConversationId,
          correlationId: eventInput.correlationId,
          occurredAt: processedAt,
          type: `conversation.n8n.${eventInput.eventType}`,
        });
      }
      return {
        accepted: true,
        duplicate: false,
        event_id: eventInput.eventId,
        processed_at: processedAt,
        ...(eventInput.eventType === 'message.send.requested'
          ? { send_authorized: true }
          : {}),
        ...(outcome.handoffId ? { handoff_id: outcome.handoffId } : {}),
        ...('noticeCommandId' in outcome
          ? {
              notice: {
                send_authorized: outcome.noticeCommandId !== null,
                command_id: outcome.noticeCommandId,
              },
            }
          : {}),
      };
    });
    // A replay opens it too: the order call is idempotent, and a retry after
    // a lost response must still learn whether the order exists.
    const order =
      input.openOrder === true
        ? this.requireHumanOrderCreation
          ? { opened: null, status: 'awaiting_human' }
          : await this.#openOrder(input, runtime, answeredTurn)
        : null;
    // An order created just now was built from the briefing this event
    // merged; only an order that already existed needs the projection.
    const createdNow = order?.opened === true && order.created;
    const projection =
      projectionTarget && !createdNow
        ? await this.#projectOrder(projectionTarget)
        : null;
    return {
      ...result,
      ...(order ? { order } : {}),
      ...(projectionTarget?.subjectId && projection ? { projection } : {}),
    };
  }

  /**
   * AGENTE-OBS-01: a reply or handoff refused by the automation fence leaves
   * no receipt (the transaction rolls back), so the refusal is recorded apart,
   * best-effort, as an audit code for the "Desempenho do Vendedor" panel.
   *
   * @template T
   * @param {any} input @param {any} runtime @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #traceStaleFence(input, runtime, operation) {
    try {
      return await operation();
    } catch (error) {
      if (
        /** @type {any} */ (error)?.code === 'STALE_AUTOMATION_FENCE' &&
        EVENTS_WITH_TURNS.has(input.eventType) &&
        input.conversationId
      ) {
        await this.database
          .transaction(async (client) => {
            await transactionBounds(client);
            await appendAudit(client, runtime, {
              action: 'integration.n8n.stale_fence',
              actor: input.technical.actor,
              correlationId: input.correlationId,
              occurredAt: validClock(runtime.clock),
              reason: 'STALE_AUTOMATION_FENCE',
              targetId: input.conversationId,
              targetType: 'conversation',
              version: input.automationEpoch ?? 1,
            });
          })
          .catch(() => {});
      }
      throw error;
    }
  }

  /**
   * ADR 014 (D30): creates or reuses the conversation's pending order from
   * the merged briefing, after the event committed. A failure never fails
   * the event — the customer reply still goes out — but it is not silent
   * either: it is logged without PII, audited and reported as
   * `{opened: false, error}` so the workflow raises `ORDER_OPEN_FAILED`.
   *
   * @param {any} input @param {any} runtime
   * @param {{fromRevision: number, toRevision: number} | null} [turn]
   * @returns {Promise<OrderOpening>}
   */
  async #openOrder(input, runtime, turn = null) {
    if (typeof this.orders?.ensurePendingFromIntent !== 'function') {
      return this.#orderOpenFailed(
        input,
        runtime,
        'ORDERS_RUNTIME_UNAVAILABLE',
      );
    }
    try {
      const { created, order } = await this.orders.ensurePendingFromIntent({
        conversationId: input.conversationId,
        correlationId: input.correlationId,
      });
      const subjectId = await this.#ensureSubjectForOrder(
        input,
        runtime,
        order.id,
        turn,
      );
      return {
        opened: true,
        id: order.id,
        subject_id: subjectId,
        created: created === true,
      };
    } catch (error) {
      return this.#orderOpenFailed(input, runtime, orderFailureCode(error));
    }
  }

  /**
   * The bootstrap pairs a newly opened order with a stable subject. While
   * that subject is the conversation's only one, the turn that opened the
   * order is unambiguous and its inbound messages are recorded under it.
   *
   * @param {any} input @param {any} runtime @param {string} orderId
   * @param {{fromRevision: number, toRevision: number} | null} [turn]
   */
  async #ensureSubjectForOrder(input, runtime, orderId, turn = null) {
    return this.database.transaction(async (client) => {
      await transactionBounds(client);
      const conversation = (
        await client.query(
          `SELECT conversation.id, conversation.briefing_envelope,
                  conversation.briefing_version, identity.current_contact_id
           FROM crm.conversations AS conversation
           JOIN crm.contact_identities AS identity
             ON identity.id = conversation.contact_identity_id
           WHERE conversation.id = $1 FOR UPDATE OF conversation`,
          [input.conversationId],
        )
      ).rows[0];
      if (!conversation)
        throw new N8nConflictError('Conversation no longer exists');
      const order = (
        await client.query(
          `SELECT id FROM crm.orders WHERE id = $1 AND contact_id = $2
             AND status = 'pendente' AND cancelled_at IS NULL
             AND origin = 'atendimento'`,
          [orderId, conversation.current_contact_id],
        )
      ).rows[0];
      if (!order)
        throw new N8nConflictError(
          'Order does not belong to the contact',
          'SUBJECT_TARGET_INVALID',
        );
      const existing = (
        await client.query(
          `SELECT id FROM crm.conversation_subjects
           WHERE conversation_id = $1 AND order_id = $2`,
          [conversation.id, orderId],
        )
      ).rows[0];
      if (existing) {
        if (conversation.briefing_envelope) {
          await this.#initializeSubjectBriefing(
            client,
            existing.id,
            conversation,
            runtime,
          );
        }
        return this.#linkBootstrapTurn(
          client,
          runtime,
          input,
          existing.id,
          turn,
        );
      }
      const position = (
        await client.query(
          `SELECT COALESCE(max(position), 0) + 1 AS next_position,
                  count(*) FILTER (WHERE is_current)::integer AS current_count
           FROM crm.conversation_subjects WHERE conversation_id = $1`,
          [conversation.id],
        )
      ).rows[0];
      const current = Number(position.current_count) === 0;
      const created = (
        await client.query(
          `INSERT INTO crm.conversation_subjects
             (id, conversation_id, contact_id, order_id, kind, position,
              is_current, selected_source, selected_by, selected_at,
              created_by, created_by_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pedido', $5, $6, $7, $9, $10,
                   'AUTOMATION_EXECUTOR', 'agent', $8, $8)
           RETURNING id`,
          [
            runtime.idFactory('subject'),
            conversation.id,
            conversation.current_contact_id,
            orderId,
            position.next_position,
            current,
            current ? 'agent' : null,
            validClock(runtime.clock),
            current ? 'AUTOMATION_EXECUTOR' : null,
            current ? validClock(runtime.clock) : null,
          ],
        )
      ).rows[0];
      if (conversation.briefing_envelope) {
        await this.#initializeSubjectBriefing(
          client,
          created.id,
          conversation,
          runtime,
        );
      }
      return this.#linkBootstrapTurn(client, runtime, input, created.id, turn);
    });
  }

  /**
   * @param {Queryable} client @param {any} runtime @param {any} input @param {string} subjectId
   * @param {{fromRevision: number, toRevision: number} | null} turn
   * @returns {Promise<string>}
   */
  async #linkBootstrapTurn(client, runtime, input, subjectId, turn) {
    // CP-29: a turn the agent handed off because it was unsure is never
    // recorded under a subject on its behalf, not even the only one.
    if (!turn || isLowConfidenceHandoff(input)) return subjectId;
    const subjects = (
      await client.query(
        `SELECT count(*)::integer AS total
         FROM crm.conversation_subjects WHERE conversation_id = $1`,
        [input.conversationId],
      )
    ).rows[0];
    if (Number(subjects.total) === 1) {
      await this.#linkTurnInbound(
        client,
        runtime,
        input,
        input.conversationId,
        turn,
        subjectId,
        validClock(runtime.clock),
      );
    }
    return subjectId;
  }

  /**
   * CP-12: records the subject of the inbound messages one automated turn
   * answered — revisions after the pre-turn claimed_revision up to the
   * turn's source_revision. A message with any link, or one a person
   * already reviewed (including "no subject"), is never overwritten.
   *
   * @param {Queryable} client @param {any} runtime @param {any} input
   * @param {string} conversationId
   * @param {{fromRevision: number, toRevision: number}} turn
   * @param {string} subjectId @param {string} at
   */
  async #linkTurnInbound(
    client,
    runtime,
    input,
    conversationId,
    turn,
    subjectId,
    at,
  ) {
    const linked = await client.query(
      `INSERT INTO crm.message_subject_links
         (message_id, subject_id, conversation_id, assigned_by,
          assigned_by_kind, assigned_at)
       SELECT message.id, $2, message.conversation_id, 'AUTOMATION_EXECUTOR',
              'agent', $5
       FROM crm.messages AS message
       WHERE message.conversation_id = $1 AND message.direction = 'inbound'
         AND message.inbound_revision > $3 AND message.inbound_revision <= $4
         AND NOT EXISTS (
           SELECT 1 FROM crm.message_subject_links AS link
           WHERE link.message_id = message.id)
         AND NOT EXISTS (
           SELECT 1 FROM crm.message_subject_reviews AS review
           WHERE review.message_id = message.id
             AND review.resolved_at IS NOT NULL)
       ON CONFLICT (message_id, subject_id) DO NOTHING
       RETURNING message_id`,
      [conversationId, subjectId, turn.fromRevision, turn.toRevision, at],
    );
    if (linked.rows.length === 0) return;
    await appendAudit(client, runtime, {
      action: 'integration.n8n.message_subjects_inferred',
      actor: input.technical.actor,
      correlationId: input.correlationId,
      occurredAt: at,
      reason: 'AGENT_SUBJECT_ASSIGNMENT',
      targetId: subjectId,
      targetType: 'conversation_subject',
      // IDs and counts only: the audit never carries message content.
      version: linked.rows.length,
    });
  }

  /**
   * CP-16: a subject-v1 handoff the agent raised for low confidence, with
   * no target, asks the seller to classify the turn's unlinked inbound
   * messages. It never touches the order, the briefing or existing links.
   *
   * @param {Queryable} client @param {any} runtime @param {any} input
   * @param {string} conversationId
   * @param {{fromRevision: number, toRevision: number}} turn
   * @param {string} handoffId @param {string} at
   */
  async #requestSubjectReview(
    client,
    runtime,
    input,
    conversationId,
    turn,
    handoffId,
    at,
  ) {
    const requested = await client.query(
      `INSERT INTO crm.message_subject_reviews
         (message_id, conversation_id, handoff_id, source_revision, reason,
          requested_at)
       SELECT message.id, message.conversation_id, $4, $3, 'subject_ambiguous',
              $5
       FROM crm.messages AS message
       WHERE message.conversation_id = $1 AND message.direction = 'inbound'
         AND message.inbound_revision > $2 AND message.inbound_revision <= $3
         AND EXISTS (
           SELECT 1 FROM crm.conversation_subjects AS subject
           WHERE subject.conversation_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM crm.message_subject_links AS link
           WHERE link.message_id = message.id)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [conversationId, turn.fromRevision, turn.toRevision, handoffId, at],
    );
    if (requested.rows.length === 0) return;
    await appendAudit(client, runtime, {
      action: 'integration.n8n.message_subject_review_requested',
      actor: input.technical.actor,
      correlationId: input.correlationId,
      occurredAt: at,
      reason: 'AGENT_SUBJECT_AMBIGUOUS',
      targetId: handoffId,
      targetType: 'handoff',
      version: requested.rows.length,
    });
  }

  /** @param {Queryable} client @param {string} subjectId @param {any} conversation @param {any} runtime */
  async #initializeSubjectBriefing(client, subjectId, conversation, runtime) {
    const envelope = encryptJson(
      this.#readBriefing(conversation),
      `n8n-subject-briefing:${subjectId}:1`,
      this.envelopeKey,
    );
    await client.query(
      `INSERT INTO crm.subject_briefings
         (subject_id, version, envelope, updated_at)
       VALUES ($1, 1, $2::jsonb, $3) ON CONFLICT (subject_id) DO NOTHING`,
      [subjectId, JSON.stringify(envelope), validClock(runtime.clock)],
    );
  }

  /**
   * @param {any} input @param {any} runtime @param {string} code
   * @returns {Promise<{opened: false, error: string}>}
   */
  async #orderOpenFailed(input, runtime, code) {
    const trace = {
      code,
      conversationId: input.conversationId,
      correlationId: input.correlationId,
      eventType: input.eventType,
    };
    console.error(
      'n8n event accepted but the pending order did not open',
      trace,
    );
    try {
      await this.database.transaction(async (client) => {
        await transactionBounds(client);
        await appendAudit(client, runtime, {
          action: 'integration.n8n.order.open_failed',
          actor: input.technical.actor,
          correlationId: input.correlationId,
          occurredAt: validClock(runtime.clock),
          reason: code,
          targetId: input.conversationId,
          targetType: 'conversation',
          version: input.automationEpoch ?? 1,
        });
      });
    } catch (error) {
      console.error('the failed order opening could not be audited', {
        ...trace,
        auditCode: orderFailureCode(error),
      });
    }
    return { opened: false, error: code };
  }

  /** @param {Queryable} client @param {string} conversationId @param {boolean} duplicate */
  async #inboundResponse(client, conversationId, duplicate) {
    const conversation = (
      await client.query(
        `SELECT conversation.*, identity.current_contact_id, identity.channel
         FROM crm.conversations AS conversation
         JOIN crm.contact_identities AS identity
           ON identity.id = conversation.contact_identity_id
         WHERE conversation.id = $1`,
        [conversationId],
      )
    ).rows[0];
    if (!conversation) throw new N8nNotFoundError('Conversation was not found');
    const subjects = (
      await client.query(
        `SELECT subject.id, subject.order_id, orders.number AS order_number,
                CASE WHEN orders.cancelled_at IS NOT NULL THEN 'cancelado'
                     ELSE orders.status END AS order_status,
                subject.kind, subject.is_current,
                subject.selected_source, subject.position, briefing.version,
                briefing.envelope, briefing.legacy_conversation_id
         FROM crm.conversation_subjects AS subject
         LEFT JOIN crm.orders AS orders ON orders.id = subject.order_id
         LEFT JOIN crm.subject_briefings AS briefing ON briefing.subject_id = subject.id
         WHERE subject.conversation_id = $1 ORDER BY subject.position`,
        [conversation.id],
      )
    ).rows.map((row) => ({
      subject_id: row.id,
      order_id: row.order_id,
      order_number: row.order_number ?? null,
      order_status: row.order_status ?? null,
      kind: row.kind,
      is_current: row.is_current,
      selected_source: row.selected_source,
      position: row.position,
      briefing_version: Number(row.version ?? 0),
      briefing: this.#readSubjectBriefing({
        id: row.id,
        briefing_version: row.version ?? 0,
        briefing_envelope: row.envelope,
        legacy_conversation_id: row.legacy_conversation_id,
      }),
    }));
    const sourceLinks = await client.query(
      `SELECT link.subject_id FROM crm.message_subject_links AS link
       JOIN crm.messages AS message ON message.id = link.message_id
       WHERE message.conversation_id = $1 AND message.direction = 'inbound'
         AND message.inbound_revision = $2`,
      [conversation.id, conversation.inbound_revision],
    );
    let siteContact = null;
    if (conversation.channel === 'site_chat') {
      const claim = (
        await client.query(
          `SELECT id, phone_hash, details_envelope, version
           FROM crm.site_contact_claims WHERE conversation_id = $1`,
          [conversation.id],
        )
      ).rows[0];
      if (!claim)
        throw new N8nConflictError(
          'Site contact claim is missing',
          'SITE_CONTACT_REQUIRED',
        );
      const details = decryptSiteContactClaim(
        claim.details_envelope,
        claim.id,
        Number(claim.version),
        this.contactEnvelopeKey,
      );
      const matches = await client.query(
        `SELECT count(DISTINCT candidate.contact_id)::integer AS total
         FROM (
           SELECT contact.id AS contact_id FROM crm.contacts AS contact
           WHERE contact.contact_phone_hash = $1
           UNION ALL
           SELECT CASE WHEN lookup.source = 'whatsapp'
                         THEN identity.current_contact_id
                         ELSE lookup.contact_id END AS contact_id
           FROM crm.contact_phone_lookup AS lookup
           LEFT JOIN crm.contact_identities AS identity
             ON identity.id = lookup.identity_id
           WHERE lookup.phone_hash = $1
         ) AS candidate
         WHERE candidate.contact_id IS NOT NULL AND candidate.contact_id <> $2`,
        [claim.phone_hash, conversation.current_contact_id],
      );
      const total = Number(matches.rows[0]?.total ?? 0);
      siteContact = {
        name: details.name,
        match: total === 0 ? 'new' : total === 1 ? 'existing' : 'ambiguous',
      };
    }
    return {
      accepted: true,
      automation_epoch: Number(conversation.automation_epoch),
      ...(this.requireHumanOrderCreation
        ? {
            order_opening_policy: 'human_confirmation',
            order_assistance: { enabled: true },
          }
        : {}),
      briefing: this.#readBriefing(conversation),
      briefing_version: Number(conversation.briefing_version),
      contact_id: conversation.current_contact_id,
      conversation_id: conversation.id,
      conversation_version: Number(conversation.version),
      duplicate,
      mode: conversationMode(conversation),
      recent_messages: await this.#recentMessages(client, conversation.id),
      source_revision: Number(conversation.inbound_revision),
      source_subject_ids: sourceLinks.rows.map((row) => row.subject_id),
      subjects,
      ...(siteContact
        ? {
            site_contact: { name: siteContact.name },
            site_contact_match: siteContact.match,
          }
        : {}),
      automation_message_count: await countAutomationMessages(
        client,
        conversation.id,
      ),
      automation_message_cap: this.automationMessageCap,
      sellers: await activeSellers(client),
      contact_context: await this.#contactContext(client, conversation),
    };
  }

  /**
   * VND-CTX-01: what the agent may know about a returning customer, kept to
   * the minimum (RULES.md 8 and 13): how many earlier cycles, when the last
   * one closed and how many earlier orders exist. No order number, status,
   * product, amount, address, payment or file leaves here, and no ficha is
   * decrypted on this path.
   *
   * @param {Queryable} client @param {any} conversation
   */
  async #contactContext(client, conversation) {
    const row = (
      await client.query(
        `SELECT
           (SELECT count(*)::integer
            FROM crm.conversations AS previous
            JOIN crm.contact_identities AS identity
              ON identity.id = previous.contact_identity_id
            WHERE identity.current_contact_id = $1 AND previous.id <> $2
              AND previous.opened_at <= $3) AS previous_cycles,
           (SELECT to_char(max(closed.terminal_at)
                     AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD')
            FROM crm.conversations AS closed
            JOIN crm.contact_identities AS identity
              ON identity.id = closed.contact_identity_id
            WHERE identity.current_contact_id = $1 AND closed.id <> $2
              AND closed.terminal_at IS NOT NULL) AS last_closed_at,
           (SELECT count(*)::integer FROM (
              SELECT 1
              FROM crm.orders AS orders
              LEFT JOIN crm.conversations AS origin
                ON origin.id = orders.conversation_id
              LEFT JOIN crm.contact_identities AS origin_identity
                ON origin_identity.id = origin.contact_identity_id
              WHERE (orders.contact_id = $1
                  OR origin_identity.current_contact_id = $1)
                AND orders.conversation_id IS DISTINCT FROM $2
                AND NOT orders.is_test
                AND orders.cancelled_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM crm.conversation_subjects AS subject
                  WHERE subject.conversation_id = $2
                    AND subject.order_id = orders.id)
              LIMIT 99) AS earlier) AS previous_orders_count`,
        [
          conversation.current_contact_id,
          conversation.id,
          conversation.opened_at,
        ],
      )
    ).rows[0];
    return {
      previous_cycles: Number(row?.previous_cycles ?? 0),
      previous_orders_count: Math.min(
        99,
        Number(row?.previous_orders_count ?? 0),
      ),
      last_closed_at: row?.last_closed_at ?? null,
    };
  }

  /** @param {any} conversation */
  #readBriefing(conversation) {
    if (!conversation.briefing_envelope) return {};
    return decryptJson(
      conversation.briefing_envelope,
      `n8n-briefing:${conversation.id}:${conversation.briefing_version}`,
      this.envelopeKey,
    );
  }

  /** @param {{id: string, briefing_version: number, briefing_envelope: any, legacy_conversation_id?: string|null}} subject */
  #readSubjectBriefing(subject) {
    if (!subject.briefing_envelope) return {};
    return decryptJson(
      subject.briefing_envelope,
      subject.legacy_conversation_id
        ? `n8n-briefing:${subject.legacy_conversation_id}:${subject.briefing_version}`
        : `n8n-subject-briefing:${subject.id}:${subject.briefing_version}`,
      this.envelopeKey,
    );
  }

  /** @param {Queryable} client @param {any} conversation @param {any} input */
  async #validateExplicitTarget(client, conversation, input) {
    if (!conversation)
      throw new N8nConflictError(
        'Conversation target is required',
        'SUBJECT_TARGET_INVALID',
      );
    assertCurrentAutomatedTurn(conversation, input);
    const target = (
      await client.query(
        `SELECT subject.id, subject.order_id, orders.version AS order_version,
                subject.is_current,
                subject.selected_source, subject.contact_id,
                briefing.version AS briefing_version,
                briefing.envelope AS briefing_envelope,
                briefing.legacy_conversation_id
         FROM crm.conversation_subjects AS subject
         JOIN crm.contact_identities AS identity
           ON identity.id = $3
         JOIN crm.orders AS orders ON orders.id = subject.order_id
         LEFT JOIN crm.subject_briefings AS briefing
           ON briefing.subject_id = subject.id
         WHERE subject.id = $1 AND subject.order_id = $2
           AND subject.conversation_id = $4
           AND subject.contact_id = identity.current_contact_id
           AND orders.contact_id = identity.current_contact_id
           AND orders.origin = 'atendimento' AND orders.status = 'pendente'
           AND orders.cancelled_at IS NULL
           AND (identity.channel <> 'site_chat'
                OR orders.conversation_id = subject.conversation_id)
         FOR SHARE OF subject, orders`,
        [
          input.subjectId,
          input.orderId,
          conversation.contact_identity_id,
          conversation.id,
        ],
      )
    ).rows[0];
    if (!target)
      throw new N8nConflictError(
        'Subject and order do not match the current contact',
        'SUBJECT_TARGET_INVALID',
      );
    const current = (
      await client.query(
        `SELECT id, selected_source FROM crm.conversation_subjects
         WHERE conversation_id = $1 AND is_current`,
        [conversation.id],
      )
    ).rows[0];
    if (current?.selected_source === 'human' && current.id !== target.id) {
      throw new N8nConflictError(
        'Human-selected subject has priority',
        'SUBJECT_TARGET_CONFLICT',
      );
    }
    const links = await client.query(
      `SELECT DISTINCT link.subject_id FROM crm.message_subject_links AS link
       JOIN crm.messages AS message ON message.id = link.message_id
       WHERE message.conversation_id = $1 AND message.direction = 'inbound'
         AND message.inbound_revision = $2`,
      [conversation.id, input.sourceRevision],
    );
    if (
      links.rows.length > 1 ||
      (links.rows.length === 1 && links.rows[0].subject_id !== target.id)
    ) {
      throw new N8nConflictError(
        'Inbound message refers to another or multiple subjects',
        'SUBJECT_AMBIGUOUS',
      );
    }
    return target;
  }

  /**
   * PAG-01/PAG-02: projects the merged pré-ficha onto the conversation's
   * pending order, but only while the agent still owns the turn — the guard
   * and the "no pending order" no-op both live in OrderService, already
   * covered by its own tests. Runs after the caller's transaction commits
   * (see the recordEvent doc comment): it opens its own transaction, and
   * running it earlier, nested inside that transaction, risks a
   * cross-connection deadlock over crm.domain_events' shared stream-cursor
   * lock. Best-effort: never blocks or fails the n8n event.
   *
   * @param {any} target
   */
  async #projectOrder(target) {
    if (!this.orders)
      return { applied: false, error: 'ORDERS_RUNTIME_UNAVAILABLE' };
    try {
      const result = await this.orders.projectAgentBriefing({
        automationState: target.conversation.automation_state,
        briefing: target.subjectId
          ? target.briefing
          : this.#readBriefing(target.conversation),
        conversationId: target.conversation.id,
        correlationId: target.correlationId,
        orderId: target.orderId,
        subjectId: target.subjectId,
        automationEpoch: target.automationEpoch,
        sourceRevision: target.sourceRevision,
        eventId: target.eventId,
        eventType: target.eventType,
        expectedSubjectVersion: target.expectedSubjectVersion,
        expectedOrderVersion: target.expectedOrderVersion,
        recovery: target.recovery === true,
      });
      return {
        applied: result.applied === true,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      console.error('n8n briefing merged but order projection failed', {
        conversationId: target.conversation.id,
        correlationId: target.correlationId,
        code: /** @type {any} */ (error)?.code ?? 'ORDER_PROJECTION_FAILED',
      });
      return {
        applied: false,
        error: /** @type {any} */ (error)?.code ?? 'ORDER_PROJECTION_FAILED',
      };
    }
  }

  /** @param {Queryable} client @param {any} conversation @param {Record<string, unknown>} patch @param {any} runtime @param {string} now @param {any} [subject] @param {boolean} [promoteName] */
  async #mergeBriefing(
    client,
    conversation,
    patch,
    runtime,
    now,
    subject = null,
    promoteName = true,
  ) {
    const current = subject
      ? this.#readSubjectBriefing(subject)
      : this.#readBriefing(conversation);
    const values = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    );
    if (Object.keys(values).length === 0) return;
    const version =
      Number(subject?.briefing_version ?? conversation.briefing_version) + 1;
    const envelope = encryptJson(
      { ...current, ...values },
      subject
        ? `n8n-subject-briefing:${subject.id}:${version}`
        : `n8n-briefing:${conversation.id}:${version}`,
      this.envelopeKey,
    );
    if (subject) {
      await client.query(
        `INSERT INTO crm.subject_briefings (subject_id, version, envelope, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (subject_id) DO UPDATE
         SET version = EXCLUDED.version, envelope = EXCLUDED.envelope,
             legacy_conversation_id = NULL,
             updated_at = EXCLUDED.updated_at`,
        [subject.id, version, JSON.stringify(envelope), now],
      );
      subject.briefing_version = version;
      subject.briefing_envelope = envelope;
      subject.legacy_conversation_id = null;
    } else {
      await client.query(
        `UPDATE crm.conversations
         SET briefing_version = $2, briefing_envelope = $3::jsonb,
             briefing_updated_at = $4
         WHERE id = $1`,
        [conversation.id, version, JSON.stringify(envelope), now],
      );
      conversation.briefing_version = version;
      conversation.briefing_envelope = envelope;
      conversation.briefing_updated_at = now;
      // During rollout the old workflow still writes the conversation. Once
      // its sole pending order has a subject, mirror that safe single target.
      const legacySubject = (
        await client.query(
          `SELECT subject.id, briefing.version AS briefing_version,
                  briefing.envelope AS briefing_envelope,
                  briefing.legacy_conversation_id
           FROM crm.conversation_subjects AS subject
           JOIN crm.orders AS orders ON orders.id = subject.order_id
           LEFT JOIN crm.subject_briefings AS briefing
             ON briefing.subject_id = subject.id
           WHERE subject.conversation_id = $1 AND subject.is_current
             AND orders.conversation_id = $1 AND orders.status = 'pendente'
             AND orders.cancelled_at IS NULL`,
          [conversation.id],
        )
      ).rows[0];
      if (legacySubject) {
        await this.#mergeBriefing(
          client,
          conversation,
          patch,
          runtime,
          now,
          legacySubject,
          false,
        );
      }
    }
    if (promoteName) {
      await this.#promoteCustomerName(
        client,
        conversation,
        values.customer_name,
        runtime,
        now,
      );
    }
  }

  /**
   * Exposes the name supplied by a customer on CRM readers. An operator rename
   * remains authoritative; the guided workflow can change only a blank or
   * automation-owned name.
   * @param {Queryable} client
   * @param {any} conversation
   * @param {unknown} customerName
   * @param {any} runtime
   * @param {string} now
   */
  async #promoteCustomerName(client, conversation, customerName, runtime, now) {
    const displayName = automationDisplayName(customerName);
    if (!displayName) return;
    const contact = (
      await client.query(
        `SELECT contact.id, contact.display_name, contact.display_name_source
         FROM crm.contacts AS contact
         JOIN crm.contact_identities AS identity
           ON identity.current_contact_id = contact.id
         WHERE identity.id = $1
         FOR UPDATE OF contact`,
        [conversation.contact_identity_id],
      )
    ).rows[0];
    if (
      !contact ||
      (contact.display_name !== null &&
        contact.display_name_source !== 'automation')
    ) {
      return;
    }
    const updated = (
      await client.query(
        `UPDATE crm.contacts
         SET display_name = $2, display_name_source = 'automation',
             version = version + 1, updated_at = $3
         WHERE id = $1
           AND (display_name IS NULL OR display_name_source = 'automation')
           AND (display_name IS DISTINCT FROM $2
                OR display_name_source IS DISTINCT FROM 'automation')
         RETURNING id, version`,
        [contact.id, displayName, now],
      )
    ).rows[0];
    if (!updated) return;
    const correlationId = `n8n-contact-name:${conversation.id}`;
    await appendAudit(client, runtime, {
      action: 'contact.name_collected',
      actor: 'AUTOMATION_EXECUTOR',
      correlationId,
      occurredAt: now,
      reason: 'customer name collected by guided workflow',
      targetId: updated.id,
      targetType: 'contact',
      version: Number(updated.version),
    });
    await client.query(
      `INSERT INTO crm.domain_events
         (id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload, correlation_id, occurred_at)
       VALUES ($1, 'contact', $2, $3, 'contact.name_collected', $4::jsonb,
               $5, $6)`,
      [
        runtime.idFactory('event'),
        updated.id,
        Number(updated.version),
        JSON.stringify({ contactId: updated.id }),
        correlationId,
        now,
      ],
    );
  }

  /** @param {Queryable} client @param {string} conversationId */
  async #recentMessages(client, conversationId) {
    const rows = (
      await client.query(
        `SELECT id, external_message_id, direction, author_kind, message_type, status,
                content_envelope, occurred_at, transcript_status,
                transcript_envelope,
                ARRAY(SELECT link.subject_id
                      FROM crm.message_subject_links AS link
                      WHERE link.message_id = crm.messages.id
                      ORDER BY link.subject_id) AS subject_ids
         FROM crm.messages
         WHERE conversation_id = $1
           AND occurred_at >= now() - interval '24 hours'
         ORDER BY occurred_at DESC, id DESC LIMIT 20`,
        [conversationId],
      )
    ).rows.reverse();
    return rows.map((row) => {
      const content = decryptJson(
        row.content_envelope,
        `message:${row.id}`,
        this.messageEnvelopeKey,
      );
      // INBOX-AUDIO-TRANSCRIPT-01: the agent reads what the customer said.
      const transcribed =
        row.message_type === 'audio' && row.transcript_status === 'ok';
      const transcript = transcribed
        ? decryptJson(
            row.transcript_envelope,
            `message-transcript:${row.id}`,
            this.messageEnvelopeKey,
          )
        : null;
      return {
        attachment_id: content.attachmentId ?? null,
        id: row.id,
        external_id: row.external_message_id,
        status: row.status,
        occurred_at: iso(row.occurred_at),
        sender_type:
          row.direction === 'inbound'
            ? 'customer'
            : row.author_kind === 'assistant'
              ? 'ai'
              : row.author_kind,
        // VND-CTX-01: every subject the message refers to, not only one.
        subject_ids: Array.isArray(row.subject_ids) ? row.subject_ids : [],
        text: transcript
          ? String(transcript.text ?? '')
          : (content.text ?? content.caption ?? ''),
        transcribed,
        type: row.message_type,
      };
    });
  }

  /**
   * INBOX-AUDIO-TRANSCRIPT-01: stores the transcript of one inbound audio of
   * the conversation, sealed with the message key like the message itself.
   * A failed attempt can be followed by a successful one; a recorded
   * transcript is never replaced.
   *
   * @param {Queryable} client @param {any} input @param {string} now
   * @returns {Promise<string>}
   */
  async #recordTranscript(client, input, now) {
    const message = (
      await client.query(
        `SELECT id, direction, message_type, transcript_status
         FROM crm.messages
         WHERE conversation_id = $1 AND external_message_id = $2
         FOR UPDATE`,
        [input.conversationId, input.externalMessageId],
      )
    ).rows[0];
    if (!message) {
      throw new N8nNotFoundError('Audio message was not found');
    }
    if (message.direction !== 'inbound' || message.message_type !== 'audio') {
      throw new N8nConflictError(
        'Only an inbound audio can be transcribed',
        'TRANSCRIPT_TARGET_INVALID',
      );
    }
    if (message.transcript_status === 'ok') {
      throw new N8nConflictError(
        'The audio already has a transcript',
        'TRANSCRIPT_ALREADY_RECORDED',
      );
    }
    const transcript = input.transcript;
    await client.query(
      `UPDATE crm.messages
       SET transcript_status = $2, transcript_envelope = $3::jsonb,
           transcript_code = $4, transcribed_at = $5
       WHERE id = $1`,
      [
        message.id,
        transcript.status,
        transcript.status === 'ok'
          ? JSON.stringify(
              encryptJson(
                { text: transcript.text },
                `message-transcript:${message.id}`,
                this.messageEnvelopeKey,
              ),
            )
          : null,
        transcript.code,
        now,
      ],
    );
    return message.id;
  }

  /** @param {Queryable} client @param {any} input @param {any} runtime @param {any} conversation @param {string} now @param {any} [subject] @param {any} [panelCommand] */
  async #reserveSend(
    client,
    input,
    runtime,
    conversation,
    now,
    subject = null,
    panelCommand = null,
  ) {
    if (!conversation || !input.commandId || !input.message) {
      throw new N8nConflictError('Send reservation is incomplete');
    }
    if (panelCommand) {
      if (input.briefingPatch) {
        throw new N8nConflictError(
          'A panel command cannot change agent briefing',
          'SUBJECT_TARGET_CONFLICT',
        );
      }
      const bound =
        panelCommand.message_type === 'text'
          ? null
          : (
              await client.query(
                'SELECT * FROM crm.chat_media WHERE message_id=$1 AND conversation_id=$2 FOR UPDATE',
                [panelCommand.message_id, panelCommand.conversation_id],
              )
            ).rows[0];
      assertPanelSendFence(
        panelCommand,
        conversation,
        input,
        this.envelopeKey,
        bound,
        this.messageEnvelopeKey,
      );
      const updated = await client.query(
        `UPDATE crm.messages
         SET status = 'sending', n8n_execution_id = $2,
             automation_epoch = $3
         WHERE id = $1 AND status = 'queued'
         RETURNING id`,
        [
          panelCommand.message_id,
          input.technical.executionId,
          input.automationEpoch,
        ],
      );
      if (!updated.rows[0]) {
        throw new N8nConflictError(
          'Send was already authorized',
          'SEND_ALREADY_AUTHORIZED',
        );
      }
      return { messageId: updated.rows[0].id };
    }

    assertCurrentAutomatedTurn(conversation, input);
    // The last automated slot belongs to the handoff notice (ADR 009).
    if (
      (await countAutomationMessages(client, conversation.id)) >=
      this.automationMessageCap - 1
    ) {
      throw new N8nConflictError(
        'Automated message cap reached',
        'AUTOMATION_MESSAGE_CAP',
      );
    }
    const type = outboundMessageType(input.message);
    const messageId = runtime.idFactory('message');
    const content = outboundMessageContent(input.message, type);
    await client.query(
      `INSERT INTO crm.messages
         (id, conversation_id, provider, provider_account_id, command_id,
          direction, author_kind, author_id, message_type, content_envelope,
          key_version, status, occurred_at, created_at, automation_epoch,
          n8n_execution_id)
       VALUES ($1, $2, $3, $4, $5, 'outbound', 'assistant',
               'AUTOMATION_EXECUTOR', $6, $7::jsonb, 1, 'sending', $8, $8,
               $9, $10)`,
      [
        messageId,
        conversation.id,
        conversation.provider,
        conversation.provider_account_id,
        input.commandId,
        type,
        JSON.stringify(
          encryptJson(content, `message:${messageId}`, this.messageEnvelopeKey),
        ),
        now,
        input.automationEpoch,
        input.technical.executionId,
      ],
    );
    if (input.briefingPatch) {
      await this.#mergeBriefing(
        client,
        conversation,
        input.briefingPatch,
        runtime,
        now,
        subject,
      );
    }
    const updated = await client.query(
      `UPDATE crm.conversations
       SET claimed_revision = $2
       WHERE id = $1 AND automation_state = 'assistant'
         AND terminal_at IS NULL AND automation_epoch = $3
         AND inbound_revision = $2 AND claimed_revision < $2
       RETURNING id`,
      [conversation.id, input.sourceRevision, input.automationEpoch],
    );
    if (!updated.rows[0]) {
      throw new N8nConflictError(
        'Automated response is stale or already processed',
        'STALE_AUTOMATION_FENCE',
      );
    }
    return { messageId, automated: true };
  }

  /**
   * Reserves the notice that tells the customer a seller will take over, in
   * the same transaction as the handoff, while the cap still has room.
   *
   * @param {Queryable} client @param {any} input @param {any} runtime @param {any} conversation @param {string} now
   * @returns {Promise<string | null>} the notice command id, or null when the cap is spent
   */
  async #reserveHandoffNotice(client, input, runtime, conversation, now) {
    const notice = input.handoff.notice;
    if (
      (await countAutomationMessages(client, conversation.id)) >=
      this.automationMessageCap
    ) {
      return null;
    }
    const messageId = runtime.idFactory('message');
    await client.query(
      `INSERT INTO crm.messages
         (id, conversation_id, provider, provider_account_id, command_id,
          direction, author_kind, author_id, message_type, content_envelope,
          key_version, status, occurred_at, created_at, automation_epoch,
          n8n_execution_id)
       VALUES ($1, $2, $3, $4, $5, 'outbound', 'assistant',
               'AUTOMATION_EXECUTOR', 'text', $6::jsonb, 1, 'sending', $7, $7,
               $8, $9)`,
      [
        messageId,
        conversation.id,
        conversation.provider,
        conversation.provider_account_id,
        notice.command_id,
        JSON.stringify(
          encryptJson(
            { text: notice.text },
            `message:${messageId}`,
            this.messageEnvelopeKey,
          ),
        ),
        now,
        input.automationEpoch,
        input.technical.executionId,
      ],
    );
    return notice.command_id;
  }
}

/** @param {Queryable} client @param {any} runtime @param {any} input */
async function insertReceipt(client, runtime, input) {
  const id = runtime.idFactory('n8n-event');
  await client.query(
    `INSERT INTO crm.n8n_events
       (id, idempotency_scope, idempotency_key, external_event_id, event_type,
        fingerprint, conversation_id, message_id, run_id, correlation_id,
        outcome, occurred_at, processed_at, workflow_key, workflow_version,
        execution_id, automation_epoch, source_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10::jsonb, $11,
             $12, $13, $14, $15, $16, $17)`,
    [
      id,
      input.idempotencyScope,
      input.idempotencyKey,
      input.eventId,
      input.eventType,
      input.fingerprint,
      input.conversationId,
      input.messageId,
      input.correlationId,
      JSON.stringify(input.outcome),
      input.occurredAt,
      input.processedAt,
      input.technical.workflowKey,
      input.technical.workflowVersion,
      input.technical.executionId,
      input.automationEpoch,
      input.sourceRevision,
    ],
  );
  return id;
}

/**
 * AGENTE-OBS-01: one row per accepted turn, keyed by its receipt, so a replay
 * (which returns before reaching this point) never counts twice.
 *
 * @param {Queryable} client @param {any} runtime @param {any} input
 * @param {string} receiptId @param {string} conversationId @param {string|null} handoffReason
 */
async function insertAutomationTurn(
  client,
  runtime,
  input,
  receiptId,
  conversationId,
  handoffReason,
) {
  const turn = input.turn;
  await client.query(
    `INSERT INTO crm.automation_turns
       (id, n8n_event_id, conversation_id, event_type, asked_field,
        answer_status, ficha_filled, ficha_total, trigger, model, latency_ms,
        media_kind, workflow_key, workflow_version, handoff_reason,
        occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16)
     ON CONFLICT (n8n_event_id) DO NOTHING`,
    [
      runtime.idFactory('automation-turn'),
      receiptId,
      conversationId,
      input.eventType,
      turn.askedField,
      turn.answerStatus,
      turn.fichaFilled,
      turn.fichaTotal,
      turn.trigger,
      turn.model,
      turn.latencyMs,
      turn.mediaKind,
      input.technical.workflowKey,
      input.technical.workflowVersion,
      handoffReason,
      input.occurredAt,
    ],
  );
}

/** @param {Queryable} client @param {string} scope @param {string} key */
async function selectReceipt(client, scope, key) {
  return (
    await client.query(
      `SELECT * FROM crm.n8n_events
       WHERE idempotency_scope = $1 AND idempotency_key = $2`,
      [scope, key],
    )
  ).rows[0];
}

/** @param {any} receipt @param {string} expected */
function assertFingerprint(receipt, expected) {
  if (receipt.fingerprint !== expected) {
    throw new N8nConflictError(
      'Idempotency key was reused with a different payload',
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

/** @param {Queryable} client @param {any} input */
async function resolveEventConversation(client, input) {
  let rows = [];
  if (input.commandId) {
    rows = (
      await client.query(
        `SELECT DISTINCT conversation_id
         FROM (
           SELECT conversation_id FROM crm.n8n_commands WHERE command_id = $1
           UNION ALL
           SELECT conversation_id FROM crm.messages WHERE command_id = $1
         ) AS candidates`,
        [input.commandId],
      )
    ).rows;
  } else if (input.externalMessageId) {
    rows = (
      await client.query(
        `SELECT DISTINCT conversation_id FROM crm.messages
         WHERE external_message_id = $1`,
        [input.externalMessageId],
      )
    ).rows;
  }
  if (rows.length === 0) {
    throw new N8nNotFoundError('Event target was not found');
  }
  if (rows.length !== 1) {
    throw new N8nConflictError(
      'Event target is ambiguous',
      'AMBIGUOUS_EVENT_TARGET',
    );
  }
  return rows[0].conversation_id;
}

/** Original reservation is authoritative; a replay cannot stamp another identity.
 * Only an authenticated recipient-check failure can resolve a worker timeout
 * before transport. Media reads and every other failure retain the active fence.
 * @param {Queryable} client @param {any} command @param {any} input
 * @param {boolean} [allowLateRecipientCheck] @param {false|'read'|'unknown'} [allowTimedOutMedia] @returns {Promise<boolean>}
 */
async function assertReservedExecution(
  client,
  command,
  input,
  allowLateRecipientCheck = false,
  allowTimedOutMedia = false,
) {
  const lateRecipientCheck =
    allowLateRecipientCheck &&
    input.eventType === 'workflow.failed' &&
    input.failure?.phase === 'before_message_send' &&
    [
      'EVOLUTION_RECIPIENT_NOT_FOUND',
      'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
      'MEDIA_DOWNLOAD_FAILED',
      'MEDIA_INTEGRITY_MISMATCH',
      'MEDIA_UPLOAD_FAILED',
      'MEDIA_PREFLIGHT_REJECTED',
      'MEDIA_PREFLIGHT_UNAVAILABLE',
    ].includes(input.failure.code) &&
    command?.status === 'outcome_unknown' &&
    command.message_status === 'outcome_unknown' &&
    command.message_delivery_status === 'outcome_unknown' &&
    [
      'N8N_COMMAND_TIMEOUT',
      'N8N_COMMAND_NETWORK_ERROR',
      'N8N_COMMAND_REMOTE_UNAVAILABLE',
      'N8N_COMMAND_ACK_INVALID',
      'N8N_COMMAND_ACK_MISMATCH',
      'N8N_COMMAND_DELIVERY_FAILED',
      'COMMAND_LEASE_EXPIRED',
      'WORKER_LEASE_EXPIRED',
    ].includes(command.last_error_code) &&
    input.automationEpoch !== null &&
    input.automationEpoch !== undefined &&
    input.sourceRevision !== null &&
    input.sourceRevision !== undefined &&
    Number(command.automation_epoch) === input.automationEpoch;
  // The HTTP caller timing out does not cancel the original reserved execution.
  // This exception never reserves again and never applies to transport uncertainty.
  const lateMedia =
    allowTimedOutMedia &&
    command?.status === 'outcome_unknown' &&
    command.last_error_code === 'N8N_COMMAND_TIMEOUT' &&
    command.message_status === 'outcome_unknown' &&
    command.message_delivery_status === 'outcome_unknown';
  const late = lateRecipientCheck || lateMedia;
  if (
    !command ||
    (!late && command.status !== 'processing') ||
    (!late && command.message_status !== 'sending') ||
    command.message_external_id ||
    command.external_message_id ||
    command.action !== 'send_message' ||
    command.actor_kind !== 'human' ||
    command.message_author_kind !== 'human' ||
    command.message_author_id !== command.actor_id ||
    (!late && command.message_delivery_status) ||
    command.message_execution_id !== input.technical.executionId
  )
    throw new N8nConflictError('Reservation is not active');
  const receipts = (
    await client.query(
      `SELECT workflow_key,workflow_version,execution_id,automation_epoch,source_revision,
              processed_at > clock_timestamp() - interval '5 minutes' AS media_window_open
       FROM crm.n8n_events WHERE message_id=$1 AND conversation_id=$2 AND event_type='message.send.requested'`,
      [command.message_id, command.conversation_id],
    )
  ).rows;
  if (
    receipts.length !== 1 ||
    receipts[0].workflow_key !== input.technical.workflowKey ||
    receipts[0].workflow_version !== input.technical.workflowVersion ||
    receipts[0].execution_id !== input.technical.executionId ||
    (input.automationEpoch !== null &&
      input.automationEpoch !== undefined &&
      Number(receipts[0].automation_epoch) !== input.automationEpoch) ||
    (input.sourceRevision !== null &&
      input.sourceRevision !== undefined &&
      Number(receipts[0].source_revision) !== input.sourceRevision)
  )
    throw new N8nConflictError('Reservation execution mismatch');
  if (
    lateMedia &&
    allowTimedOutMedia === 'read' &&
    !receipts[0].media_window_open
  )
    throw new N8nConflictError('Reserved media execution expired');
  if (late) {
    const transportUnknown = await client.query(
      `SELECT 1 FROM crm.n8n_events
       WHERE message_id=$1 AND conversation_id=$2
         AND event_type='message.send.unknown' AND execution_id=$3
       LIMIT 1`,
      [
        command.message_id,
        command.conversation_id,
        input.technical.executionId,
      ],
    );
    if (transportUnknown.rows.length)
      throw new N8nConflictError('Transport outcome is unknown');
  }
  return late;
}

/** @param {Queryable} client @param {string} commandId */
async function selectPanelCommand(client, commandId) {
  return (
    await client.query(
      `SELECT command.*, message.status AS message_status,
              message.message_type, message.content_envelope AS message_content_envelope,
              message.conversation_id AS message_conversation_id,
              message.author_id AS message_author_id, message.author_kind AS message_author_kind,
              message.n8n_execution_id AS message_execution_id,
              message.external_message_id AS message_external_id,
              message.delivery_status AS message_delivery_status
       FROM crm.n8n_commands AS command
       JOIN crm.messages AS message ON message.id = command.message_id
       WHERE command.command_id = $1
       FOR UPDATE OF command, message`,
      [commandId],
    )
  ).rows[0];
}

/** @param {any} command @param {any} conversation @param {any} input @param {Buffer} key @param {any} bound @param {Buffer} messageKey */
function assertPanelSendFence(
  command,
  conversation,
  input,
  key,
  bound,
  messageKey,
  expectedStatus = 'queued',
  expectedCommandStatus = 'processing',
) {
  if (
    command.action !== 'send_message' ||
    command.actor_kind !== 'human' ||
    command.message_author_kind !== 'human' ||
    command.message_author_id !== command.actor_id ||
    command.conversation_id !== conversation.id ||
    command.message_conversation_id !== conversation.id ||
    !command.message_id ||
    command.message_status !== expectedStatus ||
    command.status !== expectedCommandStatus ||
    Number(command.automation_epoch) !== Number(input.automationEpoch) ||
    Number(conversation.automation_epoch) !== Number(input.automationEpoch) ||
    Number(conversation.inbound_revision) !== Number(input.sourceRevision) ||
    conversation.automation_state !== 'human' ||
    conversation.terminal_at
  ) {
    throw new N8nConflictError('Panel send command fence is stale');
  }
  const payload = decryptJson(
    command.payload_envelope,
    `n8n-command:${command.command_id}`,
    key,
  );
  if (command.message_type !== 'text') {
    const content = decryptJson(
      command.message_content_envelope,
      `message:${command.message_id}`,
      messageKey,
    );
    const reference = retainedMediaReference(bound, {
      id: command.message_id,
      conversationId: conversation.id,
      actorId: command.actor_id,
      type: command.message_type,
      content,
    });
    if (
      fingerprint(comparableOutbound(payload.message)) !==
      fingerprint(
        comparableOutbound({
          ...payload.message,
          ...reference,
          type: command.message_type,
          text: content.caption ?? '',
        }),
      )
    )
      throw new N8nConflictError(
        'Bound variant changed after authorization',
        'COMMAND_PAYLOAD_MISMATCH',
      );
  }
  if (
    payload.conversation_id !== conversation.id ||
    Number(payload.automation_epoch) !== Number(input.automationEpoch) ||
    Number(payload.source_revision) !== Number(input.sourceRevision) ||
    fingerprint(comparableOutbound(payload.message)) !==
      fingerprint(comparableOutbound(input.message))
  ) {
    throw new N8nConflictError(
      'Command payload differs from the authorized message',
      'COMMAND_PAYLOAD_MISMATCH',
    );
  }
}

/** @param {any} message */
export function comparableOutbound(message) {
  const aliases = [
    message?.attachment_id,
    message?.media_id,
    message?.attachmentId,
  ].filter((value) => value !== undefined && value !== null);
  if (new Set(aliases).size > 1)
    throw new N8nConflictError(
      'Contradictory media aliases',
      'COMMAND_PAYLOAD_MISMATCH',
    );
  const retained = ['image', 'audio', 'video'].includes(message?.type);
  if (
    retained &&
    (Object.keys(message).some(
      (key) =>
        ![
          'type',
          'text',
          'caption',
          'media_id',
          'sha256',
          'mime_type',
          'size_bytes',
          'filename',
          'media_url',
        ].includes(key),
    ) ||
      typeof message.media_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        message.media_id,
      ) ||
      !/^[a-f0-9]{64}$/u.test(message.sha256 ?? '') ||
      typeof message.mime_type !== 'string' ||
      !Number.isSafeInteger(message.size_bytes) ||
      message.size_bytes < 1 ||
      (message.filename !== undefined && message.filename !== null) ||
      (message.media_url !== undefined && message.media_url !== null) ||
      (message.caption !== undefined &&
        message.caption !== null &&
        typeof message.caption !== 'string'))
  )
    throw new N8nConflictError(
      'Invalid retained media payload',
      'COMMAND_PAYLOAD_MISMATCH',
    );
  return {
    attachmentId:
      message?.attachment_id ??
      message?.media_id ??
      message?.attachmentId ??
      null,
    text: message?.text ?? null,
    type: message?.type ?? null,
    sha256: retained ? message.sha256 : null,
    mimeType: retained ? message.mime_type : null,
    sizeBytes: retained ? message.size_bytes : null,
    caption: retained ? (message.caption ?? null) : null,
  };
}

/** @param {any} conversation @param {any} input */
function assertCurrentAutomatedTurn(conversation, input) {
  if (
    !conversation ||
    conversation.terminal_at ||
    conversation.automation_state !== 'assistant' ||
    Number(conversation.automation_epoch) !== Number(input.automationEpoch) ||
    Number(conversation.inbound_revision) !== Number(input.sourceRevision) ||
    Number(conversation.claimed_revision) >= Number(input.sourceRevision)
  ) {
    throw new N8nConflictError(
      'Automated response is stale or already processed',
      'STALE_AUTOMATION_FENCE',
    );
  }
}

/**
 * CP-16/CP-29: the agent handed the turn off because it was unsure.
 * @param {any} input
 */
function isLowConfidenceHandoff(input) {
  return (
    input.eventType === 'handoff.requested' &&
    input.handoff?.reason === 'low_confidence'
  );
}

/** @param {Queryable} client @param {any} input @param {string} now */
async function confirmReservedSend(client, input, now) {
  const message = (
    await client.query(
      `UPDATE crm.messages
       SET external_message_id = COALESCE(external_message_id, $2),
           status = 'sent',
           sent_at = COALESCE(sent_at, $3),
           delivery_status = CASE
             WHEN delivery_status IN ('delivered', 'read') THEN delivery_status
             ELSE 'sent'
           END,
           delivery_status_at = CASE
             WHEN delivery_status IN ('delivered', 'read') THEN delivery_status_at
             ELSE $3
           END,
           delivery_failure_code = NULL
       WHERE command_id = $1
         AND conversation_id = $4
         AND status IN ('sending', 'sent', 'failed', 'outcome_unknown')
         AND (external_message_id IS NULL OR external_message_id = $2)
       RETURNING id, delivery_status`,
      [
        input.commandId,
        input.externalMessageId,
        input.occurredAt,
        input.conversationId,
      ],
    )
  ).rows[0];
  if (!message) throw new N8nNotFoundError('Send reservation was not found');
  await client.query(
    `UPDATE crm.n8n_commands
     SET status = 'sent', external_message_id = $2, updated_at = $3,
         last_error_code = NULL, retryable = false, retry_safe = false,
         completed_at = $3, locked_by = NULL, locked_until = NULL
     WHERE command_id = $1 AND conversation_id = $4 AND status IN ('pending', 'processing', 'outcome_unknown')`,
    [input.commandId, input.externalMessageId, now, input.conversationId],
  );
  return { messageId: message.id, status: message.delivery_status };
}

/** @param {Queryable} client @param {any} input */
async function updateDeliveryStatus(client, input) {
  const message = (
    await client.query(
      `SELECT id, delivery_status FROM crm.messages
       WHERE external_message_id = $1 AND conversation_id = $2
       FOR UPDATE`,
      [input.externalMessageId, input.conversationId],
    )
  ).rows[0];
  if (!message) throw new N8nNotFoundError('Outbound message was not found');
  const requested = /** @type {Record<string, string>} */ ({
    'message.delivered': 'delivered',
    'message.failed': 'failed',
    'message.read': 'read',
  })[input.eventType];
  const rank = /** @type {Record<string, number>} */ ({
    sent: 1,
    delivered: 2,
    read: 3,
  });
  const current = message.delivery_status;
  const changed =
    requested === 'failed'
      ? current === null || current === 'sent' || current === 'outcome_unknown'
      : !current ||
        current === 'failed' ||
        current === 'outcome_unknown' ||
        (rank[requested] ?? 0) > (rank[current] ?? 0);
  if (changed) {
    // INBOX-DELIVERY-02: why it failed, as a bounded code; cleared once a
    // later receipt proves the message arrived.
    await client.query(
      `UPDATE crm.messages
       SET delivery_status = $2, delivery_status_at = $3,
           status = CASE
             WHEN $2 = 'failed' THEN 'failed'
             WHEN $2 IN ('delivered', 'read') THEN 'sent'
             ELSE status END,
           delivery_failure_code = $4
       WHERE id = $1`,
      [
        message.id,
        requested,
        input.occurredAt,
        requested === 'failed' ? (input.failure?.code ?? 'SEND_FAILED') : null,
      ],
    );
  }
  return {
    changed,
    messageId: message.id,
    status: changed ? requested : current,
  };
}

/** @param {Queryable} client @param {any} input @param {string} now */
async function markSendUnknown(client, input, now) {
  const command = await selectPanelCommand(client, input.commandId);
  const late = command?.message_status === 'outcome_unknown';
  if (late)
    await assertReservedExecution(client, command, input, false, 'unknown');
  const message = (
    await client.query(
      `UPDATE crm.messages
       SET status = 'outcome_unknown', delivery_status = 'outcome_unknown',
           delivery_status_at = $2, delivery_failure_code = $4
       WHERE command_id = $1 AND conversation_id = $3 AND status = $5
         AND external_message_id IS NULL
       RETURNING id`,
      [
        input.commandId,
        now,
        input.conversationId,
        input.failure?.code ?? 'SEND_OUTCOME_UNKNOWN',
        late ? 'outcome_unknown' : 'sending',
      ],
    )
  ).rows[0];
  if (!message) throw new N8nNotFoundError('Send reservation was not found');
  await client.query(
    `UPDATE crm.n8n_commands
     SET status = 'outcome_unknown', locked_by = NULL, locked_until = NULL,
         retryable = false, retry_safe = false,
         last_error_code = 'OUTCOME_UNKNOWN', updated_at = $2,
         completed_at = $2
     WHERE command_id = $1 AND conversation_id = $3 AND status IN ('pending', 'processing', 'outcome_unknown')
       AND external_message_id IS NULL`,
    [input.commandId, now, input.conversationId],
  );
  return { messageId: message.id };
}

/** @param {Queryable} client @param {any} input @param {any} runtime @param {Buffer} key @param {any} conversation @param {string} now */
async function createUnassignedHandoff(
  client,
  input,
  runtime,
  key,
  conversation,
  now,
) {
  const reason = input.handoff?.reason;
  const reasonMap = /** @type {Record<string, string>} */ ({
    human_requested: 'customer_requested_human',
    negotiation: 'price_before_quote',
  });
  const reasonCode = reasonMap[reason] ?? reason ?? 'unresolved_blocker';
  const targetRole = 'Vendedor';
  const existing = await client.query(
    `SELECT id FROM crm.handoffs
     WHERE conversation_id = $1 AND status IN ('pending', 'accepted')
     FOR UPDATE`,
    [conversation.id],
  );
  if (existing.rows[0]) {
    throw new N8nConflictError('Active handoff already exists');
  }
  const preferredUserId = await preferredSellerFor(
    client,
    input,
    runtime,
    conversation,
    now,
  );
  const id = runtime.idFactory('handoff');
  const summary = String(
    input.handoff?.summary ??
      input.handoff?.reasoning ??
      // AGENTE-FAIL-01: the workflow's error branch may carry no summary.
      (reasonCode === 'automation_failure'
        ? AUTOMATION_FAILURE_SUMMARY
        : reasonCode),
  ).slice(0, 8192);
  const slaMinutes = 240;
  const dueAt = new Date(
    new Date(now).getTime() + slaMinutes * 60_000,
  ).toISOString();
  const changed = (
    await client.query(
      `UPDATE crm.conversations
       SET automation_state = 'human', automation_epoch = automation_epoch + 1,
           claimed_revision = $3, state = 'requer_atencao',
           assigned_user_id = NULL, version = version + 1
       WHERE id = $1 AND automation_state = 'assistant'
         AND terminal_at IS NULL AND automation_epoch = $2
         AND inbound_revision = $3 AND claimed_revision < $3
       RETURNING id`,
      [conversation.id, input.automationEpoch, input.sourceRevision],
    )
  ).rows[0];
  if (!changed) {
    throw new N8nConflictError(
      'Automated handoff is stale or already processed',
      'STALE_AUTOMATION_FENCE',
    );
  }
  const handoff = (
    await client.query(
      `INSERT INTO crm.handoffs
         (id, deal_id, conversation_id, assigned_user_id, target_role, status,
          version, reason_code, summary_envelope, due_at, sla_minutes,
          sla_policy_version, automation_workflow_key,
          automation_workflow_version, automation_execution_id, created_at,
          updated_at, preferred_user_id)
       VALUES ($1, NULL, $2, NULL, $3, 'pending', 1, $4, $5::jsonb, $6, $7,
               'n8n-mvp-1', $8, $9, $10, $11, $11, $12)
       RETURNING *`,
      [
        id,
        conversation.id,
        targetRole,
        reasonCode,
        JSON.stringify(
          encryptJson(summary, `${conversation.id}:handoff:summary`, key),
        ),
        dueAt,
        slaMinutes,
        input.technical.workflowKey,
        input.technical.workflowVersion,
        input.technical.executionId,
        now,
        preferredUserId,
      ],
    )
  ).rows[0];
  await client.query(
    `INSERT INTO crm.handoff_history
       (handoff_id, resulting_version, from_status, to_status,
        assigned_user_id, target_role, actor_id, reason_code,
        correlation_id, occurred_at)
     VALUES ($1, 1, NULL, 'pending', NULL, $2, $3, $4, $5, $6)`,
    [
      handoff.id,
      handoff.target_role,
      input.technical.actor,
      handoff.reason_code,
      input.correlationId,
      now,
    ],
  );
  return handoff;
}

/**
 * INBOX-HANDOFF-02: the seller the customer asked for by name, kept only when
 * it is one of the active sellers the inbound offered in `sellers[]`. Any
 * other id is ignored and audited, so a stale or wrong id never fails the
 * handoff. The handoff still opens without an owner (ADR 009).
 *
 * @param {Queryable} client @param {any} input @param {any} runtime
 * @param {any} conversation @param {string} now
 * @returns {Promise<string|null>}
 */
async function preferredSellerFor(client, input, runtime, conversation, now) {
  const requested = input.handoff?.requested_seller_id;
  if (typeof requested !== 'string') return null;
  const seller = (
    await client.query(
      `SELECT u.id FROM crm.users AS u
       JOIN crm.user_functions AS f ON f.user_id = u.id
       WHERE u.id = $1 AND u.disabled_at IS NULL
         AND f.function_name = 'Vendedor'`,
      [requested],
    )
  ).rows[0];
  if (seller) return seller.id;
  await appendAudit(client, runtime, {
    action: 'integration.n8n.handoff.preferred_seller_ignored',
    actor: input.technical.actor,
    correlationId: input.correlationId,
    occurredAt: now,
    // The code only: the requested id is not echoed into the trail.
    reason: 'PREFERRED_SELLER_NOT_ACTIVE',
    targetId: conversation.id,
    targetType: 'conversation',
    version: input.automationEpoch ?? 1,
  });
  return null;
}

/** @param {Queryable} client @param {any} runtime @param {any} input */
async function appendAudit(client, runtime, input) {
  await client.query(
    `INSERT INTO crm.audit_events
       (id, actor_id, action, target_type, target_id, version, reason,
        correlation_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      runtime.idFactory('audit'),
      input.actor,
      input.action,
      input.targetType,
      input.targetId,
      String(input.version),
      input.reason,
      input.correlationId,
      input.occurredAt,
    ],
  );
}

/** @param {any} row */
function conversationMode(row) {
  if (row.terminal_at !== null) return 'closed';
  if (row.automation_state === 'assistant') return 'ai_active';
  return row.state === 'requer_atencao' ? 'handoff_pending' : 'human_active';
}

/** @param {any} message */
function outboundMessageType(message) {
  const type = message?.type;
  if (!['audio', 'document', 'image', 'text', 'video'].includes(type)) {
    throw new N8nConflictError('Unsupported outbound message type');
  }
  return type;
}

/** @param {any} message @param {string} type */
function outboundMessageContent(message, type) {
  return type === 'text'
    ? { text: String(message.text ?? '') }
    : {
        attachmentId: message.attachment_id ?? message.media_id,
        caption: message.text ?? null,
      };
}

/** @param {any} outcome @param {boolean} duplicate */
function attachmentResponse(outcome, duplicate) {
  const value = jsonObject(outcome);
  return { accepted: true, duplicate, ...value };
}

/** @param {unknown} value */
function jsonObject(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value && typeof value === 'object' ? value : {};
}

/** @param {unknown} value */
function safeFailureCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value)
    ? value
    : 'WORKFLOW_FAILED';
}

/**
 * A typed domain code (`CONVERSATION_NOT_FOUND`, `ORDER_PENDING_EXISTS`...)
 * travels as is; anything else, including driver codes and messages that
 * could echo stored values, becomes the generic `ORDER_OPEN_FAILED`.
 *
 * @param {unknown} error
 */
function orderFailureCode(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code;
  return typeof code === 'string' &&
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(code) &&
    code.length <= 64
    ? code
    : 'ORDER_OPEN_FAILED';
}

/** @param {unknown} value */
function automationDisplayName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > CONTACT_DISPLAY_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** @param {Queryable} client */
async function transactionBounds(client) {
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL transaction_timeout = '10s'");
}

/** @param {Queryable} client @param {string} key */
async function advisoryLock(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    key,
  ]);
}

/** @param {() => Date} clock */
function validClock(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('clock must return a valid Date');
  }
  return now.toISOString();
}

/** @param {unknown} value */
function iso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

/** @param {Queryable} client @param {string} conversationId */
async function countAutomationMessages(client, conversationId) {
  const row = (
    await client.query(
      `SELECT count(*)::int AS total FROM crm.messages
       WHERE conversation_id = $1 AND direction = 'outbound'
         AND author_kind = 'assistant'`,
      [conversationId],
    )
  ).rows[0];
  return Number(row?.total ?? 0);
}

/**
 * Active sellers, first name only: the agent recognises a seller the customer
 * asks for by name (ADR 009) without seeing anything else about the team.
 *
 * @param {Queryable} client
 */
async function activeSellers(client) {
  const rows = (
    await client.query(
      `SELECT u.id, split_part(u.name, ' ', 1) AS first_name
       FROM crm.users AS u
       JOIN crm.user_functions AS f ON f.user_id = u.id
       WHERE u.disabled_at IS NULL AND f.function_name = 'Vendedor'
       ORDER BY u.name, u.id`,
    )
  ).rows;
  return rows.map((/** @type {any} */ row) => ({
    id: row.id,
    name: row.first_name,
  }));
}
