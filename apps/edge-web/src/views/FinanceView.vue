<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { ApiError, commandKey, request } from '../lib/api-client.js';

const props = defineProps({
  session: { type: Object, required: true },
  announce: { type: Function, required: true },
});
const user = computed(() => props.session.user ?? props.session);
const canManage = computed(
  () =>
    user.value.functionName === 'Financeiro' &&
    !(user.value.capabilities ?? []).includes('COMMERCIAL_ADMIN'),
);
const heading = ref(null);
const detailHeading = ref(null);
const actionErrorSummary = ref(null);
const status = ref('waiting');
const orders = ref([]);
const counts = ref(null);
const nextCursor = ref(null);
const loading = ref(true);
const loadingMore = ref(false);
const listError = ref('');
const detailError = ref('');
const actionError = ref('');
const detail = ref(null);
const detailLoading = ref(false);
const selectedId = ref(null);
const mobileDetail = ref(false);
const busy = ref(false);
const requiresRefresh = ref(false);
const feedback = ref('');
const undoOrder = ref(null);
let listController;
let detailController;
let disposed = false;

const originLabels = Object.freeze({
  atendimento: 'Atendimento',
  manual: 'Pedido manual',
  loja: 'Loja do site',
});
const eventLabels = Object.freeze({
  completed: 'Nota criada',
  reopened: 'Voltou para aguardando',
  invalidated: 'Conferência anterior invalidada',
});
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function money(value) {
  return Number.isSafeInteger(value) ? currency.format(value / 100) : '—';
}
function day(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : 'Não informado';
}
function instant(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? dateTime.format(date)
    : 'Não informado';
}
function origin(order) {
  return order.isManual ||
    (order.origin === 'atendimento' && order.manualOwnerId)
    ? 'Pedido manual'
    : (originLabels[order.origin] ?? 'Pedido');
}
function grade(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => `${line.tamanho}: ${line.quantidade}`)
    .join(' · ');
}
function rowButton(id) {
  return globalThis.document.getElementById(`finance-order-${id}`);
}

async function loadDetail(id, focus = false) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  detailLoading.value = true;
  detailError.value = '';
  detail.value = null;
  try {
    const response = await request(
      `/api/v1/finance/orders/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    );
    if (disposed || controller.signal.aborted || selectedId.value !== id)
      return false;
    detail.value = response.data.order;
    requiresRefresh.value = false;
    actionError.value = '';
    detailLoading.value = false;
    await nextTick();
    if (focus) detailHeading.value?.focus();
    return true;
  } catch (error) {
    if (controller.signal.aborted || disposed) return false;
    detailError.value =
      error instanceof ApiError && [403, 404].includes(error.status)
        ? 'Este pedido não está mais disponível nesta fila.'
        : 'Não foi possível carregar o pedido. Tente novamente.';
    return false;
  } finally {
    if (!controller.signal.aborted && !disposed) detailLoading.value = false;
  }
}

async function selectOrder(id) {
  if (busy.value) return;
  selectedId.value = id;
  mobileDetail.value = true;
  feedback.value = '';
  undoOrder.value = null;
  await loadDetail(id, true);
}

async function loadList(append = false, desiredId = selectedId.value) {
  if (append && !nextCursor.value) return false;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  if (append) loadingMore.value = true;
  else loading.value = true;
  listError.value = '';
  try {
    const query = new URLSearchParams({ status: status.value, limit: '25' });
    if (append) query.set('cursor', nextCursor.value);
    const response = await request(`/api/v1/finance/orders?${query}`, {
      signal: controller.signal,
    });
    if (controller.signal.aborted || disposed) return false;
    orders.value = append
      ? [...orders.value, ...response.data.items]
      : response.data.items;
    counts.value = response.data.counts;
    nextCursor.value = response.data.nextCursor;
    if (!append) {
      selectedId.value = orders.value.some((order) => order.id === desiredId)
        ? desiredId
        : (orders.value[0]?.id ?? null);
      if (selectedId.value) await loadDetail(selectedId.value);
      else {
        detailController?.abort();
        detail.value = null;
        detailError.value = '';
        detailLoading.value = false;
      }
    }
    return true;
  } catch (error) {
    if (controller.signal.aborted || disposed) return false;
    counts.value = null;
    listError.value =
      'Não foi possível carregar a fila financeira. Tente novamente.';
    return false;
  } finally {
    if (!controller.signal.aborted && !disposed) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

async function changeStatus(value) {
  if (busy.value || value === status.value) return;
  status.value = value;
  detail.value = null;
  selectedId.value = null;
  mobileDetail.value = false;
  actionError.value = '';
  feedback.value = '';
  undoOrder.value = null;
  await loadList();
}

async function refresh() {
  if (busy.value) return;
  const refreshed = await loadList();
  if (refreshed) {
    undoOrder.value = null;
    requiresRefresh.value = false;
    actionError.value = '';
    props.announce('Fila financeira atualizada.');
    await nextTick();
    (mobileDetail.value
      ? (detailHeading.value ?? heading.value)
      : selectedId.value
        ? rowButton(selectedId.value)
        : heading.value
    )?.focus();
  }
}

async function runCommand(action, target = detail.value) {
  if (!target || busy.value || requiresRefresh.value || !canManage.value)
    return;
  busy.value = true;
  actionError.value = '';
  feedback.value = '';
  const selectedIndex = orders.value.findIndex(
    (order) => order.id === target.id,
  );
  try {
    const response = await request(
      `/api/v1/finance/orders/${encodeURIComponent(target.id)}/${action}`,
      {
        method: 'POST',
        idempotencyKey: commandKey(),
        body: {
          expectedVersion: target.version,
          expectedFinanceVersion: target.financeVersion,
        },
      },
    );
    if (disposed) return;
    undoOrder.value = action === 'complete' ? response.data.order : null;
    feedback.value =
      action === 'complete'
        ? `${target.number} marcado como nota criada.`
        : `${target.number} voltou para aguardando.`;
    props.announce(feedback.value);
    const nextId =
      orders.value[selectedIndex + 1]?.id ??
      orders.value[Math.max(0, selectedIndex - 1)]?.id ??
      null;
    mobileDetail.value = false;
    await loadList(false, nextId);
    busy.value = false;
    await nextTick();
    (selectedId.value ? rowButton(selectedId.value) : heading.value)?.focus();
  } catch (error) {
    if (disposed) return;
    requiresRefresh.value = true;
    undoOrder.value = null;
    actionError.value =
      error instanceof ApiError && [409, 412].includes(error.status)
        ? 'O pedido mudou durante a conferência. Atualize a fila antes de continuar.'
        : error instanceof ApiError && [403, 404].includes(error.status)
          ? 'Este pedido ou esta ação não está mais disponível para seu acesso. Atualize a fila.'
          : 'Não foi possível confirmar o resultado. Atualize a fila para conferir antes de tentar outra ação.';
    props.announce(actionError.value);
    await nextTick();
    actionErrorSummary.value?.focus();
  } finally {
    busy.value = false;
  }
}

async function returnToList() {
  mobileDetail.value = false;
  await nextTick();
  (selectedId.value ? rowButton(selectedId.value) : heading.value)?.focus();
}

onMounted(() => {
  heading.value?.focus();
  void loadList();
});
onBeforeUnmount(() => {
  disposed = true;
  listController?.abort();
  detailController?.abort();
});
</script>

<template>
  <div class="page finance-page" :data-detail-open="mobileDetail || undefined">
    <header class="page-heading">
      <div>
        <h1 ref="heading" tabindex="-1">Financeiro</h1>
        <p>Pedidos confirmados e integralmente pagos.</p>
      </div>
      <button type="button" :disabled="busy || loading" @click="refresh">
        {{ loading ? 'Atualizando…' : 'Atualizar' }}
      </button>
    </header>
    <div class="filter-bar">
      <div
        class="chip-row finance-filters"
        role="group"
        aria-label="Filtrar rotina financeira"
      >
        <button
          class="chip"
          type="button"
          :aria-pressed="status === 'waiting'"
          :disabled="busy"
          @click="changeStatus('waiting')"
        >
          Aguardando <span>{{ counts ? counts.waiting : '—' }}</span>
        </button>
        <button
          class="chip"
          type="button"
          :aria-pressed="status === 'completed'"
          :disabled="busy"
          @click="changeStatus('completed')"
        >
          Concluídos <span>{{ counts ? counts.completed : '—' }}</span>
        </button>
      </div>
      <p v-if="!canManage" class="filter-summary">Consulta do administrador</p>
    </div>
    <div
      v-if="feedback"
      class="audit-note finance-feedback"
      role="status"
      aria-live="polite"
    >
      <p>{{ feedback }}</p>
      <button
        v-if="undoOrder && canManage"
        type="button"
        class="quiet"
        :disabled="busy || requiresRefresh"
        @click="runCommand('reopen', undoOrder)"
      >
        Desfazer
      </button>
    </div>
    <div
      v-if="actionError"
      ref="actionErrorSummary"
      class="audit-note"
      role="alert"
      tabindex="-1"
    >
      <p>{{ actionError }}</p>
      <button type="button" :disabled="busy || loading" @click="refresh">
        Atualizar fila
      </button>
    </div>
    <div v-if="listError" class="surface empty-list" role="alert">
      <h2>Fila indisponível</h2>
      <p>{{ listError }}</p>
      <button type="button" :disabled="loading" @click="refresh">
        Tentar novamente
      </button>
    </div>
    <p v-if="loading" class="loading-state" role="status">
      Carregando fila financeira…
    </p>
    <div v-else-if="!listError" class="finance-layout">
      <section
        class="surface finance-list"
        aria-labelledby="finance-list-title"
      >
        <div class="panel-head">
          <h2 id="finance-list-title">
            {{
              status === 'waiting'
                ? 'Aguardando financeiro'
                : 'Rotinas concluídas'
            }}
          </h2>
          <p>
            {{
              status === 'waiting'
                ? 'Pagamentos mais antigos primeiro'
                : 'Conclusões mais recentes primeiro'
            }}
          </p>
        </div>
        <ul v-if="orders.length" class="finance-order-list">
          <li v-for="order in orders" :key="order.id">
            <button
              :id="`finance-order-${order.id}`"
              type="button"
              class="finance-order-button"
              :aria-pressed="selectedId === order.id"
              :aria-label="`Conferir ${order.number}, ${order.clientName}`"
              :disabled="busy"
              @click="selectOrder(order.id)"
            >
              <span class="finance-order-context"
                ><span>{{ order.number }}</span
                ><span>{{ money(order.finalAmountCents) }}</span></span
              ><strong>{{ order.clientName }}</strong
              ><span class="table-detail"
                >{{ order.totalPieces }} peças ·
                {{ order.ownerName || origin(order) }}</span
              ><span class="table-detail">{{
                status === 'waiting'
                  ? `Pago em ${day(order.paidOn)}`
                  : `Concluído em ${instant(order.completedAt)}`
              }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="empty-list">
          <h3>
            {{
              status === 'waiting'
                ? 'Nenhum pedido aguardando'
                : 'Nenhuma rotina concluída'
            }}
          </h3>
          <p>
            {{
              status === 'waiting'
                ? 'Os pedidos confirmados e integralmente pagos aparecerão aqui.'
                : 'As marcações de nota criada aparecerão aqui.'
            }}
          </p>
        </div>
        <button
          v-if="nextCursor"
          type="button"
          :disabled="busy || loadingMore"
          @click="loadList(true)"
        >
          {{ loadingMore ? 'Carregando…' : 'Carregar mais pedidos' }}
        </button>
      </section>
      <section
        v-if="detailLoading || detail || detailError"
        class="surface finance-detail"
        :aria-labelledby="detailLoading ? undefined : 'finance-detail-title'"
        :aria-label="detailLoading ? 'Pedido selecionado' : undefined"
        :aria-busy="detailLoading || busy"
      >
        <button
          type="button"
          class="quiet finance-mobile-back"
          @click="returnToList"
        >
          <AppIcon name="back" />Voltar à fila
        </button>
        <p v-if="detailLoading" role="status">Carregando pedido…</p>
        <div v-else-if="detailError" role="alert">
          <h2 id="finance-detail-title">Pedido indisponível</h2>
          <p>{{ detailError }}</p>
          <button type="button" @click="loadDetail(selectedId, true)">
            Tentar novamente
          </button>
        </div>
        <template v-else-if="detail">
          <div class="client-head">
            <p>{{ detail.number }} · {{ origin(detail) }}</p>
            <h2 id="finance-detail-title" ref="detailHeading" tabindex="-1">
              {{ detail.clientName }}
            </h2>
            <p>
              <span
                class="badge"
                :data-tone="detail.completedAt ? 'success' : undefined"
                >{{
                  detail.completedAt ? 'Nota criada' : 'Aguardando financeiro'
                }}</span
              >
            </p>
          </div>
          <dl class="client-facts">
            <div>
              <dt>Situação</dt>
              <dd>Confirmado</dd>
            </div>
            <div>
              <dt>Pago integralmente em</dt>
              <dd>{{ day(detail.paidOn) }}</dd>
            </div>
            <div>
              <dt>Responsável</dt>
              <dd>{{ detail.ownerName || origin(detail) }}</dd>
            </div>
            <div>
              <dt>Entrega prometida</dt>
              <dd>{{ day(detail.deliveryOn) }}</dd>
            </div>
          </dl>
          <section class="finance-items" aria-labelledby="finance-items-title">
            <h3 id="finance-items-title">Itens do pedido</h3>
            <ul>
              <li v-for="(item, index) in detail.items" :key="index">
                <strong
                  >{{ item.tipo
                  }}<template v-if="item.cor">
                    · {{ item.cor }}</template
                  ></strong
                >
                <p>{{ grade(item.grade) }}</p>
                <p class="table-detail">
                  {{
                    [item.malhas?.join(', '), item.tipo_servico]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                </p>
              </li>
            </ul>
          </section>
          <div class="finance-total">
            <span>Valor integral recebido</span
            ><strong>{{ money(detail.finalAmountCents) }}</strong>
          </div>
          <div v-if="detail.completedAt" class="audit-note">
            <p>
              Rotina concluída por {{ detail.completedByName || 'Financeiro' }}
            </p>
            <p>{{ instant(detail.completedAt) }}</p>
          </div>
          <div v-if="canManage && detail.canManage" class="finance-actions">
            <button
              v-if="!detail.completedAt"
              type="button"
              class="primary"
              :disabled="busy || requiresRefresh"
              @click="runCommand('complete')"
            >
              {{ busy ? 'Salvando…' : 'Marcar nota criada' }}</button
            ><button
              v-else
              type="button"
              :disabled="busy || requiresRefresh"
              @click="runCommand('reopen')"
            >
              {{ busy ? 'Salvando…' : 'Voltar para aguardando' }}
            </button>
            <p v-if="!detail.completedAt" class="field-help">
              Marque ao terminar sua rotina financeira.
            </p>
          </div>
          <details class="exact finance-history">
            <summary>
              Histórico financeiro
              <span>({{ detail.history?.length ?? 0 }})</span>
            </summary>
            <ul v-if="detail.history?.length" class="finance-history-list">
              <li v-for="event in detail.history" :key="event.id">
                <strong>{{
                  eventLabels[event.action] || 'Rotina atualizada'
                }}</strong>
                <p>
                  {{ event.actorName || 'Sistema' }} ·
                  {{ instant(event.occurredAt) }}
                </p>
              </li>
            </ul>
            <p v-else>Nenhuma alteração financeira registrada.</p>
          </details>
        </template>
      </section>
    </div>
  </div>
</template>
