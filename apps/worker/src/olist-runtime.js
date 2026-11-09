import {
  createOlistConnection,
  createOlistClient,
  createOlistRepository,
  createOlistResourceResolver,
  createOlistResourceWriter,
  createOlistSaleWriter,
  createOlistDispatcher,
  olistConfiguration,
  olistReadWait,
  OlistError,
} from '@crm-silmer/olist';

/** Failures that are safe to retry only when the dispatcher also reports
 * `retryable` and `retrySafe` (nothing was sent: no sale ticket and nothing
 * reserved or uncertain). The handler never invents a retry on its own. */
const RETRYABLE_CODES = new Set([
  'OLIST_RATE_LIMITED',
  'OLIST_UNAVAILABLE',
  'OLIST_REFRESH_IN_PROGRESS',
]);

/** @param {any} value */
function safeCode(value) {
  const codes = new Set([
    'ORDER_CANCELLED',
    'OLIST_DISPATCH_DISABLED',
    'OLIST_JOB_INVALID',
    'OLIST_JOB_LEASE_LOST',
    'FORBIDDEN',
    'VERSION_CONFLICT',
    'OLIST_CREATION_DISABLED',
    'OLIST_CONNECTION_CHANGED',
    'OLIST_SALE_UNCERTAIN',
    'OLIST_RESOURCE_UNCERTAIN',
    'OLIST_PAYMENT_DUE_REQUIRED',
    'OLIST_SALE_READBACK_MISMATCH',
    'OLIST_SALE_ALREADY_EXISTS',
    'OLIST_PERSISTENCE_FAILED',
    'OLIST_SALE_PLAN_INVALID',
    'OLIST_SALE_EXACT_CENT_REQUIRED',
    'OLIST_SALE_REQUEST_CHANGED',
    'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
    'OLIST_RATE_LIMITED',
    'OLIST_UNAVAILABLE',
    'OLIST_REFRESH_IN_PROGRESS',
    'OLIST_EXPORT_UNAVAILABLE',
    'OLIST_DISPATCH_FAILED',
  ]);
  return codes.has(value?.code) ? value.code : 'OLIST_DISPATCH_FAILED';
}
/** Closed job boundary: payload supplies only an export ID, never authority.
 * @param {{dispatcher:any,environment?:Record<string,string|undefined>}} options */
export function createOlistJobHandler({
  dispatcher,
  environment = process.env,
}) {
  return async (/** @type {any} */ job, /** @type {any} */ context) => {
    if (environment.OLIST_DISPATCH_ENABLED !== 'true')
      return {
        outcome: 'failed',
        errorCode: 'OLIST_DISPATCH_DISABLED',
        retryable: false,
        retrySafe: false,
      };
    if (
      job.jobType !== 'olist.export' ||
      job.queue !== 'olist' ||
      typeof job.olistExportId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        job.olistExportId,
      )
    )
      return {
        outcome: 'failed',
        errorCode: 'OLIST_JOB_INVALID',
        retryable: false,
        retrySafe: false,
      };
    try {
      const marked = await context.markEffectStarted({ provider: 'olist' });
      if (!marked) throw new OlistError('OLIST_JOB_LEASE_LOST');
      const response = await dispatcher.dispatch(
        { exportId: job.olistExportId },
        context,
      );
      if (
        !response ||
        !['sent', 'failed', 'outcome_unknown'].includes(response.outcome)
      )
        throw new OlistError('OLIST_DISPATCH_FAILED');
      const errorCode = response.errorCode
        ? safeCode({ code: response.errorCode })
        : undefined;
      // A retry is granted only to a plain pre-effect failure; `sent` and
      // `outcome_unknown` can never be retried, whatever the flags say.
      const retry =
        response.outcome === 'failed' &&
        response.retryable === true &&
        response.retrySafe === true &&
        RETRYABLE_CODES.has(errorCode ?? '');
      return {
        outcome: response.outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(typeof response.providerExternalId === 'string' &&
        /^[1-9][0-9]{0,18}$/u.test(response.providerExternalId)
          ? { providerExternalId: response.providerExternalId }
          : {}),
        retryable: retry,
        retrySafe: retry,
      };
    } catch (error) {
      return {
        outcome: 'outcome_unknown',
        errorCode: safeCode(error),
        retryable: false,
        retrySafe: false,
      };
    }
  };
}
/** Per-job composition binds all credentials and effects to the frozen actor.
 * @param {{database:any,environment?:Record<string,string|undefined>,fetch?:typeof fetch,clock?:()=>Date}} options */
export function createOlistDispatchRuntime({
  database,
  environment = process.env,
  fetch: fetchOverride,
  clock = () => new Date(),
}) {
  const config = olistConfiguration(environment);
  const repository = createOlistRepository(database, {
    envelopeKey: config.envelopeKey,
    hmacKey: config.hmacKey,
    pilotUserIds: config.pilotUserIds,
    clock,
  });
  return Object.freeze({
    async dispatch(
      /** @type {{exportId:string}} */ input,
      /** @type {any} */ context,
    ) {
      const operation = await repository.loadDispatchContext({
        ...input,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
      });
      const base = {
        exportId: operation.id,
        actor: operation.actor,
        authorizationVersion: operation.authorizationVersion,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
        connectionGeneration: operation.connectionGeneration,
        settingsVersion: operation.settingsVersion,
        correlationId: 'olist-' + operation.id,
      };
      const guardedFetch = async (
        /** @type {Parameters<typeof fetch>[0]} */ url,
        /** @type {Parameters<typeof fetch>[1]} */ init,
      ) => {
        if (!(await context.heartbeat()))
          throw new OlistError('OLIST_JOB_LEASE_LOST');
        return (fetchOverride ?? globalThis.fetch)(url, init);
      };
      const connection = createOlistConnection(database, {
        config,
        fetch: guardedFetch,
        clock,
      });
      const credentials = () => connection.credentials(base, 'olist.export');
      const onAuthFailure = (/** @type {number} */ version) =>
        connection.authFailure(base, version);
      const client = createOlistClient({
        credentials,
        quota: connection.quota,
        fetch: guardedFetch,
        onAuthFailure,
        // Reads wait for quota; `beat` keeps the job lease alive meanwhile and
        // a lost lease aborts the wait (writes never wait).
        readWait: olistReadWait('worker', {
          beat: async () => context.heartbeat(),
        }),
      });
      const writer = createOlistResourceWriter({
        credentials,
        quota: connection.quota,
        fetch: guardedFetch,
        onAuthFailure,
      });
      const resolver = createOlistResourceResolver({
        repository,
        client,
        writer,
        config,
        onStage: async (/** @type {string} */ stage) =>
          repository.updateStage({ ...base, stage, state: 'resolving' }),
      });
      const saleWriter = createOlistSaleWriter({
        credentials,
        quota: connection.quota,
        fetch: guardedFetch,
        onAuthFailure,
      });
      return createOlistDispatcher({
        repository,
        client,
        resourceResolver: resolver,
        saleWriter,
        config,
        // Renews an expired access token before the dispatcher's local guard.
        prepare: async () => {
          await credentials();
        },
      }).dispatch(input);
    },
  });
}
