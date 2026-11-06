import {
  leadIdempotencyKey,
  LeadOutcomeError,
  parseLeadOutcomeCommand,
} from './lead-outcome-runtime.js';

const PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_LOSS_REASON',
  'INVALID_LOSS_NOTE',
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'CONVERSATION_NOT_FOUND',
  'LEAD_NOT_ELIGIBLE',
  'LEAD_HAS_ORDER',
  'LEAD_AWAITING_REPLY',
  'LEAD_ALREADY_LOST',
  'LEAD_NOT_LOST',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
]);

/** @param {any} reply @param {()=>Promise<unknown>} work */
async function respond(reply, work) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Origin, Cookie');
  try {
    return reply.send(await work());
  } catch (error) {
    const candidate = /** @type {{statusCode?:number,code?:string}} */ (error);
    const status =
      candidate.statusCode &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 500
        ? candidate.statusCode
        : 503;
    const code =
      status === 503
        ? 'SERVICE_UNAVAILABLE'
        : PUBLIC_CODES.has(candidate.code ?? '')
          ? candidate.code
          : 'INVALID_REQUEST';
    return reply.code(status).type('application/problem+json').send({
      type: 'about:blank',
      title: code,
      status,
      code,
    });
  }
}

/** @param {any} request */
function conversationId(request) {
  const value = /** @type {any} */ (request.params)?.conversationId;
  if (typeof value !== 'string' || !value.trim())
    throw new LeadOutcomeError(400, 'INVALID_REQUEST');
  return value;
}

/** MET-06–08 (RFC 048 / ADR 061): declared lead loss of a conversation. The
 * free-text note never reaches logs, the POST response or the audit; only
 * the GET detail returns it, to the owner or an administrator.
 * @param {import('fastify').FastifyInstance} api @param {any} leadOutcomes
 * @param {(request:object)=>{correlationId:string}} contextFor
 */
export function registerLeadOutcomeRoutes(api, leadOutcomes, contextFor) {
  api.get(
    '/api/v1/conversations/:conversationId/lead-outcome',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () => {
        const id = conversationId(request);
        const query = /** @type {any} */ (request.query) ?? {};
        if (Object.keys(query).length)
          throw new LeadOutcomeError(400, 'INVALID_REQUEST');
        const { actor } = await leadOutcomes.authorizeRead({
          action: 'conversation.read',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          secFetchSite: request.headers['sec-fetch-site'],
        });
        return leadOutcomes.detail({ actor, conversationId: id });
      }),
  );
  api.post(
    '/api/v1/conversations/:conversationId/lead-outcome',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () => {
        const id = conversationId(request);
        const { actor } = await leadOutcomes.authorizeWrite({
          action: 'conversation.transition',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          secFetchSite: request.headers['sec-fetch-site'],
          csrfToken: request.headers['x-csrf-token'],
        });
        // Validated here for an early, uniform answer; the runtime validates
        // again before touching the database.
        parseLeadOutcomeCommand(request.body);
        const idempotencyKey = leadIdempotencyKey(
          request.headers['idempotency-key'],
        );
        return leadOutcomes.record({
          actor,
          conversationId: id,
          body: request.body,
          idempotencyKey,
          correlationId: contextFor(request).correlationId,
        });
      }),
  );
}
