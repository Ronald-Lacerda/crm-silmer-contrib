<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, commandKey, request } from '../lib/api-client.js';
import {
  HEALTH_ERROR_STATUSES,
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
const status = ref('all');
const answeredStatus = ref('all');
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
const totals = computed(() => [
  { value: answer.value?.summary?.new ?? 0, label: 'Novos', status: 'new' },
  {
    value: answer.value?.summary?.investigating ?? 0,
    label: 'Em análise',
    status: 'investigating',
  },
  {
    value: answer.value?.summary?.resolved ?? 0,
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
  error.value = '';
  try {
    const response = await request(
      `${base}?status=${encodeURIComponent(requested)}`,
      {
        signal: own.signal,
      },
    );
    if (disposed || own.signal.aborted) return;
    answer.value = response.data;
    answeredStatus.value = requested;
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
      Ocorrências dos últimos 30 dias. Erros da API são registrados a partir da
      ativação desta central; falhas de tarefas e comandos n8n são coletadas dos
      registros do CRM. Esta consulta não substitui o monitoramento externo de
      disponibilidade.
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
        <h2 id="health-errors-summary" class="sr-only">
          Resumo das ocorrências
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
      <p v-if="answer" class="health-errors-checked">
        {{ filterLabel }} · Última consulta:
        {{ healthErrorInstant(answer.checkedAt) }} (Brasília). Até 100
        ocorrências agrupadas.
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
            <dl class="health-error-facts">
              <div>
                <dt>Repetições</dt>
                <dd>{{ item.occurrences }}</dd>
              </div>
              <div>
                <dt>Primeira ocorrência</dt>
                <dd>{{ healthErrorInstant(item.firstSeenAt) }}</dd>
              </div>
              <div>
                <dt>Última ocorrência</dt>
                <dd>{{ healthErrorInstant(item.lastSeenAt) }}</dd>
              </div>
            </dl>
            <details class="health-error-detail">
              <summary>Referência e histórico</summary>
              <dl>
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
