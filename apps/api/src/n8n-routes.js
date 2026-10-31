import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const N8N_SCHEMA_VERSION = '1.0';

const EVENT_ACTIONS = Object.freeze({
  'handoff.requested': 'handoff.create',
  'message.delivered': 'integration.n8n.event.create',
  'message.failed': 'integration.n8n.event.create',
  'message.read': 'integration.n8n.event.create',
  'message.send.requested': 'integration.n8n.event.create',
  'message.send.unknown': 'integration.n8n.event.create',
  'message.sent': 'integration.n8n.event.create',
  // INBOX-AUDIO-TRANSCRIPT-01: the transcript of an inbound audio.
  'message.transcribed': 'integration.n8n.event.create',
  // Deprecated by ADR 014: workflows from mvp-simple-11 on send `open_order`
  // on the reservation or the handoff. Kept for older workflows.
  'order.intent_confirmed': 'order.intent',
  'workflow.failed': 'integration.n8n.event.create',
});

export class N8nRouteError extends Error {
  /** @param {number} statusCode @param {string} code */
  constructor(statusCode, code) {
    super(code);
    this.name = 'N8nRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Registers the compatibility boundary used by the versioned n8n workflow.
 * The injected service owns domain translation and transactions; this layer
 * owns transport validation, technical authentication and safe errors.
 *
 * @param {import('fastify').FastifyInstance} api
 * @param {{
 *   receiveInbound(input: Record<string, unknown>): Promise<Record<string, unknown>>,
 *   storeAttachment(input: Record<string, unknown>): Promise<Record<string, unknown>>,
 *   recordEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>,
 *   recordOrderIntent(input: Record<string, unknown>): Promise<Record<string, unknown>>,
 * }} integration
 * @param {(request: import('fastify').FastifyRequest) => {correlationId: string, requestId: string}} contextFor
 */
export function registerN8nRoutes(api, integration, contextFor) {
  assertIntegration(integration);

  api.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fieldNameSize: 64,
        fieldSize: 512,
        fields: 4,
        fileSize: MAX_ATTACHMENT_BYTES,
        files: 1,
        parts: 5,
      },
    });

    scope.setErrorHandler((error, request, reply) => {
      return sendProblem(reply, request, contextFor, error);
    });

    scope.post(
      '/api/v1/integrations/n8n/messages/inbound',
      { bodyLimit: JSON_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const body = requireObject(request.body);
        rejectUnknownKeys(body, [
          'channel',
          'contact',
          'event_id',
          'external_conversation_id',
          'message',
          'metadata',
          'occurred_at',
          'provider',
          'schema_version',
          'site_contact',
        ]);
        requireSchemaVersion(body.schema_version);
        const technical = await authorizeRequest(
          request,
          contextFor,
          'integration.n8n.message.create',
        );
        const result = await integration.receiveInbound({
          ...body,
          technical,
        });
        return reply.code(200).send(result);
      },
    );

    scope.post(
      '/api/v1/integrations/n8n/conversations/:conversationId/attachments',
      async (request, reply) => {
        const technical = await authorizeRequest(
          request,
          contextFor,
          'integration.n8n.attachment.create',
        );
        const params = requireObject(request.params);
        const conversationId = requireIdentifier(
          params.conversationId,
          'INVALID_CONVERSATION_ID',
        );
        const contentSha256 = requireSha256(
          request.headers['x-silmer-content-sha256'],
        );
        const saved = await request.saveRequestFiles();
        const files = saved.files;
        if (files.length !== 1) {
          throw new N8nRouteError(400, 'INVALID_ATTACHMENT_COUNT');
        }
        const upload = files[0];
        const fields = normalizeMultipartFields(saved.values);
        requireSchemaVersion(fields.schema_version);
        const externalId = requireIdentifier(
          fields.external_id,
          'INVALID_EXTERNAL_ID',
        );
        const filename = sanitizeFilename(fields.filename ?? upload.filename);
        const mimeType = requireText(
          fields.mime_type ?? upload.mimetype,
          'INVALID_MIME_TYPE',
          255,
        );
        const size = (await stat(upload.filepath)).size;
        if (size > attachmentLimitFor(mimeType)) {
          throw new N8nRouteError(413, 'ATTACHMENT_TOO_LARGE');
        }
        const result = await integration.storeAttachment({
          contentSha256,
          conversationId,
          externalId,
          filename,
          mimeType,
          size,
          stream: createReadStream(upload.filepath),
          technical,
        });
        return reply.code(result.duplicate ? 200 : 201).send(result);
      },
    );

    scope.post(
      '/api/v1/integrations/n8n/events',
      { bodyLimit: JSON_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const body = requireObject(request.body);
        rejectUnknownKeys(body, [
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
          'schema_version',
          'source_revision',
          'subject_id',
          'target_contract',
          'transcript',
          // AGENTE-OBS-01: optional turn telemetry (codes and counts only).
          'turn',
        ]);
        requireSchemaVersion(body.schema_version);
        const eventType = requireIdentifier(
          body.event_type,
          'INVALID_EVENT_TYPE',
        );
        const action = /** @type {Record<string, string>} */ (EVENT_ACTIONS)[
          eventType
        ];
        if (!action) throw new N8nRouteError(422, 'UNSUPPORTED_EVENT_TYPE');
        const technical = await authorizeRequest(request, contextFor, action);
        const result =
          action === 'order.intent'
            ? await integration.recordOrderIntent({ ...body, technical })
            : await integration.recordEvent({ ...body, technical });
        return reply.code(200).send(result);
      },
    );
  });
}

/**
 * The technical envelope every n8n route checks: `Idempotency-Key`,
 * `X-Correlation-Id` equal to the request's correlation, the workflow
 * identity and the Basic credential of the `AUTOMATION_EXECUTOR` for
 * `action`. Shared with the site shop's route (ADR 028).
 *
 * @param {import('fastify').FastifyRequest} request @param {Function} contextFor @param {string} action
 */
export async function authorizeRequest(request, contextFor, action) {
  const context = contextFor(request);
  const idempotencyKey = requireHeader(request, 'idempotency-key', 255);
  const correlationHeader = requireHeader(request, 'x-correlation-id', 128);
  if (correlationHeader !== context.correlationId) {
    throw new N8nRouteError(400, 'INVALID_CORRELATION_ID');
  }
  const workflowKey = requireHeader(request, 'x-silmer-workflow-key', 128);
  const workflowVersion = requireHeader(
    request,
    'x-silmer-workflow-version',
    64,
  );
  const executionId = requireHeader(request, 'x-silmer-execution-id', 128);
  const automationAuth = /** @type {any} */ (request.server).automationAuth;
  if (!automationAuth) {
    throw new N8nRouteError(503, 'AUTOMATION_AUTH_UNAVAILABLE');
  }
  const principal = await automationAuth.authorize({
    action,
    authorization: request.headers.authorization,
    correlationId: context.correlationId,
  });
  return Object.freeze({
    actor: principal.actor,
    correlationId: context.correlationId,
    credentialVersion: principal.credentialVersion,
    executionId,
    idempotencyKey,
    requestId: context.requestId,
    workflowKey,
    workflowVersion,
  });
}

/** @param {import('fastify').FastifyRequest} request @param {string} name @param {number} max */
function requireHeader(request, name, max) {
  return requireText(
    request.headers[name],
    `INVALID_${name.toUpperCase().replaceAll('-', '_')}`,
    max,
  );
}

/** @param {unknown} value */
function requireSchemaVersion(value) {
  if (value !== N8N_SCHEMA_VERSION) {
    throw new N8nRouteError(400, 'UNSUPPORTED_SCHEMA_VERSION');
  }
}

/** @param {unknown} value @param {string} code */
function requireIdentifier(value, code) {
  const normalized = requireText(value, code, 255);
  if (/[^\x21-\x7e]/u.test(normalized)) {
    throw new N8nRouteError(400, code);
  }
  return normalized;
}

/** @param {unknown} value */
function requireSha256(value) {
  const normalized = requireText(value, 'INVALID_CONTENT_SHA256', 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new N8nRouteError(400, 'INVALID_CONTENT_SHA256');
  }
  return normalized;
}

/** @param {unknown} value @param {string} code @param {number} max */
function requireText(value, code, max) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new N8nRouteError(400, code);
  }
  return value;
}

/** @param {unknown} value */
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new N8nRouteError(400, 'INVALID_REQUEST');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function rejectUnknownKeys(value, allowed) {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new N8nRouteError(400, 'UNKNOWN_REQUEST_FIELD');
  }
}

/** @param {Record<string, any>} fields */
function normalizeMultipartFields(fields) {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([name, field]) => [
      name,
      Array.isArray(field) ? field[0]?.value : field?.value,
    ]),
  );
}

/** @param {unknown} value */
function sanitizeFilename(value) {
  const supplied = requireText(value, 'INVALID_FILENAME', 1_024);
  const leaf = supplied.split(/[\\/]/u).at(-1) ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new N8nRouteError(400, 'INVALID_FILENAME');
  }
  return cleaned.slice(0, 255);
}

/** @param {string} mimeType */
function attachmentLimitFor(mimeType) {
  if (mimeType.startsWith('image/')) return 5 * 1024 * 1024;
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 16 * 1024 * 1024;
  }
  return MAX_ATTACHMENT_BYTES;
}

/**
 * The closed `application/problem+json` answer of the n8n routes, without
 * echoing input. Shared with the site shop's route (ADR 028).
 *
 * @param {import('fastify').FastifyReply} reply @param {import('fastify').FastifyRequest} request @param {Function} contextFor @param {any} error
 */
export function sendProblem(reply, request, contextFor, error) {
  const context = contextFor(request);
  const statusCode = normalizeStatusCode(error);
  const code = normalizeProblemCode(error, statusCode);
  if (statusCode === 401) {
    reply.header('www-authenticate', 'Basic realm="crm-silmer-n8n"');
  }
  if (statusCode === 429 || statusCode === 503) {
    reply.header('retry-after', '1');
  }
  return reply
    .code(statusCode)
    .type('application/problem+json')
    .send({
      accepted: false,
      detail: problemTitle(statusCode),
      error: { code },
      instance: request.url,
      request_id: context.requestId,
      status: statusCode,
      title: problemTitle(statusCode),
      type: `urn:silmer:problem:${code.toLowerCase()}`,
    });
}

/** @param {any} error */
function normalizeStatusCode(error) {
  if (error?.code === 'FST_REQ_FILE_TOO_LARGE') return 413;
  if (error?.code === 'FST_FILES_LIMIT') return 400;
  if (error?.code === 'FST_FIELDS_LIMIT') return 400;
  if (error?.code === 'FST_PARTS_LIMIT') return 400;
  const statusCode = Number(error?.statusCode);
  return statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
}

/** @param {any} error @param {number} statusCode */
function normalizeProblemCode(error, statusCode) {
  const supplied = typeof error?.code === 'string' ? error.code : '';
  if (/^[A-Z][A-Z0-9_]{2,80}$/u.test(supplied)) return supplied;
  if (statusCode === 413) return 'ATTACHMENT_TOO_LARGE';
  return statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST';
}

/** @param {number} statusCode */
function problemTitle(statusCode) {
  if (statusCode === 400) return 'Invalid integration request';
  if (statusCode === 401) return 'Authentication required';
  if (statusCode === 403) return 'Integration action forbidden';
  if (statusCode === 404) return 'Integration resource not found';
  if (statusCode === 409) return 'Integration state conflict';
  if (statusCode === 413) return 'Attachment is too large';
  if (statusCode === 415) return 'Unsupported media type';
  if (statusCode === 422) return 'Integration request cannot be applied';
  if (statusCode === 429) return 'Integration rate limit exceeded';
  return 'Integration service unavailable';
}

/** @param {any} integration */
function assertIntegration(integration) {
  for (const method of [
    'receiveInbound',
    'recordEvent',
    'recordOrderIntent',
    'storeAttachment',
  ]) {
    if (!integration || typeof integration[method] !== 'function') {
      throw new TypeError(`n8n integration must implement ${method}`);
    }
  }
}
