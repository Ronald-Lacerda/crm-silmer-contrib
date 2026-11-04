import { randomUUID } from 'node:crypto';
import { normalizeContactPhone } from '@crm-silmer/contacts';

import {
  N8nConflictError,
  N8nForbiddenError,
  N8nValidationError,
} from './errors.js';
import { fingerprint } from './crypto.js';

const EVENT_TYPES = new Set([
  'handoff.requested',
  'message.delivered',
  'message.failed',
  'message.read',
  'message.send.requested',
  'message.send.unknown',
  'message.sent',
  'message.transcribed',
  'workflow.failed',
]);
const EVENTS_WITH_RESOLVABLE_CONVERSATION = new Set([
  'message.delivered',
  'message.failed',
  'message.read',
  'message.send.unknown',
  'message.sent',
]);
export const BRIEFING_PATCH_FIELDS = new Set([
  'artwork_locations',
  'artwork_status',
  'artwork_technique',
  // ADR 025: how the customer splits the quantity by audience.
  'audiences',
  'briefing_status',
  'city_or_postal_code',
  'collar',
  'colors',
  'customer_name',
  'customizations',
  'delivery_address',
  'delivery_mode',
  'fabrics',
  'needed_by',
  'next_required_field',
  'notes',
  'numbers',
  'order_name',
  'pickup_location',
  'product_model',
  'product_type',
  'purchase_profile',
  'purpose',
  'quantity',
  'segment',
  'sizes',
  'sponsors',
]);
// ADR 014: the agent asks the CRM to open the pending order on the same
// event that carries the turn's briefing, never on a call of its own.
const EVENTS_THAT_OPEN_ORDERS = new Set([
  'handoff.requested',
  'message.send.requested',
]);

/**
 * Small compatibility boundary for the WhatsApp MVP. Authentication happens at
 * the HTTP edge; the actor is checked again here so internal callers cannot
 * accidentally bypass the service account boundary.
 *
 * @param {{
 *   repository: {
 *     receiveInbound(input: any, runtime: any): Promise<any>,
 *     storeAttachment(input: any, runtime: any): Promise<any>,
 *     recordEvent(input: any, runtime: any): Promise<any>,
 *   },
 *   clock?: () => Date,
 *   idFactory?: (kind: string) => string,
 *   allowConversationBriefing?: boolean,
 * }} options
 */
export function createN8nIntegrationService({
  repository,
  clock = () => new Date(),
  idFactory = (kind) => `${kind}-${randomUUID()}`,
  allowConversationBriefing = false,
}) {
  for (const [candidate, method] of [
    [repository?.receiveInbound, 'receiveInbound'],
    [repository?.storeAttachment, 'storeAttachment'],
    [repository?.recordEvent, 'recordEvent'],
  ]) {
    if (typeof candidate !== 'function') {
      throw new N8nValidationError(`repository must implement ${method}`);
    }
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new N8nValidationError('Invalid n8n integration runtime');
  }

  const runtime = Object.freeze({ clock, idFactory });

  return Object.freeze({
    /** @param {any} input */
    async receiveInbound(input) {
      const technical = normalizeTechnical(input?.technical);
      requireSchema(input?.schema_version);
      const occurredAt = instant(input?.occurred_at, 'occurred_at');
      const channel = /** @type {'whatsapp'|'site_chat'} */ (
        oneOf(input?.channel, ['whatsapp', 'site_chat'], 'channel')
      );
      const provider = identifier(
        input?.provider ?? (channel === 'site_chat' ? 'site' : 'meta'),
        'provider',
        64,
      );
      if (channel === 'site_chat' && provider !== 'site') {
        throw new N8nValidationError('site_chat requires the site provider');
      }
      const providerAccountId = identifier(
        input?.metadata?.provider_account_id ??
          input?.metadata?.phone_number_id ??
          input?.provider_account_id,
        'metadata.provider_account_id',
        512,
      );
      const externalIdentityId =
        channel === 'site_chat'
          ? normalizeSiteIdentity(input?.contact?.external_id)
          : normalizeWhatsAppIdentity(
              input?.contact?.external_id ?? input?.contact?.wa_id,
            );
      if (channel === 'site_chat' && input?.contact?.wa_id !== undefined) {
        throw new N8nValidationError(
          'site_chat cannot claim a WhatsApp identity',
        );
      }
      const siteContact =
        channel === 'site_chat'
          ? normalizeSiteContact(input?.site_contact)
          : null;
      if (channel === 'whatsapp' && input?.site_contact !== undefined) {
        throw new N8nValidationError('site_contact requires site_chat');
      }
      const externalMessageId = identifier(
        input?.message?.external_id,
        'message.external_id',
        512,
      );
      const externalConversationId = identifier(
        input?.external_conversation_id ?? externalIdentityId,
        'external_conversation_id',
        512,
      );
      const messageType = oneOf(
        input?.message?.type,
        [
          'audio',
          'button',
          'document',
          'image',
          'interactive',
          'text',
          'video',
        ],
        'message.type',
      );
      const content = normalizeMessageContent(input?.message, messageType);
      const canonicalMessageType = ['button', 'interactive'].includes(
        messageType,
      )
        ? 'text'
        : messageType;

      return translateConflict(() =>
        repository.receiveInbound(
          Object.freeze({
            channel,
            correlationId: technical.correlationId,
            eventFingerprint: fingerprint({
              channel,
              contact: input.contact,
              siteContact,
              eventId: input.event_id,
              message: input.message,
              occurredAt,
              provider,
              providerAccountId,
            }),
            externalConversationId,
            externalEventId: identifier(input?.event_id, 'event_id', 512),
            externalIdentityId,
            externalMessageId,
            identityKind: channel === 'site_chat' ? 'handle' : 'phone',
            displayHandle: null,
            message: { content, type: canonicalMessageType },
            occurredAt,
            phoneStatus: channel === 'site_chat' ? 'pending' : 'confirmed',
            siteContact,
            provider,
            providerAccountId,
            technical,
          }),
          runtime,
        ),
      );
    },

    /** @param {any} input */
    async storeAttachment(input) {
      const technical = normalizeTechnical(input?.technical);
      const contentSha256 = sha256(
        input?.contentSha256 ?? input?.content_sha256,
        'contentSha256',
      );
      const transientMediaId = identifier(
        input?.transientMediaId ?? input?.transient_media_id,
        'transientMediaId',
        512,
      );
      const normalized = Object.freeze({
        contentSha256,
        conversationId: identifier(
          input?.conversationId ?? input?.conversation_id,
          'conversationId',
          512,
        ),
        correlationId: technical.correlationId,
        eventFingerprint: fingerprint({
          contentSha256,
          externalId: input?.externalId ?? input?.external_id,
          filename: input?.filename,
          mimeType: input?.mimeType ?? input?.mime_type,
          size: input?.size,
          transientMediaId,
        }),
        externalId: identifier(
          input?.externalId ?? input?.external_id,
          'externalId',
          512,
        ),
        filename: safeFilename(input?.filename),
        mimeType: identifier(
          input?.mimeType ?? input?.mime_type,
          'mimeType',
          255,
        ),
        size: nonNegativeInteger(input?.size, 'size'),
        transientMediaId,
        technical,
      });
      return translateConflict(() =>
        repository.storeAttachment(normalized, runtime),
      );
    },

    /** @param {any} input */
    async recordEvent(input) {
      const technical = normalizeTechnical(input?.technical);
      requireSchema(input?.schema_version);
      const eventType = oneOf(
        input?.event_type,
        [...EVENT_TYPES],
        'event_type',
      );
      const occurredAt = instant(input?.occurred_at, 'occurred_at');
      const conversationId =
        (input?.conversation_id === null ||
          input?.conversation_id === undefined) &&
        (eventType === 'workflow.failed' ||
          EVENTS_WITH_RESOLVABLE_CONVERSATION.has(eventType))
          ? null
          : identifier(input?.conversation_id, 'conversation_id', 512);
      const normalized = Object.freeze({
        allowConversationBriefing,
        automationEpoch:
          input?.automation_epoch === undefined
            ? null
            : nonNegativeInteger(input.automation_epoch, 'automation_epoch'),
        briefingPatch: normalizeBriefingPatch(input?.briefing_patch),
        commandId: optionalString(input?.command_id, 512),
        conversationId,
        correlationId: technical.correlationId,
        eventFingerprint: fingerprint(stripTechnical(input)),
        eventId: identifier(input?.event_id, 'event_id', 512),
        eventType,
        externalMessageId: optionalString(input?.external_message_id, 512),
        failure: normalizeFailure(input?.failure, eventType),
        handoff: input?.handoff ? plainObject(input.handoff) : null,
        message: input?.message ? plainObject(input.message) : null,
        occurredAt,
        openOrder: optionalBoolean(input?.open_order, 'open_order'),
        sourceRevision:
          input?.source_revision === undefined
            ? null
            : positiveInteger(input.source_revision, 'source_revision'),
        subjectId: optionalString(input?.subject_id, 512),
        orderId: optionalString(input?.order_id, 512),
        targetContract:
          input?.target_contract === undefined
            ? null
            : oneOf(input.target_contract, ['subject-v1'], 'target_contract'),
        subjectContractRequired: requiresSubjectContract(
          input?.target_contract,
          technical.workflowVersion,
        ),
        technical,
        transcript: normalizeTranscript(input?.transcript, eventType),
        turn: normalizeTurn(input?.turn, eventType),
      });
      validateEventShape(normalized);
      return translateConflict(() =>
        repository.recordEvent(normalized, runtime),
      );
    },
  });
}

/** @param {any} input */
function validateEventShape(input) {
  const requiresSubjectTarget =
    input.subjectContractRequired && !input.allowConversationBriefing;
  if (
    requiresSubjectTarget &&
    input.briefingPatch &&
    !input.subjectId &&
    input.openOrder !== true
  ) {
    throw new N8nValidationError(
      'subject-v1 briefing changes require subject_id and order_id',
    );
  }
  if ((input.subjectId === null) !== (input.orderId === null)) {
    throw new N8nValidationError(
      'subject_id and order_id must be supplied together',
    );
  }
  if (input.subjectId && !EVENTS_THAT_OPEN_ORDERS.has(input.eventType)) {
    throw new N8nValidationError(
      'subject_id and order_id are only allowed on send reservation or handoff',
    );
  }
  if (input.subjectId && input.openOrder === true) {
    throw new N8nValidationError('open_order cannot target an existing order');
  }
  if (
    input.eventType === 'workflow.failed' &&
    input.failure?.phase !== undefined
  ) {
    if (
      input.failure.phase !== 'before_message_send' ||
      !input.commandId ||
      !input.conversationId ||
      Object.keys(input.failure).some(
        (key) => !['phase', 'code'].includes(key),
      ) ||
      ![
        'MEDIA_DOWNLOAD_FAILED',
        'MEDIA_INTEGRITY_MISMATCH',
        'MEDIA_UPLOAD_FAILED',
        'MEDIA_PREFLIGHT_REJECTED',
        'MEDIA_PREFLIGHT_UNAVAILABLE',
        'EVOLUTION_RECIPIENT_NOT_FOUND',
        'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
      ].includes(input.failure.code)
    )
      throw new N8nValidationError('Invalid before-message-send failure');
  }
  if (
    input.briefingPatch &&
    !['handoff.requested', 'message.send.requested'].includes(input.eventType)
  ) {
    throw new N8nValidationError(
      'briefing_patch is only allowed on send reservation or handoff',
    );
  }
  if (
    input.openOrder !== null &&
    !EVENTS_THAT_OPEN_ORDERS.has(input.eventType)
  ) {
    throw new N8nValidationError(
      'open_order is only allowed on send reservation or handoff',
    );
  }
  if (
    input.eventType === 'handoff.requested' &&
    (input.automationEpoch === null || input.sourceRevision === null)
  ) {
    throw new N8nValidationError(
      `${input.eventType} requires automation_epoch and source_revision`,
    );
  }
  if (input.eventType === 'message.send.requested') {
    if (
      !input.commandId ||
      !input.message ||
      input.automationEpoch === null ||
      input.sourceRevision === null
    ) {
      throw new N8nValidationError(
        'message.send.requested requires command_id, message, automation_epoch and source_revision',
      );
    }
  }
  if (input.eventType === 'handoff.requested' && !input.handoff) {
    throw new N8nValidationError('handoff.requested requires handoff');
  }
  // INBOX-HANDOFF-02: the seller the customer asked for by name. Only the
  // shape is checked here; the repository ignores (and audits) an id that is
  // not an active Vendedor instead of failing the handoff.
  if (
    input.handoff?.requested_seller_id !== undefined &&
    input.handoff.requested_seller_id !== null
  ) {
    identifier(
      input.handoff.requested_seller_id,
      'handoff.requested_seller_id',
      128,
    );
  }
  if (input.handoff?.notice !== undefined) {
    const notice = input.handoff.notice;
    if (!notice || typeof notice !== 'object' || Array.isArray(notice)) {
      throw new N8nValidationError('handoff.notice must be an object');
    }
    identifier(notice.command_id, 'handoff.notice.command_id', 512);
    if (
      typeof notice.text !== 'string' ||
      notice.text.trim().length < 1 ||
      notice.text.length > 4096
    ) {
      throw new N8nValidationError('handoff.notice.text is invalid');
    }
  }
  if (
    ['message.delivered', 'message.failed', 'message.read'].includes(
      input.eventType,
    ) &&
    !input.externalMessageId
  ) {
    throw new N8nValidationError(
      `${input.eventType} requires external_message_id`,
    );
  }
  if (
    input.eventType === 'message.sent' &&
    (!input.commandId || !input.externalMessageId)
  ) {
    throw new N8nValidationError(
      'message.sent requires command_id and external_message_id',
    );
  }
  if (
    input.eventType === 'message.transcribed' &&
    (!input.conversationId || !input.externalMessageId || !input.transcript)
  ) {
    throw new N8nValidationError(
      'message.transcribed requires conversation_id, external_message_id and transcript',
    );
  }
  if (input.eventType === 'message.send.unknown' && !input.commandId) {
    throw new N8nValidationError('message.send.unknown requires command_id');
  }
}

const TRANSCRIPT_FAILURE_CODES = [
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_EMPTY',
  'AUDIO_TOO_LARGE',
];

/**
 * INBOX-DELIVERY-02: `message.failed` and `message.send.unknown` carry only
 * `failure.code`. A code outside the bounded pattern never reaches storage:
 * it becomes the generic code of the event (`SEND_FAILED`, or
 * `SEND_OUTCOME_UNKNOWN` when the outcome is unknown). Other events keep the
 * previous contract.
 *
 * @param {unknown} value @param {string} eventType
 */
function normalizeFailure(value, eventType) {
  if (!value) return null;
  const failure = /** @type {Record<string, unknown>} */ (plainObject(value));
  if (!['message.failed', 'message.send.unknown'].includes(eventType)) {
    return failure;
  }
  if (Object.keys(failure).some((key) => key !== 'code')) {
    throw new N8nValidationError('failure only accepts code');
  }
  const fallback =
    eventType === 'message.failed' ? 'SEND_FAILED' : 'SEND_OUTCOME_UNKNOWN';
  return Object.freeze({
    code:
      typeof failure.code === 'string' &&
      /^[A-Z0-9_]{1,64}$/u.test(failure.code)
        ? failure.code
        : fallback,
  });
}

/**
 * INBOX-AUDIO-TRANSCRIPT-01: `{status: 'ok', text}` or
 * `{status: 'failed', code}`, nothing else.
 *
 * @param {unknown} value @param {string} eventType
 */
function normalizeTranscript(value, eventType) {
  if (value === undefined || value === null) return null;
  if (eventType !== 'message.transcribed') {
    throw new N8nValidationError(
      'transcript is only allowed on message.transcribed',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new N8nValidationError('transcript must be an object');
  }
  const transcript = /** @type {Record<string, unknown>} */ (value);
  if (transcript.status === 'ok') {
    if (
      Object.keys(transcript).some((key) => !['status', 'text'].includes(key))
    ) {
      throw new N8nValidationError('transcript ok only carries text');
    }
    const text = transcript.text;
    if (
      typeof text !== 'string' ||
      text.trim().length < 1 ||
      text.length > 4000
    ) {
      throw new N8nValidationError('transcript.text is invalid');
    }
    return Object.freeze({ code: null, status: 'ok', text });
  }
  if (transcript.status === 'failed') {
    if (
      Object.keys(transcript).some((key) => !['status', 'code'].includes(key))
    ) {
      throw new N8nValidationError('transcript failed only carries code');
    }
    if (
      typeof transcript.code !== 'string' ||
      !TRANSCRIPT_FAILURE_CODES.includes(transcript.code)
    ) {
      throw new N8nValidationError('transcript.code is unsupported');
    }
    return Object.freeze({
      code: transcript.code,
      status: 'failed',
      text: null,
    });
  }
  throw new N8nValidationError('transcript.status is unsupported');
}

const TURN_ANSWER_STATUSES = [
  'answered',
  'unclear',
  'undecided',
  'question',
  'deferred',
  'other',
  'none',
];
const TURN_MEDIA_KINDS = ['text', 'image', 'audio', 'sticker'];
const TURN_FIELDS = new Set([
  'answer_status',
  'asked_field',
  'ficha_filled',
  'ficha_total',
  'latency_ms',
  'media_kind',
  'model',
  'trigger',
]);

/**
 * AGENTE-OBS-01: the turn telemetry the workflow may attach to a reply or a
 * handoff. Strict: codes, counts and times only, never customer text. An
 * absent key reads as null; `ficha_filled` and `ficha_total` are required.
 *
 * @param {unknown} value @param {string} eventType
 */
function normalizeTurn(value, eventType) {
  if (value === undefined || value === null) return null;
  if (!['handoff.requested', 'message.send.requested'].includes(eventType)) {
    throw new N8nValidationError(
      'turn is only allowed on send reservation or handoff',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new N8nValidationError('turn must be an object');
  }
  const turn = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(turn).some((key) => !TURN_FIELDS.has(key))) {
    throw new N8nValidationError('turn has unknown fields');
  }
  /** @param {string} key @param {RegExp} pattern */
  const code = (key, pattern) => {
    const field = turn[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== 'string' || !pattern.test(field)) {
      throw new N8nValidationError(`turn.${key} is invalid`);
    }
    return field;
  };
  /** @param {string} key @param {string[]} allowed */
  const choice = (key, allowed) => {
    const field = turn[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== 'string' || !allowed.includes(field)) {
      throw new N8nValidationError(`turn.${key} is unsupported`);
    }
    return field;
  };
  /** @param {string} key @param {number} max */
  const count = (key, max) => {
    const field = turn[key];
    if (
      !Number.isSafeInteger(field) ||
      Number(field) < 0 ||
      Number(field) > max
    ) {
      throw new N8nValidationError(`turn.${key} is invalid`);
    }
    return Number(field);
  };
  const fichaFilled = count('ficha_filled', 64);
  const fichaTotal = count('ficha_total', 64);
  if (fichaFilled > fichaTotal) {
    throw new N8nValidationError('turn.ficha_filled exceeds ficha_total');
  }
  return Object.freeze({
    answerStatus: choice('answer_status', TURN_ANSWER_STATUSES),
    askedField: code('asked_field', /^[a-z_]{1,48}$/u),
    fichaFilled,
    fichaTotal,
    latencyMs:
      turn.latency_ms === undefined || turn.latency_ms === null
        ? null
        : count('latency_ms', 600_000),
    mediaKind: choice('media_kind', TURN_MEDIA_KINDS),
    model: code('model', /^[a-z0-9._-]{1,64}$/u),
    trigger: code('trigger', /^[a-z0-9_]{1,64}$/u),
  });
}

/** @param {unknown} contract @param {string} workflowVersion */
function requiresSubjectContract(contract, workflowVersion) {
  const version = /^(dev-)?mvp-simple-(\d+)$/u.exec(workflowVersion);
  return (
    contract === 'subject-v1' ||
    Boolean(version && Number(version[2]) >= (version[1] ? 16 : 15))
  );
}

/** @param {unknown} value */
function normalizeBriefingPatch(value) {
  if (value === null || value === undefined) return null;
  const patch = plainObject(value);
  for (const key of Object.keys(patch)) {
    if (!BRIEFING_PATCH_FIELDS.has(key)) {
      throw new N8nValidationError(`briefing_patch.${key} is not allowed`);
    }
  }
  return patch;
}

/** @param {any} value */
function normalizeTechnical(value) {
  if (!value || typeof value !== 'object') throw new N8nForbiddenError();
  const actorValue = value.actor;
  const actor =
    typeof actorValue === 'string'
      ? actorValue
      : (actorValue?.id ?? actorValue?.kind);
  if (actor !== 'AUTOMATION_EXECUTOR') throw new N8nForbiddenError();
  return Object.freeze({
    actor: 'AUTOMATION_EXECUTOR',
    correlationId: identifier(
      value.correlationId,
      'technical.correlationId',
      128,
    ),
    credentialVersion: identifier(
      String(value.credentialVersion),
      'technical.credentialVersion',
      64,
    ),
    executionId: identifier(value.executionId, 'technical.executionId', 256),
    idempotencyKey: identifier(
      value.idempotencyKey,
      'technical.idempotencyKey',
      512,
    ),
    requestId: identifier(value.requestId, 'technical.requestId', 128),
    workflowKey: identifier(value.workflowKey, 'technical.workflowKey', 128),
    workflowVersion: identifier(
      value.workflowVersion,
      'technical.workflowVersion',
      128,
    ),
  });
}

/** @param {any} message @param {string} type */
function normalizeMessageContent(message, type) {
  if (message?.content !== undefined) return plainObject(message.content);
  if (type === 'button' || type === 'interactive') {
    return {
      interaction: {
        payload: plainObject(message?.interaction ?? message?.button ?? {}),
        type,
      },
      text: typeof message?.text === 'string' ? message.text : '',
    };
  }
  if (type === 'text') {
    if (typeof message?.text !== 'string') {
      throw new N8nValidationError('message.text must be a string');
    }
    return { text: message.text };
  }
  const documentMime =
    type === 'document' && typeof message?.attachment?.mime_type === 'string'
      ? message.attachment.mime_type.split(';')[0].trim().toLowerCase()
      : null;
  return {
    attachmentId: identifier(
      message?.attachment?.external_id,
      'message.attachment.external_id',
      512,
    ),
    caption: typeof message?.text === 'string' ? message.text : null,
    // Metadata can announce missing bytes, never authorize a content read.
    ...(['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
      documentMime,
    )
      ? { mimeType: documentMime }
      : {}),
  };
}

/** @param {any} input */
function stripTechnical(input) {
  const payload = { ...input };
  delete payload.technical;
  return payload;
}

/** @param {unknown} value */
function requireSchema(value) {
  if (value !== '1.0') {
    throw new N8nValidationError('schema_version must be 1.0');
  }
}

/** @param {unknown} value @param {string[]} allowed @param {string} field */
function oneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new N8nValidationError(`${field} is unsupported`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} max */
function identifier(value, field, max) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new N8nValidationError(`${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {number} max */
function optionalString(value, max) {
  return value === null || value === undefined
    ? null
    : identifier(value, 'optional value', max);
}

/** @param {unknown} value */
function normalizeWhatsAppIdentity(value) {
  const identity = identifier(value, 'contact.external_id', 512);
  const compact = identity.startsWith('+') ? identity.slice(1) : identity;
  if (!/^[1-9][0-9]{7,14}$/u.test(compact)) {
    throw new N8nValidationError('contact.wa_id must be a valid E.164 number');
  }
  return `+${compact}`;
}

/** @param {unknown} value */
function normalizeSiteIdentity(value) {
  const identity = identifier(value, 'contact.external_id', 512);
  if (!/^999[0-9]{39}$/u.test(identity)) {
    throw new N8nValidationError('site_chat requires a synthetic 999 identity');
  }
  return identity;
}

/** @param {unknown} value */
function normalizeSiteContact(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new N8nValidationError('site_contact is invalid');
  }
  const details = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(details).some((key) => !['name', 'phone'].includes(key))) {
    throw new N8nValidationError('site_contact has unknown fields');
  }
  const name = typeof details.name === 'string' ? details.name.trim() : '';
  const phone = normalizeContactPhone(details.phone);
  if (
    !name ||
    name.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    !phone
  ) {
    throw new N8nValidationError('site_contact requires valid name and phone');
  }
  return { name, phone };
}

/** @param {unknown} value @param {string} field */
function instant(value, field) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new N8nValidationError(`${field} must be a canonical ISO instant`);
  }
  return value;
}

/**
 * Absent is null; a present flag must be a real boolean, so a template that
 * renders "true" as text is refused instead of silently opening nothing.
 *
 * @param {unknown} value @param {string} field
 * @returns {boolean|null}
 */
function optionalBoolean(value, field) {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new N8nValidationError(`${field} must be a boolean`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new N8nValidationError(`${field} must be a positive integer`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new N8nValidationError(`${field} must be a non-negative integer`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function sha256(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new N8nValidationError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/** @param {unknown} value */
function safeFilename(value) {
  const name = identifier(value, 'filename', 255);
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    throw new N8nValidationError('filename must not contain a path');
  }
  return name;
}

/** @param {unknown} value */
function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new N8nValidationError('Expected an object');
  }
  try {
    return structuredClone(value);
  } catch {
    throw new N8nValidationError('Object must be structured-cloneable');
  }
}

/** @param {() => Promise<any>} operation */
async function translateConflict(operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new N8nConflictError(
        'Idempotency key was reused with a different payload',
        'IDEMPOTENCY_CONFLICT',
      );
    }
    throw error;
  }
}
