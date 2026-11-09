import rateLimit from '@fastify/rate-limit';
import { authorizeRequest } from './n8n-routes.js';

const PUBLIC_CODES = new Set([
  'FORBIDDEN',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'INVALID_AUTOMATION_CREDENTIALS',
  'FORBIDDEN_AUTOMATION_ACTION',
  'AUTOMATION_AUTH_UNAVAILABLE',
  'INVALID_REQUEST',
  'INVALID_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_CONFIRMED',
  'ORDER_LOCKED',
  'ORDER_CANCELLED',
  'BILLING_DISABLED',
  'BILLING_NOT_FOUND',
  'BILLING_CONFLICT',
  'BILLING_INVALID_PERCENT',
  'BILLING_MINIMUM_AMOUNT',
  'BILLING_ALREADY_PAID',
  'BILLING_LEGACY_PAYMENT',
  'BILLING_CHARGE_ACTIVE',
  'BILLING_REVIEW_REQUIRED',
  'BILLING_INVALID_URL',
  'BILLING_INVALID_PAYMENT',
  'BILLING_TRANSACTION_CONFLICT',
  'BILLING_CHARGE_EXPIRED',
  'BILLING_EXECUTION_CONFLICT',
  'BILLING_REFUND_INVALID',
  'BILLING_PROVIDER_REVIEW_REQUIRED',
  'BILLING_INVALID_AMOUNT',
  'BILLING_ACTIVE_CHARGE',
  'BILLING_CHARGE_NOT_FOUND',
  'BILLING_CHECKOUT_CONFLICT',
  'BILLING_CONDITION_LOCKED',
  'BILLING_INVALID_REFUND',
  'BILLING_LINK_STILL_VALID',
  'BILLING_NOT_MANAGED',
  'BILLING_ORDER_NOT_CONFIRMED',
  'BILLING_OVERPAID',
  'BILLING_PAYMENT_MISMATCH',
  'BILLING_RECEIPT_CONFLICT',
  'BILLING_REVIEW_CONFIRMATION_REQUIRED',
  'BILLING_STORE_ORDER',
  'INVALID_EXPECTED_VERSION',
  'RATE_LIMITED',
  'REQUEST_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'BILLING_INVALID_EXTERNAL_RECEIPT',
  'BILLING_REVERSAL_REASON_REQUIRED',
  'BILLING_RECEIPT_NOT_FOUND',
  'BILLING_RECEIPT_REVERSED',
  'BILLING_PAYMENT_NOT_RECORDED',
  'BILLING_CHECK_DISABLED',
]);

/** @param {string} code @param {number} [statusCode] */
function invalid(code = 'INVALID_REQUEST', statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

/** @param {unknown} value */
function identifier(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[^\x21-\x7e]/u.test(value)
  )
    throw invalid();
  return value;
}

/** @param {unknown} value @param {string[]} keys */
function body(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw invalid();
  return /** @type {Record<string, any>} */ (value);
}

/** @param {any} reply @param {unknown} error */
function problem(reply, error) {
  const candidate = /** @type {any} */ (error);
  const supplied = candidate?.code;
  const code = PUBLIC_CODES.has(supplied)
    ? supplied
    : supplied?.startsWith('INVALID_X_') ||
        supplied === 'INVALID_CORRELATION_ID'
      ? 'INVALID_REQUEST'
      : Number(candidate?.statusCode) >= 400 &&
          Number(candidate?.statusCode) < 500
        ? 'INVALID_REQUEST'
        : 'SERVICE_UNAVAILABLE';
  const status =
    code === 'SERVICE_UNAVAILABLE'
      ? 503
      : Number(candidate?.statusCode) >= 400 &&
          Number(candidate?.statusCode) < 600
        ? Number(candidate.statusCode)
        : 400;
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title: code, status, code });
}

/** @param {any} reply @param {()=>Promise<unknown>} operation */
async function respond(reply, operation) {
  reply.header('cache-control', 'private, no-store');
  reply.header('vary', 'Cookie, Origin');
  reply.header('referrer-policy', 'no-referrer');
  try {
    return reply.send(await operation());
  } catch (error) {
    return problem(reply, error);
  }
}

/** @param {any} request @param {any} billing @param {boolean} write */
async function human(request, billing, write) {
  if (request.headers.authorization !== undefined)
    throw invalid('FORBIDDEN', 403);
  return (write ? billing.authorizeWrite : billing.authorizeRead)({
    action: write ? 'billing.manage' : 'billing.read',
    cookie: request.headers.cookie,
    origin: request.headers.origin,
    csrfToken: request.headers['x-csrf-token'],
    secFetchSite: request.headers['sec-fetch-site'],
  });
}

/**
 * COB-01/04/13: human session and narrow technical capabilities are separate.
 * The runtime revalidates live ownership and versions inside its transaction.
 * @param {import('fastify').FastifyInstance} api
 * @param {any} billing
 * @param {(request:any)=>{correlationId:string,requestId:string}} contextFor
 */
export function registerOrderBillingRoutes(api, billing, contextFor) {
  api.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      errorResponseBuilder: () => invalid('RATE_LIMITED', 429),
    });
    scope.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('referrer-policy', 'no-referrer');
    });
    scope.setErrorHandler((error, _request, reply) => {
      const status = Number(/** @type {any} */ (error).statusCode);
      return problem(
        reply,
        status === 413
          ? invalid('REQUEST_TOO_LARGE', 413)
          : status === 415
            ? invalid('UNSUPPORTED_MEDIA_TYPE', 415)
            : error,
      );
    });
    const options = {
      bodyLimit: 8192,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    };
    const prefix = '/api/v1/orders/:orderId/billing';
    scope.get(prefix, options, (request, reply) =>
      respond(reply, async () => {
        body(request.query ?? {}, []);
        const { actor } = await human(request, billing, false);
        return billing.get({
          actor,
          orderId: identifier(/** @type {any} */ (request.params).orderId),
        });
      }),
    );
    for (const [suffix, method, extra] of /** @type {const} */ ([
      ['/plan', 'configure', ['percent']],
      ['/charges', 'issue', ['percent']],
      ['/charges/:chargeId/refund', 'refund', ['amountCents']],
      ['/reconcile', 'reconcile', ['decision', 'confirmedProviderReview']],
      [
        '/external-receipts',
        'recordExternal',
        ['amountCents', 'receivedOn', 'method', 'note'],
      ],
      ['/external-receipts/:receiptId/reverse', 'reverseExternal', ['reason']],
      [
        '/charges/:chargeId/check-payment',
        'checkPayment',
        ['invoiceSlug', 'transactionNsu'],
      ],
    ])) {
      scope.post(`${prefix}${suffix}`, options, (request, reply) =>
        respond(reply, async () => {
          const { actor } = await human(request, billing, true);
          const command = body(request.body, [
            'expectedVersion',
            'expectedBillingVersion',
            ...extra,
          ]);
          const params = /** @type {any} */ (request.params);
          if (method === 'checkPayment') reply.code(202);
          return billing[method]({
            ...command,
            actor,
            orderId: identifier(params.orderId),
            ...(params.chargeId
              ? { chargeId: identifier(params.chargeId) }
              : {}),
            ...(params.receiptId
              ? { receiptId: identifier(params.receiptId) }
              : {}),
            idempotencyKey: identifier(request.headers['idempotency-key']),
            correlationId: contextFor(request).correlationId,
          });
        }),
      );
    }
    const technicalPrefix =
      '/api/v1/integrations/n8n/billing/charges/:chargeId';
    for (const [suffix, operation, action, keys] of /** @type {const} */ ([
      ['', 'paymentCheckLookup', 'billing.checkout.read', []],
      ['/result', 'paymentCheckResult', 'billing.payment.record', ['status']],
    ])) {
      const path =
        '/api/v1/integrations/n8n/billing/payment-checks/:checkId' + suffix;
      const handler = (/** @type {any} */ request, /** @type {any} */ reply) =>
        respond(reply, async () => {
          const technical = await authorizeRequest(request, contextFor, action);
          if (technical.workflowKey !== 'silmer-order-billing')
            throw invalid('FORBIDDEN_AUTOMATION_ACTION', 403);
          const data = body(suffix ? request.body : (request.query ?? {}), [
            ...keys,
          ]);
          return billing[operation]({
            ...data,
            checkId: identifier(request.params.checkId),
            executionId: technical.executionId,
            correlationId: technical.correlationId,
          });
        });
      if (suffix) scope.post(path, options, handler);
      else scope.get(path, options, handler);
    }
    for (const [operation, action, keys] of /** @type {const} */ ([
      ['reserve', 'billing.checkout.reserve', []],
      ['created', 'billing.checkout.record', ['checkoutUrl']],
      [
        'payment',
        'billing.payment.record',
        [
          'transactionNsu',
          'invoiceSlug',
          'amountCents',
          'paidAmountCents',
          'method',
          'installments',
          'receiptUrl',
        ],
      ],
      ['lookup', 'billing.checkout.read', []],
    ])) {
      const handler = (/** @type {any} */ request, /** @type {any} */ reply) =>
        respond(reply, async () => {
          const technical = await authorizeRequest(request, contextFor, action);
          if (technical.workflowKey !== 'silmer-order-billing')
            throw invalid('FORBIDDEN_AUTOMATION_ACTION', 403);
          const data = body(
            operation === 'lookup' ? (request.query ?? {}) : request.body,
            [...keys],
          );
          return billing[operation]({
            ...data,
            chargeId: identifier(request.params.chargeId),
            executionId: technical.executionId,
            correlationId: technical.correlationId,
          });
        });
      if (operation === 'lookup')
        scope.get(`${technicalPrefix}/${operation}`, options, handler);
      else scope.post(`${technicalPrefix}/${operation}`, options, handler);
    }
  });
}
