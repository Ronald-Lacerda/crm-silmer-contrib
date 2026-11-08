import rateLimit from '@fastify/rate-limit';
import {
  billingChatError,
  billingChatIdentifier,
  billingIntentSchema,
  readBillingSendCommand,
  billingHistorySchema,
} from './order-billing-chat-contract.js';

const CODES = new Set([
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_SESSION',
  'INVALID_REQUEST',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_CONFIRMED',
  'BILLING_NOT_FOUND',
  'BILLING_DISABLED',
  'BILLING_ALREADY_PAID',
  'BILLING_ACTIVE_CHARGE',
  'BILLING_REVIEW_REQUIRED',
  'BILLING_LINK_STILL_VALID',
  'BILLING_PAYMENT_MISMATCH',
  'BILLING_RETRY_UNSAFE',
  'BILLING_TARGET_CONFLICT',
  'BILLING_INVALID_AMOUNT',
  'REQUEST_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
]);

/** COB-CHAT-B01: injectable boundary; no production service wired until B04.
 * @param {import('fastify').FastifyInstance} api
 * @param {any} service
 * @param {(request:any)=>{correlationId:string}} contextFor
 * @param {{enabled?:boolean}} [options]
 */
export function registerOrderBillingChatRoutes(
  api,
  service,
  contextFor,
  { enabled = false } = {},
) {
  api.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      errorResponseBuilder: () => billingChatError('RATE_LIMITED', 429),
    });
    scope.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('vary', 'Cookie, Origin');
      reply.header('referrer-policy', 'no-referrer');
    });
    scope.setErrorHandler((error, _request, reply) => {
      const e = /** @type {any} */ (error);
      const code =
        e.statusCode === 413
          ? 'REQUEST_TOO_LARGE'
          : e.statusCode === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : CODES.has(e.code)
              ? e.code
              : e.statusCode === 400
                ? 'INVALID_REQUEST'
                : 'SERVICE_UNAVAILABLE';
      const status =
        code === 'SERVICE_UNAVAILABLE'
          ? 503
          : Number.isInteger(e.statusCode) &&
              e.statusCode >= 400 &&
              e.statusCode <= 599
            ? e.statusCode
            : 400;
      reply
        .code(status)
        .type('application/problem+json')
        .send({ type: 'about:blank', title: code, status, code });
    });
    const prefix = '/api/v1/orders/:orderId/billing';
    const limits = {
      bodyLimit: 8192,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    };
    /** @param {any} request @param {boolean} write */
    async function actorFor(request, write) {
      if (request.headers.authorization !== undefined)
        throw billingChatError('FORBIDDEN', 403);
      return (write ? service.authorizeWrite : service.authorizeRead)({
        action: write ? 'billing.manage' : 'billing.read',
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        csrfToken: request.headers['x-csrf-token'],
        secFetchSite: request.headers['sec-fetch-site'],
      });
    }
    scope.post(
      `${prefix}/send-intents`,
      {
        ...limits,
        schema: { response: { 202: structuredClone(billingIntentSchema) } },
      },
      async (request, reply) => {
        const { actor } = await actorFor(request, true);
        if (!enabled) throw billingChatError('BILLING_DISABLED', 503);
        if (Object.keys(request.query ?? {}).length) throw billingChatError();
        const command = readBillingSendCommand(request.body);
        const result = await service.submit({
          ...command,
          actor,
          orderId: billingChatIdentifier(
            /** @type {any} */ (request.params).orderId,
          ),
          idempotencyKey: billingChatIdentifier(
            request.headers['idempotency-key'],
          ),
          correlationId: contextFor(request).correlationId,
        });
        return reply.code(202).send(result);
      },
    );
    scope.get(
      `${prefix}/send-intents/:intentId`,
      {
        ...limits,
        schema: { response: { 200: structuredClone(billingIntentSchema) } },
      },
      async (request) => {
        const { actor } = await actorFor(request, false);
        if (Object.keys(request.query ?? {}).length) throw billingChatError();
        const params = /** @type {any} */ (request.params);
        return service.getIntent({
          actor,
          orderId: billingChatIdentifier(params.orderId),
          intentId: billingChatIdentifier(params.intentId),
        });
      },
    );
    scope.get(
      `${prefix}/history`,
      {
        ...limits,
        schema: { response: { 200: structuredClone(billingHistorySchema) } },
      },
      async (request) => {
        const { actor } = await actorFor(request, false);
        const query = /** @type {Record<string,unknown>} */ (
          request.query ?? {}
        );
        if (Object.keys(query).some((k) => !['limit', 'cursor'].includes(k)))
          throw billingChatError();
        const limit =
          query.limit === undefined
            ? 20
            : typeof query.limit === 'string' &&
                /^(?:[1-9]|[1-4][0-9]|50)$/u.test(query.limit)
              ? Number(query.limit)
              : 0;
        if (!limit) throw billingChatError();
        return service.getHistory({
          actor,
          orderId: billingChatIdentifier(
            /** @type {any} */ (request.params).orderId,
          ),
          limit,
          cursor:
            query.cursor === undefined
              ? null
              : billingChatIdentifier(query.cursor),
        });
      },
    );
  });
}
