import { onBeforeUnmount, ref } from 'vue';
import { request } from './api-client.js';

/**
 * ACT-09: one read per region. Only the latest request may answer (an older
 * period never replaces a newer one); a failure after a valid answer keeps
 * the old data and says it may be outdated, a first failure leaves no data so
 * the screen shows "—", never zero. Call inside `setup`.
 *
 * @param {{unavailable: string, stale: string}} messages
 */
export function useLatestRead(messages) {
  /** @type {import('vue').Ref<Record<string, any>|null>} */
  const data = ref(null);
  const loading = ref(false);
  const error = ref('');
  /** @type {AbortController|null} */
  let controller = null;
  let disposed = false;

  /** @param {string} url @returns {Promise<boolean>} true when it answered */
  async function load(url) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    loading.value = true;
    try {
      const response = await request(url, { signal: current.signal });
      if (controller !== current || disposed) return false;
      data.value = response.data ?? null;
      error.value = '';
      return true;
    } catch (cause) {
      if (
        controller !== current ||
        disposed ||
        /** @type {any} */ (cause)?.name === 'AbortError'
      )
        return false;
      error.value = data.value ? messages.stale : messages.unavailable;
      return false;
    } finally {
      if (controller === current && !disposed) loading.value = false;
    }
  }

  onBeforeUnmount(() => {
    disposed = true;
    controller?.abort();
  });

  return { data, loading, error, load };
}
