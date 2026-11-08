import {
  ConversationReminderError,
  parseConversationReminderCommand,
  reminderIdempotencyKey,
} from './conversation-reminder-runtime.js';

const PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_REMINDER_DATE',
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'CONVERSATION_NOT_FOUND',
  'ACTION_NOT_AVAILABLE',
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

/** INBOX-VEZ-01 (RFC 052): personal reminder of the acting seller. No free
 * text exists in the body, the response, the audit or the logs.
 * @param {import('fastify').FastifyInstance} api @param {any} reminders
 * @param {(request:object)=>{correlationId:string}} contextFor
 */
export function registerConversationReminderRoutes(api, reminders, contextFor) {
  api.post(
    '/api/v1/conversations/:conversationId/reminder',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () => {
        const id = /** @type {any} */ (request.params)?.conversationId;
        if (typeof id !== 'string' || !id.trim())
          throw new ConversationReminderError(400, 'INVALID_REQUEST');
        const { actor } = await reminders.authorizeWrite({
          action: 'conversation.transition',
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          secFetchSite: request.headers['sec-fetch-site'],
          csrfToken: request.headers['x-csrf-token'],
        });
        parseConversationReminderCommand(request.body);
        const idempotencyKey = reminderIdempotencyKey(
          request.headers['idempotency-key'],
        );
        return reminders.set({
          actor,
          conversationId: id,
          body: request.body,
          idempotencyKey,
          correlationId: contextFor(request).correlationId,
        });
      }),
  );
}
