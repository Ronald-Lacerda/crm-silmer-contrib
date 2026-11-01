import { createHash } from 'node:crypto';
import { ShippingHttpError } from './shipping-runtime.js';

const PUBLIC_CODES = new Set([
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'INVALID_REQUEST',
  'INVALID_POSTAL_CODE',
  'INVALID_QUOTE_PACKAGES',
  'MELHOR_ENVIO_NOT_CONFIGURED',
  'MELHOR_ENVIO_NOT_CONNECTED',
  'MELHOR_ENVIO_RECONNECT_REQUIRED',
  'MELHOR_ENVIO_REFRESH_IN_PROGRESS',
  'MELHOR_ENVIO_CONNECTION_CHANGED',
  'MELHOR_ENVIO_INVALID_STATE',
  'MELHOR_ENVIO_AUTH',
  'MELHOR_ENVIO_RATE_LIMITED',
  'MELHOR_ENVIO_UNAVAILABLE',
  'MELHOR_ENVIO_INVALID_RESPONSE',
  'MELHOR_ENVIO_VALIDATION',
  'MELHOR_ENVIO_REJECTED',
]);

/** @param {any} request @param {any} runtime @param {boolean} write */
async function principal(request, runtime, write) {
  const auth = {
    action: 'shipping.manage',
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    csrfToken: request.headers['x-csrf-token'],
    secFetchSite: request.headers['sec-fetch-site'],
  };
  const { actor } = await (write
    ? runtime.authorizeWrite(auth)
    : runtime.authorizeRead(auth));
  const cookie =
    typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
  const sessions = cookie
    .split(';')
    .map((/** @type {string} */ part) => part.trim())
    .filter((/** @type {string} */ part) => part.startsWith('crm_session='));
  if (sessions.length !== 1 || !sessions[0].slice(12))
    throw new ShippingHttpError(403, 'FORBIDDEN');
  return {
    actor,
    sessionBinding: createHash('sha256')
      .update(sessions[0].slice(12))
      .digest('hex'),
  };
}

/** @param {any} reply @param {()=>Promise<unknown>} work */
async function respond(reply, work) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Origin, Cookie');
  reply.header('referrer-policy', 'no-referrer');
  try {
    return reply.send(await work());
  } catch (error) {
    const candidate = /** @type {any} */ (error);
    const code = PUBLIC_CODES.has(candidate.code)
      ? candidate.code
      : 'SERVICE_UNAVAILABLE';
    const status =
      code === 'SERVICE_UNAVAILABLE'
        ? 503
        : Number.isInteger(candidate.statusCode) &&
            candidate.statusCode >= 400 &&
            candidate.statusCode <= 599
          ? candidate.statusCode
          : 503;
    // Upstream messages/fieldErrors may contain recipient data. Only fixed codes cross this boundary.
    return reply
      .code(status)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: code, status, code });
  }
}

/** @param {unknown} body @param {string[]} fields */
function strictBody(body, fields) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(body, key))
  )
    throw new ShippingHttpError(400, 'INVALID_REQUEST');
}

/** @param {import('fastify').FastifyInstance} api @param {any} runtime @param {(request:object)=>{correlationId:string}} contextFor */
export function registerShippingRoutes(api, runtime, contextFor) {
  const prefix = '/api/v1/shipping/melhor-envio';
  api.get(
    `${prefix}/status`,
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () =>
        runtime.status({
          ...(await principal(request, runtime, false)),
          ...contextFor(request),
        }),
      ),
  );
  for (const action of ['authorize', 'complete', 'quote', 'disconnect']) {
    api.post(
      `${prefix}/${action}`,
      {
        bodyLimit: 8192,
        config: {
          rateLimit: {
            max: action === 'quote' ? 30 : 10,
            timeWindow: '1 minute',
          },
        },
      },
      (request, reply) =>
        respond(reply, async () => {
          const authorized = await principal(request, runtime, true);
          const fields =
            action === 'complete'
              ? ['code', 'state']
              : action === 'quote'
                ? [
                    'fromPostalCode',
                    'toPostalCode',
                    'weightGrams',
                    'widthCm',
                    'heightCm',
                    'lengthCm',
                    'insuranceValueCents',
                  ]
                : [];
          strictBody(request.body, fields);
          const input = {
            ...authorized,
            ...contextFor(request),
            ...(action === 'complete'
              ? /** @type {object} */ (request.body)
              : {}),
            ...(action === 'quote' ? { body: request.body } : {}),
          };
          return runtime[action](input);
        }),
    );
  }
}
