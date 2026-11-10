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
import { RouterLink } from 'vue-router';
import DashboardTeamTable from './DashboardTeamTable.vue';
import { useLatestRead } from '../lib/dashboard-read.js';
import { joinPeople, salesReconciliation } from '../lib/dashboard-metrics.js';
import { countCell, salesTable } from '../lib/team-performance.js';
import { performanceMoney } from '../lib/dashboard-actions.js';

// "Equipe nos últimos 7 dias" (PERF-01..05, MET-05): the manager's compact
// view of the team. Sales come from `/dashboard/performance`; "Sem resposta"
// counts the waits past 15 business minutes in the period, from the service
// read the Dashboard already holds. The full table lives on its own page.
const props = defineProps({
  /** `/dashboard/metrics/service?days=7`, owned by the Dashboard. */
  service: { type: Object, default: null },
  serviceError: { type: String, default: '' },
  revision: { type: Number, default: 0 },
});
const LIMIT = 5;
const liveEvent = inject('liveEvent', ref(null));
const heading = ref(null);
const sales = useLatestRead({
  unavailable: 'Não foi possível consultar as vendas da equipe agora.',
  stale:
    'Não foi possível atualizar as vendas da equipe. Os dados exibidos podem estar desatualizados.',
});
let refreshTimer = 0;

const columns = [
  { key: 'sold', label: 'Vendido', meter: true },
  { key: 'attended', label: 'Atendeu' },
  { key: 'unanswered', label: 'Sem resposta' },
];
const people = computed(() =>
  joinPeople(sales.data.value?.rows, props.service?.rows),
);
const table = computed(() => {
  const base = salesTable(sales.data.value, { withSale: false });
  const byId = new Map(people.value.map((person) => [person.userId, person]));
  const rows = base.rows.slice(0, LIMIT).map((row) => {
    const [activity, times] = byId.get(row.id)?.sources ?? [];
    const episodes = times?.unansweredEpisodes?.count;
    return {
      ...row,
      cells: {
        sold: row.cells.sold,
        attended: countCell(activity?.attendedCount),
        unanswered: props.service
          ? {
              ...countCell(episodes ?? 0),
              tone: Number(episodes) > 0 ? 'warning' : undefined,
            }
          : { text: '—', value: null },
      },
    };
  });
  /** @param {any} row */
  const channel = (row) => ({
    ...row,
    cells: {
      sold: row.cells.sold,
      attended: { text: '—', value: null },
      unanswered: { text: '—', value: null },
    },
  });
  return {
    rows,
    extraRows: base.extraRows.map(channel),
    totalRow: base.totalRow ? channel(base.totalRow) : null,
  };
});
const hidden = computed(() =>
  Math.max(0, (sales.data.value?.rows?.length ?? 0) - LIMIT),
);
const reconciliation = computed(() =>
  sales.data.value ? salesReconciliation(sales.data.value) : null,
);

function load() {
  return sales.load('/api/v1/dashboard/performance?days=7');
}
async function retry() {
  if (sales.loading.value) return;
  if (await load()) {
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
    class="dashboard-panel dashboard-team-summary"
    aria-labelledby="dashboard-team-title"
    :aria-busy="sales.loading.value ? 'true' : undefined"
  >
    <div class="dashboard-panel-head">
      <div>
        <h2 id="dashboard-team-title" ref="heading" tabindex="-1">
          Equipe nos últimos 7 dias
        </h2>
        <p>A venda conta para quem era responsável na confirmação.</p>
      </div>
      <RouterLink class="dashboard-panel-link" to="/dashboard/equipe"
        >Ver desempenho da equipe</RouterLink
      >
    </div>
    <div v-if="sales.error.value" class="audit-note" role="alert">
      <p>{{ sales.error.value }}</p>
      <button
        type="button"
        :aria-disabled="sales.loading.value ? 'true' : undefined"
        @click="retry"
      >
        {{ sales.loading.value ? 'Consultando…' : 'Atualizar equipe' }}
      </button>
    </div>
    <p
      v-if="sales.loading.value && !sales.data.value"
      class="dashboard-data-loading"
      role="status"
    >
      Carregando a equipe…
    </p>
    <template v-if="sales.data.value">
      <DashboardTeamTable
        id-prefix="dashboard-team"
        caption="Vendas, conversas atendidas e esperas sem resposta por vendedor nos últimos 7 dias"
        :columns="columns"
        :rows="table.rows"
        :extra-rows="table.extraRows"
        :total-row="table.totalRow"
        sorted-by="sold"
        empty-text="Nenhuma venda ou atendimento de vendedores no período."
      />
      <p v-if="hidden" class="dashboard-performance-note">
        Mostrando {{ LIMIT }} de {{ LIMIT + hidden }} pessoas; o total inclui
        todas.
      </p>
      <p
        v-if="reconciliation && reconciliation.difference !== 0"
        class="dashboard-performance-note"
      >
        A soma das linhas difere do total em
        {{ performanceMoney(Math.abs(reconciliation.difference)) }}; confira a
        página da equipe.
      </p>
      <p v-if="serviceError" class="dashboard-performance-note">
        "Sem resposta" indisponível agora; tente de novo em Atendimento agora.
      </p>
      <p class="dashboard-performance-note">
        Sem resposta: esperas de cliente que passaram de 15 minutos no
        expediente, uma vez por espera.
      </p>
    </template>
    <p
      v-else-if="!sales.loading.value && !sales.error.value"
      class="dashboard-performance-note"
    >
      Sem dados da equipe disponíveis.
    </p>
  </section>
</template>
