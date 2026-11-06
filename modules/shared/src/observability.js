import { randomUUID } from 'node:crypto';

export const REDACTED_FIELD_NAMES = Object.freeze([
  'attachment',
  'authorization',
  'body',
  'comprovante',
  'cookie',
  'email',
  'message',
  'password',
  'payload',
  'phone',
  'prompt',
  'response',
  'secret',
  'telefone',
  'token',
]);

const allowedContextFields = new Set([
  // AGENTE-FAIL-01: counts of one stall sweep.
  'candidates',
  'correlation_id',
  'duration_ms',
  'error_code',
  'failed',
  'handed_off',
  'job_type',
  'metric',
  'outcome',
  'queue',
  'request_id',
  'status_code',
  'unit',
  'value',
]);
const traceIdPattern =
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/iu;
const allowedServices = new Set(['crm-silmer-api', 'crm-silmer-worker']);
const allowedEvents = new Set([
  'api_readiness_failed',
  'api_request_completed',
  'api_request_failed',
  'api_request_started',
  'api_start_failed',
  'automation_stall_sweep_completed',
  'metric_observed',
  'synthetic_failure',
  'worker_job_failed',
  'worker_started',
  'worker_stopped',
]);
const allowedMetrics = new Set([
  'api_5xx_total',
  'api_duration_ms',
  'api_requests_total',
  'worker_heartbeat_unixtime_seconds',
  'worker_jobs_failed_total',
  'worker_oldest_job_age_seconds',
]);
/** @type {ReadonlyMap<string, { allowed: ReadonlySet<string>, fallback?: string }>} */
const categoricalPolicies = new Map([
  [
    'error_code',
    {
      allowed: new Set([
        'API_START_FAILED',
        'JOB_FAILED',
        'WORKER_HEALTH_PUBLISH_FAILED',
        'OPERATIONAL_SAMPLING_FAILED',
        'OPERATIONAL_CLEANUP_INCOMPLETE',
        'MEDIA_LEASE_LOST',
        'MEDIA_PROCESS_UNAVAILABLE',
        'CLAM_SIGNATURE_REFRESH_FAILED',
        'READINESS_CHECK_FAILED',
        'SYNTHETIC_FAILURE',
        'UNHANDLED_ERROR',
      ]),
      fallback: 'UNCLASSIFIED_ERROR',
    },
  ],
  [
    'job_type',
    {
      allowed: new Set([
        'outbox_delivery',
        'unknown_job',
        'automation.stall.sweep',
        'chat_media.process',
        'media.signature.refresh',
      ]),
      fallback: 'unknown_job',
    },
  ],
  ['metric', { allowed: allowedMetrics }],
  [
    'outcome',
    {
      allowed: new Set(['failure', 'outcome_unknown', 'success']),
      fallback: 'unknown_outcome',
    },
  ],
  [
    'queue',
    {
      allowed: new Set([
        'default',
        'external_effects',
        'chat_media',
        'media-retention',
      ]),
      fallback: 'unknown_queue',
    },
  ],
  [
    'unit',
    {
      allowed: new Set([
        'count',
        'milliseconds',
        'seconds',
        'unixtime_seconds',
      ]),
      fallback: 'unknown_unit',
    },
  ],
]);
const traceFields = new Set(['correlation_id', 'request_id']);

/**
 * Accepts only opaque identifiers. Human-readable or malformed inbound values
 * are replaced instead of being echoed into logs or response headers.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTraceId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && traceIdPattern.test(candidate)
    ? candidate
    : randomUUID();
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {string} service
 * @param {string} event
 * @param {Record<string, unknown>} context
 * @param {() => Date} clock
 */
export function createSafeLogRecord(
  level,
  service,
  event,
  context = {},
  clock = () => new Date(),
) {
  /** @type {Record<string, unknown>} */
  const record = {
    timestamp: clock().toISOString(),
    level,
    service: allowedServices.has(service) ? service : 'unknown_service',
    event: allowedEvents.has(event) ? event : 'unknown_event',
  };
  let redactedFieldCount = 0;

  for (const [field, value] of Object.entries(context)) {
    if (!allowedContextFields.has(field)) {
      redactedFieldCount += 1;
      continue;
    }

    if (traceFields.has(field)) {
      if (typeof value === 'string' && traceIdPattern.test(value)) {
        record[field] = value;
      } else {
        redactedFieldCount += 1;
      }
      continue;
    }

    const policy = categoricalPolicies.get(field);
    if (policy) {
      if (typeof value === 'string' && policy.allowed.has(value)) {
        record[field] = value;
      } else {
        redactedFieldCount += 1;
        if (policy.fallback !== undefined) record[field] = policy.fallback;
      }
      continue;
    }

    if (isFiniteNumber(value)) {
      record[field] = value;
    } else {
      redactedFieldCount += 1;
    }
  }

  if (redactedFieldCount > 0) {
    record.redacted_field_count = redactedFieldCount;
  }

  return record;
}

/**
 * @param {{ service: string, sink?: (record: Record<string, unknown>) => void, clock?: () => Date }} options
 */
export function createSafeLogger({
  service,
  sink = (record) => console.log(JSON.stringify(record)),
  clock = () => new Date(),
}) {
  /**
   * @param {'debug' | 'info' | 'warn' | 'error'} level
   * @param {string} event
   * @param {Record<string, unknown>} [context]
   */
  function write(level, event, context = {}) {
    const record = createSafeLogRecord(level, service, event, context, clock);
    sink(record);
    return record;
  }

  return Object.freeze({
    debug: write.bind(undefined, 'debug'),
    error: write.bind(undefined, 'error'),
    info: write.bind(undefined, 'info'),
    warn: write.bind(undefined, 'warn'),
  });
}

export class MetricRegistry {
  /**
   * @param {{ logger: ReturnType<typeof createSafeLogger> }} options
   */
  constructor({ logger }) {
    this.logger = logger;
    /** @type {Map<string, number>} */
    this.values = new Map();
  }

  /**
   * @param {string} metric
   * @param {number} value
   * @param {Record<string, unknown>} [context]
   */
  record(metric, value, context = {}) {
    if (!allowedMetrics.has(metric) || !isFiniteNumber(value)) {
      throw new TypeError(
        'Metric name and value must be bounded technical data',
      );
    }

    this.values.set(metric, value);
    this.logger.info('metric_observed', { ...context, metric, value });
  }

  /**
   * @param {string} metric
   * @param {number} [increment]
   * @param {Record<string, unknown>} [context]
   */
  increment(metric, increment = 1, context = {}) {
    const value = (this.values.get(metric) ?? 0) + increment;
    this.record(metric, value, context);
  }

  snapshot() {
    return Object.freeze(Object.fromEntries(this.values));
  }
}
