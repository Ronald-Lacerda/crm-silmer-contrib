import {
  createOlistAdminRepository,
  createOlistReadonlyInspector,
  createOlistClient,
  createOlistConnection,
  olistConfiguration,
  OlistError,
} from '@crm-silmer/olist';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SAFE = new Set([
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'INVALID_REQUEST',
  'OLIST_NOT_CONFIGURED',
  'OLIST_RECONCILIATION_REQUIRED',
  'OLIST_RECONCILIATION_NOT_FOUND',
  'OLIST_JOB_LEASE_LOST',
  'OLIST_CONNECTION_CHANGED',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_REFRESH_IN_PROGRESS',
  'OLIST_RATE_LIMITED',
  'OLIST_AUTH',
  'OLIST_UNAVAILABLE',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_INVALID_RESPONSE',
  'OLIST_RESOURCE_NOT_FOUND',
  'OLIST_EXPORT_UNAVAILABLE',
  'OLIST_RESOURCE_DIVERGENT',
  'OLIST_CUSTOMER_DIVERGENT',
  'OLIST_PRODUCT_DIVERGENT',
  'OLIST_PRODUCT_FISCAL_DIVERGENT',
  'OLIST_VARIATION_DIVERGENT',
  'OLIST_SALE_READBACK_MISMATCH',
  'OLIST_SALE_REQUEST_CHANGED',
  'OLIST_SALE_REFERENCE_CONFLICT',
  'OLIST_SALE_UNCERTAIN',
  'OLIST_SALE_RECONCILIATION_REQUIRED',
  'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
  'OLIST_PARENT_UNRESOLVED',
  'OLIST_PRODUCT_FISCAL_REQUIRED',
]);
/** @param {any} error */
function codeOf(error) {
  return SAFE.has(error?.code) ? error.code : 'OLIST_RECONCILE_FAILED';
}
/** Isolated read-only composition. No resolver, dispatcher or write transport is
 * imported here; creation flags cannot turn a reconciliation into an inclusion.
 * @param {{database:any,environment?:Record<string,string|undefined>,fetch?:typeof fetch,clock?:()=>Date,repository?:any,inspector?:any}} options */
export function createOlistReconciliationRuntime(options) {
  const environment = options.environment ?? process.env;
  const config = olistConfiguration(environment),
    clock = options.clock ?? (() => new Date());
  const repository =
    options.repository ??
    createOlistAdminRepository(options.database, {
      envelopeKey: config.envelopeKey,
      hmacKey: config.hmacKey,
      clock,
    });
  return Object.freeze({
    /** @param {{requestId:string,exportId:string}} input @param {any} context */
    async dispatch(input, context) {
      const request = await repository.loadReadRequest({
        requestId: input.requestId,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
      });
      if (request.exportId !== input.exportId)
        throw new OlistError('OLIST_RECONCILIATION_NOT_FOUND');
      const base = {
        action: 'olist.reconcile',
        orderId: request.orderId,
        exportId: request.exportId,
        requestId: input.requestId,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
        actor: request.actor,
        authorizationVersion: request.authorizationVersion,
        connectionGeneration: request.connectionGeneration,
        correlationId: 'olist-read-' + input.requestId,
      };
      let reads = 0;
      const heartbeat = async () => {
        if (!(await context.heartbeat()))
          throw new OlistError('OLIST_JOB_LEASE_LOST');
      };
      try {
        await heartbeat();
        await repository.guard(base, 'olist.reconcile');
        if (request.status !== 'queued')
          return {
            status: request.status,
            code: request.code ?? request.safe_code,
          };
        // OAuth remains on the fixed credential port; only catalog GETs reach
        // the data port below, including after a legitimate token refresh.
        const connection = createOlistConnection(options.database, {
          config,
          clock,
          fetch: async (url, init) => {
            await heartbeat();
            return (options.fetch ?? globalThis.fetch)(url, init);
          },
        });
        const client = createOlistClient({
          credentials: async () => {
            await repository.guard(base, 'olist.reconcile');
            return connection.credentials(base, 'olist.reconcile');
          },
          quota: connection.quota,
          fetch: async (url, init) => {
            if ((init?.method ?? 'GET') !== 'GET' || ++reads > 64)
              throw new OlistError('OLIST_INCOMPLETE_LOOKUP');
            await heartbeat();
            await repository.guard(base, 'olist.reconcile');
            return (options.fetch ?? globalThis.fetch)(url, init);
          },
          onAuthFailure: (version) => connection.authFailure(base, version),
        });
        const inspector =
          options.inspector ?? createOlistReadonlyInspector({ client, config });
        let proof;
        if (request.stage === 'sale') {
          const operation = await repository.readOperation(base);
          if (!operation) throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
          proof = await inspector.reconcileSale({ operation });
        } else {
          const resource = await repository.readResource({
            ...base,
            resourceId: request.resourceId,
          });
          proof = await inspector.reconcileResource({
            resource,
            parent: resource.parent,
          });
        }
        await heartbeat();
        return await repository.completeReadRequest({
          ...base,
          matched: true,
          remoteId: proof.remoteId,
          number: proof.number,
          resources: proof.resources,
          proof: proof.proof,
        });
      } catch (error) {
        const code = codeOf(error);
        await repository.completeReadRequest({ ...base, matched: false, code });
        return { status: 'blocked', code };
      }
    },
  });
}
/** @param {{dispatcher:any}} options
 * @returns {(job:any,context:any)=>Promise<{outcome:'sent'|'failed',errorCode?:string,retryable:false,retrySafe:false}>} */
export function createOlistReconciliationHandler({ dispatcher }) {
  return async (/** @type {any} */ job, /** @type {any} */ context) => {
    if (
      job.jobType !== 'olist.reconcile' ||
      job.queue !== 'olist_reconcile' ||
      !UUID.test(job.idempotencyKey ?? '') ||
      !UUID.test(job.olistExportId ?? '')
    )
      return {
        outcome: 'failed',
        errorCode: 'OLIST_JOB_INVALID',
        retryable: false,
        retrySafe: false,
      };
    try {
      const result = await dispatcher.dispatch(
        { requestId: job.idempotencyKey, exportId: job.olistExportId },
        context,
      );
      return result?.status === 'succeeded'
        ? { outcome: 'sent', retryable: false, retrySafe: false }
        : {
            outcome: 'failed',
            errorCode: codeOf({ code: result?.code }),
            retryable: false,
            retrySafe: false,
          };
    } catch (error) {
      return {
        outcome: 'failed',
        errorCode: codeOf(error),
        retryable: false,
        retrySafe: false,
      };
    }
  };
}
