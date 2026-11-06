import { OLIST_API } from './configuration.js';
import { OlistError, integer, text } from './errors.js';
import { assertOlistSalePlan } from './sale-payload.js';
import {
  parseOlistLosslessJson,
  olistIdentifierFromJson,
} from './lossless-json.js';
/** Closed single-attempt sale transport. A returned ID is observation, never
 * confirmation; the caller persists it before any GET/readback.
 * @param {{credentials:()=>Promise<{token:string,version:number}>,quota:any,fetch?:typeof fetch,timeoutMs?:number,maxBytes?:number,onAuthFailure?:(version:number)=>Promise<unknown>}} options */
export function createOlistSaleWriter(options) {
  const timeoutMs = options.timeoutMs ?? 15000,
    maxBytes = options.maxBytes ?? 262144;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return Object.freeze({
    /** @param {{plan:any,reserve:(payload:any,metadata:{connectionVersion:number})=>Promise<any>}} input */
    async dispatch(input) {
      const plan = assertOlistSalePlan(input.plan);
      if (typeof input.reserve !== 'function')
        throw new OlistError('INVALID_REQUEST', 400);
      const credentials = await options.credentials(),
        token = text(credentials.token, 4096);
      integer(credentials.version, true);
      if (/\s/u.test(token)) throw new OlistError('OLIST_AUTH', 409);
      await options.quota.reserve();
      const reservation = await input.reserve(plan.encoded, {
        connectionVersion: credentials.version,
      });
      if (
        !reservation ||
        typeof reservation.attemptId !== 'string' ||
        typeof reservation.fence !== 'string'
      )
        throw new OlistError('INVALID_REQUEST', 400);
      try {
        const response = await (options.fetch ?? globalThis.fetch)(
          OLIST_API + '/pedidos',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: 'Bearer ' + token,
            },
            body: plan.encoded,
          },
        );
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel();
          await options.onAuthFailure?.(credentials.version);
          throw new OlistError('OLIST_AUTH');
        }
        if (response.status === 429) {
          await response.body?.cancel();
          const seconds = response.headers.get('retry-after');
          await options.quota.block?.(
            seconds && /^\d{1,5}$/u.test(seconds)
              ? Math.min(3600000, Math.max(1000, Number(seconds) * 1000))
              : 60000,
          );
          throw new OlistError('OLIST_RATE_LIMITED');
        }
        if (![200, 201].includes(response.status)) {
          await response.body?.cancel();
          throw new OlistError('OLIST_UPSTREAM_REJECTED');
        }
        const declared = response.headers.get('content-length');
        if (
          !/^(?:application\/json|[^;\s]+\+json)(?:;|$)/iu.test(
            response.headers.get('content-type') ?? '',
          ) ||
          !response.body ||
          (declared &&
            (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
        ) {
          await response.body?.cancel();
          throw new OlistError('OLIST_INVALID_RESPONSE');
        }
        const reader = response.body.getReader(),
          chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel();
              throw new OlistError('OLIST_INVALID_RESPONSE');
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const parsed = parseOlistLosslessJson(
          Buffer.concat(chunks).toString('utf8'),
        );
        const remoteId = olistIdentifierFromJson(parsed?.id);
        let remoteNumber = null;
        let invalidResponse =
          BigInt(remoteId) > BigInt(Number.MAX_SAFE_INTEGER);
        if (parsed.numeroPedido !== undefined && parsed.numeroPedido !== null) {
          try {
            remoteNumber = olistIdentifierFromJson(parsed.numeroPedido);
          } catch {
            invalidResponse = true;
          }
        }
        let quotaObservationFailed = false;
        try {
          await options.quota.observe(response.headers);
        } catch {
          quotaObservationFailed = true;
        }
        return {
          remoteId,
          remoteNumber,
          body: { id: remoteId, number: remoteNumber },
          reservation,
          quotaObservationFailed,
          invalidResponse,
        };
      } catch {
        throw Object.assign(new OlistError('OLIST_SALE_UNCERTAIN', 409), {
          reservation,
        });
      }
    },
  });
}
