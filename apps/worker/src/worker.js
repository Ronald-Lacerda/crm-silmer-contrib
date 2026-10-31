import { pathToFileURL } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';

import { createDatabase } from '@crm-silmer/database';
import {
  ClamAvMediaScanner,
  ClamAvDaemon,
  ClamAvSignatureRefresh,
  CHAT_MEDIA_PROCESS_JOB_TYPE,
  CHAT_MEDIA_QUEUE,
  createChatMediaProcessJobHandler,
  createMediaDeleteJobHandler,
  createN8nCommandDeliveryClient,
  createN8nCommandJobHandler,
  MEDIA_DELETE_JOB_TYPE,
  MEDIA_RETENTION_QUEUE,
  N8N_COMMAND_JOB_TYPE,
  N8N_COMMAND_QUEUE,
  PostgresJobQueue,
  PostgresChatMediaRepository,
  PostgresChatMediaDraftCleanup,
  ChatMediaDraftCleanupScheduler,
  RustfsMediaStore,
  PostgresTransientMediaRepository,
  PrivateMediaVolume,
} from '@crm-silmer/integration-reliability';
import { createSafeLogger, MetricRegistry, SERVICES } from '@crm-silmer/shared';

/**
 * Process boundary for asynchronous jobs. Concrete handlers are injected by
 * each domain module, keeping queue reliability independent from job payloads.
 */
export class WorkerRuntime {
  /**
   * @param {{
   *   handlers?: Record<string, (job: Readonly<Record<string, unknown>>, context: {heartbeat: () => Promise<boolean>, markEffectStarted: (input: {provider: string}) => Promise<boolean>}) => Promise<{outcome: 'sent'|'failed'|'outcome_unknown', errorCode?: string, providerExternalId?: string, retryable?: boolean, retrySafe?: boolean}>>,
   *   heartbeatIntervalMs?: number,
   *   leaseMs?: number,
   *   logger?: ReturnType<typeof createSafeLogger>,
   *   metrics?: MetricRegistry,
   *   now?: () => number,
   *   pollIntervalMs?: number,
   *   queueName?: string,
   *   queue?: {claim: Function, heartbeat: Function, markEffectStarted: Function, settle: Function},
   *   workerId?: string
   * }} [options]
   */
  constructor(options = {}) {
    this.name = SERVICES.worker;
    this.logger =
      options.logger ?? createSafeLogger({ service: SERVICES.worker });
    this.metrics =
      options.metrics ?? new MetricRegistry({ logger: this.logger });
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.queue = options.queue;
    this.queueName = options.queueName ?? 'default';
    this.handlers = Object.freeze({ ...(options.handlers ?? {}) });
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    /** @type {NodeJS.Timeout | undefined} */
    this.heartbeatTimer = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this.pollTimer = undefined;
    /** @type {Promise<void>|undefined} */
    this.pollInFlight = undefined;
  }

  /** @returns {Promise<void>} */
  async start() {
    if (this.heartbeatTimer) return;

    this.emitHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.emitHeartbeat(),
      this.heartbeatIntervalMs,
    );
    if (this.queue) {
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
      this.poll();
    }
    this.logger.info('worker_started');
  }

  emitHeartbeat() {
    this.metrics.record(
      'worker_heartbeat_unixtime_seconds',
      Math.floor(this.now() / 1000),
    );
  }

  /**
   * Records bounded technical dimensions only. Job content and errors are not
   * accepted by this boundary.
   *
   * @param {{ ageSeconds?: number, errorCode?: string, jobType?: string, queue?: string }} [event]
   */
  recordJobFailure(event = {}) {
    const context = {
      error_code: event.errorCode ?? 'JOB_FAILED',
      job_type: event.jobType ?? 'unknown_job',
      queue: event.queue ?? 'default',
    };
    this.metrics.increment('worker_jobs_failed_total', 1, context);
    this.metrics.record(
      'worker_oldest_job_age_seconds',
      Math.max(0, event.ageSeconds ?? 0),
      context,
    );
    this.logger.error('worker_job_failed', context);
  }

  /** Processes at most one claim batch without overlapping another poll. */
  async poll() {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.runOnce()
      .then(() => {})
      .finally(() => {
        this.pollInFlight = undefined;
      });
    return this.pollInFlight;
  }

  /** @returns {Promise<number>} */
  async runOnce() {
    const queue = this.queue;
    if (!queue) return 0;
    const jobs = await queue.claim({
      leaseMs: this.leaseMs,
      limit: 1,
      now: new Date(this.now()),
      queue: this.queueName,
      workerId: this.workerId,
    });
    for (const job of jobs) {
      await this.processJob(job);
    }
    return jobs.length;
  }

  /** @param {Readonly<Record<string, any>>} job */
  async processJob(job) {
    const queue = this.queue;
    if (!queue) throw new Error('Worker queue is not configured');
    const handler = this.handlers[job.jobType];
    let effectStarted = false;
    const heartbeat = () =>
      queue.heartbeat({
        attemptId: job.attemptId,
        jobId: job.id,
        leaseMs: this.leaseMs,
        now: new Date(this.now()),
        workerId: this.workerId,
      });
    /** @param {{provider: string}} input */
    const markEffectStarted = async ({ provider }) => {
      const marked = await queue.markEffectStarted({
        attemptId: job.attemptId,
        jobId: job.id,
        now: new Date(this.now()),
        provider,
        workerId: this.workerId,
      });
      if (!marked) throw new Error('Job lease was lost before effect start');
      effectStarted = true;
      return true;
    };
    const context = Object.freeze({
      heartbeat,
      markEffectStarted,
    });

    try {
      if (!handler) throw new Error('No handler registered for job type');
      const result = await handler(job, context);
      if (result.outcome !== 'sent') {
        this.recordJobFailure({
          errorCode:
            result.errorCode ??
            (result.outcome === 'outcome_unknown'
              ? 'OUTCOME_UNKNOWN'
              : 'JOB_FAILED'),
          jobType: job.jobType,
          queue: job.queue,
        });
      }
      await queue.settle({
        attemptId: job.attemptId,
        errorCode: result.errorCode,
        jobId: job.id,
        now: new Date(this.now()),
        outcome: result.outcome,
        providerExternalId: result.providerExternalId,
        retryable: result.retryable ?? false,
        retrySafe: result.retrySafe ?? false,
        workerId: this.workerId,
      });
    } catch (error) {
      const errorCode = technicalErrorCode(error);
      this.recordJobFailure({
        errorCode,
        jobType: job.jobType,
        queue: job.queue,
      });
      await queue.settle({
        attemptId: job.attemptId,
        errorCode,
        jobId: job.id,
        now: new Date(this.now()),
        outcome: effectStarted ? 'outcome_unknown' : 'failed',
        retryable: !effectStarted,
        retrySafe: !effectStarted,
        workerId: this.workerId,
      });
    }
  }

  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.pollInFlight;
    this.logger.info('worker_stopped');
  }
}

export class MediaRetentionScheduler {
  /** @param {{repository: {scheduleExpiredDeletions: Function, scheduleTerminalJourneyDeletions: Function}, intervalMs?: number, logger?: ReturnType<typeof createSafeLogger>}} options */
  constructor(options) {
    if (
      !options?.repository ||
      typeof options.repository.scheduleExpiredDeletions !== 'function'
    ) {
      throw new TypeError(
        'Media retention scheduler requires scheduleExpiredDeletions',
      );
    }
    if (
      typeof options.repository.scheduleTerminalJourneyDeletions !== 'function'
    ) {
      throw new TypeError(
        'Media retention scheduler requires scheduleTerminalJourneyDeletions',
      );
    }
    this.repository = options.repository;
    this.intervalMs = options.intervalMs ?? 60_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new TypeError('Media retention interval must be at least 1000ms');
    }
    this.logger =
      options.logger ?? createSafeLogger({ service: SERVICES.worker });
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
    /** @type {Promise<void>|undefined} */
    this.inFlight = undefined;
  }

  async start() {
    if (this.timer) return;
    await this.runOnce();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  poll() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce()
      .catch((error) => {
        this.logger.error('worker_job_failed', {
          error_code: technicalErrorCode(error),
          job_type: 'media.retention.scan',
          queue: MEDIA_RETENTION_QUEUE,
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async runOnce() {
    await this.repository.scheduleTerminalJourneyDeletions();
    await this.repository.scheduleExpiredDeletions();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}

export const AUTOMATION_STALL_SWEEP_JOB = 'automation.stall.sweep';

/**
 * AGENTE-FAIL-01: every minute, hands to a seller the conversations whose
 * customer message the assistant left unanswered. The sweep itself is a port
 * of the n8n domain module; this loop only paces it and logs bounded codes.
 */
export class AutomationStallScheduler {
  /** @param {{sweeper: {sweep: () => Promise<unknown>}, intervalMs?: number, logger?: ReturnType<typeof createSafeLogger>}} options */
  constructor(options) {
    if (!options?.sweeper || typeof options.sweeper.sweep !== 'function') {
      throw new TypeError('Automation stall scheduler requires sweep');
    }
    this.sweeper = options.sweeper;
    this.intervalMs = options.intervalMs ?? 60_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new TypeError('Automation stall interval must be at least 1000ms');
    }
    this.logger =
      options.logger ?? createSafeLogger({ service: SERVICES.worker });
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
    /** @type {Promise<void>|undefined} */
    this.inFlight = undefined;
  }

  async start() {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  poll() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sweeper
      .sweep()
      .then(() => {})
      .catch((error) => {
        this.logger.error('worker_job_failed', {
          error_code: technicalErrorCode(error),
          job_type: AUTOMATION_STALL_SWEEP_JOB,
          queue: 'default',
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}

/**
 * Loads the stall sweep from the n8n domain module at the executable
 * boundary, as `loadN8nCommandStore` does.
 *
 * @param {Record<string, unknown>} database
 * @param {Record<string, string|undefined>} environment
 * @param {(specifier: string) => Promise<Record<string, any>>} [importModule]
 */
export async function loadAutomationStallSweeper(
  database,
  environment,
  importModule = (specifier) => import(specifier),
) {
  const domainModule = await importModule('@crm-silmer/n8n-integration');
  if (typeof domainModule.createPostgresAutomationStallSweeper !== 'function') {
    throw technicalStartupError('AUTOMATION_STALL_SWEEPER_UNAVAILABLE');
  }
  return domainModule.createPostgresAutomationStallSweeper({
    database,
    environment,
  });
}

/**
 * Production composition root. The n8n domain store remains a port so this
 * package has no compile-time dependency on the domain module.
 *
 * @param {{
 *   client?: {prepareDelivery: Function},
 *   commandStore: {
 *     loadForDelivery: (commandId: string, context: Record<string, unknown>) => Promise<unknown>,
 *     markProcessing: (commandId: string, context: Record<string, unknown>) => Promise<unknown>,
 *     markDelivered: (commandId: string, context: Record<string, unknown>) => Promise<unknown>,
 *     markFailed: (commandId: string, context: Record<string, unknown>) => Promise<unknown>,
 *     markOutcomeUnknown: (commandId: string, context: Record<string, unknown>) => Promise<unknown>,
 *   },
 *   database: {query: (sql: string, values?: unknown[]) => Promise<{rows: Array<Record<string, unknown>>}>, transaction: <T>(work: (client: any) => Promise<T>) => Promise<T>},
 *   environment?: Record<string, string|undefined>,
 *   fetchImpl?: (input: URL, init: RequestInit) => Promise<{status: number, json: () => Promise<unknown>}>,
 *   logger?: ReturnType<typeof createSafeLogger>,
 *   metrics?: MetricRegistry,
 *   queue?: {claim: Function, heartbeat: Function, markEffectStarted: Function, settle: Function},
 *   workerId?: string,
 * }} options
 */
export function createWorkerRuntime(options) {
  if (
    !options?.database ||
    typeof options.database.transaction !== 'function'
  ) {
    throw new TypeError('A transactional database is required');
  }
  const environment = options.environment ?? process.env;
  const queue =
    options.queue ?? new PostgresJobQueue({ database: options.database });
  const client =
    options.client ??
    createN8nCommandDeliveryClient({
      clientId: requiredEnvironment(environment, 'N8N_COMMAND_CLIENT_ID'),
      clientSecret: requiredEnvironment(
        environment,
        'N8N_COMMAND_CLIENT_SECRET',
      ),
      endpoint: requiredEnvironment(environment, 'N8N_COMMAND_URL'),
      allowInsecureLocal:
        environment.APP_ENV === 'development' &&
        environment.N8N_COMMAND_ALLOW_INSECURE_LOCAL === 'true',
      fetchImpl: options.fetchImpl,
      replaySafe: environment.N8N_COMMAND_REPLAY_SAFE === 'true',
      timeoutMs: optionalPositiveInteger(
        environment.N8N_COMMAND_TIMEOUT_MS,
        10_000,
        'N8N_COMMAND_TIMEOUT_MS',
      ),
    });
  return new WorkerRuntime({
    handlers: {
      [N8N_COMMAND_JOB_TYPE]: createN8nCommandJobHandler({
        client,
        commandStore: options.commandStore,
      }),
    },
    logger: options.logger,
    metrics: options.metrics,
    queue,
    queueName: N8N_COMMAND_QUEUE,
    workerId: options.workerId,
  });
}

/** @param {{database: any, logger?: ReturnType<typeof createSafeLogger>, mediaVolume: {delete: Function}, metrics?: MetricRegistry, queue?: any, repository: any, workerId?: string}} options */
export function createMediaRetentionWorkerRuntime(options) {
  if (
    !options?.database ||
    typeof options.database.transaction !== 'function'
  ) {
    throw new TypeError('A transactional database is required');
  }
  return new WorkerRuntime({
    handlers: {
      [MEDIA_DELETE_JOB_TYPE]: createMediaDeleteJobHandler({
        mediaVolume: options.mediaVolume,
        repository: options.repository,
      }),
    },
    logger: options.logger,
    metrics: options.metrics,
    queue:
      options.queue ?? new PostgresJobQueue({ database: options.database }),
    queueName: MEDIA_RETENTION_QUEUE,
    workerId: options.workerId,
  });
}

/** @param {{database: any,environment?: Record<string,string|undefined>,logger?: ReturnType<typeof createSafeLogger>,queue?: any,repository?: any,store?: any,spoolRoot?: string,workerId?: string}} options */
export function createChatMediaWorkerRuntime(options) {
  const environment = options.environment ?? process.env;
  const repository =
    options.repository ??
    new PostgresChatMediaRepository({ database: options.database });
  const store =
    options.store ??
    new RustfsMediaStore({
      bucket: requiredEnvironment(environment, 'MEDIA_S3_BUCKET'),
      endpoint: requiredEnvironment(environment, 'MEDIA_S3_ENDPOINT'),
      region: requiredEnvironment(environment, 'MEDIA_S3_REGION'),
      accessKeyId: requiredEnvironment(environment, 'MEDIA_S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment(
        environment,
        'MEDIA_S3_SECRET_ACCESS_KEY',
      ),
    });
  return new WorkerRuntime({
    handlers: {
      [CHAT_MEDIA_PROCESS_JOB_TYPE]: createChatMediaProcessJobHandler({
        repository,
        store,
        spoolRoot:
          options.spoolRoot ??
          requiredEnvironment(environment, 'CHAT_MEDIA_SPOOL_ROOT'),
        bucketAlias:
          environment.MEDIA_S3_BUCKET === 'crm-silmer-chat-media'
            ? 'chat-operational'
            : 'chat-dev',
      }),
    },
    queue:
      options.queue ?? new PostgresJobQueue({ database: options.database }),
    queueName: CHAT_MEDIA_QUEUE,
    logger: options.logger,
    workerId: options.workerId,
  });
}

/** Starts text delivery without waiting for an external signature CDN.
 * @param {{commandWorker: {start: Function},mediaWorker: {start: Function},chatMediaWorker?: {start: Function},chatMediaCleanup?:{start:Function},retentionScheduler: {start: Function},signatureRefresh: {start: () => Promise<void>},scannerDaemon?: {start: () => Promise<void>},stallScheduler?: {start: Function}}} services */
export async function startWorkerServices({
  commandWorker,
  mediaWorker,
  chatMediaWorker,
  chatMediaCleanup,
  retentionScheduler,
  signatureRefresh,
  scannerDaemon,
  stallScheduler,
}) {
  await commandWorker.start();
  await stallScheduler?.start();
  await scannerDaemon?.start();
  await mediaWorker.start();
  await chatMediaWorker?.start();
  await chatMediaCleanup?.start();
  await retentionScheduler.start();
  void signatureRefresh.start();
}

/**
 * Dynamically loads the domain adapter only at the executable boundary. Tests
 * and modules depend exclusively on the store port above.
 *
 * @param {Record<string, unknown>} database
 * @param {Record<string, string|undefined>} environment
 * @param {(specifier: string) => Promise<Record<string, any>>} [importModule]
 */
export async function loadN8nCommandStore(
  database,
  environment,
  importModule = (specifier) => import(specifier),
) {
  const packageName = '@crm-silmer/n8n-integration';
  const domainModule = await importModule(packageName);
  if (typeof domainModule.createPostgresN8nCommandStore === 'function') {
    return domainModule.createPostgresN8nCommandStore({
      database,
      environment,
    });
  }
  if (typeof domainModule.PostgresN8nCommandStore === 'function') {
    return new domainModule.PostgresN8nCommandStore({
      database,
      environment,
    });
  }
  throw technicalStartupError('N8N_COMMAND_STORE_UNAVAILABLE');
}

/**
 * @param {{environment?: Record<string, string|undefined>, importModule?: (specifier: string) => Promise<Record<string, any>>, logger?: ReturnType<typeof createSafeLogger>}} [options]
 */
export async function startWorkerFromEnvironment(options = {}) {
  const environment = options.environment ?? process.env;
  const logger =
    options.logger ?? createSafeLogger({ service: SERVICES.worker });
  const database = createDatabase({
    applicationName: SERVICES.worker,
    connectionString: requiredEnvironment(environment, 'DATABASE_URL'),
  });
  const scannerDaemon = new ClamAvDaemon({
    onFailure: () =>
      logger.error('worker_job_failed', {
        error_code: 'CLAM_DAEMON_UNAVAILABLE',
        job_type: 'media.scanner',
        queue: 'default',
      }),
  });
  const signatureRefresh = new ClamAvSignatureRefresh({
    onUpdated: () => scannerDaemon.restart(),
    onFailure: () =>
      logger.error('worker_job_failed', {
        error_code: 'CLAM_SIGNATURE_REFRESH_FAILED',
        job_type: 'media.signature.refresh',
        queue: 'default',
      }),
  });
  try {
    const commandStore = await loadN8nCommandStore(
      database,
      environment,
      options.importModule,
    );
    const queue = new PostgresJobQueue({ database });
    const repository = new PostgresTransientMediaRepository({ database });
    const mediaVolume = new PrivateMediaVolume({
      maxBytes: requiredPositiveInteger(environment, 'PRIVATE_MEDIA_MAX_BYTES'),
      maxFileBytes: requiredPositiveInteger(
        environment,
        'PRIVATE_MEDIA_MAX_FILE_BYTES',
      ),
      repository,
      rootDirectory: requiredEnvironment(environment, 'PRIVATE_MEDIA_ROOT'),
      scanner: new ClamAvMediaScanner(),
    });
    const commandWorker = createWorkerRuntime({
      commandStore,
      database,
      environment,
      logger,
      queue,
      workerId: `n8n-${process.pid}`,
    });
    const mediaWorker = createMediaRetentionWorkerRuntime({
      database,
      logger,
      mediaVolume,
      queue,
      repository,
      workerId: `media-${process.pid}`,
    });
    const retentionScheduler = new MediaRetentionScheduler({
      intervalMs: optionalPositiveInteger(
        environment.MEDIA_RETENTION_SCAN_INTERVAL_MS,
        60_000,
        'MEDIA_RETENTION_SCAN_INTERVAL_MS',
      ),
      logger,
      repository,
    });
    const chatMediaWorker =
      environment.CHAT_MEDIA_ENABLED === 'true'
        ? createChatMediaWorkerRuntime({
            database,
            environment,
            queue,
            logger,
            workerId: `chat-media-${process.pid}`,
          })
        : undefined;
    const chatMediaCleanup =
      environment.CHAT_MEDIA_ENABLED === 'true'
        ? new ChatMediaDraftCleanupScheduler({
            cleanup: new PostgresChatMediaDraftCleanup({
              database,
              spoolRoot: requiredEnvironment(
                environment,
                'CHAT_MEDIA_SPOOL_ROOT',
              ),
              bucketAlias:
                environment.MEDIA_S3_BUCKET === 'crm-silmer-chat-media'
                  ? 'chat-operational'
                  : 'chat-dev',
              store: new RustfsMediaStore({
                bucket: requiredEnvironment(environment, 'MEDIA_S3_BUCKET'),
                endpoint: requiredEnvironment(environment, 'MEDIA_S3_ENDPOINT'),
                region: requiredEnvironment(environment, 'MEDIA_S3_REGION'),
                accessKeyId: requiredEnvironment(
                  environment,
                  'MEDIA_S3_ACCESS_KEY_ID',
                ),
                secretAccessKey: requiredEnvironment(
                  environment,
                  'MEDIA_S3_SECRET_ACCESS_KEY',
                ),
              }),
            }),
          })
        : undefined;
    const stallScheduler = new AutomationStallScheduler({
      intervalMs: optionalPositiveInteger(
        environment.ASSISTANT_STALL_SWEEP_INTERVAL_MS,
        60_000,
        'ASSISTANT_STALL_SWEEP_INTERVAL_MS',
      ),
      logger,
      sweeper: await loadAutomationStallSweeper(
        database,
        environment,
        options.importModule,
      ),
    });
    await startWorkerServices({
      commandWorker,
      mediaWorker,
      chatMediaWorker,
      chatMediaCleanup,
      retentionScheduler,
      signatureRefresh,
      scannerDaemon,
      stallScheduler,
    });
    return Object.freeze({
      runtime: Object.freeze({
        commandWorker,
        mediaWorker,
        retentionScheduler,
        chatMediaWorker,
        chatMediaCleanup,
        scannerDaemon,
        stallScheduler,
      }),
      stop: async () => {
        await stallScheduler.stop();
        await chatMediaCleanup?.stop();
        await signatureRefresh.stop();
        await retentionScheduler.stop();
        await Promise.all([
          commandWorker.stop(),
          mediaWorker.stop(),
          chatMediaWorker?.stop(),
        ]);
        await scannerDaemon.stop();
        await database.close();
      },
    });
  } catch (error) {
    await signatureRefresh.stop();
    await scannerDaemon.stop();
    await database.close();
    throw error;
  }
}

/** @param {unknown} error */
function technicalErrorCode(error) {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'JOB_HANDLER_FAILED';
  return /^[A-Z0-9_]{1,64}$/u.test(candidate)
    ? candidate
    : 'JOB_HANDLER_FAILED';
}

/** @param {Record<string, string|undefined>} environment @param {string} name */
function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw technicalStartupError(`${name}_REQUIRED`);
  }
  return value;
}

/** @param {string|undefined} value @param {number} fallback @param {string} name */
function optionalPositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw technicalStartupError(`${name}_INVALID`);
  }
  return parsed;
}

/** @param {Record<string, string|undefined>} environment @param {string} name */
function requiredPositiveInteger(environment, name) {
  return optionalPositiveInteger(
    requiredEnvironment(environment, name),
    0,
    name,
  );
}

/** @param {string} code */
function technicalStartupError(code) {
  return Object.assign(new Error(code), { code });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const logger = createSafeLogger({ service: SERVICES.worker });
  try {
    const worker = await startWorkerFromEnvironment({ logger });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await worker.stop();
    };
    process.once('SIGTERM', () => {
      void stop();
    });
    process.once('SIGINT', () => {
      void stop();
    });
  } catch (error) {
    logger.error('worker_job_failed', {
      error_code: technicalErrorCode(error),
      job_type: 'unknown_job',
      queue: 'default',
    });
    process.exitCode = 1;
  }
}
