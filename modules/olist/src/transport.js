import { OlistError } from './errors.js';
import { OLIST_API, OLIST_TOKEN } from './configuration.js';
/** No redirect, no upstream text in errors, bounded streaming and one deadline.
 * @param {string} url @param {{fetch?: typeof fetch, method?:string, token?:string, form?:URLSearchParams, timeoutMs?:number, maxBytes?:number}} options */
export async function olistJson(url, options = {}) {
  const parsed = new URL(url);
  const apiUrl = new URL(OLIST_API);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !(
      (parsed.origin === apiUrl.origin &&
        parsed.pathname.startsWith(apiUrl.pathname + '/') &&
        (options.method ?? 'GET') === 'GET') ||
      (url === OLIST_TOKEN && options.method === 'POST' && options.form)
    )
  )
    throw new OlistError('INVALID_REQUEST', 400);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 262_144;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1_048_576
  )
    throw new OlistError('INVALID_REQUEST', 400);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: options.method ?? 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
        ...(options.form
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(options.form ? { body: options.form } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new OlistError('OLIST_AUTH', 409);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      const seconds = response.headers.get('retry-after');
      const retryAfterMs =
        seconds && /^\d{1,5}$/u.test(seconds)
          ? Math.min(3_600_000, Math.max(1000, Number(seconds) * 1000))
          : 60_000;
      throw Object.assign(new OlistError('OLIST_RATE_LIMITED', 429), {
        retryAfterMs,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OlistError('OLIST_UPSTREAM_REJECTED', 502);
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
      await response.body?.cancel();
      throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    }
    if (
      !/^(?:application\/json|[^;\s]+\+json)(?:;|$)/iu.test(
        response.headers.get('content-type') ?? '',
      ) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new OlistError('OLIST_INVALID_RESPONSE', 502);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new OlistError('OLIST_INVALID_RESPONSE', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { body, headers: response.headers };
  } catch (error) {
    if (error instanceof OlistError) throw error;
    throw new OlistError('OLIST_UNAVAILABLE', 503);
  }
}
