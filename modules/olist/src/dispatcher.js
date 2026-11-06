import { OlistError } from './errors.js';
import { buildOlistSalePayload, reconcileOlistSale } from './sale-payload.js';

const STOP = new Set([
  'ORDER_CANCELLED',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'OLIST_NOT_CONFIGURED',
  'OLIST_CREATION_DISABLED',
  'OLIST_CONNECTION_CHANGED',
  'OLIST_RECONNECT_REQUIRED',
  'OLIST_EXPORT_UNAVAILABLE',
  'OLIST_PAYMENT_DUE_REQUIRED',
  'OLIST_SALE_PLAN_INVALID',
  'OLIST_SALE_EXACT_CENT_REQUIRED',
  'INVALID_REQUEST',
  'OLIST_SALE_ALREADY_EXISTS',
  'OLIST_JOB_LEASE_LOST',
  'OLIST_RATE_LIMITED',
]);
const SAFE = new Set([
  ...STOP,
  'OLIST_SALE_UNCERTAIN',
  'OLIST_SALE_REQUEST_CHANGED',
  'OLIST_SALE_READBACK_MISMATCH',
  'OLIST_RESOURCE_UNCERTAIN',
  'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
  'OLIST_RESOURCE_DIVERGENT',
  'OLIST_CUSTOMER_DIVERGENT',
  'OLIST_PRODUCT_DIVERGENT',
  'OLIST_VARIATION_DIVERGENT',
  'OLIST_PRODUCT_FISCAL_REQUIRED',
  'OLIST_RESOURCE_PERSISTENCE_FAILED',
  'OLIST_PERSISTENCE_FAILED',
  'OLIST_UNAVAILABLE',
  'OLIST_INCOMPLETE_LOOKUP',
  'OLIST_AMBIGUOUS_MATCH',
  'OLIST_EFFECT_ALREADY_RESERVED',
  'OLIST_DISPATCH_FAILED',
]);
/** @param {any} error */
function codeOf(error) {
  return SAFE.has(error?.code) ? error.code : 'OLIST_DISPATCH_FAILED';
}
/** @param {'sent'|'failed'|'outcome_unknown'} outcome @param {string|undefined} errorCode @param {string|undefined} providerExternalId */
function result(outcome, errorCode, providerExternalId) {
  return {
    outcome,
    ...(errorCode ? { errorCode } : {}),
    ...(providerExternalId ? { providerExternalId } : {}),
    retryable: false,
    retrySafe: false,
  };
}
/** Snapshot-only orchestration. Each mutation has its own durable ticket;
 * an expired job lease or an empty lookup can never authorize a second sale.
 * @param {{repository:any,client:any,resourceResolver:any,saleWriter:any,config:{accountKey:string,contextKey:string}}} options */
export function createOlistDispatcher({
  repository,
  client,
  resourceResolver,
  saleWriter,
  config,
}) {
  /** @param {any} operation */
  function baseFor(operation) {
    return {
      exportId: operation.id,
      actor: operation.actor ?? { id: operation.actor_id, kind: 'human' },
      authorizationVersion: Number(
        operation.authorizationVersion ?? operation.authorization_version,
      ),
      accountKey: config.accountKey,
      contextKey: config.contextKey,
      connectionGeneration: Number(
        operation.connectionGeneration ?? operation.connection_generation,
      ),
      settingsVersion: Number(
        operation.settingsVersion ?? operation.settings_version,
      ),
      correlationId: 'olist-' + operation.id,
    };
  }
  /** A shape-only preflight before even a customer inclusion; fake IDs never
   * leave this process or become a stored resource mapping.
   * @param {any} snapshot */
  function preflight(snapshot) {
    let next = 10;
    return {
      resolved: true,
      customerId: '1',
      groups: (snapshot.commercial?.groups ?? []).map(
        (/** @type {any} */ group) => ({
          groupId: group.groupId,
          productId: String(next++),
          lines: group.lines.map((/** @type {any} */ line) => ({
            lineId: line.lineId,
            productId: String(next++),
          })),
        }),
      ),
    };
  }
  return Object.freeze({
    /** @param {{exportId:string}} input */
    async dispatch(input) {
      /** @type {any} */ let operation;
      /** @type {any} */ let base;
      /** @type {any} */ let ticket;
      try {
        operation = await repository.loadDispatchContext({
          exportId: input.exportId,
          accountKey: config.accountKey,
          contextKey: config.contextKey,
        });
        base = baseFor(operation);
        if (
          operation.state === 'invalidated' &&
          operation.last_error_code === 'ORDER_CANCELLED'
        )
          throw new OlistError('ORDER_CANCELLED');
        if (['confirmed', 'linked'].includes(operation.state))
          return result('sent', undefined, String(operation.remote_id));
        if (operation.saleAttempt) {
          const attempt = operation.saleAttempt;
          ticket = {
            attemptId: attempt.attemptId ?? attempt.id,
            fence: attempt.fence,
          };
          const mapping = operation.resourceMapping ?? operation.resources;
          const plan = buildOlistSalePayload({
            snapshot: operation.snapshot,
            resolved: mapping,
            reference: operation.reference,
          });
          // Reconciliation proves the request actually reserved, even after a
          // serializer upgrade. Drift requires explicit review, never HTTP.
          if (attempt.requestPayload?.encoded !== plan.encoded)
            throw new OlistError('OLIST_SALE_REQUEST_CHANGED');
          let id =
            attempt.observedRemoteId ?? attempt.observed_remote_id ?? null;
          if (!id) {
            const found = await client.findOrder(operation.reference);
            if (!found) throw new OlistError('OLIST_SALE_UNCERTAIN');
            id = String(found.id);
            await repository.persistSaleObservedId({
              ...base,
              ...ticket,
              remoteId: id,
              remoteNumber: found.numeroPedido
                ? String(found.numeroPedido)
                : undefined,
            });
          }
          const raw = await client.orderRaw(Number(id));
          const proof = reconcileOlistSale(plan, raw, String(id));
          await repository.finishSale({
            ...base,
            ...ticket,
            matched: true,
            remoteId: String(id),
            number: proof.number,
            proof,
          });
          return result('sent', undefined, String(id));
        }
        await repository.validateDispatch(base);
        buildOlistSalePayload({
          snapshot: operation.snapshot,
          resolved: preflight(operation.snapshot),
          reference: operation.reference,
        });
        // A sale found without our durable attempt belongs to explicit T09
        // review, never an automatic link or another inclusion.
        if (await client.findOrder(operation.reference))
          throw new OlistError('OLIST_SALE_ALREADY_EXISTS');
        await repository.updateStage({
          ...base,
          stage: 'customer',
          state: 'resolving',
        });
        const resources = await resourceResolver.resolve(base);
        await repository.markReady({ ...base, resources });
        const plan = buildOlistSalePayload({
          snapshot: operation.snapshot,
          resolved: resources,
          reference: operation.reference,
        });
        // Registrations may take time: repeat reference discovery immediately
        // before reserving the sale, then revalidate again inside reservation.
        if (await client.findOrder(operation.reference))
          throw new OlistError('OLIST_SALE_ALREADY_EXISTS');
        const response = await saleWriter.dispatch({
          plan,
          reserve: async (
            /** @type {string} */ encoded,
            /** @type {{connectionVersion:number}} */ credentials,
          ) => {
            ticket = await repository.reserveSaleEffect({
              ...base,
              connectionVersion: credentials.connectionVersion,
              requestPayload: { encoded },
            });
            return ticket;
          },
        });
        ticket = response.reservation;
        await repository.persistSaleObservedId({
          ...base,
          ...ticket,
          remoteId: response.remoteId,
          remoteNumber: response.remoteNumber ?? undefined,
        });
        if (response.quotaObservationFailed || response.invalidResponse)
          throw new OlistError('OLIST_SALE_UNCERTAIN');
        const raw = await client.orderRaw(Number(response.remoteId));
        const proof = reconcileOlistSale(plan, raw, response.remoteId);
        await repository.finishSale({
          ...base,
          ...ticket,
          matched: true,
          remoteId: response.remoteId,
          number: proof.number,
          proof,
        });
        return result('sent', undefined, response.remoteId);
      } catch (error) {
        const candidate = /** @type {any} */ (error);
        ticket = candidate.reservation ?? ticket;
        let safeCode = codeOf(candidate);
        if (ticket && base) {
          try {
            await repository.markSaleUncertain({
              ...base,
              ...ticket,
              code: safeCode,
            });
          } catch {
            safeCode = 'OLIST_PERSISTENCE_FAILED';
          }
        }
        if (base) {
          try {
            await repository.recordDispatchStop({ ...base, code: safeCode });
          } catch {
            safeCode = 'OLIST_PERSISTENCE_FAILED';
          }
        }
        // A concurrent dispatcher may have completed the same reserved sale.
        if (operation) {
          try {
            const latest = await repository.loadDispatchContext({
              exportId: operation.id,
              accountKey: config.accountKey,
              contextKey: config.contextKey,
            });
            if (['confirmed', 'linked'].includes(latest.state))
              return result('sent', undefined, String(latest.remote_id));
          } catch {
            /* No retry or untrusted error text crosses this boundary. */
          }
        }
        const unknown = Boolean(ticket) || !STOP.has(safeCode);
        return result(
          unknown ? 'outcome_unknown' : 'failed',
          safeCode,
          undefined,
        );
      }
    },
  });
}
