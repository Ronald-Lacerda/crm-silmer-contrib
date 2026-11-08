/**
 * RFC 052: in tab mode the API stamps every item with the requested `bucket`,
 * and the screen rejects a list that omits it (a server older than the RFC).
 * Specs that serve the Caixa list with their own fixtures use this to behave
 * like the new API.
 *
 * @template {Record<string, any>} T
 * @param {T[]} items
 * @param {string} requestUrl
 * @returns {T[]}
 */
export function withBucket(items, requestUrl) {
  const bucket = new URL(requestUrl).searchParams.get('bucket');
  return bucket ? items.map((item) => ({ ...item, bucket })) : items;
}
