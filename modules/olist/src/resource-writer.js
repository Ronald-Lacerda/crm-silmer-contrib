import { OLIST_API } from './configuration.js';
import { OlistError, integer, text } from './errors.js';
import { validateResourcePayload } from './resource-payloads.js';
import { OLIST_WRITE_READBACKS } from './quota.js';

/** @param {any} value */
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** @param {Response} response @param {number} maxBytes */
async function bodyOf(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (
    !/^(?:application\/json|[^;\s]+\+json)(?:;|$)/iu.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body ||
    (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
  ) {
    await response.body?.cancel();
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new OlistError('OLIST_INVALID_RESPONSE', 502);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new OlistError('OLIST_INVALID_RESPONSE', 502);
  integer(body.id);
  return body;
}
/** A closed, single-attempt resource effect port. Credentials/quota precede the
 * durable reservation callback; the very next external call is one official POST.
 * This port has no sale/delete/update methods and is not wired to public HTTP.
 * @param {{credentials:()=>Promise<{token:string,version:number}>,quota:any,fetch?:typeof fetch,timeoutMs?:number,maxBytes?:number,onAuthFailure?:(version:number)=>Promise<unknown>}} options */
export function createOlistResourceWriter(options) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 262144;
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
    /** @param {{kind:string,parentRemoteId?:number,payload:unknown,reserve:(payload:any,metadata:{connectionVersion:number})=>Promise<any>}} input */
    async dispatch(input) {
      if (typeof input.reserve !== 'function')
        throw new OlistError('INVALID_REQUEST', 400);
      let path;
      if (input.kind === 'customer') path = '/contatos';
      else if (input.kind === 'product') path = '/produtos';
      else if (input.kind === 'variation')
        path = '/produtos/' + integer(input.parentRemoteId) + '/variacoes';
      else throw new OlistError('INVALID_REQUEST', 400);
      if (input.kind !== 'variation' && input.parentRemoteId !== undefined)
        throw new OlistError('INVALID_REQUEST', 400);
      const payload = freeze(
        validateResourcePayload(input.kind, input.payload),
      );
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) > 262144)
        throw new OlistError('INVALID_REQUEST', 400);
      const credentials = await options.credentials();
      const token = text(credentials.token, 4096);
      if (/\s/u.test(token)) throw new OlistError('OLIST_AUTH', 409);
      integer(credentials.version, true);
      // One unit for the POST plus headroom for its readbacks, checked BEFORE the
      // durable ticket: without room the job is deferred with no ticket and no
      // POST. Never waits. A quota without `reserveWrite` keeps the old reserve.
      if (typeof options.quota.reserveWrite === 'function')
        await options.quota.reserveWrite({
          readbacks:
            OLIST_WRITE_READBACKS[
              /** @type {'customer'|'product'|'variation'} */ (input.kind)
            ],
        });
      else await options.quota.reserve();
      const reservation = await input.reserve(payload, {
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
          OLIST_API + path,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: 'Bearer ' + token,
            },
            body: encoded,
          },
        );
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel();
          await options.onAuthFailure?.(credentials.version);
          throw new OlistError('OLIST_AUTH', 409);
        }
        if (response.status === 429) {
          await response.body?.cancel();
          const seconds = response.headers.get('retry-after');
          const duration =
            seconds && /^\d{1,5}$/u.test(seconds)
              ? Math.min(3600000, Math.max(1000, Number(seconds) * 1000))
              : 60000;
          await options.quota.block?.(duration);
          throw new OlistError('OLIST_RATE_LIMITED', 429);
        }
        if (![200, 201].includes(response.status)) {
          await response.body?.cancel();
          throw new OlistError('OLIST_UPSTREAM_REJECTED', 502);
        }
        const body = await bodyOf(response, maxBytes);
        // Quota hints never erase a known successful ID. The resolver persists
        // the ID first and may then stop dependencies when observation failed.
        let quotaObservationFailed = false;
        try {
          await options.quota.observe(response.headers);
        } catch {
          quotaObservationFailed = true;
        }
        return {
          remoteId: String(body.id),
          body,
          reservation,
          quotaObservationFailed,
        };
      } catch {
        // Intentionally discard raw causes, upstream text, fiscal data and tokens.
        throw Object.assign(new OlistError('OLIST_RESOURCE_UNCERTAIN', 409), {
          reservation,
        });
      }
    },
  });
}
