import { FinanceError } from '@crm-silmer/orders';

const PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_FILTER',
  'INVALID_CURSOR',
  'INVALID_EXPECTED_VERSION',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'CSRF_INVALID',
  'VERSION_CONFLICT',
  'FINANCE_STATUS_CONFLICT',
  'FINANCE_ORDER_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_IDEMPOTENCY_KEY',
]);

/** @param {unknown} value */
function identifier(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new FinanceError(400, 'INVALID_REQUEST');
  }
  return value.trim();
}

/** @param {any} request @param {any} finance @param {string} action @param {boolean} write */
async function principal(request, finance, action, write) {
  const input = {
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    csrfToken: request.headers['x-csrf-token'],
    secFetchSite: request.headers['sec-fetch-site'],
  };
  return write ? finance.authorizeWrite(input) : finance.authorizeRead(input);
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
    return reply
      .code(status)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: code, status, code });
  }
}

/** @param {import('fastify').FastifyInstance} api @param {any} finance @param {(request:object)=>{correlationId:string}} contextFor */
export function registerFinanceRoutes(api, finance, contextFor) {
  api.get('/api/v1/finance/orders', (request, reply) =>
    respond(reply, async () => {
      const { actor } = await principal(
        request,
        finance,
        'finance.read',
        false,
      );
      return finance.list({ actor, query: request.query });
    }),
  );
  api.get('/api/v1/finance/orders/:orderId', (request, reply) =>
    respond(reply, async () => {
      const { actor } = await principal(
        request,
        finance,
        'finance.read',
        false,
      );
      return finance.get({
        actor,
        orderId: identifier(/** @type {any} */ (request.params).orderId),
      });
    }),
  );
  for (const action of /** @type {const} */ (['complete', 'reopen'])) {
    api.post(
      `/api/v1/finance/orders/:orderId/${action}`,
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      (request, reply) =>
        respond(reply, async () => {
          const { actor } = await principal(
            request,
            finance,
            `finance.${action}`,
            true,
          );
          const body = /** @type {any} */ (request.body);
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).some(
              (key) =>
                !['expectedVersion', 'expectedFinanceVersion'].includes(key),
            )
          ) {
            throw new FinanceError(400, 'INVALID_REQUEST');
          }
          return finance.change({
            actor,
            action,
            orderId: identifier(/** @type {any} */ (request.params).orderId),
            expectedVersion: body.expectedVersion,
            expectedFinanceVersion: body.expectedFinanceVersion,
            idempotencyKey: identifier(request.headers['idempotency-key']),
            correlationId: contextFor(request).correlationId,
          });
        }),
    );
  }
}
