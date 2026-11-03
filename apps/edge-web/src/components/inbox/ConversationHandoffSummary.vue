<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import { request } from '../../lib/api-client.js';
import { preferredSellerFirstName } from '../../lib/assistant-context.js';
import { handoffSummaryLines } from '../../lib/handoff-summary.js';

/**
 * INBOX-HANDOFF-01 / AGT-03: what the agent handed over with the conversation
 * (Ficha, Atenção, Dica, the customer's questions), above the history. It is
 * read apart from the conversation, under `handoff.read`, and kept only in
 * memory: no URL, storage or log ever holds it.
 */
const props = defineProps({
  conversationId: { type: String, required: true },
  /** The read model's open handoff (`{id, status}`), or null. */
  handoff: { type: Object, default: null },
});

const toggle = ref(null);
const summary = ref('');
/** INBOX-HANDOFF-02: the seller the customer asked for, first name only. */
const preferredSeller = ref('');
const loading = ref(false);
const error = ref('');
/** Without `handoff.read` (or with no summary) the section stays out. */
const unavailable = ref(false);
/** Open while the handoff waits for a seller; closed once someone took it. */
const expanded = ref(false);
let controller;

const lines = computed(() => handoffSummaryLines(summary.value));
const bodyId = computed(() => `handoff-summary-${props.conversationId}`);
const visible = computed(
  () =>
    Boolean(props.handoff) &&
    !unavailable.value &&
    (loading.value ||
      Boolean(error.value) ||
      Boolean(preferredSeller.value) ||
      lines.value.length > 0),
);

async function load() {
  controller?.abort();
  if (!props.handoff) {
    loading.value = false;
    return;
  }
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(props.conversationId)}/handoff`,
      { signal: own.signal },
    );
    if (own !== controller) return;
    const handoff = response.data?.handoff ?? null;
    summary.value = handoff?.summary ?? '';
    // INBOX-HANDOFF-02: `preferred_seller` sits beside `handoff` in the
    // answer (the API client keeps the keys as sent).
    preferredSeller.value = handoff
      ? preferredSellerFirstName(response.data)
      : '';
    unavailable.value = !handoff;
    error.value = '';
  } catch (cause) {
    if (own !== controller || /** @type {any} */ (cause)?.name === 'AbortError')
      return;
    summary.value = '';
    preferredSeller.value = '';
    // No permission, or nothing to show: the conversation reads as before.
    const status = /** @type {any} */ (cause)?.status;
    unavailable.value = status === 403 || status === 404;
    error.value = unavailable.value
      ? ''
      : 'Não foi possível carregar o resumo da transferência.';
  } finally {
    if (own === controller) loading.value = false;
  }
}

/** The retry button leaves with the error; focus waits on the toggle. */
async function retry() {
  await load();
  await nextTick();
  toggle.value?.focus();
}

watch(
  () => [props.conversationId, props.handoff?.id],
  () => {
    // Another conversation or handoff never shows the summary before it.
    summary.value = '';
    preferredSeller.value = '';
    error.value = '';
    unavailable.value = false;
    expanded.value =
      props.handoff?.status === 'pending' &&
      props.handoff?.reasonCode !== 'unsupported';
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    v-if="visible"
    class="handoff-summary"
    :aria-labelledby="`${bodyId}-title`"
    :aria-busy="loading ? 'true' : undefined"
  >
    <h3 :id="`${bodyId}-title`" class="handoff-summary-title">
      <button
        ref="toggle"
        type="button"
        class="quiet"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-controls="bodyId"
        @click="expanded = !expanded"
      >
        Resumo da transferência
        <AppIcon name="chevron-down" />
      </button>
    </h3>
    <!-- A scrollable summary must be reachable by keyboard (WCAG 2.1.1). -->
    <div
      :id="bodyId"
      class="handoff-summary-body"
      :hidden="!expanded"
      tabindex="0"
      :aria-labelledby="`${bodyId}-title`"
    >
      <p v-if="loading" class="op-hint">Carregando resumo…</p>
      <div v-else-if="error" class="handoff-summary-error">
        <p>{{ error }}</p>
        <button type="button" @click="retry">Tentar novamente</button>
      </div>
      <ul v-else class="handoff-summary-lines">
        <li v-if="preferredSeller" data-tone="info">
          <strong>Cliente pediu:</strong>{{ ' ' }}{{ preferredSeller }}
        </li>
        <li
          v-for="line in lines"
          :key="line.key"
          :data-tone="line.tone || undefined"
        >
          <template v-if="line.label">
            <strong>{{ line.label }}:</strong>{{ ' ' }}
          </template>
          <template v-if="line.items.length">
            <ul class="handoff-summary-questions">
              <li v-for="(item, index) in line.items" :key="index">
                {{ item }}
              </li>
            </ul>
          </template>
          <template v-else>{{ line.text }}</template>
        </li>
      </ul>
    </div>
  </section>
</template>
