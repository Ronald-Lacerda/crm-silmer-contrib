import { DashboardError } from './dashboard-runtime.js';

const PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_FILTER',
  'FORBIDDEN',
  'INVALID_CREDENTIALS',
]);

/** Metric reads are heavier than the action queue; bound them per client. */
const READ_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

/** Strict `?days=7|30`: any other key (actorId, userId, scope) or value is
 * refused instead of trusting the browser (PERF-07).
 * @param {unknown} value
 */
function period(value) {
  const query = value ?? {};
  if (
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).some((key) => key !== 'days')
  )
    throw new DashboardError(400, 'INVALID_REQUEST');
  const days = /** @type {Record<string, unknown>} */ (query).days;
  if (days !== undefined && days !== '7' && days !== '30')
    throw new DashboardError(400, 'INVALID_FILTER');
  return Number(days ?? 7);
}

/** @param {any} request @param {any} metrics */
async function reader(request, metrics) {
  return metrics.authorizeRead({
    action: 'conversation.read',
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    secFetchSite: request.headers['sec-fetch-site'],
  });
}

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

/** RFC 048 metric reads. `metrics/losses` and `metrics/presence` join this
 * file with the same period, scope and error contract.
 * @param {import('fastify').FastifyInstance} api @param {any} metrics
 */
export function registerDashboardMetricsRoutes(api, metrics) {
  api.get(
    '/api/v1/dashboard/metrics/service',
    { config: READ_LIMIT },
    (request, reply) =>
      respond(reply, async () => {
        const days = period(request.query);
        const { actor } = await reader(request, metrics);
        return metrics.service({ actor, days });
      }),
  );
}
