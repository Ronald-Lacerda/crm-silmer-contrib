import { createHash, randomUUID } from 'node:crypto';

import {
  createN8nIntegrationService,
  PostgresN8nCommandOutbox,
  PostgresN8nIntegrationRepository,
} from '@crm-silmer/n8n-integration';
import {
  ClamAvMediaScanner,
  MediaHashMismatchError,
  MediaQuotaExceededError,
  MediaVolumeUnavailableError,
  PostgresTransientMediaRepository,
  PrivateMediaVolume,
} from '@crm-silmer/integration-reliability';

const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

class N8nMediaIngressError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'N8nMediaIngressError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Composes the compatibility service and its private media ingress. The n8n
 * DTO remains at this boundary; repositories receive canonical values.
 *
 * @param {any} database
 * @param {{environment?: Record<string,string|undefined>, orderAssistance?: {observe(input: any): Promise<any>}, mediaVolume?: PrivateMediaVolume, scanner?: {scan(path: string): Promise<any>}, clock?: () => Date, orders?: {ensurePendingFromIntent(input: {conversationId: string, correlationId: string}): Promise<{created: boolean, order: {id: string}}>, projectAgentBriefing(input: {conversationId: string, correlationId: string, briefing: Record<string, unknown>, automationState: string}): Promise<any>}}} [options]
 */
export function createN8nApiRuntime(database, options = {}) {
  const environment = options.environment ?? process.env;
  const envelopeKey = readEnvelopeKey(
    environment.N8N_INTEGRATION_ENVELOPE_KEY,
    'N8N_INTEGRATION_ENVELOPE_KEY',
  );
  const contactEnvelopeKey = readEnvelopeKey(
    environment.CONTACT_IDENTITY_ENVELOPE_KEY,
    'CONTACT_IDENTITY_ENVELOPE_KEY',
  );
  const contactLookupKey = readEnvelopeKey(
    environment.CONTACT_IDENTITY_LOOKUP_KEY,
    'CONTACT_IDENTITY_LOOKUP_KEY',
  );
  const messageEnvelopeKey = readEnvelopeKey(
    environment.INBOX_MESSAGE_ENVELOPE_KEY,
    'INBOX_MESSAGE_ENVELOPE_KEY',
  );
  const clock = options.clock ?? (() => new Date());
  const repository = new PostgresN8nIntegrationRepository({
    contactEnvelopeKey,
    contactLookupKey,
    database,
    envelopeKey,
    messageEnvelopeKey,
    orders: options.orders,
    requireHumanOrderCreation: true,
    billingSendEnabled:
      environment.ORDER_BILLING_ENABLED === 'true' &&
      environment.ORDER_BILLING_CHAT_SEND_ENABLED === 'true',
  });
  const service = createN8nIntegrationService({
    repository,
    clock,
    allowConversationBriefing: true,
  });
  const transientMediaRepository = new PostgresTransientMediaRepository({
    database,
  });
  const mediaVolume =
    options.mediaVolume ??
    new PrivateMediaVolume({
      maxBytes: positiveInteger(
        environment.PRIVATE_MEDIA_MAX_BYTES,
        'PRIVATE_MEDIA_MAX_BYTES',
      ),
      maxFileBytes: positiveInteger(
        environment.PRIVATE_MEDIA_MAX_FILE_BYTES,
        'PRIVATE_MEDIA_MAX_FILE_BYTES',
      ),
      repository: transientMediaRepository,
      rootDirectory: required(
        environment.PRIVATE_MEDIA_ROOT,
        'PRIVATE_MEDIA_ROOT',
      ),
      scanner: options.scanner ?? new ClamAvMediaScanner(),
    });
  const commandOutbox = new PostgresN8nCommandOutbox({
    contactEnvelopeKey,
    envelopeKey,
    messageEnvelopeKey,
  });
  // The approved pilot has one API process. Keep state discovery, storage and
  // binding in one per-message critical section; the volume queue alone starts
  // too late to prevent two retries from acting on the same obsolete state.
  const attachmentWrites = /** @type {Map<string, Promise<void>>} */ (
    new Map()
  );

  return Object.freeze({
    commandOutbox,
    mediaVolume,
    receiveInbound: service.receiveInbound,
    async recordEvent(/** @type {any} */ input) {
      if (input?.event_type === 'order.assistance.observed') {
        if (!options.orderAssistance) {
          throw new N8nMediaIngressError(503, 'ORDER_ASSISTANCE_UNAVAILABLE');
        }
        const observation = input.observation;
        const allowed = new Set([
          'signal',
          'product_summary',
          'evidence_message_id',
          'briefing_patch',
          'subject_id',
        ]);
        if (
          !observation ||
          typeof observation !== 'object' ||
          Array.isArray(observation) ||
          Object.keys(observation).some((key) => !allowed.has(key)) ||
          [
            'briefing_patch',
            'open_order',
            'subject_id',
            'order_id',
            'command_id',
            'handoff',
            'message',
            'failure',
            'turn',
            'transcript',
            'target_contract',
            'external_message_id',
          ].some((key) => input[key] !== undefined)
        ) {
          throw new N8nMediaIngressError(400, 'INVALID_OBSERVATION_EVENT');
        }
        return options.orderAssistance.observe({
          conversation_id: input.conversation_id,
          source_revision: input.source_revision,
          automation_epoch: input.automation_epoch,
          ...observation,
          technical: input.technical,
        });
      }
      if (input?.observation !== undefined) {
        throw new N8nMediaIngressError(400, 'INVALID_OBSERVATION_EVENT');
      }
      return service.recordEvent(input);
    },
    readSiteMessages: (/** @type {{sessionId: string}} */ input) =>
      repository.readSiteMessages(input),
    readReservedMedia: (/** @type {any} */ input) =>
      repository.readReservedMedia(input),
    readReservedSend: (/** @type {any} */ input) =>
      repository.readReservedSend(input),
    /**
     * The MVP agent's `order.intent_confirmed` event, kept out of the n8n
     * integration service: order creation is idempotent by conversation
     * state (ADR 006), so it needs no receipt-based replay of its own.
     * Deprecated by ADR 014: workflows from mvp-simple-11 on open the order
     * with `open_order` on the reservation or the handoff instead. It stays
     * for older workflows still synced to this CRM.
     * @param {any} input
     */
    async recordOrderIntent(input) {
      // OA-01: legacy clients cannot bypass the human creation command.
      requireIdentifier(input?.conversation_id, 'INVALID_CONVERSATION_ID');
      const eventId = requireIdentifier(input?.event_id, 'INVALID_EVENT_ID');
      return {
        accepted: true,
        duplicate: false,
        event_id: eventId,
        order_id: null,
        order: { opened: null, status: 'awaiting_human' },
        processed_at: clock().toISOString(),
      };
    },
    /** @param {any} input */
    async storeAttachment(input) {
      return serializeAttachment(
        attachmentWrites,
        JSON.stringify([input.conversationId, input.externalId]),
        async () => {
          const media = await prepareTransientMedia(database, input, clock());
          if (media.availabilityStatus === 'available') {
            if (
              media.contentSha256 !== input.contentSha256 ||
              Number(media.sizeBytes) !== input.size
            ) {
              throw new N8nMediaIngressError(409, 'IDEMPOTENCY_CONFLICT');
            }
          } else if (!isRetryableAttachment(media)) {
            throw new N8nMediaIngressError(409, 'ATTACHMENT_NOT_RETRYABLE');
          } else {
            let stored;
            try {
              if (media.storageKey) {
                if (
                  media.contentSha256 !== input.contentSha256 ||
                  Number(media.sizeBytes) !== input.size ||
                  media.detectedMimeType !== input.mimeType
                )
                  throw new N8nMediaIngressError(409, 'IDEMPOTENCY_CONFLICT');
                stored = await mediaVolume.revalidate({
                  mediaId: media.id,
                  storageKey: media.storageKey,
                  expectedSha256: input.contentSha256,
                  expectedSizeBytes: input.size,
                  declaredMimeType: input.mimeType,
                });
              } else {
                stored = await mediaVolume.store({
                  bytes: input.stream,
                  declaredMimeType: input.mimeType,
                  expectedSha256: input.contentSha256,
                  mediaId: media.id,
                });
              }
            } catch (error) {
              if (error instanceof MediaHashMismatchError) {
                throw new N8nMediaIngressError(400, 'CONTENT_SHA256_MISMATCH');
              }
              if (error instanceof MediaQuotaExceededError) {
                throw new N8nMediaIngressError(413, 'MEDIA_QUOTA_EXCEEDED');
              }
              if (error instanceof MediaVolumeUnavailableError) {
                throw new N8nMediaIngressError(503, 'MEDIA_VOLUME_UNAVAILABLE');
              }
              throw error;
            }
            if (stored.availabilityStatus === 'quarantined') {
              throw new N8nMediaIngressError(503, 'MEDIA_QUARANTINED');
            }
            if (stored.availabilityStatus !== 'available') {
              throw new N8nMediaIngressError(415, 'UNSUPPORTED_MEDIA_TYPE');
            }
          }
          return service.storeAttachment({
            ...input,
            transientMediaId: media.id,
          });
        },
      );
    },
  });
}

/** @template T @param {Map<string, Promise<void>>} writes @param {string} key @param {() => Promise<T>} work */
async function serializeAttachment(writes, key, work) {
  const previous = writes.get(key) ?? Promise.resolve();
  let release = /** @type {() => void} */ (() => {});
  const current = new Promise((resolveCurrent) => {
    release = () => resolveCurrent(undefined);
  });
  writes.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writes.get(key) === current) writes.delete(key);
  }
}

/** @param {any} media */
function isRetryableAttachment(media) {
  return (
    media.availabilityStatus === 'metadata_only' ||
    (media.availabilityStatus === 'quarantined' &&
      media.validationStatus === 'stale_signatures') ||
    (media.availabilityStatus === 'unavailable' &&
      [
        'storage_or_scan_failed',
        'quota_exceeded',
        'volume_unavailable',
      ].includes(media.unavailableReason))
  );
}

/** @param {any} database @param {any} input @param {Date} now */
async function prepareTransientMedia(database, input, now) {
  return database.transaction(async (/** @type {any} */ transaction) => {
    const message = (
      await transaction.query(
        `SELECT message.id, message.message_type, message.created_at,
                conversation.terminal_at, conversation.provider,
                conversation.provider_account_id
         FROM crm.messages AS message
         JOIN crm.conversations AS conversation
           ON conversation.id = message.conversation_id
         WHERE conversation.id = $1 AND message.external_message_id = $2
         FOR UPDATE OF message, conversation`,
        [input.conversationId, input.externalId],
      )
    ).rows[0];
    if (!message) throw new N8nMediaIngressError(404, 'MESSAGE_NOT_FOUND');
    if (
      !['audio', 'document', 'image', 'video'].includes(message.message_type)
    ) {
      throw new N8nMediaIngressError(422, 'MESSAGE_DOES_NOT_ACCEPT_ATTACHMENT');
    }
    const receivedAt = new Date(message.created_at);
    const expiresAt = new Date(receivedAt.getTime() + MEDIA_TTL_MS);
    if (
      message.terminal_at ||
      !Number.isFinite(receivedAt.getTime()) ||
      expiresAt <= now
    ) {
      throw new N8nMediaIngressError(410, 'ATTACHMENT_EXPIRED');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          contentSha256: input.contentSha256,
          externalId: input.externalId,
          filename: input.filename,
          mimeType: input.mimeType,
          size: input.size,
        }),
      )
      .digest('hex');
    const mediaId = `media-${randomUUID()}`;
    const inserted = await transaction.query(
      `INSERT INTO crm.transient_media
         (id, provider, provider_account_id, external_media_id, media_type,
          declared_mime_type, provider_sha256, metadata_fingerprint,
          first_received_at, expires_at, availability_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'metadata_only')
       ON CONFLICT ON CONSTRAINT transient_media_external_identity_key
       DO NOTHING
       RETURNING id, availability_status, content_sha256, size_bytes,
                 metadata_fingerprint, storage_key, detected_mime_type,
                 validation_status, unavailable_reason`,
      [
        mediaId,
        message.provider,
        message.provider_account_id,
        input.externalId,
        message.message_type,
        input.mimeType,
        input.contentSha256,
        fingerprint,
        receivedAt,
        expiresAt,
      ],
    );
    const selected =
      inserted.rows[0] ??
      (
        await transaction.query(
          `SELECT id, availability_status, content_sha256, size_bytes,
                  metadata_fingerprint, storage_key, detected_mime_type,
                  validation_status, unavailable_reason
           FROM crm.transient_media
           WHERE provider = $1 AND provider_account_id = $2
             AND external_media_id = $3
           FOR UPDATE`,
          [message.provider, message.provider_account_id, input.externalId],
        )
      ).rows[0];
    if (!selected || selected.metadata_fingerprint !== fingerprint) {
      throw new N8nMediaIngressError(409, 'IDEMPOTENCY_CONFLICT');
    }
    return Object.freeze({
      availabilityStatus: selected.availability_status,
      contentSha256: selected.content_sha256,
      storageKey: selected.storage_key,
      detectedMimeType: selected.detected_mime_type,
      validationStatus: selected.validation_status,
      unavailableReason: selected.unavailable_reason,
      id: selected.id,
      sizeBytes: selected.size_bytes,
    });
  });
}

/** @param {unknown} value @param {string} code */
function requireIdentifier(value, code) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > 512 ||
    /[ -\u007f]/u.test(value)
  ) {
    throw new N8nMediaIngressError(400, code);
  }
  return value;
}

/** @param {string|undefined} value @param {string} name */
function readEnvelopeKey(value, name) {
  const encoded = required(value, name);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) {
    throw new Error(`${name} must use base64 or base64url`);
  }
  const key = Buffer.from(
    encoded,
    encoded.includes('-') || encoded.includes('_') ? 'base64url' : 'base64',
  );
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return key;
}

/** @param {string|undefined} value @param {string} name */
function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required when n8n integration is enabled`);
  }
  return value;
}

/** @param {string|undefined} value @param {string} name */
function positiveInteger(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}
