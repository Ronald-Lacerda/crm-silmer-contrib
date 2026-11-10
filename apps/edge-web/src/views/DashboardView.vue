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
import AppIcon from '../components/AppIcon.vue';
import DashboardActions from '../components/DashboardActions.vue';
import DashboardPerformance from '../components/DashboardPerformance.vue';
import DashboardTeamSummary from '../components/DashboardTeamSummary.vue';
import DashboardWaitingQueue from '../components/DashboardWaitingQueue.vue';
import { request } from '../lib/api-client.js';
import { useLatestRead } from '../lib/dashboard-read.js';
import { minutesLabel } from '../lib/dashboard-metrics.js';
import {
  PERIODS,
  attendanceRows,
  dailySalesChart,
  dueSoonIndicator,
  longDay,
  myOrdersIndicator,
  nextStep,
  overdueIndicator,
  pendingIndicator,
  replyIndicator,
  soldIndicator,
  unavailableIndicator,
  waitingIndicator,
} from '../lib/dashboard-format.js';
import { storeNoticeText } from '../lib/order-format.js';
import { performanceTitle } from '../lib/assistant-performance.js';

// Pesquisa de UX de 15/10/2026, achado 2: o Painel responde às perguntas de
// cada papel. O gestor vê o dia (vendas do período, entregas, quem espera
// uma pessoa e a saúde do assistente); a atendente vê a própria fila
// primeiro. Cada indicador é um link para a lista já filtrada.
// ACT-T04 (protótipo aprovado em 05/11/2026): o gestor lê, nesta ordem,
// próximo passo → vendas e entregas → vendido por dia e atendimento agora →
// equipe em 7 dias → quem espera um vendedor.
const ADMIN_CAPABILITY = 'COMMERCIAL_ADMIN';

const heading = ref(null);
const performanceLinkLabel = `Ver ${performanceTitle().toLocaleLowerCase('pt-BR')}`;
const ordersRetry = ref(null);
const liveEvent = inject('liveEvent', ref(null));
const sessionUser = inject(
  'sessionUser',
  computed(() => ({})),
);
// LOJ-32: the menu shows the same number; the shell does not read it again
// while the Dashboard is open.
const menuStoreCount = inject('storeNewCount', ref(0));
const loading = ref(true);
const summaryLoaded = ref(false);
const hasLoaded = computed(() => summaryLoaded.value || Boolean(queue.value));
const error = ref('');
const queueError = ref('');
const period = ref('hoje');
const periodAnnouncement = ref('');
const dashboardRevision = ref(0);
/** @type {import('vue').Ref<Record<string, any>>} */
const summary = ref({});
/** @type {import('vue').Ref<Record<string, any>|null>} */
const queue = ref(null);
let controller;
let refreshTimer = 0;

const isManager = computed(() =>
  (sessionUser.value?.capabilities ?? []).includes(ADMIN_CAPABILITY),
);
// MET-02 / MET-05: the manager's service times in business minutes; the team
// table and the unclaimed handoffs read from it.
const service = useLatestRead({
  unavailable: 'Não foi possível consultar as esperas sem resposta agora.',
  stale:
    'Não foi possível atualizar as esperas sem resposta. Os números podem estar desatualizados.',
});
const unclaimed = computed(
  () => service.data.value?.team?.unclaimedHandoffs ?? null,
);

// LOJ-31 (ADR 031): paid site orders whose ficha nobody printed yet. The
// notice is one link to the list filtered on "Loja do site"; it disappears
// with the last first print, which reaches here as `inbox.order.changed`.
const storeNotice = computed(() =>
  storeNoticeText(
    summary.value.storeNewCount,
    summary.value.storeNewOldestPaidAt,
  ),
);

const today = computed(() => longDay(summary.value.today));
const intro = computed(() => {
  const context = isManager.value
    ? 'vendas, entregas e quem espera atendimento'
    : 'sua fila e as entregas';
  return today.value ? `${today.value}: ${context}.` : `Hoje: ${context}.`;
});
const soldLabel = computed(
  () => PERIODS.find((option) => option.key === period.value)?.sold ?? '',
);

// PNL-01: one next step for the reader's role, from the same summaries.
const step = computed(() =>
  error.value
    ? {
        key: 'orders-unavailable',
        label: 'Os pedidos não responderam; tente de novo mais abaixo.',
        action: '',
        to: null,
      }
    : nextStep({
        isManager: isManager.value,
        queue: queue.value,
        queueError: queueError.value,
        summary: summary.value,
      }),
);

const now = computed(() => queue.value?.generatedAt);
// PNL-03: without any queue answer the queue cards read "—", never "0". A
// queue read earlier keeps its numbers, flagged as possibly outdated.
/** @param {() => import('../lib/dashboard-format.js').Indicator} indicator */
const fromQueue = (indicator) =>
  queue.value ? indicator() : unavailableIndicator();
// FIN-02 / T130: a failed first sales read must not look like zero sales.
/** @param {() => import('../lib/dashboard-format.js').Indicator} indicator */
const fromSummary = (indicator) =>
  summaryLoaded.value
    ? indicator()
    : {
        ...unavailableIndicator(),
        detail: 'Sem dados de vendas e entregas agora',
      };
const cards = computed(() => ({
  dueSoon: {
    ...fromSummary(() => dueSoonIndicator(summary.value.deliveries)),
    label: 'Próximas entregas',
    to: { path: '/pedidos', query: { entrega: 'proxima' } },
  },
  myOrders: {
    ...fromQueue(() => myOrdersIndicator(queue.value?.mine?.pendingOrderCount)),
    label: 'Meus pedidos pendentes',
    to: { path: '/pedidos', query: { status: 'pendente', vendedor: 'eu' } },
  },
  reply: {
    ...fromQueue(() => replyIndicator(queue.value?.mine, now.value)),
    label: 'Responder agora',
    to: { path: '/inbox', query: { fila: 'minhas' } },
  },
  overdue: {
    ...fromSummary(() => overdueIndicator(summary.value.deliveries)),
    label: 'Entregas atrasadas',
    to: { path: '/pedidos', query: { entrega: 'atrasada' } },
  },
  pending: {
    ...fromSummary(() => pendingIndicator(summary.value.pendingCount)),
    label: 'Pedidos a confirmar',
    to: { path: '/pedidos', query: { status: 'pendente' } },
  },
  sold: {
    ...fromSummary(() => soldIndicator(summary.value.period)),
    label: soldLabel.value,
    to: { path: '/pedidos', query: { status: 'confirmado' } },
  },
  waiting: {
    ...fromQueue(() =>
      waitingIndicator(queue.value?.waitingHandoff, now.value),
    ),
    label: 'Esperando vendedor',
    to: { path: '/inbox', query: { situacao: 'aguardando' } },
  },
}));

// Mobile-first (PO, 15/10/2026): the seller works from the phone, so their
// home is "Minha fila" — what to answer now, what is stalled waiting for a
// seller and their own pending orders — then the deliveries. The manager
// reads the day first: sales of the period and deliveries, then the week by
// day next to "Atendimento agora" (PNL-05/06), then the team.
const sections = computed(() =>
  isManager.value
    ? [
        {
          cards: ['sold', 'pending', 'overdue', 'dueSoon'],
          id: 'orders',
          period: true,
          title: 'Vendas e entregas',
        },
      ]
    : [
        {
          cards: ['reply', 'waiting', 'myOrders'],
          id: 'attendance',
          queue: true,
          title: 'Minha fila',
        },
        { cards: ['overdue', 'dueSoon'], id: 'orders', title: 'Entregas' },
      ],
);

// PNL-05: the week by day; FIN-02 / T130, no bars without a sales read.
const salesChart = computed(() =>
  dailySalesChart(summary.value.daily, {
    loaded: summaryLoaded.value && !error.value,
  }),
);
// PNL-06 / PNL-03: three links into the Inbox; "—" without a queue read.
const attendance = computed(() =>
  attendanceRows(queue.value, {
    failed: !queue.value || Boolean(queueError.value),
  }),
);
function loadService() {
  return isManager.value
    ? service.load('/api/v1/dashboard/metrics/service?days=7')
    : Promise.resolve(false);
}

async function retryService() {
  if (service.loading.value) return;
  if (!(await loadService())) return;
  await nextTick();
  queueHeading?.focus();
}

async function loadDashboard({ announce = false } = {}) {
  if (!announce) void loadService();
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  loading.value = true;
  const signal = currentController.signal;
  const [orders, inbox] = await Promise.allSettled([
    request(
      `/api/v1/orders/summary?period=${encodeURIComponent(period.value)}`,
      {
        signal,
      },
    ),
    request('/api/v1/inbox/summary', { signal }),
  ]);
  if (controller !== currentController) return;
  loading.value = false;
  if (orders.status === 'fulfilled') {
    summary.value = orders.value.data ?? {};
    const storeCount = Number(summary.value.storeNewCount ?? 0);
    menuStoreCount.value =
      Number.isSafeInteger(storeCount) && storeCount > 0 ? storeCount : 0;
    summaryLoaded.value = true;
    error.value = '';
    if (announce) periodAnnouncement.value = `${soldLabel.value} atualizado.`;
  } else if (orders.reason?.name !== 'AbortError') {
    error.value = summaryLoaded.value
      ? 'Não foi possível atualizar os indicadores. Os dados exibidos podem estar desatualizados.'
      : 'Não foi possível carregar os indicadores.';
  }
  if (inbox.status === 'fulfilled') {
    queue.value = inbox.value.data ?? null;
    queueError.value = '';
  } else if (inbox.reason?.name !== 'AbortError') {
    queueError.value = queue.value
      ? 'A fila não foi atualizada agora. Os números podem estar desatualizados.'
      : 'Não foi possível consultar a fila agora.';
  }
}

/** @type {HTMLElement|null} */
let queueHeading = null;
/** @param {any} element */
function setQueueHeading(element) {
  queueHeading = element instanceof HTMLElement ? element : null;
}

// PNL-03: the queue retry stays focusable while it runs (aria-disabled); when
// the queue answers, the button leaves and focus goes to the section title.
async function retryQueue() {
  if (loading.value) return;
  await loadDashboard();
  if (queueError.value) return;
  await nextTick();
  queueHeading?.focus();
}

async function retryOrders() {
  if (loading.value) return;
  await loadDashboard();
  await nextTick();
  if (error.value) ordersRetry.value?.focus();
  else heading.value?.focus();
}

/** @param {string} key */
function choosePeriod(key) {
  if (period.value === key) return;
  period.value = key;
  periodAnnouncement.value = '';
  void loadDashboard({ announce: true });
}

function scheduleLiveRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void loadDashboard();
  }, 250);
}

function dashboardChanged() {
  dashboardRevision.value += 1;
  void loadDashboard();
}

watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.conversation.changed',
      'inbox.contact.changed',
    ].includes(event?.type)
  ) {
    scheduleLiveRefresh();
  }
});

onMounted(() => {
  heading.value?.focus();
  void loadDashboard();
});
// The session can arrive after the first paint; the manager's service read
// starts when the role is known.
watch(isManager, (manager) => {
  if (manager && !service.data.value && !service.loading.value)
    void loadService();
});
onBeforeUnmount(() => {
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="page dashboard-page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Dashboard</h1>
        <p>{{ intro }}</p>
      </div>
    </header>

    <!-- LOJ-31: the region exists from the first paint so the arrival of a
         new site order is announced; the link is the whole notice. -->
    <div class="store-notice-region" aria-live="polite">
      <RouterLink
        v-if="storeNotice"
        class="store-notice"
        :to="{ path: '/pedidos', query: { origem: 'loja' } }"
      >
        <span class="store-notice-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"
            />
          </svg>
        </span>
        <span class="store-notice-text">
          <strong>{{ storeNotice.title }}</strong>
          <span>{{ storeNotice.detail }}</span>
        </span>
        <span class="store-notice-action">
          Ver pedidos
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
            <path d="m9 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6Z" />
          </svg>
        </span>
      </RouterLink>
    </div>

    <DashboardActions v-if="!isManager" @changed="dashboardChanged">
      <template #summary>
        <DashboardPerformance :revision="dashboardRevision" />
      </template>
    </DashboardActions>

    <component
      :is="isManager ? 'div' : 'details'"
      class="dashboard-secondary-sources"
    >
      <summary v-if="!isManager">Outras filas e entregas</summary>
      <div
        v-if="loading && !hasLoaded && !error"
        class="loading-state"
        role="status"
      >
        Carregando indicadores…
      </div>
      <div v-else-if="error && !hasLoaded" class="empty-state" role="alert">
        <h2>Dashboard indisponível</h2>
        <p>{{ error }}</p>
        <button
          ref="ordersRetry"
          type="button"
          :aria-disabled="loading ? 'true' : undefined"
          @click="retryOrders()"
        >
          {{ loading ? 'Consultando…' : 'Tentar novamente' }}
        </button>
      </div>
      <template v-else>
        <!-- PNL-01: one next step for the role, no heading of its own (the
           section titles stay the page outline); one button-like link at
           most, after the sentence it acts on. -->
        <section class="next-step" aria-labelledby="dashboard-next-step-label">
          <div class="next-step-body">
            <p id="dashboard-next-step-label" class="next-step-label">
              Próximo passo
            </p>
            <p class="next-step-text">{{ step.label }}</p>
          </div>
          <RouterLink v-if="step.to" class="next-step-link" :to="step.to">
            {{ step.action || 'Ver' }}
          </RouterLink>
        </section>

        <div v-if="error" class="audit-note" role="alert">
          <p>{{ error }}</p>
          <button
            ref="ordersRetry"
            type="button"
            :aria-disabled="loading ? 'true' : undefined"
            @click="retryOrders()"
          >
            {{ loading ? 'Consultando…' : 'Tentar novamente' }}
          </button>
        </div>
        <p v-if="periodAnnouncement" class="sr-only" role="status">
          {{ periodAnnouncement }}
        </p>

        <section
          v-for="section in sections"
          :key="section.id"
          class="dashboard-section"
          :aria-labelledby="`dashboard-${section.id}-title`"
        >
          <div class="dashboard-section-head">
            <h2
              :id="`dashboard-${section.id}-title`"
              :ref="section.queue ? setQueueHeading : undefined"
              :tabindex="section.queue ? -1 : undefined"
            >
              {{ section.title }}
            </h2>
            <!-- PNL-02: the period only changes "Vendido"; the legend says so. -->
            <div v-if="section.period" class="dashboard-period">
              <p id="dashboard-period-scope" class="dashboard-period-scope">
                Vale para Vendido
              </p>
              <div
                class="segmented-options"
                role="group"
                aria-label="Período das vendas"
                aria-describedby="dashboard-period-scope"
              >
                <button
                  v-for="option in PERIODS"
                  :key="option.key"
                  type="button"
                  :aria-pressed="period === option.key"
                  @click="choosePeriod(option.key)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </div>
          <!-- PNL-03: the section never disappears when the queue fails. -->
          <div
            v-if="section.queue && queueError"
            class="audit-note"
            role="alert"
          >
            <p>{{ queueError }}</p>
            <button
              type="button"
              :aria-disabled="loading ? 'true' : undefined"
              @click="retryQueue()"
            >
              {{ loading ? 'Consultando…' : 'Tentar novamente' }}
            </button>
          </div>
          <ul class="metric-grid" role="list">
            <li v-for="key in section.cards" :key="key">
              <RouterLink
                class="metric-card"
                :to="cards[key].to"
                :data-tone="cards[key].tone || undefined"
              >
                <span class="metric-head">
                  <span class="metric-label">{{ cards[key].label }}</span>
                  <AppIcon name="chevron" class="metric-go" />
                </span>
                <span class="metric-value">{{ cards[key].value }}</span>
                <span class="metric-detail">
                  <span
                    v-if="cards[key].badge"
                    class="badge"
                    :data-tone="cards[key].tone"
                    >{{ cards[key].badge }}</span
                  >
                  {{ cards[key].detail }}
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <div v-if="isManager" class="dashboard-insights">
          <!-- PNL-05: the last seven days; the figure speaks every day and
             full value, the drawn labels are only for the eye. -->
          <section
            class="dashboard-card sales-by-day"
            aria-labelledby="dashboard-daily-title"
          >
            <h2 id="dashboard-daily-title">Vendido por dia</h2>
            <p class="dashboard-card-subtitle">{{ salesChart.summary }}</p>
            <div
              v-if="salesChart.available"
              class="sales-chart"
              role="img"
              :aria-label="salesChart.description"
            >
              <ol class="sales-chart-plot" aria-hidden="true">
                <li
                  v-for="bar in salesChart.bars"
                  :key="bar.day"
                  class="sales-chart-column"
                  :data-current="bar.current || undefined"
                  :style="{ '--bar': bar.ratio }"
                >
                  <span class="sales-chart-track">
                    <span class="sales-chart-value">{{ bar.value }}</span>
                    <span class="sales-chart-bar"></span>
                  </span>
                  <span class="sales-chart-day">{{ bar.label }}</span>
                </li>
              </ol>
            </div>
            <p v-else class="sales-chart-empty">Sem dados de vendas agora</p>
          </section>

          <!-- PNL-06 / PNL-03: three links into the Inbox; without a queue
             read every number is "—" and the retry stays here. -->
          <section
            class="dashboard-card attendance-now"
            aria-labelledby="dashboard-attendance-title"
          >
            <h2
              id="dashboard-attendance-title"
              :ref="setQueueHeading"
              tabindex="-1"
            >
              Atendimento agora
            </h2>
            <div v-if="queueError" class="audit-note" role="alert">
              <p>{{ queueError }}</p>
              <button
                type="button"
                :aria-disabled="loading ? 'true' : undefined"
                @click="retryQueue()"
              >
                {{ loading ? 'Consultando…' : 'Tentar novamente' }}
              </button>
            </div>
            <ul class="attendance-list" role="list">
              <li v-for="row in attendance" :key="row.key">
                <RouterLink
                  class="attendance-row"
                  :to="row.to"
                  :data-tone="row.tone || undefined"
                >
                  <span class="attendance-value">{{ row.value }}</span>
                  <span class="attendance-text">
                    <span class="attendance-label">{{ row.label }}</span>
                    <span
                      class="attendance-detail"
                      :data-tone="row.detailTone || undefined"
                      >{{ row.detail }}</span
                    >
                  </span>
                  <AppIcon name="chevron" class="attendance-go" />
                </RouterLink>
              </li>
            </ul>
            <!-- MET-02: a handoff nobody took is never omitted, with its age
               in business minutes. -->
            <p
              v-if="unclaimed && unclaimed.count > 0"
              class="dashboard-performance-note"
            >
              Pedidos de atendimento ainda sem tomada: {{ unclaimed.count
              }}<template v-if="unclaimed.oldestWaitingMinutes !== null"
                >; o mais antigo espera
                {{ minutesLabel(unclaimed.oldestWaitingMinutes) }} de
                expediente</template
              >.
            </p>
            <!-- ACT-09: the service read fails in its own region, with retry. -->
            <div v-if="service.error.value" class="audit-note" role="alert">
              <p>{{ service.error.value }}</p>
              <button
                type="button"
                :aria-disabled="service.loading.value ? 'true' : undefined"
                @click="retryService()"
              >
                {{
                  service.loading.value
                    ? 'Consultando…'
                    : 'Atualizar atendimento'
                }}
              </button>
            </div>
            <!-- AGENTE-OBS-01: the agent's numbers over days. -->
            <RouterLink class="metric-more" to="/dashboard/agente">{{
              performanceLinkLabel
            }}</RouterLink>
          </section>
        </div>
      </template>
    </component>
    <!-- The team after the day and the week, then who waits for a seller
         (ACT-T04: PERF-01..05, PCX-03, MET-02, MET-05). -->
    <template v-if="isManager">
      <DashboardTeamSummary
        :service="service.data.value"
        :service-error="service.error.value"
        :revision="dashboardRevision"
      />
      <DashboardWaitingQueue
        :now="queue?.generatedAt ?? ''"
        :total="queue ? Number(queue.waitingHandoff?.count ?? 0) : null"
      />
    </template>
  </div>
</template>
