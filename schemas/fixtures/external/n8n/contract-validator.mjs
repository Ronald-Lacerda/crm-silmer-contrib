const commonEnvelopeKeys = Object.freeze(['schema_version']);
const inboundKeys = Object.freeze([
  ...commonEnvelopeKeys,
  'channel',
  'contact',
  'event_id',
  'external_conversation_id',
  'message',
  'metadata',
  'occurred_at',
  'provider',
  'site_contact',
]);
const attachmentKeys = Object.freeze([
  ...commonEnvelopeKeys,
  'content_sha256',
  'conversation_id',
  'external_id',
  'filename',
  'message_external_id',
  'mime_type',
  'size_bytes',
]);
const eventKeys = Object.freeze([
  ...commonEnvelopeKeys,
  'automation_epoch',
  'briefing_patch',
  'command_id',
  'conversation_id',
  'event_id',
  'event_type',
  'external_message_id',
  'failure',
  'handoff',
  'message',
  'occurred_at',
  'open_order',
  'order_id',
  'source_revision',
  'subject_id',
  'target_contract',
  // INBOX-AUDIO-TRANSCRIPT-01 and AGENTE-OBS-01.
  'transcript',
  'turn',
]);
const turnKeys = Object.freeze([
  'answer_status',
  'asked_field',
  'ficha_filled',
  'ficha_total',
  'latency_ms',
  'media_kind',
  'model',
  'trigger',
]);
const transcriptFailureCodes = Object.freeze([
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_EMPTY',
  'AUDIO_TOO_LARGE',
]);

export class ContractValidationError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'ContractValidationError';
    this.code = code;
  }
}

/** @param {any} contract */
export function validateContract(contract) {
  object(contract, 'INVALID_CONTRACT');
  if (contract.schemaVersion !== '1.0') fail('UNSUPPORTED_SCHEMA_VERSION');
  if (contract.authentication?.scheme !== 'Basic') {
    fail('UNSUPPORTED_AUTHENTICATION_SCHEME');
  }
  if (contract.errorMediaType !== 'application/problem+json') {
    fail('INVALID_ERROR_MEDIA_TYPE');
  }
  exactMembers(
    contract.channels,
    ['whatsapp', 'site_chat'],
    'INVALID_CHANNELS',
  );
  exactMembers(
    contract.activeChannels,
    ['site_chat'],
    'INVALID_ACTIVE_CHANNELS',
  );
  if (!Array.isArray(contract.endpoints) || contract.endpoints.length !== 3) {
    fail('INVALID_ENDPOINT_COUNT');
  }
  const routes = new Set();
  for (const endpoint of contract.endpoints) {
    if (endpoint.method !== 'POST' || !opaque(endpoint.path)) {
      fail('INVALID_ENDPOINT');
    }
    const route = `${endpoint.method} ${endpoint.path}`;
    if (routes.has(route)) fail('DUPLICATE_ENDPOINT');
    routes.add(route);
  }
  for (const required of [
    'authorization',
    'idempotency-key',
    'x-correlation-id',
    'x-silmer-workflow-key',
    'x-silmer-workflow-version',
    'x-silmer-execution-id',
  ]) {
    if (!contract.requiredHeaders?.includes(required)) {
      fail('MISSING_REQUIRED_HEADER');
    }
  }
  if (!contract.eventTypes?.includes('message.send.requested')) {
    fail('MISSING_SEND_FENCE_EVENT');
  }
  // ADR 014: only the events that carry the turn's briefing open the order.
  if (
    !Array.isArray(contract.openOrderEvents) ||
    contract.openOrderEvents.some(
      (/** @type {string} */ eventType) =>
        !['handoff.requested', 'message.send.requested'].includes(eventType) ||
        !contract.eventTypes.includes(eventType),
    )
  ) {
    fail('INVALID_OPEN_ORDER_EVENTS');
  }
  return true;
}

/** @param {any} headers @param {any} contract @param {any} [payload] */
export function validateHeaders(headers, contract, payload) {
  object(headers, 'INVALID_HEADERS');
  for (const header of contract.requiredHeaders) {
    nonEmpty(headers[header], 'MISSING_REQUIRED_HEADER');
  }
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(headers.authorization)) {
    fail('INVALID_AUTOMATION_CREDENTIALS');
  }
  if (
    payload !== undefined &&
    headers['x-correlation-id'] !== payload.correlation_id
  ) {
    fail('CORRELATION_ID_MISMATCH');
  }
  return true;
}

/** @param {any} payload @param {any} contract */
export function validateInbound(payload, contract) {
  object(payload, 'INVALID_INBOUND');
  rejectUnknown(payload, inboundKeys);
  common(payload);
  if (!contract.channels.includes(payload.channel)) fail('UNSUPPORTED_CHANNEL');
  for (const field of ['event_id', 'occurred_at']) {
    nonEmpty(payload[field], 'INVALID_INBOUND');
  }
  object(payload.contact, 'INVALID_CONTACT');
  rejectUnknown(payload.contact, ['display_name', 'external_id']);
  nonEmpty(payload.contact.external_id, 'INVALID_CONTACT');
  if (payload.channel === 'site_chat') {
    if (!/^999[0-9]{39}$/u.test(payload.contact.external_id)) {
      fail('INVALID_SITE_IDENTITY');
    }
    if (payload.provider !== undefined && payload.provider !== 'site') {
      fail('INVALID_SITE_PROVIDER');
    }
    if (payload.site_contact !== undefined) {
      object(payload.site_contact, 'INVALID_SITE_CONTACT');
      rejectUnknown(payload.site_contact, ['name', 'phone']);
      nonEmpty(payload.site_contact.name, 'INVALID_SITE_CONTACT');
      nonEmpty(payload.site_contact.phone, 'INVALID_SITE_CONTACT');
    }
  } else if (payload.site_contact !== undefined) {
    fail('INVALID_SITE_CONTACT');
  }
  object(payload.message, 'INVALID_MESSAGE');
  rejectUnknown(payload.message, [
    'attachment',
    'external_id',
    'reply_to',
    'text',
    'type',
  ]);
  nonEmpty(payload.message.external_id, 'INVALID_MESSAGE');
  nonEmpty(payload.message.type, 'INVALID_MESSAGE');
  object(payload.metadata, 'INVALID_INBOUND_METADATA');
  rejectUnknown(payload.metadata, ['provider_account_id']);
  nonEmpty(payload.metadata.provider_account_id, 'INVALID_INBOUND_METADATA');
  return true;
}

/** @param {any} payload @param {any} contract */
export function assertChannelActive(payload, contract) {
  if (!contract.activeChannels.includes(payload.channel)) {
    fail('CHANNEL_NOT_ACTIVE');
  }
  return true;
}

/** @param {any} payload */
export function validateAttachmentMetadata(payload) {
  object(payload, 'INVALID_ATTACHMENT');
  rejectUnknown(payload, attachmentKeys);
  common(payload);
  for (const field of [
    'content_sha256',
    'conversation_id',
    'external_id',
    'filename',
    'message_external_id',
    'mime_type',
  ]) {
    nonEmpty(payload[field], 'INVALID_ATTACHMENT');
  }
  if (!/^[0-9a-f]{64}$/u.test(payload.content_sha256)) {
    fail('INVALID_CONTENT_SHA256');
  }
  if (!Number.isSafeInteger(payload.size_bytes) || payload.size_bytes < 0) {
    fail('INVALID_ATTACHMENT_SIZE');
  }
  if (
    payload.filename.includes('/') ||
    payload.filename.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(payload.filename)
  ) {
    fail('UNSAFE_FILENAME');
  }
  return true;
}

/** @param {any} payload @param {any} contract */
export function validateEvent(payload, contract) {
  object(payload, 'INVALID_EVENT');
  rejectUnknown(payload, eventKeys);
  common(payload);
  for (const field of ['event_id', 'event_type', 'occurred_at']) {
    nonEmpty(payload[field], 'INVALID_EVENT');
  }
  if (!contract.eventTypes.includes(payload.event_type)) {
    fail('UNSUPPORTED_EVENT_TYPE');
  }
  if (payload.event_type !== 'workflow.failed') {
    nonEmpty(payload.conversation_id, 'INVALID_EVENT');
  }
  if (payload.event_type === 'message.send.requested') {
    nonEmpty(payload.command_id, 'INVALID_SEND_FENCE');
    epoch(payload.automation_epoch);
    positive(payload.source_revision, 'INVALID_SEND_FENCE');
    object(payload.message, 'INVALID_SEND_FENCE');
  }
  if (payload.event_type === 'handoff.requested') {
    epoch(payload.automation_epoch);
    positive(payload.source_revision, 'INVALID_HANDOFF_FENCE');
    object(payload.handoff, 'INVALID_HANDOFF');
    if (
      payload.handoff.reason !== undefined &&
      Array.isArray(contract.handoffReasons) &&
      !contract.handoffReasons.includes(payload.handoff.reason)
    ) {
      fail('INVALID_HANDOFF_REASON');
    }
    // INBOX-HANDOFF-02: an id from `sellers[]`; the CRM ignores any other.
    if (
      payload.handoff.requested_seller_id !== undefined &&
      payload.handoff.requested_seller_id !== null
    ) {
      nonEmpty(payload.handoff.requested_seller_id, 'INVALID_HANDOFF');
    }
    if (payload.handoff.notice !== undefined) {
      object(payload.handoff.notice, 'INVALID_HANDOFF_NOTICE');
      nonEmpty(payload.handoff.notice.command_id, 'INVALID_HANDOFF_NOTICE');
      nonEmpty(payload.handoff.notice.text, 'INVALID_HANDOFF_NOTICE');
    }
  }
  if (payload.event_type === 'message.sent') {
    nonEmpty(payload.command_id, 'INVALID_MESSAGE_STATUS');
    nonEmpty(payload.external_message_id, 'INVALID_MESSAGE_STATUS');
  }
  if (payload.event_type === 'message.send.unknown') {
    nonEmpty(payload.command_id, 'INVALID_MESSAGE_STATUS');
  }
  if (
    ['message.delivered', 'message.failed', 'message.read'].includes(
      payload.event_type,
    )
  ) {
    nonEmpty(payload.external_message_id, 'INVALID_MESSAGE_STATUS');
  }
  if (
    ['message.failed', 'message.send.unknown'].includes(payload.event_type) &&
    payload.failure !== undefined
  ) {
    // INBOX-DELIVERY-02: only the code.
    object(payload.failure, 'INVALID_FAILURE');
    rejectUnknown(payload.failure, ['code']);
  }
  if (payload.event_type === 'message.transcribed') {
    nonEmpty(payload.external_message_id, 'INVALID_TRANSCRIPT');
    validateTranscript(payload.transcript);
  } else if (payload.transcript !== undefined) {
    fail('INVALID_TRANSCRIPT_EVENT');
  }
  if (payload.turn !== undefined && payload.turn !== null) {
    if (
      !['handoff.requested', 'message.send.requested'].includes(
        payload.event_type,
      )
    ) {
      fail('INVALID_TURN_EVENT');
    }
    validateTurn(payload.turn);
  }
  if (payload.open_order !== undefined) {
    if (typeof payload.open_order !== 'boolean') fail('INVALID_OPEN_ORDER');
    if (!contract.openOrderEvents.includes(payload.event_type)) {
      fail('INVALID_OPEN_ORDER_EVENT');
    }
  }
  if (Boolean(payload.subject_id) !== Boolean(payload.order_id)) {
    fail('INVALID_SUBJECT_TARGET');
  }
  if (
    payload.target_contract !== undefined &&
    payload.target_contract !== 'subject-v1'
  ) {
    fail('INVALID_SUBJECT_CONTRACT');
  }
  if (
    payload.target_contract === 'subject-v1' &&
    payload.briefing_patch !== undefined &&
    payload.subject_id === undefined &&
    payload.open_order !== true
  ) {
    fail('INVALID_SUBJECT_TARGET');
  }
  if (payload.subject_id !== undefined) {
    nonEmpty(payload.subject_id, 'INVALID_SUBJECT_TARGET');
    nonEmpty(payload.order_id, 'INVALID_SUBJECT_TARGET');
    if (
      !['message.send.requested', 'handoff.requested'].includes(
        payload.event_type,
      ) ||
      payload.open_order === true
    ) {
      fail('INVALID_SUBJECT_TARGET');
    }
  }
  if (payload.briefing_patch !== undefined) {
    if (
      !['handoff.requested', 'message.send.requested'].includes(
        payload.event_type,
      )
    ) {
      fail('INVALID_BRIEFING_PATCH_EVENT');
    }
    validateBriefingPatch(payload.briefing_patch, contract);
  }
  return true;
}

/**
 * AGENTE-OBS-01: codes, counts and times only.
 * @param {any} turn
 */
export function validateTurn(turn) {
  object(turn, 'INVALID_TURN');
  rejectUnknown(turn, turnKeys);
  /** @param {string} key @param {RegExp} pattern */
  const code = (key, pattern) => {
    const value = turn[key];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !pattern.test(value)) {
        fail('INVALID_TURN');
      }
    }
  };
  code('asked_field', /^[a-z_]{1,48}$/u);
  code('trigger', /^[a-z0-9_]{1,64}$/u);
  code('model', /^[a-z0-9._-]{1,64}$/u);
  code(
    'answer_status',
    /^(?:answered|unclear|undecided|question|deferred|other|none)$/u,
  );
  code('media_kind', /^(?:text|image|audio|sticker)$/u);
  for (const key of ['ficha_filled', 'ficha_total']) {
    if (!Number.isSafeInteger(turn[key]) || turn[key] < 0 || turn[key] > 64) {
      fail('INVALID_TURN');
    }
  }
  if (turn.ficha_filled > turn.ficha_total) fail('INVALID_TURN');
  if (
    turn.latency_ms !== undefined &&
    turn.latency_ms !== null &&
    (!Number.isSafeInteger(turn.latency_ms) ||
      turn.latency_ms < 0 ||
      turn.latency_ms > 600_000)
  ) {
    fail('INVALID_TURN');
  }
  return true;
}

/**
 * INBOX-AUDIO-TRANSCRIPT-01: `{status: 'ok', text}` or
 * `{status: 'failed', code}`.
 * @param {any} transcript
 */
export function validateTranscript(transcript) {
  object(transcript, 'INVALID_TRANSCRIPT');
  if (transcript.status === 'ok') {
    rejectUnknown(transcript, ['status', 'text']);
    if (
      typeof transcript.text !== 'string' ||
      transcript.text.trim() === '' ||
      transcript.text.length > 4000
    ) {
      fail('INVALID_TRANSCRIPT');
    }
    return true;
  }
  if (transcript.status === 'failed') {
    rejectUnknown(transcript, ['status', 'code']);
    if (!transcriptFailureCodes.includes(transcript.code)) {
      fail('INVALID_TRANSCRIPT');
    }
    return true;
  }
  return fail('INVALID_TRANSCRIPT');
}

/** @param {any} patch @param {any} contract */
export function validateBriefingPatch(patch, contract) {
  object(patch, 'INVALID_BRIEFING_PATCH');
  rejectUnknown(patch, contract.briefingPatchFields);
  return true;
}

/**
 * ADR 014: the `order` field of an event response that asked `open_order`.
 * @param {any} order
 */
export function validateOrderOpening(order) {
  object(order, 'INVALID_ORDER_OPENING');
  if (order.opened === true) {
    rejectUnknown(order, ['created', 'id', 'subject_id', 'opened']);
    nonEmpty(order.id, 'INVALID_ORDER_OPENING');
    nonEmpty(order.subject_id, 'INVALID_ORDER_OPENING');
    if (typeof order.created !== 'boolean') fail('INVALID_ORDER_OPENING');
    return true;
  }
  if (order.opened !== false) fail('INVALID_ORDER_OPENING');
  rejectUnknown(order, ['error', 'opened']);
  if (
    typeof order.error !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/u.test(order.error)
  ) {
    fail('INVALID_ORDER_OPENING');
  }
  return true;
}

/** @param {any} problem */
export function validateProblem(problem) {
  object(problem, 'INVALID_PROBLEM');
  rejectUnknown(problem, [
    'accepted',
    'correlation_id',
    'detail',
    'error',
    'instance',
    'request_id',
    'status',
    'title',
    'type',
  ]);
  for (const field of ['detail', 'instance', 'request_id', 'title', 'type']) {
    nonEmpty(problem[field], 'INVALID_PROBLEM');
  }
  if (problem.accepted !== false) fail('INVALID_PROBLEM');
  object(problem.error, 'INVALID_PROBLEM');
  rejectUnknown(problem.error, ['code']);
  nonEmpty(problem.error.code, 'INVALID_PROBLEM');
  if (!Number.isSafeInteger(problem.status) || problem.status < 400) {
    fail('INVALID_PROBLEM');
  }
  return true;
}

/** @param {any} payload */
function common(payload) {
  if (payload.schema_version !== '1.0') fail('UNSUPPORTED_SCHEMA_VERSION');
}

/** @param {any} value */
function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_AUTOMATION_EPOCH');
  }
}

/** @param {any} value @param {string} code */
function positive(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed */
function rejectUnknown(value, allowed) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`UNKNOWN_FIELD:${key}`);
  }
}

/** @param {any} actual @param {readonly any[]} expected @param {string} code */
function exactMembers(actual, expected, code) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(code);
  }
}

/** @param {any} value @param {string} code */
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

/** @param {any} value @param {string} code */
function nonEmpty(value, code) {
  if (!opaque(value)) fail(code);
}

/** @param {any} value */
function opaque(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** @param {string} code @returns {never} */
function fail(code) {
  throw new ContractValidationError(code);
}
