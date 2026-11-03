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
import { brand } from '../brand/index.js';
import { request } from '../lib/api-client.js';
import {
  DEFAULT_PERFORMANCE_DAYS,
  assistantOf,
  PERFORMANCE_PERIODS,
  performanceSummary,
  performanceTitle,
} from '../lib/assistant-performance.js';

// AGENTE-OBS-01 (RFC 041): how the agent did in the chosen window, from the
// aggregates the API computes. Only counts and times reach this page; the
// numbers on screen always name the window they belong to, so a failed change
// of period keeps the last answer instead of looking like zero.
const title = performanceTitle();
const assistant = brand.assistant.reference;
const heading = ref(null);
const retryButton = ref(null);
const liveEvent = inject('liveEvent', ref(null));
const days = ref(DEFAULT_PERFORMANCE_DAYS);
const loading = ref(true);
/** @type {import('vue').Ref<Record<string, any>|null>} */
const answer = ref(null);
const answeredDays = ref(DEFAULT_PERFORMANCE_DAYS);
const error = ref('');
const announcement = ref('');
const consultedAt = ref('');
let controller;
let refreshTimer = 0;
let reconciliationTimer = 0;
let refreshQueued = false;
let disposed = false;

const consultationLabel = computed(() =>
  consultedAt.value
    ? new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'medium',
        timeZone: 'America/Sao_Paulo',
      }).format(new Date(consultedAt.value))
    : '',
);

const summary = computed(() =>
  answer.value ? performanceSummary(answer.value, answeredDays.value) : null,
);
const periodLabel = computed(
  () =>
    PERFORMANCE_PERIODS.find((period) => period.days === days.value)?.label ??
    '',
);

/** @param {unknown} cause */
function failureText(cause) {
  const status = /** @type {any} */ (cause)?.status;
  if (status === 401 || status === 403)
    return `Você não tem acesso ao desempenho ${assistantOf()}.`;
  if (status === 404)
    return 'Este servidor ainda não mede o desempenho. Tente de novo depois da próxima atualização do CRM.';
  return answer.value
    ? `Não foi possível atualizar para ${periodLabel.value}. Os números abaixo continuam sendo de ${summary.value?.windowLabel.toLowerCase()}.`
    : 'Não foi possível carregar o desempenho agora.';
}

/** @param {{announce?: boolean}} [options] */
async function load({ announce = false } = {}) {
  if (disposed) return;
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = 0;
  refreshQueued = false;
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loading.value = true;
  const requested = days.value;
  try {
    const response = await request(
      `/api/v1/inbox/assistant/performance?days=${encodeURIComponent(requested)}`,
      { signal: own.signal },
    );
    if (own !== controller) return;
    answer.value = response.data ?? {};
    answeredDays.value = requested;
    consultedAt.value = new Date().toISOString();
    const restoreFocus =
      error.value &&
      retryButton.value &&
      globalThis.document.activeElement === retryButton.value;
    error.value = '';
    if (announce)
      announcement.value = `${summary.value?.windowLabel ?? 'Período'}: desempenho atualizado.`;
    if (restoreFocus) {
      await nextTick();
      if (!disposed && own === controller) heading.value?.focus();
    }
  } catch (cause) {
    if (own !== controller || /** @type {any} */ (cause)?.name === 'AbortError')
      return;
    error.value = failureText(cause);
  } finally {
    if (own === controller) {
      loading.value = false;
      if (refreshQueued) scheduleLiveRefresh();
    }
  }
}

// One read after a burst of inbox events. Events received during a read queue
// one follow-up instead of aborting a slow request over and over.
function scheduleLiveRefresh() {
  if (disposed || globalThis.document.hidden) return;
  if (loading.value) {
    refreshQueued = true;
    return;
  }
  if (refreshTimer) return;
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    if (globalThis.document.hidden) return;
    void load();
  }, 250);
}

function refreshVisiblePage() {
  if (!globalThis.document.hidden) scheduleLiveRefresh();
}

watch(liveEvent, (event) => {
  if (event?.reset || event?.type?.startsWith('inbox.')) scheduleLiveRefresh();
});

function refresh() {
  if (loading.value) return;
  announcement.value = '';
  void load({ announce: true });
}

/** @param {number} value */
function choosePeriod(value) {
  if (days.value === value) return;
  days.value = value;
  announcement.value = '';
  void load({ announce: true });
}

// The retry stays focusable while it runs (aria-disabled); when the answer
// arrives the button leaves, and the focus goes to the page title.
async function retry() {
  if (loading.value) return;
  await load();
  await nextTick();
  if (error.value) retryButton.value?.focus();
  else heading.value?.focus();
}

onMounted(() => {
  heading.value?.focus();
  void load();
  // Failures without a conversation and the current waiting time may change
  // without an inbox event. Reconcile them without opening another stream.
  reconciliationTimer = globalThis.setInterval(scheduleLiveRefresh, 60_000);
  globalThis.document.addEventListener('visibilitychange', refreshVisiblePage);
});
onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  if (reconciliationTimer) globalThis.clearInterval(reconciliationTimer);
  globalThis.document.removeEventListener(
    'visibilitychange',
    refreshVisiblePage,
  );
});
</script>

<template>
  <div class="page assistant-performance-page">
    <nav class="performance-trail" aria-label="Rastro">
      <RouterLink to="/dashboard">← Dashboard</RouterLink>
    </nav>
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">{{ title }}</h1>
        <p>
          Conversas, transferências, tempos e falhas do atendimento automático.
          Só números do período; nenhuma conversa aparece aqui.
        </p>
      </div>
      <button
        type="button"
        :aria-disabled="loading ? 'true' : undefined"
        @click="refresh"
      >
        {{ loading ? 'Atualizando…' : 'Atualizar' }}
      </button>
    </header>

    <p v-if="consultedAt" class="performance-consultation">
      Última consulta:
      <time :datetime="consultedAt">{{ consultationLabel }}</time>
      (horário de São Paulo).
    </p>

    <div class="performance-period">
      <p id="performance-period-label" class="performance-period-label">
        Período
      </p>
      <div
        class="segmented-options"
        role="group"
        aria-labelledby="performance-period-label"
      >
        <button
          v-for="period in PERFORMANCE_PERIODS"
          :key="period.days"
          type="button"
          :aria-pressed="days === period.days"
          @click="choosePeriod(period.days)"
        >
          {{ period.label }}
        </button>
      </div>
    </div>
    <p v-if="announcement" class="sr-only" role="status">{{ announcement }}</p>

    <div
      v-if="loading && !summary && !error"
      class="loading-state"
      role="status"
    >
      Carregando desempenho…
    </div>
    <div v-else-if="error && !summary" class="empty-state" role="alert">
      <h2>Desempenho indisponível</h2>
      <p>{{ error }}</p>
      <button
        ref="retryButton"
        type="button"
        :aria-disabled="loading ? 'true' : undefined"
        @click="retry()"
      >
        {{ loading ? 'Consultando…' : 'Tentar novamente' }}
      </button>
    </div>
    <div
      v-else-if="summary"
      class="performance-body"
      :aria-busy="loading ? 'true' : undefined"
    >
      <div v-if="error" class="audit-note" role="alert">
        <p>{{ error }}</p>
        <button
          ref="retryButton"
          type="button"
          :aria-disabled="loading ? 'true' : undefined"
          @click="retry()"
        >
          {{ loading ? 'Consultando…' : 'Tentar novamente' }}
        </button>
      </div>
      <p class="performance-window">
        <strong>{{ summary.windowLabel }}</strong>
        <template v-if="summary.empty">
          · Nenhuma conversa com {{ assistant }} neste período.</template
        >
      </p>

      <section
        v-if="summary.telemetryMissing"
        class="audit-note performance-measurement"
        aria-labelledby="performance-measurement"
      >
        <h2 id="performance-measurement">Medição incompleta neste período</h2>
        <p>
          Há atividade registrada, mas nenhum turno foi registrado por versão. O
          preenchimento da ficha pode ficar sem amostras. Confira a coleta de
          dados antes de comparar o desempenho.
        </p>
      </section>

      <section class="dashboard-section" aria-labelledby="performance-totals">
        <h2 id="performance-totals">Resumo</h2>
        <ul class="metric-grid" role="list">
          <li v-for="metric in summary.totals" :key="metric.key">
            <div class="performance-card" :data-tone="metric.tone || undefined">
              <span class="metric-label">{{ metric.label }}</span
              >{{ ' ' }}<span class="metric-value">{{ metric.value }}</span
              >{{ ' ' }}
              <span class="metric-detail">{{ metric.detail }}</span>
            </div>
          </li>
        </ul>
        <p class="performance-more">
          <RouterLink :to="{ path: '/inbox', query: { situacao: 'agente' } }"
            >Ver conversas com {{ assistant }}</RouterLink
          >
        </p>
      </section>

      <section class="dashboard-section" aria-labelledby="performance-reasons">
        <h2 id="performance-reasons">Transferências por motivo</h2>
        <ul v-if="summary.reasons.length" class="performance-list" role="list">
          <li v-for="reason in summary.reasons" :key="reason.code">
            <span class="performance-list-label">{{ reason.label }}</span
            >{{ ' ' }}
            <span class="performance-list-value"
              >{{ reason.count
              }}<template v-if="reason.share">
                · {{ reason.share }}</template
              ></span
            >
          </li>
        </ul>
        <p v-else class="performance-empty">
          Nenhuma transferência no período.
        </p>
      </section>

      <section class="dashboard-section" aria-labelledby="performance-timing">
        <h2 id="performance-timing">Ficha e tempos</h2>
        <ul class="metric-grid" role="list">
          <li v-for="metric in summary.timing" :key="metric.key">
            <div
              class="performance-card"
              :data-empty="metric.empty ? 'true' : undefined"
            >
              <span class="metric-label">{{ metric.label }}</span
              >{{ ' ' }}<span class="metric-value">{{ metric.value }}</span
              >{{ ' ' }}
              <span v-if="metric.detail" class="metric-detail">{{
                metric.detail
              }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section class="dashboard-section" aria-labelledby="performance-failures">
        <h2 id="performance-failures">Falhas</h2>
        <p class="performance-explanation">
          Contagens registradas no período. Os eventos de falha do workflow
          podem incluir falhas fora das respostas do agente e não representam
          clientes afetados nem uma taxa de erro.
        </p>
        <p v-if="summary.failureTotal === null" class="performance-empty">
          Sem dados de falhas neste servidor.
        </p>
        <p v-else-if="summary.failureTotal === 0" class="performance-empty">
          Nenhuma falha no período.
        </p>
        <ul v-else class="performance-list" role="list">
          <li
            v-for="failure in summary.failures"
            :key="failure.key"
            :data-tone="failure.count ? 'warning' : undefined"
          >
            <span class="performance-list-label">{{ failure.label }}</span
            >{{ ' ' }}
            <span class="performance-list-value">{{
              failure.count === null ? '—' : failure.count
            }}</span>
          </li>
        </ul>
      </section>

      <section class="dashboard-section" aria-labelledby="performance-versions">
        <h2 id="performance-versions">Versões do workflow</h2>
        <ul v-if="summary.versions.length" class="performance-list" role="list">
          <li v-for="version in summary.versions" :key="version.version">
            <span class="performance-list-label"
              ><code>{{ version.version }}</code></span
            >{{ ' ' }}
            <span class="performance-list-value">{{ version.detail }}</span>
          </li>
        </ul>
        <p v-else-if="summary.versionsUnavailable" class="performance-empty">
          As versões registradas não estão disponíveis para exibição.
        </p>
        <p v-else class="performance-empty">
          Nenhuma versão registrou turnos no período.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.performance-trail {
  margin-block-end: var(--space-3);
  font-size: var(--text-sm);
}
.performance-trail a {
  display: inline-flex;
  align-items: center;
  min-block-size: var(--target-min);
}
.performance-period {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-block-end: var(--space-4);
}
.performance-period-label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
}
.performance-period .segmented-options {
  flex: 1 1 100%;
  margin: 0;
}
.performance-period .segmented-options button {
  min-block-size: var(--target-min);
}
.performance-window {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
}
.performance-consultation,
.performance-explanation {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.performance-explanation,
.performance-measurement {
  max-inline-size: 48rem;
}
.performance-measurement h2 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-base);
}
.performance-measurement p {
  margin: 0;
}
.performance-body .audit-note {
  margin-block: 0 var(--space-3);
}
.performance-body .audit-note button {
  min-block-size: var(--target-min);
}
.dashboard-section h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-lg);
}
.performance-card {
  display: grid;
  align-content: start;
  gap: var(--space-1);
  min-block-size: 100%;
  padding: var(--space-3);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.performance-card[data-empty='true'] .metric-value {
  color: var(--color-text-muted);
  font-size: var(--text-base);
  font-weight: 500;
}
.performance-card[data-tone='warning'] .metric-value {
  color: var(--status-warning-text);
}
.performance-more {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
}
.performance-more a {
  display: inline-flex;
  align-items: center;
  min-block-size: var(--target-min);
}
.performance-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.performance-list > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-3);
}
.performance-list > li + li {
  border-block-start: 1px solid var(--color-border-subtle);
}
.performance-list-label {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.performance-list-value {
  text-align: end;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.performance-list > li[data-tone='warning'] .performance-list-value {
  color: var(--status-warning-text);
}
.performance-empty {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
@media (min-width: 769px) {
  .performance-period .segmented-options {
    flex: none;
  }
  .performance-period .segmented-options button {
    min-inline-size: max-content;
    min-block-size: calc(var(--control-height) - 0.5rem);
  }
  .performance-card {
    padding: var(--space-4);
  }
  .performance-list {
    max-inline-size: 48rem;
  }
}
</style>
