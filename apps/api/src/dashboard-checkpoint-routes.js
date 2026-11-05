import { CheckpointError } from './dashboard-checkpoint-runtime.js';

const PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_AUTOMATION_CREDENTIALS',
  'FORBIDDEN_AUTOMATION_ACTION',
  'CHECKPOINT_DISABLED',
  'CHECKPOINT_NOT_CONFIGURED',
  'CHECKPOINT_NOT_FOUND',
  'CHECKPOINT_RECIPIENT_CHANGED',
  'CHECKPOINT_RESULT_CONFLICT',
  'CHECKPOINT_REPORT_TOO_LARGE',
  'INVALID_CHECKPOINT_DAY',
]);

/** @param {unknown} value @param {string[]} allowed */
function object(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new CheckpointError(400, 'INVALID_REQUEST');
  return /** @type {Record<string,any>} */ (value);
}

/** @param {any} reply @param {()=>Promise<unknown>} work */
async function respond(reply, work) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Origin, Cookie, Authorization');
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
    return reply
      .code(status)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: code, status, code });
  }
}

/** @param {any} request @param {any} api @param {string} correlationId */
async function technical(request, api, correlationId) {
  if (!api.automationAuth?.authorize)
    throw new CheckpointError(503, 'CHECKPOINT_NOT_CONFIGURED');
  return api.automationAuth.authorize({
    action: 'dashboard.checkpoint.execute',
    authorization: request.headers.authorization,
    correlationId,
  });
}

/** @param {import('fastify').FastifyInstance} api @param {any} checkpoint @param {(request:object)=>{correlationId:string}} contextFor */
export function registerDashboardCheckpointRoutes(api, checkpoint, contextFor) {
  api.get('/api/v1/dashboard/checkpoint', (request, reply) =>
    respond(reply, async () => {
      const query = object(request.query ?? {}, ['day']);
      const { actor } = await checkpoint.authorizeRead({
        action: 'assistant.performance.read',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        secFetchSite: request.headers['sec-fetch-site'],
      });
      return checkpoint.preview({ actor, day: query.day });
    }),
  );
  for (const action of /** @type {const} */ ([
    'prepare',
    'reserve',
    'complete',
  ])) {
    api.post(
      '/api/v1/integrations/n8n/dashboard/checkpoint/' + action,
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      (request, reply) =>
        respond(reply, async () => {
          object(request.query ?? {}, []);
          const allowed =
            action === 'prepare'
              ? ['day']
              : action === 'reserve'
                ? ['checkpointId', 'recipientId']
                : [
                    'checkpointId',
                    'recipientId',
                    'reservationId',
                    'status',
                    'code',
                    'providerMessageId',
                    'reconciled',
                  ];
          const body = object(request.body ?? {}, allowed);
          const correlationId = contextFor(request).correlationId;
          const access = await technical(
            request,
            /** @type {any} */ (api),
            correlationId,
          );
          return checkpoint[action]({
            ...body,
            technical: access,
            correlationId,
          });
        }),
    );
  }
}
