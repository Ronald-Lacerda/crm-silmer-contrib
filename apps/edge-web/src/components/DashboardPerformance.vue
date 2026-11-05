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
import { request } from '../lib/api-client.js';
import {
  performanceCount,
  performanceMoney,
} from '../lib/dashboard-actions.js';

const props = defineProps({
  manager: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
});
const liveEvent = inject('liveEvent', ref(null));
const days = ref(7);
const loadedDays = ref(7);
const loaded = ref(false);
const loading = ref(true);
const error = ref('');
const expanded = ref(false);
const heading = ref(null);
/** @type {import('vue').Ref<Record<string, any>|null>} */
const performance = ref(null);
let controller;
let refreshTimer = 0;
const rows = computed(() => performance.value?.rows ?? []);
const own = computed(() => rows.value[0] ?? null);

async function load({ focus = false } = {}) {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const response = await request(
      `/api/v1/dashboard/performance?days=${days.value}`,
      { signal: current.signal },
    );
    if (controller !== current) return;
    performance.value = response.data;
    loadedDays.value = Number(response.data.days) === 30 ? 30 : 7;
    loaded.value = true;
    error.value = '';
    if (focus) {
      await nextTick();
      heading.value?.focus();
    }
  } catch (cause) {
    if (controller !== current || cause?.name === 'AbortError') return;
    error.value = loaded.value
      ? 'Não foi possível atualizar o desempenho. Os dados exibidos podem estar desatualizados.'
      : 'Não foi possível consultar o desempenho agora.';
  } finally {
    if (controller === current) loading.value = false;
  }
}
function refresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load();
  }, 250);
}
watch(days, () => {
  void load();
});
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
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <section
    class="dashboard-performance"
    :class="{ 'dashboard-performance-compact': compact }"
    :aria-labelledby="
      manager ? 'dashboard-team-title' : 'dashboard-own-performance-title'
    "
  >
    <div class="dashboard-performance-head">
      <h2
        :id="
          manager ? 'dashboard-team-title' : 'dashboard-own-performance-title'
        "
        ref="heading"
        tabindex="-1"
      >
        {{ manager ? 'Desempenho da equipe' : 'Seu resultado' }}
      </h2>
      <label class="dashboard-performance-period">
        <span class="sr-only">Período do desempenho</span>
        <select v-model.number="days">
          <option :value="7">Últimos 7 dias</option>
          <option :value="30">Últimos 30 dias</option>
        </select>
      </label>
    </div>
    <div v-if="error" class="audit-note" role="alert">
      <p>{{ error }}</p>
      <p v-if="loaded">Última consulta válida: {{ loadedDays }} dias.</p>
      <button
        type="button"
        :aria-disabled="loading ? 'true' : undefined"
        @click="!loading && load({ focus: true })"
      >
        {{ loading ? 'Consultando…' : 'Atualizar desempenho' }}
      </button>
    </div>
    <p v-if="loading && !loaded" class="dashboard-data-loading" role="status">
      Carregando desempenho…
    </p>
    <template v-if="loaded">
      <template v-if="manager">
        <div class="dashboard-sales-total">
          <div>
            <span>Vendido no período</span
            ><strong>{{
              performanceMoney(performance?.totals?.soldAmountCents)
            }}</strong>
          </div>
          <p>
            {{ performanceCount(performance?.totals?.confirmedCount) }} pedidos
            confirmados · loja incluída
          </p>
        </div>
        <div class="dashboard-team-table-wrap">
          <table class="dashboard-team-table" role="table">
            <caption class="sr-only">
              Atividade e vendas por vendedor nos últimos
              {{
                loadedDays
              }}
              dias
            </caption>
            <thead role="rowgroup">
              <tr role="row">
                <th id="team-seller" scope="col" role="columnheader">
                  Vendedor
                </th>
                <th id="team-sold" scope="col" role="columnheader">
                  Vendido atribuído
                </th>
                <th id="team-attended" scope="col" role="columnheader">
                  Atendeu
                </th>
                <th id="team-assumed" scope="col" role="columnheader">
                  Assumiu
                </th>
                <th id="team-closed" scope="col" role="columnheader">
                  Encerrou
                </th>
                <th id="team-sale" scope="col" role="columnheader">
                  Com venda
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              <tr v-for="(row, index) in rows" :key="row.userId" role="row">
                <th
                  :id="`team-person-${index}`"
                  scope="row"
                  role="rowheader"
                  headers="team-seller"
                >
                  {{ row.name
                  }}<span
                    v-if="row.active === false"
                    class="dashboard-cell-note"
                    >Inativo</span
                  >
                </th>
                <td
                  data-label="Vendido atribuído"
                  role="cell"
                  :headers="`team-person-${index} team-sold`"
                >
                  <strong>{{ performanceMoney(row.soldAmountCents) }}</strong
                  ><span class="dashboard-cell-note"
                    >{{ performanceCount(row.confirmedCount) }} pedidos</span
                  >
                  <span class="dashboard-cell-note"
                    >Ticket médio:
                    {{ performanceMoney(row.averageTicketCents) }}</span
                  >
                </td>
                <td
                  data-label="Atendeu"
                  role="cell"
                  :headers="`team-person-${index} team-attended`"
                >
                  {{ performanceCount(row.attendedCount) }}
                </td>
                <td
                  data-label="Assumiu"
                  role="cell"
                  :headers="`team-person-${index} team-assumed`"
                >
                  {{ performanceCount(row.assumedCount) }}
                </td>
                <td
                  data-label="Encerrou"
                  role="cell"
                  :headers="`team-person-${index} team-closed`"
                >
                  {{ performanceCount(row.closedCount) }}
                </td>
                <td
                  data-label="Com venda"
                  role="cell"
                  :headers="`team-person-${index} team-sale`"
                >
                  {{ performanceCount(row.conversationsWithSaleCount) }}
                </td>
              </tr>
              <tr v-if="!rows.length" role="row">
                <td colspan="6" class="dashboard-table-empty" role="cell">
                  Nenhuma atividade de vendedores no período.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="dashboard-performance-note">
          Loja do site:
          {{ performanceMoney(performance?.store?.soldAmountCents) }} ·
          {{ performanceCount(performance?.store?.confirmedCount) }} pedidos.
        </p>
        <p class="dashboard-performance-note">
          Sem atribuição histórica:
          {{ performanceMoney(performance?.unattributed?.soldAmountCents) }} ·
          {{ performanceCount(performance?.unattributed?.confirmedCount) }}
          pedidos.
        </p>
        <p class="dashboard-performance-note">
          Atendeu, assumiu e com venda contam conversas; encerrou conta
          atendimentos. Uma conversa pode ser atendida por mais de um vendedor.
          O crédito comercial fica com o responsável pelo pedido.
        </p>
      </template>
      <template v-else>
        <dl class="dashboard-own-stats">
          <div>
            <dt>Vendido atribuído</dt>
            <dd>{{ performanceMoney(own?.soldAmountCents) }}</dd>
          </div>
          <div>
            <dt>Pedidos</dt>
            <dd>{{ performanceCount(own?.confirmedCount) }}</dd>
          </div>
          <div>
            <dt>Atendimentos</dt>
            <dd>{{ performanceCount(own?.attendedCount) }}</dd>
          </div>
        </dl>
        <button
          type="button"
          class="link-button dashboard-performance-more"
          :aria-expanded="expanded"
          aria-controls="dashboard-own-performance-detail"
          @click="expanded = !expanded"
        >
          {{ expanded ? 'Recolher desempenho' : 'Ver desempenho completo' }}
        </button>
        <p class="dashboard-performance-note">
          O crédito é capturado na confirmação. Histórico sem atribuição
          permanece no total da empresa.
        </p>
        <div v-if="expanded" id="dashboard-own-performance-detail">
          <dl class="dashboard-performance-detail">
            <div>
              <dt>Ticket médio</dt>
              <dd>{{ performanceMoney(own?.averageTicketCents) }}</dd>
            </div>
            <div>
              <dt>Conversas assumidas</dt>
              <dd>{{ performanceCount(own?.assumedCount) }}</dd>
            </div>
            <div>
              <dt>Atendimentos encerrados</dt>
              <dd>{{ performanceCount(own?.closedCount) }}</dd>
            </div>
            <div>
              <dt>Conversas com venda</dt>
              <dd>{{ performanceCount(own?.conversationsWithSaleCount) }}</dd>
            </div>
          </dl>
          <p class="dashboard-performance-note">
            Encerrar atendimento não comprova venda. Pagamento e entrega não
            criam novas vendas.
          </p>
        </div>
      </template>
    </template>
    <p v-else-if="!loading" class="dashboard-performance-note">
      Sem dados de desempenho disponíveis.
    </p>
  </section>
</template>
