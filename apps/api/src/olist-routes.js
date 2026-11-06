import { createHash } from 'node:crypto';
import { OlistError } from '@crm-silmer/olist';
const CODES = new Set([
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'INVALID_REQUEST',
  'ORDER_NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'OLIST_NOT_CONFIGURED',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_INVALID_STATE',
  'OLIST_AUTH',
  'OLIST_UNAVAILABLE',
  'OLIST_RATE_LIMITED',
  'OLIST_ACCOUNT_MISMATCH',
  'OLIST_CONNECTION_CHANGED',
  'OLIST_REFRESH_IN_PROGRESS',
  'OLIST_INVALID_RESPONSE',
  'OLIST_UPSTREAM_REJECTED',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_RESOURCE_NOT_FOUND',
  'OLIST_ENVELOPE_INVALID',
  'OLIST_CREATION_DISABLED',
  'OLIST_PREVIEW_STALE',
  'OLIST_PREVIEW_EXPIRED',
  'OLIST_PREVIEW_INVALID',
]);
/** @param {any} reply @param {()=>Promise<any>} work */
async function respond(reply, work) {
  reply
    .header('cache-control', 'private, no-store')
    .header('vary', 'Origin, Cookie')
    .header('referrer-policy', 'no-referrer');
  try {
    return reply.send(await work());
  } catch (error) {
    const candidate = /** @type {any} */ (error);
    const code = CODES.has(candidate.code)
      ? candidate.code
      : 'SERVICE_UNAVAILABLE';
    const status =
      code === 'SERVICE_UNAVAILABLE'
        ? 503
        : Number.isInteger(candidate.statusCode) &&
            candidate.statusCode >= 400 &&
            candidate.statusCode <= 599
          ? candidate.statusCode
          : 409;
    return reply
      .code(status)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: code, status, code });
  }
}
/** @param {any} request @param {any} runtime @param {boolean} write @param {string} action */
async function principal(request, runtime, write, action) {
  const auth = {
    action,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    csrfToken: request.headers['x-csrf-token'],
    secFetchSite: request.headers['sec-fetch-site'],
  };
  const { actor } = await (write
    ? runtime.authorizeWrite(auth)
    : runtime.authorizeRead(auth));
  const sessions = String(request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('crm_session='));
  if (sessions.length !== 1 || !sessions[0].slice(12))
    throw new OlistError('FORBIDDEN', 403);
  return {
    actor,
    sessionBinding: createHash('sha256')
      .update(sessions[0].slice(12))
      .digest('hex'),
  };
}
/** @param {unknown} body @param {string[]} fields */
function strictBody(body, fields) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(body, field))
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return /** @type {Record<string,any>} */ (body);
}
/** @param {import('fastify').FastifyInstance} api @param {any} runtime @param {(request:object)=>{correlationId:string}} contextFor */
export function registerOlistRoutes(api, runtime, contextFor) {
  const prefix = '/api/v1/integrations/olist';
  api.get(
    prefix + '/status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () =>
        runtime.status({
          ...(await principal(request, runtime, false, 'olist.manage')),
          ...contextFor(request),
        }),
      ),
  );
  const commands = {
    authorize: [],
    complete: ['code', 'state'],
    disconnect: ['expectedVersion', 'reason'],
    settings: ['expectedVersion', 'reason', 'settings'],
    'order-lookup': ['query'],
    lookups: ['kind'],
    mappings: ['resourceId'],
  };
  for (const [name, fields] of Object.entries(commands)) {
    api.post(
      prefix + '/' + name,
      {
        bodyLimit: 8192,
        config: {
          rateLimit: {
            max: name === 'order-lookup' ? 15 : 10,
            timeWindow: '1 minute',
          },
        },
      },
      (request, reply) =>
        respond(reply, async () => {
          const input = await principal(
            request,
            runtime,
            true,
            name === 'order-lookup' ? 'olist.export' : 'olist.manage',
          );
          const body = strictBody(request.body, fields);
          const method = name === 'order-lookup' ? 'lookup' : name;
          return runtime[method]({
            ...input,
            ...body,
            ...contextFor(request),
            idempotencyKey: request.headers['idempotency-key'],
          });
        }),
    );
  }
  for (const [path, method, fields] of [
    ['/preview', 'preview', []],
    ['/preview/check', 'checkPreview', ['previewToken']],
  ]) {
    api.post(
      '/api/v1/orders/:orderId/olist' + path,
      {
        bodyLimit: 270000,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      (request, reply) =>
        respond(reply, async () => {
          const input = await principal(request, runtime, true, 'olist.export');
          const body = strictBody(
            request.body,
            /** @type {string[]} */ (fields),
          );
          return runtime[/** @type {string} */ (method)]({
            ...input,
            ...body,
            ...contextFor(request),
            orderId: /** @type {any} */ (request.params).orderId,
          });
        }),
    );
  }
  api.get(
    '/api/v1/orders/:orderId/olist',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    (request, reply) =>
      respond(reply, async () => {
        let input;
        let action = 'olist.read';
        try {
          input = await principal(request, runtime, false, action);
        } catch (error) {
          if (/** @type {any} */ (error).statusCode !== 403) throw error;
          action = 'order.read';
          input = await principal(request, runtime, false, action);
        }
        return runtime.project({
          ...input,
          action,
          ...contextFor(request),
          orderId: /** @type {any} */ (request.params).orderId,
        });
      }),
  );
}
