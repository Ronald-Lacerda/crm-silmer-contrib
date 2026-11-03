<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, commandKey, request } from '../lib/api-client.js';
import {
  HEALTH_ERROR_STATUSES,
  HEALTH_ERROR_VIEWS,
  healthErrorGuidance,
  healthErrorInstant,
  healthErrorSource,
  healthErrorStatus,
  healthErrorTitle,
} from '../lib/health-errors.js';
import '../styles/screens/99-health-errors.css';

const emit = defineEmits(['active-view']);
const heading = ref(null);
const listHeading = ref(null);
const actionErrorSummary = ref(null);
const archiveButton = ref(null);
const archiveHeading = ref(null);
const status = ref('all');
const answeredStatus = ref('all');
const view = ref('active');
const answeredView = ref('active');
const archiveReview = ref(null);
const loading = ref(true);
const busyId = ref('');
const error = ref('');
const actionError = ref('');
const announcement = ref('');
const denied = ref(false);
const requiresRefresh = ref(false);
const answer = ref(null);
let listController;
let actionController;
let disposed = false;
const base = '/api/v1/admin/health-errors';
const items = computed(() => answer.value?.items ?? []);
const summary = computed(() =>
  answeredView.value === 'active'
    ? answer.value?.activeSummary
    : answer.value?.summary,
);
const archiveCandidate = computed(() => answer.value?.legacyArchive);
const totals = computed(() => [
  { value: summary.value?.new ?? 0, label: 'Novos', status: 'new' },
  {
    value: summary.value?.investigating ?? 0,
    label: 'Em análise',
    status: 'investigating',
  },
  {
    value: summary.value?.resolved ?? 0,
    label: 'Resolvidos',
    status: 'resolved',
  },
]);
const filterLabel = computed(
  () =>
    HEALTH_ERROR_STATUSES.find((item) => item.value === answeredStatus.value)
      ?.label,
);

function clearPrivateData() {
  answer.value = null;
  denied.value = true;
  actionError.value = '';
  archiveReview.value = null;
}

/** @param {unknown} cause */
function accessFailure(cause) {
  if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status))
    return false;
  clearPrivateData();
  error.value =
    cause.status === 401
      ? 'Sua sessão expirou. Entre novamente para consultar esta área.'
      : 'Esta área é exclusiva da conta autorizada. Seu acesso não está disponível.';
  return true;
}

/** @param {{announce?: boolean}} [options] */
async function load({ announce = false } = {}) {
  if (disposed || denied.value || busyId.value) return;
  listController?.abort();
  const own = new AbortController();
  listController = own;
  loading.value = true;
  const requested = status.value;
  const requestedView = view.value;
  archiveReview.value = null;
  error.value = '';
  try {
    const response = await request(
      `${base}?status=${encodeURIComponent(requested)}&view=${encodeURIComponent(requestedView)}`,
      {
        signal: own.signal,
      },
    );
    if (disposed || own.signal.aborted) return;
    answer.value = response.data;
    answeredStatus.value = requested;
    answeredView.value = requestedView;
    requiresRefresh.value = false;
    actionError.value = '';
    if (announce) announcement.value = 'Ocorrências atualizadas.';
  } catch (cause) {
    if (disposed || own.signal.aborted || accessFailure(cause)) return;
    error.value = answer.value
      ? 'Não foi possível atualizar. Os dados abaixo são da última consulta bem-sucedida.'
      : 'Não foi possível consultar as ocorrências agora. Tente novamente.';
  } finally {
    if (own === listController && !disposed) loading.value = false;
  }
}

async function chooseStatus() {
  if (busyId.value) return;
  announcement.value = '';
  await load({ announce: true });
}

async function reviewArchive() {
  if (
    loading.value ||
    busyId.value ||
    requiresRefresh.value ||
    !archiveCandidate.value?.count
  )
    return;
  archiveReview.value = { ...archiveCandidate.value };
  await nextTick();
  archiveHeading.value?.focus();
}

async function cancelArchive() {
  if (busyId.value) return;
  archiveReview.value = null;
  await nextTick();
  archiveButton.value?.focus();
}

// OPS-INBOX-ACK-04: archive triage only; delivery outcomes remain unknown.
async function archiveLegacy() {
  if (
    disposed ||
    denied.value ||
    loading.value ||
    busyId.value ||
    requiresRefresh.value ||
    !archiveReview.value
  )
    return;
  const manifest = { ...archiveReview.value };
  busyId.value = 'legacy-archive';
  actionError.value = '';
  announcement.value = '';
  const own = new AbortController();
  actionController = own;
  let changed = false;
  try {
    const response = await request(`${base}/legacy/archive`, {
      method: 'POST',
      body: manifest,
      idempotencyKey: commandKey(),
      signal: own.signal,
    });
    if (disposed || own.signal.aborted) return;
    changed = true;
    requiresRefresh.value = true;
    archiveReview.value = null;
    announcement.value = `${response.data.archivedCount} pendências do WAHA arquivadas. O histórico e o resultado incerto foram preservados. Nenhuma mensagem foi reenviada.`;
  } catch (cause) {
    if (disposed || own.signal.aborted || accessFailure(cause)) return;
    requiresRefresh.value = true;
    archiveReview.value = null;
    actionError.value =
      cause instanceof ApiError && cause.status === 409
        ? 'As pendências do WAHA mudaram desde a consulta. Atualize a lista e revise a quantidade antes de arquivar.'
        : 'Não foi possível confirmar o arquivamento. Atualize a lista para conferir o resultado antes de tentar novamente.';
    await nextTick();
    actionErrorSummary.value?.focus();
  } finally {
    if (!disposed) busyId.value = '';
  }
  if (changed && !disposed) {
    await load();
    await nextTick();
    if (!denied.value) listHeading.value?.focus();
  }
}

/** @param {Record<string, any>} item @param {string} nextStatus */
async function treat(item, nextStatus) {
  if (
    disposed ||
    denied.value ||
    busyId.value ||
    loading.value ||
    requiresRefresh.value
  )
    return;
  busyId.value = item.id;
  actionError.value = '';
  announcement.value = '';
  const own = new AbortController();
  actionController = own;
  let changed = false;
  try {
    await request(`${base}/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: { status: nextStatus, version: item.version },
      idempotencyKey: commandKey(),
      signal: own.signal,
    });
    if (disposed || own.signal.aborted) return;
    changed = true;
    requiresRefresh.value = true;
    announcement.value = `Tratamento registrado: ${healthErrorStatus(nextStatus).toLowerCase()}.`;
  } catch (cause) {
    if (disposed || own.signal.aborted || accessFailure(cause)) return;
    requiresRefresh.value = true;
    actionError.value =
      cause instanceof ApiError && cause.status === 409
        ? 'Esta ocorrência mudou desde a consulta. Atualize a lista antes de registrar o tratamento.'
        : 'Não foi possível confirmar o tratamento. Atualize a lista para conferir o resultado antes de tentar novamente.';
    await nextTick();
    actionErrorSummary.value?.focus();
  } finally {
    if (!disposed) busyId.value = '';
  }
  if (changed && !disposed) {
    await load();
    await nextTick();
    if (!denied.value) listHeading.value?.focus();
  }
}

function dispose() {
  disposed = true;
  listController?.abort();
  actionController?.abort();
  answer.value = null;
  archiveReview.value = null;
}

onMounted(() => {
  heading.value?.focus();
  emit('active-view', {
    dispose,
    // Identity events refresh the shell, which revokes this view immediately.
    refreshFromEvent() {},
    reset() {
      answer.value = null;
      void load();
    },
  });
  void load();
});
onBeforeUnmount(() => {
  dispose();
  emit('active-view', null);
});
</script>

<template>
  <div class="page health-errors-page">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Saúde e erros</h1>
        <p>
          Acompanhe as falhas registradas e organize o tratamento de cada
          problema.
        </p>
      </div>
      <button
        v-if="!denied"
        type="button"
        class="secondary"
        :aria-disabled="loading || busyId ? 'true' : undefined"
        @click="!loading && !busyId && load({ announce: true })"
      >
        {{ loading ? 'Consultando…' : 'Atualizar' }}
      </button>
    </header>

    <p class="health-errors-scope">
      Pendências ativas e histórico dos últimos 30 dias são consultas distintas.
      Arquivar uma pendência não confirma o resultado do envio. Erros da API são
      registrados a partir da ativação desta central; falhas de tarefas e
      comandos n8n são coletadas dos registros do CRM. Esta consulta não
      substitui o monitoramento externo de disponibilidade.
    </p>
    <p v-if="announcement" class="sr-only" role="status">{{ announcement }}</p>
    <div v-if="error" class="audit-note" role="alert">
      <h2 v-if="denied">Acesso indisponível</h2>
      <p>{{ error }}</p>
    </div>
    <div
      v-if="actionError"
      ref="actionErrorSummary"
      class="audit-note"
      role="alert"
      tabindex="-1"
    >
      <p>{{ actionError }}</p>
    </div>

    <div v-if="loading && !answer" class="loading-state" role="status">
      Consultando ocorrências…
    </div>
    <template v-if="answer && !denied">
      <p v-if="answer.collectionPending" class="audit-note" role="status">
        Há mais registros para coletar. Use Atualizar para continuar a consulta;
        as contagens ainda estão incompletas.
      </p>
      <section aria-labelledby="health-errors-summary">
        <h2 id="health-errors-summary" class="health-errors-summary-title">
          {{
            answeredView === 'active'
              ? 'Grupos com pendências ativas'
              : 'Grupos registrados no histórico'
          }}
        </h2>
        <ul class="health-errors-totals" role="list">
          <li
            v-for="total in totals"
            :key="total.status"
            class="surface"
            :data-state="total.status"
          >
            <span>{{ total.label }}</span
            ><strong>{{ total.value }}</strong>
          </li>
        </ul>
      </section>
      <section
        v-if="archiveCandidate?.count"
        class="surface health-errors-archive"
        aria-labelledby="health-errors-archive-title"
      >
        <h2 id="health-errors-archive-title">
          Pendências do WAHA descontinuado
        </h2>
        <p>
          Retire essas pendências da fila ativa preservando o histórico e o
          resultado incerto, sem reenviar mensagens. Outras pendências mantêm
          seu acompanhamento atual.
        </p>
        <button
          v-if="!archiveReview"
          ref="archiveButton"
          type="button"
          class="secondary"
          :aria-disabled="
            loading || busyId || requiresRefresh ? 'true' : undefined
          "
          @click="reviewArchive"
        >
          Arquivar pendências do WAHA ({{ archiveCandidate.count }})
        </button>
        <div v-else class="health-errors-archive-review">
          <h3 ref="archiveHeading" tabindex="-1">
            Revisar arquivamento de {{ archiveReview.count }} pendências
          </h3>
          <p>
            Somente as {{ archiveReview.count }} pendências do WAHA desta
            consulta sairão da fila ativa. O histórico continuará disponível e
            os resultados continuarão incertos. Isso não marca envios como
            resolvidos e não reenvia mensagens.
          </p>
          <div class="health-error-actions">
            <button
              type="button"
              class="secondary"
              :aria-disabled="busyId ? 'true' : undefined"
              @click="archiveLegacy"
            >
              Confirmar arquivamento ({{ archiveReview.count }})
            </button>
            <button
              type="button"
              class="secondary"
              :aria-disabled="busyId ? 'true' : undefined"
              @click="cancelArchive"
            >
              Cancelar
            </button>
            <span v-if="busyId === 'legacy-archive'" role="status"
              >Arquivando…</span
            >
          </div>
        </div>
      </section>
    </template>

    <section
      v-if="!denied"
      class="health-errors-content"
      aria-labelledby="health-errors-list"
      :aria-busy="loading ? 'true' : undefined"
    >
      <div class="health-errors-toolbar">
        <h2 id="health-errors-list" ref="listHeading" tabindex="-1">
          Ocorrências
        </h2>
        <div class="health-errors-filters">
          <label>
            <span>Consulta</span>
            <select
              v-model="view"
              :disabled="Boolean(busyId)"
              @change="chooseStatus"
            >
              <option
                v-for="choice in HEALTH_ERROR_VIEWS"
                :key="choice.value"
                :value="choice.value"
              >
                {{ choice.label }}
              </option>
            </select>
          </label>
          <label>
            <span>Estado</span>
            <select
              v-model="status"
              :disabled="Boolean(busyId)"
              @change="chooseStatus"
            >
              <option
                v-for="choice in HEALTH_ERROR_STATUSES"
                :key="choice.value"
                :value="choice.value"
              >
                {{ choice.label }}
              </option>
            </select>
          </label>
        </div>
      </div>
      <p v-if="answer" class="health-errors-checked">
        {{ answeredView === 'active' ? 'Ativas' : 'Histórico (30 dias)' }} ·
        {{ filterLabel }} · Última consulta:
        {{ healthErrorInstant(answer.checkedAt) }} (Brasília). Até 100
        ocorrências agrupadas.
      </p>
      <p v-if="answer" class="health-errors-checked">
        {{
          answeredView === 'active'
            ? 'Somente fontes que ainda têm pendências. A mesma operação pode aparecer em Processamento e Automação n8n; não some as contagens desses grupos. As contagens atuais não são repetições históricas.'
            : 'Ocorrências e mudanças registradas, inclusive de pendências arquivadas. O estado de acompanhamento não comprova o resultado dos envios.'
        }}
      </p>
      <div v-if="answer && !items.length" class="empty-state">
        <h3>Nenhuma ocorrência nesta consulta</h3>
        <p>
          Não há registros para o estado selecionado. Isso não confirma a
          disponibilidade de todos os serviços.
        </p>
      </div>
      <ul v-else-if="answer" class="health-errors-list" role="list">
        <li v-for="item in items" :key="item.id">
          <article
            class="surface health-error-card"
            :aria-labelledby="`incident-${item.id}`"
          >
            <header class="health-error-heading">
              <div>
                <p class="health-error-source">
                  {{ healthErrorSource(item.source) }}
                </p>
                <h3 :id="`incident-${item.id}`">
                  {{ healthErrorTitle(item.code) }}
                </h3>
              </div>
              <span class="health-error-status" :data-state="item.status">{{
                healthErrorStatus(item.status)
              }}</span>
            </header>
            <p class="health-error-guidance">
              {{ healthErrorGuidance(item.code) }}
            </p>
            <dl v-if="answeredView === 'active'" class="health-error-facts">
              <div>
                <dt>Pendências atuais</dt>
                <dd>{{ item.activeCount }}</dd>
              </div>
              <div>
                <dt>Primeira pendência atual</dt>
                <dd>{{ healthErrorInstant(item.activeFirstSeenAt) }}</dd>
              </div>
              <div>
                <dt>Última pendência atual</dt>
                <dd>{{ healthErrorInstant(item.activeLastSeenAt) }}</dd>
              </div>
            </dl>
            <dl v-else class="health-error-facts">
              <div>
                <dt>Ocorrências históricas (30 dias)</dt>
                <dd>{{ item.occurrences }}</dd>
              </div>
              <div>
                <dt>Primeira ocorrência histórica</dt>
                <dd>{{ healthErrorInstant(item.firstSeenAt) }}</dd>
              </div>
              <div>
                <dt>Última ocorrência histórica</dt>
                <dd>{{ healthErrorInstant(item.lastSeenAt) }}</dd>
              </div>
              <div>
                <dt>Pendências atuais</dt>
                <dd>{{ item.activeCount }}</dd>
              </div>
            </dl>
            <details class="health-error-detail">
              <summary>Referência e histórico</summary>
              <dl>
                <template v-if="answeredView === 'active'">
                  <div>
                    <dt>Ocorrências históricas (30 dias)</dt>
                    <dd>{{ item.occurrences }}</dd>
                  </div>
                  <div>
                    <dt>Primeira ocorrência histórica</dt>
                    <dd>{{ healthErrorInstant(item.firstSeenAt) }}</dd>
                  </div>
                  <div>
                    <dt>Última ocorrência histórica</dt>
                    <dd>{{ healthErrorInstant(item.lastSeenAt) }}</dd>
                  </div>
                </template>
                <div>
                  <dt>Código</dt>
                  <dd>
                    <code>{{ item.code }}</code>
                  </dd>
                </div>
                <div>
                  <dt>Referência</dt>
                  <dd>
                    <code>{{ item.id }}</code>
                  </dd>
                </div>
                <div v-if="item.requestId">
                  <dt>Requisição</dt>
                  <dd>
                    <code>{{ item.requestId }}</code>
                  </dd>
                </div>
                <div v-if="item.correlationId">
                  <dt>Correlação</dt>
                  <dd>
                    <code>{{ item.correlationId }}</code>
                  </dd>
                </div>
              </dl>
              <ol v-if="item.history?.length">
                <li v-for="(event, index) in item.history" :key="index">
                  {{ healthErrorStatus(event.status) }} ·
                  {{ healthErrorInstant(event.at) }}
                </li>
              </ol>
              <p v-else>Sem mudanças de tratamento registradas.</p>
            </details>
            <div
              class="health-error-actions"
              role="group"
              :aria-label="`Tratar ${item.code}`"
            >
              <button
                v-if="item.status === 'new'"
                class="secondary"
                type="button"
                :aria-disabled="
                  loading || busyId || requiresRefresh ? 'true' : undefined
                "
                @click="treat(item, 'investigating')"
              >
                Em análise
              </button>
              <button
                v-if="item.status !== 'resolved'"
                class="secondary"
                type="button"
                :aria-disabled="
                  loading || busyId || requiresRefresh ? 'true' : undefined
                "
                @click="treat(item, 'resolved')"
              >
                Marcar resolvido
              </button>
              <button
                v-else
                class="secondary"
                type="button"
                :aria-disabled="
                  loading || busyId || requiresRefresh ? 'true' : undefined
                "
                @click="treat(item, 'new')"
              >
                Reabrir
              </button>
              <span v-if="busyId === item.id" role="status">Registrando…</span>
            </div>
          </article>
        </li>
      </ul>
      <p class="health-errors-treatment-note">
        Alterar o estado registra o acompanhamento. A correção deve ser feita no
        serviço de origem; nenhum envio ou tarefa é repetido por esta tela.
      </p>
    </section>
  </div>
</template>
