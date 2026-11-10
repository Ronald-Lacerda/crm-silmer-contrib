<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useLatestRead } from '../lib/dashboard-read.js';
import { minutesLabel } from '../lib/dashboard-metrics.js';
import {
  performanceCount,
  performanceMoney,
} from '../lib/dashboard-actions.js';

// "Seu resultado" (PERF-07, MET-03): the seller reads only their own line,
// as text with no controls (design.md §18, orçamento de 9 controles). The
// window is the last 7 days; sales and the first answer are separate reads,
// so one failing never turns the other into zero.
const props = defineProps({
  revision: { type: Number, default: 0 },
});
const DAYS = 7;
const liveEvent = inject('liveEvent', ref(null));
const heading = ref(null);
const sales = useLatestRead({
  unavailable: 'Não foi possível consultar suas vendas agora.',
  stale:
    'Não foi possível atualizar suas vendas. Os dados exibidos podem estar desatualizados.',
});
const service = useLatestRead({
  unavailable: 'Não foi possível consultar seu tempo de resposta agora.',
  stale:
    'Não foi possível atualizar seu tempo de resposta. Os dados exibidos podem estar desatualizados.',
});
let refreshTimer = 0;

const own = computed(() => sales.data.value?.rows?.[0] ?? null);
const ownService = computed(() => service.data.value?.rows?.[0] ?? null);
const loading = computed(() => sales.loading.value || service.loading.value);
const errors = computed(() =>
  [sales.error.value, service.error.value].filter(Boolean),
);
const firstAnswered = computed(
  () => Boolean(sales.data.value) || Boolean(service.data.value),
);
const soldDetail = computed(() => {
  if (!own.value) return sales.data.value ? 'Nenhuma venda no período' : '';
  const count = performanceCount(own.value.confirmedCount);
  return `${count} ${own.value.confirmedCount === 1 ? 'pedido' : 'pedidos'}`;
});
const responseDetail = computed(() => {
  const metric = ownService.value?.firstResponse;
  if (!metric) return '';
  if (!metric.samples) return 'Sem respostas medidas no período';
  return `mediana no expediente · ${metric.samples} ${metric.samples === 1 ? 'amostra' : 'amostras'}`;
});

function load() {
  return Promise.all([
    sales.load(`/api/v1/dashboard/performance?days=${DAYS}`),
    service.load(`/api/v1/dashboard/metrics/service?days=${DAYS}`),
  ]);
}
async function retry() {
  if (loading.value) return;
  await Promise.all([
    sales.error.value || !sales.data.value
      ? sales.load(`/api/v1/dashboard/performance?days=${DAYS}`)
      : null,
    service.error.value || !service.data.value
      ? service.load(`/api/v1/dashboard/metrics/service?days=${DAYS}`)
      : null,
  ]);
  if (!errors.value.length) {
    await nextTick();
    heading.value?.focus();
  }
}
function refresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load();
  }, 250);
}
watch(() => props.revision, refresh);
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    ['inbox.order.changed', 'inbox.conversation.changed'].includes(event?.type)
  )
    refresh();
});
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <section
    class="dashboard-own-result"
    aria-labelledby="dashboard-own-performance-title"
    :aria-busy="loading ? 'true' : undefined"
  >
    <div class="dashboard-own-result-head">
      <h2 id="dashboard-own-performance-title" ref="heading" tabindex="-1">
        Seu resultado
      </h2>
      <p>Últimos {{ DAYS }} dias</p>
    </div>
    <p
      v-if="loading && !firstAnswered"
      class="dashboard-data-loading"
      role="status"
    >
      Carregando seu resultado…
    </p>
    <dl class="dashboard-own-stats">
      <div>
        <dt>Vendido</dt>
        <dd>{{ performanceMoney(own?.soldAmountCents) }}</dd>
        <dd v-if="soldDetail" class="dashboard-own-detail">
          {{ soldDetail }}
        </dd>
      </div>
      <div>
        <dt>Atendeu</dt>
        <dd>{{ performanceCount(own?.attendedCount) }}</dd>
        <dd v-if="own" class="dashboard-own-detail">conversas</dd>
      </div>
      <div>
        <dt>1ª resposta</dt>
        <dd>{{ minutesLabel(ownService?.firstResponse?.medianMinutes) }}</dd>
        <dd v-if="responseDetail" class="dashboard-own-detail">
          {{ responseDetail }}
        </dd>
      </div>
    </dl>
    <div v-if="errors.length" class="audit-note" role="alert">
      <p v-for="message in errors" :key="message">{{ message }}</p>
      <button
        type="button"
        :aria-disabled="loading ? 'true' : undefined"
        @click="retry"
      >
        {{ loading ? 'Consultando…' : 'Atualizar resultado' }}
      </button>
    </div>
  </section>
</template>
