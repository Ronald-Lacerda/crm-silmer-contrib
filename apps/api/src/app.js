import Fastify from 'fastify';
import { performance } from 'node:perf_hooks';
import rateLimit from '@fastify/rate-limit';

import {
  createSafeLogger,
  MetricRegistry,
  normalizeTraceId,
  SERVICES,
} from '@crm-silmer/shared';
import {
  MetaWebhookAuthenticationError,
  MetaWebhookPayloadError,
  WebhookEventConflictError,
} from '@crm-silmer/integration-reliability';
import { registerConversationRoutes } from './conversation-routes.js';
import { registerChatMediaUploadRoutes } from './chat-media-upload-routes.js';
import { registerChatMediaStatusRoutes } from './chat-media-status-routes.js';
import { registerChatMediaContentRoutes } from './chat-media-content-routes.js';
import { registerIdentityRoutes } from './identity-routes.js';
import { registerFinanceRoutes } from './finance-routes.js';
import { registerDashboardRoutes } from './dashboard-routes.js';
import { registerDashboardCheckpointRoutes } from './dashboard-checkpoint-routes.js';
import { registerDashboardMetricsRoutes } from './dashboard-metrics-routes.js';
import { registerConversationReminderRoutes } from './conversation-reminder-routes.js';
import { registerLeadOutcomeRoutes } from './lead-outcome-routes.js';
import { registerOrderBillingRoutes } from './order-billing-routes.js';
import { registerShippingRoutes } from './shipping-routes.js';
import { registerN8nRoutes } from './n8n-routes.js';
import { registerN8nCommandMediaRoutes } from './n8n-command-media-routes.js';
import { registerOperationRoutes } from './operation-routes.js';
import { registerOrderRoutes } from './order-routes.js';
import { registerOrderAssistanceRoutes } from './order-assistance-routes.js';
import { registerStoreOrderRoutes } from './store-order-routes.js';
import { registerSubjectRoutes } from './subject-routes.js';
import { registerSiteChatRoutes } from './site-chat-routes.js';
import { WEBHOOK_BODY_LIMIT_BYTES } from './whatsapp-webhook-runtime.js';

export const WEBHOOK_MAX_IN_FLIGHT = 8;
export const WEBHOOK_REQUESTS_PER_SECOND = 20;

/**
 * Creates the HTTP API without binding a socket, so callers and tests own its
 * lifecycle.
 *
 * @param {import('fastify').FastifyServerOptions} [options]
 * @param {{
 *   logger?: ReturnType<typeof createSafeLogger>,
 *   metrics?: MetricRegistry,
 *   readiness?: () => boolean | Promise<boolean>,
 *   metaWebhook?: {
 *     verifyToken: string,
 *     process(input: {correlationId: string, rawBody: Buffer, signature: unknown}): Promise<unknown>
 *   },
 *   automationAuth?: {authorize(input: {action: string, authorization: unknown, correlationId: string}): Promise<unknown>},
 *   commercial?: Record<string, any>,
 *   identity?: Record<string, any>,
 *   n8n?: any,
 *   conversations?: any,
 *   chatMedia?: any,
 *   inboundMedia?: any,
 *   handoffs?: any,
 *   operations?: any,
 *   orders?: any,
 *   orderAssistance?: any,
 *   finance?: any,
 *   dashboard?: any,
 *   dashboardCheckpoint?: any,
 *   dashboardMetrics?: any,
 *   leadOutcomes?: any,
 *   conversationReminders?: any,
 *   billing?: any,
 *   shipping?: any,
 *   orderPdfRenderer?: (html: string) => Promise<Buffer>,
 *   storeOrders?: import('./store-order-runtime.js').StoreOrderRuntime
 *   subjects?: Record<string, any>,
 * }} [runtime]
 */
export function createApi(options = {}, runtime = {}) {
  const api = Fastify({ ...options, logger: false });
  const logger = runtime.logger ?? createSafeLogger({ service: SERVICES.api });
  const metrics = runtime.metrics ?? new MetricRegistry({ logger });
  const readiness = runtime.readiness ?? (() => false);
  const webhookAdmission = createWebhookAdmissionGate();
  const admittedWebhooks = new WeakSet();
  /** @type {WeakMap<object, { correlationId: string, requestId: string, startedAt: number }>} */
  const requests = new WeakMap();

  if (runtime.commercial) {
    api.decorate('commercial', runtime.commercial);
  }
  if (runtime.automationAuth) {
    api.decorate('automationAuth', runtime.automationAuth);
  }
  api.addHook('onRequest', async (request, reply) => {
    const requestId = normalizeTraceId(request.headers['x-request-id']);
    const correlationId = normalizeTraceId(
      request.headers['x-correlation-id'] ?? requestId,
    );
    requests.set(request, {
      correlationId,
      requestId,
      startedAt: performance.now(),
    });
    reply.header('x-request-id', requestId);
    reply.header('x-correlation-id', correlationId);
    logger.info('api_request_started', {
      correlation_id: correlationId,
      request_id: requestId,
    });
  });

  api.addHook('onError', async (request, _reply, error) => {
    const context = requests.get(request);
    logger.error('api_request_failed', {
      correlation_id: context?.correlationId,
      error_code:
        typeof error.code === 'string' ? error.code : 'UNHANDLED_ERROR',
      request_id: context?.requestId,
    });
  });

  api.addHook('onResponse', async (request, reply) => {
    const context = requests.get(request);
    const duration = Math.max(
      0,
      Math.round(
        (performance.now() - (context?.startedAt ?? performance.now())) * 100,
      ) / 100,
    );
    const metricContext = {
      correlation_id: context?.correlationId,
      request_id: context?.requestId,
      status_code: reply.statusCode,
    };

    metrics.increment('api_requests_total', 1, metricContext);
    metrics.record('api_duration_ms', duration, metricContext);
    if (reply.statusCode >= 500) {
      metrics.increment('api_5xx_total', 1, metricContext);
    }
    logger.info('api_request_completed', {
      ...metricContext,
      duration_ms: duration,
    });
  });

  const live = async () => ({
    service: SERVICES.api,
    status: 'ok',
  });

  api.get('/api/health/live', live);

  api.get('/api/health/ready', async (request, reply) => {
    try {
      if (await readiness()) {
        return { service: SERVICES.api, status: 'ready' };
      }
    } catch {
      const context = requests.get(request);
      logger.error('api_readiness_failed', {
        correlation_id: context?.correlationId,
        error_code: 'READINESS_CHECK_FAILED',
        request_id: context?.requestId,
      });
    }

    reply.code(503);
    return { service: SERVICES.api, status: 'unavailable' };
  });

  api.register(async (metaWebhookScope) => {
    metaWebhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );

    metaWebhookScope.get(
      '/api/v1/webhooks/meta/whatsapp',
      async (request, reply) => {
        const query = /** @type {Record<string, unknown>} */ (request.query);
        const challenge = query['hub.challenge'];
        if (
          runtime.metaWebhook &&
          query['hub.mode'] === 'subscribe' &&
          query['hub.verify_token'] === runtime.metaWebhook.verifyToken &&
          typeof challenge === 'string'
        ) {
          return reply.type('text/plain').send(challenge);
        }
        return reply.code(runtime.metaWebhook ? 403 : 503).send();
      },
    );

    metaWebhookScope.post(
      '/api/v1/webhooks/meta/whatsapp',
      {
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
        onRequest: async (request, reply) => {
          if (!isJsonContentType(request.headers['content-type'])) {
            return reply.code(415).send();
          }
          if (!webhookAdmission.enter()) {
            reply.header('retry-after', '1');
            return reply.code(429).send();
          }
          admittedWebhooks.add(request);
        },
        onResponse: async (request) => {
          if (admittedWebhooks.delete(request)) webhookAdmission.leave();
        },
      },
      async (request, reply) => {
        if (!runtime.metaWebhook) return reply.code(503).send();
        try {
          const context = requests.get(request);
          if (!context) throw new Error('Missing request context');
          const result = await runtime.metaWebhook.process({
            correlationId: context.correlationId,
            rawBody: /** @type {Buffer} */ (request.body),
            signature: request.headers['x-hub-signature-256'],
          });
          return reply.code(200).send(result);
        } catch (error) {
          if (error instanceof MetaWebhookAuthenticationError) {
            return reply.code(401).send();
          }
          if (error instanceof MetaWebhookPayloadError) {
            return reply.code(400).send();
          }
          if (error instanceof WebhookEventConflictError) {
            return reply.code(409).send();
          }
          if (isTransientWebhookPersistenceError(error)) {
            reply.header('retry-after', '1');
            return reply.code(503).send();
          }
          throw error;
        }
      },
    );
  });

  if (runtime.identity) {
    registerIdentityRoutes(api, runtime.identity, (request) => {
      const context = requests.get(request);
      if (!context) throw new Error('Missing request context');
      return context;
    });
  }

  if (runtime.n8n) {
    if (runtime.n8n.readSiteMessages) {
      registerSiteChatRoutes(api, runtime.n8n);
    }
    registerN8nRoutes(api, runtime.n8n, (request) => {
      const context = requests.get(request);
      if (!context) throw new Error('Missing request context');
      return context;
    });
  }

  if (runtime.conversations) {
    registerConversationRoutes(api, runtime.conversations, (request) => {
      const context = requests.get(request);
      if (!context) throw new Error('Missing request context');
      return context;
    });
  }

  if (runtime.subjects) {
    registerSubjectRoutes(api, runtime.subjects, (request) => {
      const context = requests.get(request);
      if (!context) throw new Error('Missing request context');
      return context;
    });
  }

  if (runtime.inboundMedia || runtime.chatMedia) {
    registerChatMediaContentRoutes(
      api,
      runtime.inboundMedia ?? runtime.chatMedia,
      (/** @type {object} */ request) => {
        const context = requests.get(request);
        if (!context) throw new Error('Missing request context');
        return context;
      },
    );
  }

  if (runtime.chatMedia) {
    if (runtime.n8n?.readReservedMedia)
      registerN8nCommandMediaRoutes(
        api,
        runtime.n8n,
        runtime.chatMedia,
        (/** @type {object} */ request) => {
          const context = requests.get(request);
          if (!context) throw new Error('Missing request context');
          return context;
        },
      );
    registerChatMediaStatusRoutes(
      api,
      runtime.chatMedia,
      (/** @type {object} */ request) => {
        const context = requests.get(request);
        if (!context) throw new Error('Missing request context');
        return context;
      },
    );
    if (runtime.chatMedia.admissionEnabled !== false)
      registerChatMediaUploadRoutes(
        api,
        runtime.chatMedia,
        (/** @type {object} */ request) => {
          const context = requests.get(request);
          if (!context) throw new Error('Missing request context');
          return context;
        },
      );
  }

  if (runtime.shipping) {
    api.register(async (shippingScope) => {
      await shippingScope.register(rateLimit, { global: false });
      registerShippingRoutes(shippingScope, runtime.shipping, (request) => ({
        correlationId:
          requests.get(request)?.correlationId ?? 'shipping-request',
      }));
    });
  }
  if (runtime.dashboardCheckpoint) {
    api.register(async (checkpointScope) => {
      await checkpointScope.register(rateLimit, { global: false });
      registerDashboardCheckpointRoutes(
        checkpointScope,
        runtime.dashboardCheckpoint,
        (request) => ({
          correlationId:
            requests.get(request)?.correlationId ??
            'dashboard-checkpoint-request',
        }),
      );
    });
  }
  if (runtime.dashboard) {
    api.register(async (dashboardScope) => {
      await dashboardScope.register(rateLimit, { global: false });
      registerDashboardRoutes(dashboardScope, runtime.dashboard, (request) => ({
        correlationId:
          requests.get(request)?.correlationId ?? 'dashboard-request',
      }));
    });
  }
  if (runtime.dashboardMetrics) {
    api.register(async (metricsScope) => {
      await metricsScope.register(rateLimit, { global: false });
      registerDashboardMetricsRoutes(metricsScope, runtime.dashboardMetrics);
    });
  }
  if (runtime.leadOutcomes) {
    api.register(async (leadScope) => {
      await leadScope.register(rateLimit, { global: false });
      registerLeadOutcomeRoutes(leadScope, runtime.leadOutcomes, (request) => ({
        correlationId:
          requests.get(request)?.correlationId ?? 'lead-outcome-request',
      }));
    });
  }
  if (runtime.conversationReminders) {
    api.register(async (reminderScope) => {
      await reminderScope.register(rateLimit, { global: false });
      registerConversationReminderRoutes(
        reminderScope,
        runtime.conversationReminders,
        (request) => ({
          correlationId:
            requests.get(request)?.correlationId ??
            'conversation-reminder-request',
        }),
      );
    });
  }
  if (runtime.finance) {
    registerFinanceRoutes(api, runtime.finance, (request) => ({
      correlationId:
        requests.get(/** @type {any} */ (request))?.correlationId ??
        'finance-request',
    }));
  }
  if (runtime.billing) {
    registerOrderBillingRoutes(api, runtime.billing, (request) => ({
      correlationId: requests.get(request)?.correlationId ?? 'billing-request',
      requestId: requests.get(request)?.requestId ?? 'billing-request',
    }));
  }
  if (runtime.orderAssistance) {
    registerOrderAssistanceRoutes(api, runtime.orderAssistance, (request) => ({
      correlationId: requests.get(request)?.correlationId ?? 'order-assistance',
      requestId: requests.get(request)?.requestId ?? 'order-assistance',
    }));
  }
  if (runtime.orders) {
    registerOrderRoutes(
      api,
      runtime.orders,
      (request) => {
        const context = requests.get(request);
        if (!context) throw new Error('Missing request context');
        return context;
      },
      runtime.orderPdfRenderer,
    );
  }

  // ADR 028: the n8n checkout workflow records the site shop's paid order;
  // off (404) until STORE_ORDERS_HMAC_KEY is configured.
  if (runtime.storeOrders) {
    registerStoreOrderRoutes(api, runtime.storeOrders, (request) => {
      const context = requests.get(request);
      if (!context) throw new Error('Missing request context');
      return context;
    });
  }

  if (runtime.operations) {
    api.register(async (operationScope) => {
      await operationScope.register(rateLimit, { global: false });
      registerOperationRoutes(operationScope, runtime.operations, (request) => {
        const context = requests.get(request);
        if (!context) throw new Error('Missing request context');
        return context;
      });
    });
  }

  // Temporary compatibility for the T00.1 container contract.
  api.get('/health/live', live);

  return api;
}

/** @param {unknown} contentType */
function isJsonContentType(contentType) {
  return (
    typeof contentType === 'string' &&
    /^application\/json(?:\s*;[^\r\n]*)?$/iu.test(contentType)
  );
}

function createWebhookAdmissionGate() {
  let inFlight = 0;
  let admittedInWindow = 0;
  let windowStartedAt = performance.now();
  return {
    enter() {
      const now = performance.now();
      if (now - windowStartedAt >= 1000) {
        admittedInWindow = 0;
        windowStartedAt = now;
      }
      if (
        inFlight >= WEBHOOK_MAX_IN_FLIGHT ||
        admittedInWindow >= WEBHOOK_REQUESTS_PER_SECOND
      ) {
        return false;
      }
      inFlight += 1;
      admittedInWindow += 1;
      return true;
    },
    leave() {
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

/** @param {unknown} error */
function isTransientWebhookPersistenceError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {Record<string, unknown>} */ (error).code;
  return [
    '25P04',
    '53300',
    '55P03',
    '57014',
    'DATABASE_CONNECTION_TIMEOUT',
  ].includes(String(code));
}
