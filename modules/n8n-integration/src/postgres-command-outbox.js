import { decryptJson, encryptJson, fingerprint } from './crypto.js';
import { retainedMediaReference } from './retained-media-reference.js';

/**
 * Drop-in replacement for PostgresOutboundMessageOutbox. It is called by the
 * existing PostgresInboxRepository inside the same transaction that writes the
 * human message and conversation takeover.
 */
export class PostgresN8nCommandOutbox {
  /** @param {{envelopeKey: Buffer, messageEnvelopeKey?: Buffer, contactEnvelopeKey?: Buffer}} options */
  constructor({
    envelopeKey,
    messageEnvelopeKey = envelopeKey,
    contactEnvelopeKey = envelopeKey,
  }) {
    for (const [key, name] of [
      [envelopeKey, 'envelopeKey'],
      [messageEnvelopeKey, 'messageEnvelopeKey'],
      [contactEnvelopeKey, 'contactEnvelopeKey'],
    ]) {
      if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new TypeError(`${name} must be a 32-byte Buffer`);
      }
    }
    this.envelopeKey = Buffer.from(envelopeKey);
    this.messageEnvelopeKey = Buffer.from(messageEnvelopeKey);
    this.contactEnvelopeKey = Buffer.from(contactEnvelopeKey);
  }

  /** @param {{id: string, idempotencyKey: string, messageId: string, availableAt: string|Date,billingSend?:boolean}} input @param {{transaction?: any}} context */
  async enqueueChannelMessage(input, context = {}) {
    const client = queryable(context);
    const row = (
      await client.query(
        `SELECT message.id, message.command_id, message.author_id,
                message.message_type, message.content_envelope,
                conversation.id AS conversation_id, conversation.automation_epoch,
                conversation.inbound_revision,
                identity.external_identity_lookup_hash, identity.identity_envelope
         FROM crm.messages AS message
         JOIN crm.conversations AS conversation
           ON conversation.id = message.conversation_id
         JOIN crm.contact_identities AS identity
           ON identity.id = conversation.contact_identity_id
         WHERE message.id = $1
         FOR UPDATE OF message, conversation`,
        [input.messageId],
      )
    ).rows[0];
    if (!row || row.command_id !== input.idempotencyKey) {
      throw new Error('Outbound message reservation is inconsistent');
    }
    const message = decryptJson(
      row.content_envelope,
      `message:${row.id}`,
      this.messageEnvelopeKey,
    );
    const identity = decryptJson(
      row.identity_envelope,
      JSON.stringify([
        'crm.contact_identities',
        1,
        row.external_identity_lookup_hash,
      ]),
      this.contactEnvelopeKey,
    );
    let mediaReference = {};
    if (['image', 'audio', 'video'].includes(row.message_type)) {
      const bound = (
        await client.query(
          'SELECT * FROM crm.chat_media WHERE message_id=$1 AND conversation_id=$2 FOR UPDATE',
          [row.id, row.conversation_id],
        )
      ).rows[0];
      mediaReference = retainedMediaReference(bound, {
        id: row.id,
        conversationId: row.conversation_id,
        actorId: row.author_id,
        type: row.message_type,
        content: message,
      });
    }
    const payload = {
      ...(input.billingSend === true ? { billing_send: true } : {}),
      action: 'send_message',
      actor: { id: row.author_id },
      automation_epoch: Number(row.automation_epoch),
      command_id: input.idempotencyKey,
      conversation_id: row.conversation_id,
      source_revision: Number(row.inbound_revision),
      message: {
        filename: null,
        media_url: null,
        text: message.text ?? message.caption ?? '',
        type: row.message_type,
        ...mediaReference,
      },
      schema_version: '1.0',
      to: identity.externalIdentityId,
    };
    await enqueue(client, this.envelopeKey, {
      action: 'send_message',
      actorId: row.author_id,
      actorKind: 'human',
      automationEpoch: Number(row.automation_epoch),
      availableAt: input.availableAt,
      commandId: input.idempotencyKey,
      jobId: input.id,
      messageId: input.messageId,
      payload,
    });
  }

  /**
   * Transaction hook for take_over, return_to_ai and close. The caller must
   * mutate the conversation and invoke this method with the exact same client.
   * @param {any} input @param {{transaction?: any}} context
   */
  async enqueuePanelCommand(input, context = {}) {
    const client = queryable(context);
    if (!['take_over', 'return_to_ai', 'close'].includes(input.action)) {
      throw new TypeError('action must be take_over, return_to_ai or close');
    }
    const conversation = (
      await client.query(
        `SELECT id, automation_epoch FROM crm.conversations
         WHERE id = $1 FOR UPDATE`,
        [input.conversationId],
      )
    ).rows[0];
    if (!conversation) throw new Error('Conversation was not found');
    const payload = {
      action: input.action,
      actor: { id: input.actor.id },
      automation_epoch: Number(conversation.automation_epoch),
      command_id: input.commandId,
      conversation_id: conversation.id,
      schema_version: '1.0',
    };
    await enqueue(client, this.envelopeKey, {
      action: input.action,
      actorId: input.actor.id,
      actorKind: input.actor.kind ?? 'human',
      automationEpoch: Number(conversation.automation_epoch),
      availableAt: input.availableAt,
      commandId: input.commandId,
      jobId: input.jobId,
      messageId: null,
      payload,
    });
    return Object.freeze({ commandId: input.commandId, payload });
  }
}

/** @param {any} client @param {Buffer} key @param {any} input */
async function enqueue(client, key, input) {
  const payloadHash = fingerprint(input.payload);
  await client.query(
    `INSERT INTO crm.n8n_commands
       (command_id, conversation_id, message_id, action, actor_id, actor_kind,
        automation_epoch, fingerprint, payload_envelope, key_version, status,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, 'pending', $10, $10)`,
    [
      input.commandId,
      input.payload.conversation_id,
      input.messageId,
      input.action,
      input.actorId,
      input.actorKind,
      input.automationEpoch,
      payloadHash,
      JSON.stringify(
        encryptJson(input.payload, `n8n-command:${input.commandId}`, key),
      ),
      input.availableAt,
    ],
  );
  await client.query(
    `INSERT INTO crm.outbox_jobs
       (id, job_type, idempotency_key, channel_event_id, status, priority,
        available_at, created_at, transient_media_id, queue, attempt_count,
        max_attempts, updated_at, effect_policy, message_id, n8n_command_id)
     VALUES ($1, 'n8n.command.deliver', $2, NULL, 'pending', 100, $3, $3,
             NULL, 'external_effects', 0, 8, $3, 'manual', $4, $2)`,
    [input.jobId, input.commandId, input.availableAt, input.messageId],
  );
}

/** @param {{transaction?: any}} context */
function queryable(context) {
  if (!context.transaction || typeof context.transaction.query !== 'function') {
    throw new TypeError('A queryable transaction is required');
  }
  return context.transaction;
}
