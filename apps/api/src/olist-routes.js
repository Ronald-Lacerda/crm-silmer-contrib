import { createHash } from 'node:crypto';
import { OlistError } from '@crm-silmer/olist';
const CODES = new Set([
  'ORDER_CANCELLED',
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
  'OLIST_RECOVERY_BLOCKED',
  'OLIST_PRODUCT_FISCAL_REQUIRED',
  'OLIST_PREVIEW_STALE',
  'OLIST_PREVIEW_EXPIRED',
  'OLIST_PREVIEW_INVALID',
  'OLIST_EXPORT_CONFLICT',
  'IDEMPOTENCY_RECORD_PENDING',
  'OLIST_ORDER_INCOMPLETE',
  'OLIST_PREVIEW_TOO_LARGE',
  'OLIST_RECONCILIATION_REQUIRED',
  'OLIST_RECONCILIATION_NOT_FOUND',
  'OLIST_SALE_READBACK_MISMATCH',
  'OLIST_SALE_REQUEST_CHANGED',
  'OLIST_SALE_REFERENCE_CONFLICT',
  'OLIST_SALE_DIVERGENT',
  'OLIST_RESOURCE_DIVERGENT',
  'OLIST_CUSTOMER_DIVERGENT',
  'OLIST_PRODUCT_DIVERGENT',
  'OLIST_PRODUCT_FISCAL_DIVERGENT',
  'OLIST_VARIATION_DIVERGENT',
  'OLIST_SALE_UNCERTAIN',
  'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
  'OLIST_EXPORT_UNAVAILABLE',
  'OLIST_SALE_RECONCILIATION_REQUIRED',
  'OLIST_RECONCILE_FAILED',
  // T14: client/state refusals reachable from the administrative commands;
  // each is thrown with its own 409 and must not collapse into a 503.
  'OLIST_PARENT_UNRESOLVED',
  'OLIST_CUSTOMER_INVALID',
  'OLIST_PAYMENT_DUE_REQUIRED',
  'OLIST_SALE_EXACT_CENT_REQUIRED',
  'OLIST_SALE_PLAN_INVALID',
  // L1: local administrative invalidation of an export generation. Both are
  // 409 refusals the operator can act on; neither carries remote or reason data.
  'OLIST_INVALIDATION_BLOCKED',
  'OLIST_EXPORT_IN_FLIGHT',
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
/** @param {unknown} body @param {string[]} fields @param {string[]} [optional] */
function strictBody(body, fields, optional = []) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (field) => !fields.includes(field) && !optional.includes(field),
    ) ||
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
    creation: ['expectedVersion', 'enabled', 'reason'],
    recovery: ['expectedVersion', 'confirmed', 'reason'],
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
    ['/export', 'exportOrder', ['previewToken']],
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
            method === 'preview' ? ['paymentDueOn', 'productFiscal'] : [],
          );
          if (method === 'exportOrder') reply.code(202);
          return runtime[/** @type {string} */ (method)]({
            ...input,
            ...body,
            ...contextFor(request),
            idempotencyKey: request.headers['idempotency-key'],
            orderId: /** @type {any} */ (request.params).orderId,
          });
        }),
    );
  }
  for (const [path, method, fields, action] of [
    ['/existing/previews', 'existingPreview', ['saleId'], 'olist.link'],
    [
      '/existing/legacy/previews',
      'legacyExistingPreview',
      ['saleId', 'mapping'],
      'olist.link',
    ],
    [
      '/existing/legacy/links',
      'linkLegacyExisting',
      ['previewToken', 'confirmed', 'reason'],
      'olist.link',
    ],
    ['/links', 'linkExisting', ['previewToken', 'reason'], 'olist.link'],
    [
      '/reconcile',
      'reconcile',
      ['stage', 'resourceId', 'expectedVersion', 'reason'],
      'olist.reconcile',
    ],
    // L1: synchronous and local (200, no ERP call, no connection health needed).
    [
      '/invalidate',
      'invalidate',
      ['operationId', 'expectedVersion', 'reason'],
      'olist.invalidate',
    ],
  ]) {
    api.post(
      '/api/v1/orders/:orderId/olist' + path,
      {
        bodyLimit: 270000,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      (request, reply) =>
        respond(reply, async () => {
          const input = await principal(
            request,
            runtime,
            true,
            /** @type {string} */ (action),
          );
          const body = strictBody(
            request.body,
            /** @type {string[]} */ (fields),
            method === 'existingPreview'
              ? ['paymentDueOn', 'productFiscal']
              : method === 'legacyExistingPreview'
                ? ['paymentDueOn']
                : [],
          );
          if (method === 'reconcile') reply.code(202);
          return runtime[/** @type {string} */ (method)]({
            ...input,
            ...body,
            ...contextFor(request),
            idempotencyKey: request.headers['idempotency-key'],
            orderId: /** @type {any} */ (request.params).orderId,
          });
        }),
    );
  }
  for (const [path, method, action] of [
    ['/administration', 'administration', 'olist.link'],
    ['/reconciliations/:requestId', 'readReconciliation', 'olist.reconcile'],
  ]) {
    api.get(
      '/api/v1/orders/:orderId/olist' + path,
      {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      (request, reply) =>
        respond(reply, async () =>
          runtime[method]({
            ...(await principal(request, runtime, false, action)),
            ...contextFor(request),
            orderId: /** @type {any} */ (request.params).orderId,
            ...(method === 'readReconciliation'
              ? { requestId: /** @type {any} */ (request.params).requestId }
              : {}),
          }),
        ),
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
