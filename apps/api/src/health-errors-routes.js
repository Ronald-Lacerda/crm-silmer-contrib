import { normalizeTraceId } from '@crm-silmer/shared';

/** @param {any} request */
function headers(request) {
  return {
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    csrfToken: request.headers['x-csrf-token'],
    origin: request.headers.origin,
    secFetchSite: request.headers['sec-fetch-site'],
    correlationId: normalizeTraceId(request.headers['x-correlation-id']),
  };
}

/** @param {any} reply @param {() => Promise<unknown>} work */
async function respond(reply, work) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Origin, Cookie');
  try {
    return reply.send(await work());
  } catch (error) {
    const failure = /** @type {any} */ (error);
    const status = Number(failure?.statusCode);
    const codes = new Set([
      'FORBIDDEN',
      'INVALID_REQUEST',
      'NOT_FOUND',
      'VERSION_CONFLICT',
      'IDEMPOTENCY_KEY_REUSED',
    ]);
    const code =
      failure?.name === 'IdempotencyConflictError'
        ? 'IDEMPOTENCY_KEY_REUSED'
        : failure?.code;
    const publicStatus =
      code === 'IDEMPOTENCY_KEY_REUSED'
        ? 409
        : [400, 403, 404, 409].includes(status) && codes.has(code)
          ? status
          : 503;
    return reply.code(publicStatus).send({
      error: { code: publicStatus === 503 ? 'SERVICE_UNAVAILABLE' : code },
    });
  }
}

/** @param {import('fastify').FastifyInstance} api @param {any} runtime */
export function registerHealthErrorsRoutes(api, runtime) {
  api.get('/api/v1/admin/health-errors', async (request, reply) =>
    respond(reply, async () => {
      const query = /** @type {Record<string, unknown>} */ (
        request.query ?? {}
      );
      if (Object.keys(query).some((key) => key !== 'status'))
        throw Object.assign(new Error('INVALID_REQUEST'), {
          code: 'INVALID_REQUEST',
          statusCode: 400,
        });
      return runtime.list({ ...headers(request), status: query.status });
    }),
  );
  api.patch('/api/v1/admin/health-errors/:id', async (request, reply) =>
    respond(reply, () => {
      const params = /** @type {{id: string}} */ (request.params);
      return runtime.change({
        ...headers(request),
        id: params.id,
        body: request.body,
        idempotencyKey: request.headers['idempotency-key'],
      });
    }),
  );
}
