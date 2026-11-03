<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { request } from '../../lib/api-client.js';
import { orderAssistanceMetrics } from '../../lib/order-assistance.js';

const props = defineProps({
  days: { type: Number, default: 30 },
  refreshKey: { type: [String, Number], default: '' },
});
/** @type {import('vue').Ref<Record<string, any>|null>} */
const answer = ref(null);
const answeredDays = ref(props.days);
const loading = ref(false);
const error = ref('');
const heading = ref(null);
let controller;
const items = computed(() =>
  answer.value ? orderAssistanceMetrics(answer.value) : [],
);
async function load() {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  const requestedDays = props.days;
  loading.value = true;
  try {
    const response = await request(
      `/api/v1/inbox/order-assistance/metrics?days=${encodeURIComponent(requestedDays)}`,
      { signal: own.signal },
    );
    if (own !== controller || own.signal.aborted) return;
    answer.value = response.data;
    answeredDays.value = requestedDays;
    error.value = '';
  } catch (cause) {
    if (own !== controller || own.signal.aborted) return;
    const status = /** @type {any} */ (cause)?.status;
    error.value =
      status === 403
        ? 'Você não tem acesso à avaliação das sugestões de pedido.'
        : answer.value
          ? `Não foi possível atualizar. Os dados exibidos continuam sendo dos últimos ${answeredDays.value} dias.`
          : 'Não foi possível consultar a avaliação das sugestões de pedido.';
  } finally {
    if (own === controller) loading.value = false;
  }
}
async function retry() {
  if (loading.value) return;
  await load();
  await nextTick();
  if (!error.value) heading.value?.focus();
}
watch(
  () => [props.days, props.refreshKey],
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    class="order-assistance-metrics"
    aria-labelledby="order-assistance-metrics-title"
    :aria-busy="loading ? 'true' : undefined"
  >
    <h2 id="order-assistance-metrics-title" ref="heading" tabindex="-1">
      Sugestões de pedido e omissões
    </h2>
    <p v-if="loading && !answer" role="status">
      Consultando avaliação das sugestões…
    </p>
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <button
        type="button"
        :aria-disabled="loading ? 'true' : undefined"
        @click="retry"
      >
        Atualizar avaliação de pedidos
      </button>
    </div>
    <template v-if="answer">
      <p>Últimos {{ answeredDays }} dias</p>
      <dl class="order-assistance-metric-grid">
        <div v-for="item in items" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>
      <p class="op-hint">
        As omissões são casos marcados pela equipe, não uma contagem de tudo que
        o agente deixou passar. Um pedido manual sem sugestão é um caso para
        revisar; não significa, sozinho, erro do agente.
      </p>
    </template>
  </section>
</template>

<style scoped>
.order-assistance-metrics {
  margin-block: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.order-assistance-metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: var(--space-4);
}
.order-assistance-metric-grid div {
  min-inline-size: 0;
}
.order-assistance-metric-grid dt {
  color: var(--color-text-muted);
}
.order-assistance-metric-grid dd {
  margin: var(--space-1) 0 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
</style>
