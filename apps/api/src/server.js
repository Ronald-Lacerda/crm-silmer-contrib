import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import {
  createDatabase,
  PostgresOperationalSignals,
} from '@crm-silmer/database';
import { createMetaWhatsAppNormalizer } from '@crm-silmer/inbox-channels';
import {
  InMemoryMetaEventStore,
  PostgresWebhookInbox,
  PostgresChatMediaUploadRepository,
  RustfsMediaStore,
  processMetaWebhook,
} from '@crm-silmer/integration-reliability';
import { objectStorageFromEnvironment } from '@crm-silmer/orders';
import { createApi } from './app.js';
import { createChatMediaApiRuntime } from './chat-media-runtime.js';
import { createInboundMediaRuntime } from './inbound-media-runtime.js';
import { createAutomationAuthRuntime } from './automation-auth-runtime.js';
import { createCommercialRuntime } from './commercial-runtime.js';
import { createConversationHandoffRuntime } from './conversation-handoff-runtime.js';
import { createConversationApiRuntime } from './conversation-runtime.js';
import { createIdentityApiRuntime } from './identity-runtime.js';
import { createFinanceApiRuntime } from './finance-runtime.js';
import { createDashboardApiRuntime } from './dashboard-runtime.js';
import { createDashboardCheckpointRuntime } from './dashboard-checkpoint-runtime.js';
import { createDashboardMetricsRuntime } from './dashboard-metrics-runtime.js';
import { createConversationReminderApiRuntime } from './conversation-reminder-runtime.js';
import { createLeadOutcomeApiRuntime } from './lead-outcome-runtime.js';
import { createOrderBillingRuntime } from './order-billing-runtime.js';
import { createHealthErrorsRuntime } from './health-errors-runtime.js';
import { registerHealthErrorsRoutes } from './health-errors-routes.js';
import { createShippingApiRuntime } from './shipping-runtime.js';
import { createN8nApiRuntime } from './n8n-runtime.js';
import { createOperationReadRuntime } from './operation-runtime.js';
import { createOperationalHealth } from './operational-health.js';
import { createOperationalAuthRuntime } from './operational-auth-runtime.js';
import { createOrderApiRuntime } from './order-runtime.js';
import { createOrderAssistanceRuntime } from './order-assistance-runtime.js';
import { createStoreOrdersForServer } from './store-order-runtime.js';
import { createSubjectApiRuntime } from './subject-runtime.js';
import { createWhatsAppWebhookRuntime } from './whatsapp-webhook-runtime.js';
import { createSafeLogger, SERVICES } from '@crm-silmer/shared';

/**
 * Production wiring stays unavailable until T01.1 injects the PostgreSQL
 * checker. Tests may inject a checker without weakening that default.
 *
 * @param {{
 *   database?: {
 *     close?: () => Promise<void>,
 *     query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}>,
 *     readiness?: () => Promise<boolean>,
 *     transaction: <T>(work: (client: any) => Promise<T>) => Promise<T>,
 *   },
 *   commercial?: Record<string, any>,
 *   environment?: Record<string, string|undefined>,
 *   logger?: ReturnType<typeof createSafeLogger>,
 *   readiness?: () => boolean | Promise<boolean>,
 *   metaWebhook?: ReturnType<typeof createMetaWebhookRuntime>,
 *   identity?: ReturnType<typeof createIdentityApiRuntime>,
 *   automationAuth?: ReturnType<typeof createAutomationAuthRuntime>,
 *   operationalAuth?: Record<string, any>,
 *   conversations?: Record<string, any>,
 *   chatMedia?: Record<string, any>,
 *   inboundMedia?: Record<string, any>,
 *   handoffs?: Record<string, any>,
 *   n8n?: Record<string, any>,
 *   operations?: Record<string, any>,
 *   orders?: ReturnType<typeof createOrderApiRuntime>,
 *   orderAssistance?: ReturnType<typeof createOrderAssistanceRuntime>,
 *   finance?: ReturnType<typeof createFinanceApiRuntime>,
 *   dashboard?: ReturnType<typeof createDashboardApiRuntime>,
 *   dashboardCheckpoint?: ReturnType<typeof createDashboardCheckpointRuntime>,
 *   dashboardMetrics?: ReturnType<typeof createDashboardMetricsRuntime>,
 *   leadOutcomes?: ReturnType<typeof createLeadOutcomeApiRuntime>,
 *   conversationReminders?: ReturnType<typeof createConversationReminderApiRuntime>,
 *   billing?: ReturnType<typeof createOrderBillingRuntime>,
 *   healthErrors?: ReturnType<typeof createHealthErrorsRuntime>,
 *   operationalHealth?: ReturnType<typeof createOperationalHealth>,
 *   shipping?: ReturnType<typeof createShippingApiRuntime>,
 *   storeOrders?: import('./store-order-runtime.js').StoreOrderRuntime,
 *   subjects?: Record<string, any>,
 *   trustProxy?: import('fastify').FastifyServerOptions['trustProxy']
 * }} [runtime]
 */
export function createServerApi(runtime = {}) {
  const logger = runtime.logger ?? createSafeLogger({ service: SERVICES.api });
  const readiness = runtime.readiness ?? runtime.database?.readiness;
  const environment = runtime.environment ?? process.env;
  const n8nEnabled = readBooleanFlag(
    environment.N8N_INTEGRATION_ENABLED,
    'N8N_INTEGRATION_ENABLED',
  );
  const metaWebhook = n8nEnabled
    ? undefined
    : (runtime.metaWebhook ??
      (runtime.database
        ? createDurableMetaWebhookRuntime(runtime.database, environment)
        : undefined));
  const commercial =
    runtime.commercial ??
    (runtime.database ? createCommercialRuntime(runtime.database) : undefined);
  const automationAuth =
    runtime.automationAuth ??
    (runtime.database
      ? createConfiguredAutomationAuthRuntime(runtime.database, environment)
      : undefined);
  const operationalAuth =
    runtime.operationalAuth ??
    (runtime.database
      ? createOperationalAuthRuntime({
          automationAuth,
          identity: runtime.identity,
        })
      : undefined);
  const operationCursorKey =
    environment.OPERATION_CURSOR_HMAC_KEY ?? environment.KANBAN_CURSOR_HMAC_KEY;
  const operationSecretValues = [
    environment.CONTACT_IDENTITY_ENVELOPE_KEY,
    environment.CONTACT_IDENTITY_LOOKUP_KEY,
    environment.IDEMPOTENCY_ENVELOPE_KEY,
    environment.INBOX_MESSAGE_ENVELOPE_KEY,
    environment.HANDOFF_ENVELOPE_KEY,
    operationCursorKey,
  ];
  const operationConfigurationPresent = operationSecretValues.some(Boolean);
  if (
    runtime.database &&
    operationConfigurationPresent &&
    !operationSecretValues.every(Boolean)
  ) {
    throw new Error(
      'Operation read runtime requires CONTACT_IDENTITY_ENVELOPE_KEY, CONTACT_IDENTITY_LOOKUP_KEY, IDEMPOTENCY_ENVELOPE_KEY, INBOX_MESSAGE_ENVELOPE_KEY, HANDOFF_ENVELOPE_KEY and OPERATION_CURSOR_HMAC_KEY together',
    );
  }
  const operations =
    runtime.operations ??
    (runtime.database && operationSecretValues.every(Boolean)
      ? createOperationReadRuntime(runtime.database, {
          environment: {
            ...environment,
            OPERATION_CURSOR_HMAC_KEY: operationCursorKey,
          },
          identity: runtime.identity,
        })
      : undefined);
  // ADR 028: the paid store orders n8n records, and the phone search of
  // the order list over them.
  const storeOrders =
    runtime.storeOrders ??
    createStoreOrdersForServer({ database: runtime.database, environment });
  const orders =
    runtime.orders ??
    createOrdersForServer({
      database: runtime.database,
      environment,
      operations,
      phoneDigestsFor: storeOrders?.phoneDigestsFor,
    });
  const orderAssistance =
    runtime.orderAssistance ??
    (runtime.database && orders && operations
      ? createOrderAssistanceRuntime({
          database: runtime.database,
          environment,
          orders,
          access: operations,
        })
      : undefined);
  const n8n =
    runtime.n8n ??
    (runtime.database && n8nEnabled
      ? createN8nApiRuntime(runtime.database, {
          environment,
          orders,
          orderAssistance,
        })
      : undefined);
  const handoffSecretNames = ['IDEMPOTENCY_ENVELOPE_KEY'];
  const handoffConfigurationPresent = handoffSecretNames.some((name) =>
    Boolean(environment[name]),
  );
  if (
    runtime.database &&
    handoffConfigurationPresent &&
    !handoffSecretNames.every((name) => Boolean(environment[name]))
  ) {
    throw new Error(
      'Conversation handoff runtime requires IDEMPOTENCY_ENVELOPE_KEY',
    );
  }
  const handoffs =
    runtime.handoffs ??
    (runtime.database &&
    handoffSecretNames.every((name) => Boolean(environment[name]))
      ? createConversationHandoffRuntime(runtime.database, { environment })
      : undefined);
  const conversations =
    runtime.conversations ??
    (runtime.database && n8n && handoffs && operationalAuth
      ? createConversationApiRuntime(
          runtime.database,
          operationalAuth,
          handoffs,
          n8n,
          readEnvelopeKey(
            environment.INBOX_MESSAGE_ENVELOPE_KEY,
            'INBOX_MESSAGE_ENVELOPE_KEY',
          ),
          { mediaEnabled: environment.CHAT_MEDIA_ENABLED === 'true' },
        )
      : undefined);
  const subjects =
    runtime.subjects ??
    (runtime.database &&
    typeof operations?.authorizeRead === 'function' &&
    typeof operations?.authorizeWrite === 'function'
      ? createSubjectApiRuntime(runtime.database, operations)
      : undefined);
  const chatMedia =
    runtime.chatMedia ??
    (runtime.database &&
    operationalAuth &&
    (environment.CHAT_MEDIA_ENABLED === 'true' ||
      environment.CHAT_MEDIA_READ_ENABLED === 'true')
      ? createChatMediaApiRuntime({
          repository: new PostgresChatMediaUploadRepository({
            database: runtime.database,
            processingCapacity: 2,
            bucketAlias:
              environment.CHAT_MEDIA_BUCKET_ALIAS ??
              (environment.MEDIA_S3_BUCKET === 'crm-silmer-chat-media'
                ? 'chat-operational'
                : 'chat-dev'),
            limitBytes: Number(
              environment.CHAT_MEDIA_QUOTA_BYTES ?? 1073741824,
            ),
          }),
          admissionEnabled: environment.CHAT_MEDIA_ENABLED === 'true',
          access: {
            ...operationalAuth,
            authorizeRead: operations?.authorizeRead,
          },
          spoolRoot: requireMediaSpoolRoot(environment),
          store: environment.MEDIA_S3_BUCKET
            ? new RustfsMediaStore({
                bucket: environment.MEDIA_S3_BUCKET,
                endpoint: environment.MEDIA_S3_ENDPOINT,
                region: environment.MEDIA_S3_REGION,
                accessKeyId: environment.MEDIA_S3_ACCESS_KEY_ID,
                secretAccessKey: environment.MEDIA_S3_SECRET_ACCESS_KEY,
              })
            : undefined,
          bucketAlias:
            environment.CHAT_MEDIA_BUCKET_ALIAS ??
            (environment.MEDIA_S3_BUCKET === 'crm-silmer-chat-media'
              ? 'chat-operational'
              : 'chat-dev'),
          envelopeKey: readEnvelopeKey(
            environment.INBOX_MESSAGE_ENVELOPE_KEY,
            'INBOX_MESSAGE_ENVELOPE_KEY',
          ),
        })
      : undefined);
  const inboundMedia =
    runtime.inboundMedia ??
    (runtime.database && n8n?.mediaVolume && operations?.authorizeRead
      ? createInboundMediaRuntime({
          database: runtime.database,
          access: operations,
          mediaVolume: n8n.mediaVolume,
          retained: chatMedia,
        })
      : undefined);
  const dashboardCheckpoint =
    runtime.dashboardCheckpoint ??
    (runtime.database && operations
      ? createDashboardCheckpointRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const dashboard =
    runtime.dashboard ??
    (runtime.database && operations && orders
      ? createDashboardApiRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const dashboardMetrics =
    runtime.dashboardMetrics ??
    (runtime.database && operations
      ? createDashboardMetricsRuntime(runtime.database, { access: operations })
      : undefined);
  const leadOutcomes =
    runtime.leadOutcomes ??
    (runtime.database && operations && orders
      ? createLeadOutcomeApiRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const conversationReminders =
    runtime.conversationReminders ??
    (runtime.database && operations
      ? createConversationReminderApiRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const finance =
    runtime.finance ??
    (runtime.database && operations && orders
      ? createFinanceApiRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const shipping =
    runtime.shipping ??
    (runtime.database && operations
      ? createShippingApiRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const billingEnabled = readBooleanFlag(
    environment.ORDER_BILLING_ENABLED,
    'ORDER_BILLING_ENABLED',
  );
  const billingReceiveEnabled = readBooleanFlag(
    environment.ORDER_BILLING_RECEIVE_ENABLED,
    'ORDER_BILLING_RECEIVE_ENABLED',
  );
  const billing =
    runtime.billing ??
    (runtime.database && operations && (billingEnabled || billingReceiveEnabled)
      ? createOrderBillingRuntime(runtime.database, {
          access: operations,
          environment,
        })
      : undefined);
  const api = createApi(
    { trustProxy: runtime.trustProxy ?? false },
    {
      ...runtime,
      finance,
      dashboard,
      dashboardCheckpoint,
      dashboardMetrics,
      leadOutcomes,
      conversationReminders,
      billing,
      shipping,
      automationAuth,
      commercial,
      chatMedia,
      inboundMedia,
      conversations,
      handoffs,
      logger,
      metaWebhook,
      n8n,
      operations,
      orders,
      orderAssistance,
      readiness,
      storeOrders,
      subjects,
    },
  );
  const database = runtime.database;
  const closeDatabase = database?.close;
  if (closeDatabase) {
    // onClose hooks run in reverse registration order: the collector added
    // below must finish using its transactions before the pool is closed.
    api.addHook('onClose', closeDatabase.bind(database));
  }
  const operationalSignals = database
    ? new PostgresOperationalSignals({ database })
    : undefined;
  const operationalHealth =
    runtime.operationalHealth ??
    createOperationalHealth({
      sample: async () => {
        if (!operationalSignals) throw new Error('UNAVAILABLE');
        return operationalSignals.sample([
          'external_effects',
          'media-retention',
          ...(environment.CHAT_MEDIA_ENABLED === 'true' ? ['chat_media'] : []),
        ]);
      },
      onFailure: () =>
        logger.error('api_request_failed', {
          error_code: 'OPERATIONAL_SAMPLING_FAILED',
        }),
    });
  api.get('/api/health/operations', async (_request, reply) => {
    const result = operationalHealth.read();
    return reply
      .header('cache-control', 'no-store')
      .code(result.statusCode)
      .send(result.body);
  });
  api.addHook('onReady', async () => {
    operationalHealth.start();
  });
  api.addHook('onClose', async () => {
    await operationalHealth.stop();
  });
  const healthErrors =
    runtime.healthErrors ??
    (database && runtime.identity && environment.IDEMPOTENCY_ENVELOPE_KEY
      ? createHealthErrorsRuntime({
          database,
          identity: runtime.identity,
          envelopeKey: Buffer.from(
            environment.IDEMPOTENCY_ENVELOPE_KEY,
            'base64url',
          ),
        })
      : undefined);
  if (healthErrors) {
    registerHealthErrorsRoutes(api, healthErrors);
    /** @type {Set<Promise<unknown>>} */
    const pendingIncidents = new Set();
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let incidentCleanup;
    let cleanupRunning = false;
    api.addHook('onReady', async () => {
      const purge = () => {
        if (cleanupRunning) return;
        cleanupRunning = true;
        const pending = (async () => {
          const startedAt = Date.now();
          let result;
          // Release DB locks between small batches; bound the whole daily pass.
          for (let batch = 0; batch < 20; batch++) {
            result = await healthErrors.cleanup();
            if (!result?.batchFull || Date.now() - startedAt >= 5000) break;
            await new Promise((resolve) => globalThis.setImmediate(resolve));
          }
          if (result?.batchFull || result?.skipped)
            logger.warn('api_request_failed', {
              error_code: 'OPERATIONAL_CLEANUP_INCOMPLETE',
            });
        })()
          .catch(() => {
            logger.error('api_request_failed', {
              error_code: 'OPERATIONAL_CLEANUP_INCOMPLETE',
            });
          })
          .finally(() => {
            cleanupRunning = false;
          });
        pendingIncidents.add(pending);
        void pending.finally(() => pendingIncidents.delete(pending));
      };
      purge();
      incidentCleanup = globalThis.setInterval(purge, 24 * 60 * 60_000);
      incidentCleanup.unref();
    });
    api.addHook('onResponse', async (request, reply) => {
      // Failure collection must never delay or replace the original response.
      // The console's own errors are excluded to prevent a feedback loop.
      if (
        reply.statusCode < 500 ||
        pendingIncidents.size >= 16 ||
        request.routeOptions.url === '/api/health/operations' ||
        request.routeOptions.url?.startsWith('/api/v1/admin/health-errors')
      )
        return;
      const header = (/** @type {string} */ name) => {
        const value = reply.getHeader(name);
        return typeof value === 'string' ? value : undefined;
      };
      const pending = healthErrors
        .recordApiFailure({
          statusCode: reply.statusCode,
          readiness: request.routeOptions.url === '/api/health/ready',
          requestId: header('x-request-id'),
          correlationId: header('x-correlation-id'),
        })
        .catch(() => {
          logger.error('api_request_failed', { error_code: 'UNHANDLED_ERROR' });
        });
      pendingIncidents.add(pending);
      void pending.finally(() => pendingIncidents.delete(pending));
    });
    api.addHook('onClose', async () => {
      if (incidentCleanup) globalThis.clearInterval(incidentCleanup);
      await Promise.allSettled(pendingIncidents);
    });
  }
  return api;
}

/** @param {Record<string,string|undefined>} environment */
export function requireMediaSpoolRoot(environment) {
  const root = environment.CHAT_MEDIA_SPOOL_ROOT;
  const canonical = (/** @type {string} */ path) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (
    !root ||
    (environment.PRIVATE_MEDIA_ROOT &&
      canonical(root) === canonical(environment.PRIVATE_MEDIA_ROOT))
  )
    throw new Error('A distinct CHAT_MEDIA_SPOOL_ROOT is required');
  return resolve(root);
}

/**
 * Orders stay disabled until FAB_CODE is configured. They reuse the operation
 * runtime's session guards, so they also need that runtime; once FAB_CODE is
 * set, a missing envelope key is a startup error.
 *
 * @param {{database?: any, environment: Record<string, string|undefined>, operations?: Record<string, any>, phoneDigestsFor?: (query: string) => string[]}} input
 */
export function createOrdersForServer({
  database,
  environment,
  operations,
  phoneDigestsFor,
}) {
  if (!database || !operations || !environment.FAB_CODE) return undefined;
  return createOrderApiRuntime(database, {
    access: /** @type {any} */ (operations),
    environment,
    phoneDigestsFor,
    // ADR 023: the art files turn on with the OBJECT_STORAGE_* variables.
    storage: objectStorageFromEnvironment(environment),
  });
}

/**
 * Keeps the technical actor disabled until both canonical credentials exist.
 * Any partial configuration fails during startup.
 *
 * @param {{query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}>}} database
 * @param {Record<string, string|undefined>} environment
 */
export function createConfiguredAutomationAuthRuntime(database, environment) {
  const names = [
    'CRM_AUTOMATION_CLIENT_ID',
    'CRM_AUTOMATION_CLIENT_SECRET',
    'CRM_AUTOMATION_PREVIOUS_CLIENT_SECRET',
  ];
  if (names.every((name) => environment[name] === undefined)) return undefined;
  return createAutomationAuthRuntime({
    auditPort: new PostgresAuditTrail(database),
    environment,
  });
}

/**
 * Legacy Phase 0 sandbox helper. Production wiring never calls this in-memory
 * runtime; it remains only for the isolated synthetic smoke contract.
 *
 * @param {Record<string, string|undefined>} [environment]
 */
export function createMetaWebhookRuntime(environment = process.env) {
  const appSecret = environment.META_APP_SECRET;
  const verifyToken = environment.META_VERIFY_TOKEN;
  if (!appSecret || !verifyToken) return undefined;

  const eventStore = new InMemoryMetaEventStore();
  return Object.freeze({
    verifyToken,
    /** @param {{rawBody: Buffer, signature: unknown}} input */
    process: (input) =>
      processMetaWebhook({
        appSecret,
        eventStore,
        onEvent: async () => undefined,
        ...input,
      }),
  });
}

/**
 * Creates the production webhook only when its complete durable configuration
 * exists. Partial configuration is a startup error rather than an in-memory
 * fallback.
 *
 * @param {ReturnType<typeof createDatabase>|{query: Function, transaction: Function}} database
 * @param {Record<string, string|undefined>} [environment]
 */
export function createDurableMetaWebhookRuntime(
  database,
  environment = process.env,
) {
  const names = [
    'META_APP_SECRET',
    'META_VERIFY_TOKEN',
    'META_WHATSAPP_BUSINESS_ACCOUNT_ID',
    'META_WHATSAPP_PHONE_NUMBER_ID',
    'META_WEBHOOK_PAYLOAD_ENVELOPE_KEY',
  ];
  if (names.every((name) => !environment[name])) return undefined;

  const appSecret = requireConfiguredSecret(
    environment.META_APP_SECRET,
    'META_APP_SECRET',
  );
  const verifyToken = requireConfiguredSecret(
    environment.META_VERIFY_TOKEN,
    'META_VERIFY_TOKEN',
  );
  const envelopeKey = readEnvelopeKey(
    environment.META_WEBHOOK_PAYLOAD_ENVELOPE_KEY,
    'META_WEBHOOK_PAYLOAD_ENVELOPE_KEY',
  );
  const normalize = createMetaWhatsAppNormalizer({
    businessAccountId: requireConfiguredSecret(
      environment.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
      'META_WHATSAPP_BUSINESS_ACCOUNT_ID',
    ),
    phoneNumberId: requireConfiguredSecret(
      environment.META_WHATSAPP_PHONE_NUMBER_ID,
      'META_WHATSAPP_PHONE_NUMBER_ID',
    ),
  });
  const inbox = new PostgresWebhookInbox({ database, envelopeKey });
  return createWhatsAppWebhookRuntime({
    appSecret,
    inbox,
    normalize,
    verifyToken,
  });
}

/** @param {string|undefined} value @param {string} name */
function requireConfiguredSecret(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required when the Meta webhook is enabled`);
  }
  return value;
}

/** @param {string|undefined} value @param {string} name */
function readEnvelopeKey(value, name) {
  const encoded = requireConfiguredSecret(value, name);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error(`${name} must use base64url`);
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return key;
}

/** @param {string|undefined} value @param {string} name */
function readBooleanFlag(value, name) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const logger = createSafeLogger({ service: SERVICES.api });
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    const database = createDatabase({
      connectionString: process.env.DATABASE_URL ?? '',
    });
    const api = createServerApi({
      database,
      identity: createIdentityApiRuntime(database),
      logger,
      trustProxy: 'loopback, linklocal, uniquelocal',
    });
    await api.listen({ host, port });
  } catch (error) {
    logger.error('api_start_failed', {
      error_code:
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'API_START_FAILED',
    });
    process.exitCode = 1;
  }
}
