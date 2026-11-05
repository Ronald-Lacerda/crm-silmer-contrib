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
import AppIcon from './AppIcon.vue';
import { commandKey, request } from '../lib/api-client.js';
import { dayLabel } from '../lib/order-format.js';
import { elapsedLabel } from '../lib/dashboard-format.js';
import {
  ACTION_FILTERS,
  ACTION_GROUPS,
  actionGroup,
  actionInitials,
  defaultReminder,
  filterActions,
  performanceMoney,
  reminderInstant,
  reminderLabel,
} from '../lib/dashboard-actions.js';

const emit = defineEmits(['changed']);
const liveEvent = inject('liveEvent', ref(null));
const heading = ref(null);
const detailHeading = ref(null);
const firstField = ref(null);
const region = ref(null);
const loading = ref(true);
const loaded = ref(false);
const error = ref('');
const commandError = ref('');
const conflict = ref(false);
const saving = ref(false);
const announcement = ref('');
const filter = ref('all');
const selectedId = ref('');
const detailOpen = ref(false);
const mode = ref('overview');
const today = ref('');
const generatedAt = ref('');
const hasMore = ref(false);
const refreshPending = ref(false);
const paidOn = ref('');
const receivedInFull = ref(false);
const remindAt = ref('');
/** @type {import('vue').Ref<Record<string, any>|null>} */
const formTarget = ref(null);
/** @type {Map<string, {paidOn?: string, remindAt?: string}>} */
const formDrafts = new Map();
/** @type {import('vue').Ref<Record<string, any>[]>} */
const items = ref([]);
let controller;
let refreshTimer = 0;
let mounted = true;
const filtered = computed(() => filterActions(items.value, filter.value));
const selected = computed(
  () => items.value.find((item) => item.id === selectedId.value) ?? null,
);
const order = computed(
  () =>
    (mode.value !== 'overview'
      ? formTarget.value?.order
      : selected.value?.order) ?? null,
);
const groups = computed(() =>
  ACTION_GROUPS.map((group) => ({
    ...group,
    items: filtered.value.filter((item) => actionGroup(item) === group.key),
  })).filter((group) => group.items.length),
);
const canMutate = computed(
  () =>
    !saving.value &&
    !error.value &&
    !conflict.value &&
    !selected.value?.deferred &&
    selected.value?.kind !== 'handoff',
);
const isConfirmedOrder = computed(() => order.value?.status === 'confirmado');
const paymentRecorded = computed(
  () => Boolean(order.value?.paidOn) && !order.value?.paymentReviewRequired,
);
const conversationTo = computed(() =>
  selected.value?.conversationId
    ? `/inbox/${encodeURIComponent(selected.value.conversationId)}`
    : selected.value?.targetType === 'conversation'
      ? `/inbox/${encodeURIComponent(selected.value.targetId)}`
      : null,
);
const orderTo = computed(() =>
  selected.value?.targetType === 'order'
    ? `/pedidos/${encodeURIComponent(selected.value.targetId)}`
    : null,
);

/** @param {string} key */
function filterCount(key) {
  return loaded.value ? filterActions(items.value, key).length : '—';
}
/** @param {Record<string, any>} item */
function rowTime(item) {
  if (item.deferred) return reminderLabel(item.remindAt);
  if (item.targetType === 'order')
    return item.order?.promisedDeliveryOn
      ? dayLabel(item.order.promisedDeliveryOn)
      : 'Sem prazo';
  return (
    elapsedLabel(item.attentionSince ?? item.dueAt, generatedAt.value) ||
    'Agora'
  );
}
/** @param {Record<string, any>} item */
function rowContext(item) {
  if (item.deferred) return 'lembrete adiado';
  if (item.kind === 'reminder') return 'retorno agendado';
  if (item.kind === 'followup') return 'sugestão';
  if (item.kind === 'handoff') return 'sem responsável';
  if (item.kind === 'pending_order') return 'a completar';
  if (item.reason === 'send_pending') return 'envio pendente';
  if (item.reason === 'send_failure') return 'envio falhou';
  if (item.reason === 'send_unknown') return 'envio sem confirmação';
  if (item.targetType === 'order') return 'prazo previsto';
  return 'espera resposta';
}

async function load({ force = false, focus = false } = {}) {
  if (saving.value || (!force && mode.value !== 'overview')) {
    refreshPending.value = true;
    return;
  }
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const response = await request('/api/v1/dashboard/actions', {
      signal: current.signal,
    });
    if (controller !== current || !mounted) return;
    const data = response.data;
    if (!data || !Array.isArray(data.items))
      throw new Error('INVALID_DASHBOARD_ACTIONS');
    items.value = data.items;
    today.value = String(data.today ?? '');
    generatedAt.value = String(data.generatedAt ?? '');
    hasMore.value = data.hasMore === true;
    loaded.value = true;
    error.value = '';
    refreshPending.value = false;
    if (!items.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = filtered.value[0]?.id ?? '';
      detailOpen.value = false;
    }
    if (focus) {
      await nextTick();
      heading.value?.focus();
    }
  } catch (cause) {
    if (controller !== current || !mounted || cause?.name === 'AbortError')
      return;
    error.value = loaded.value
      ? 'Não foi possível atualizar sua fila. Os dados exibidos podem estar desatualizados.'
      : 'Não foi possível consultar suas providências agora.';
  } finally {
    if (controller === current && mounted) loading.value = false;
  }
}

/** @param {Record<string, any>} item */
async function choose(item) {
  if (saving.value) return;
  preserveDraft();
  selectedId.value = item.id;
  detailOpen.value = true;
  mode.value = 'overview';
  if (!conflict.value) commandError.value = '';
  await nextTick();
  detailHeading.value?.focus();
  if (refreshPending.value) void load();
}
/** @param {string} key */
async function chooseFilter(key) {
  if (saving.value) return;
  preserveDraft();
  filter.value = key;
  detailOpen.value = false;
  mode.value = 'overview';
  if (!conflict.value) commandError.value = '';
  if (!filtered.value.some((item) => item.id === selectedId.value))
    selectedId.value = filtered.value[0]?.id ?? '';
  if (refreshPending.value) await load();
}
async function back() {
  if (saving.value) return;
  preserveDraft();
  detailOpen.value = false;
  mode.value = 'overview';
  if (!conflict.value) commandError.value = '';
  if (refreshPending.value) await load();
  await nextTick();
  focusRow();
}
function focusRow() {
  const row = [
    ...(region.value?.querySelectorAll('[data-action-id]') ?? []),
  ].find((element) => element.dataset.actionId === selectedId.value);
  (row ?? heading.value)?.focus();
}

function preserveDraft() {
  const id = formTarget.value?.id;
  if (!id || mode.value === 'overview') return;
  const draft = formDrafts.get(id) ?? {};
  if (mode.value === 'pay') draft.paidOn = paidOn.value;
  if (mode.value === 'snooze' || mode.value === 'schedule')
    draft.remindAt = remindAt.value;
  formDrafts.set(id, draft);
}
/** @param {string} nextMode */
async function start(nextMode) {
  if (!canMutate.value) return;
  mode.value = nextMode;
  commandError.value = '';
  conflict.value = false;
  formTarget.value = {
    ...selected.value,
    ...(selected.value?.order ? { order: { ...selected.value.order } } : {}),
  };
  if (nextMode === 'pay') {
    paidOn.value =
      formDrafts.get(selectedId.value)?.paidOn ??
      order.value?.paidOn ??
      today.value;
    receivedInFull.value = false;
  }
  if (nextMode === 'snooze' || nextMode === 'schedule')
    remindAt.value =
      formDrafts.get(selectedId.value)?.remindAt ??
      defaultReminder(today.value, generatedAt.value);
  await nextTick();
  (firstField.value ?? detailHeading.value)?.focus();
}
async function cancel() {
  if (saving.value) return;
  preserveDraft();
  mode.value = 'overview';
  if (!conflict.value) commandError.value = '';
  if (refreshPending.value) await load();
  await nextTick();
  detailHeading.value?.focus();
}
async function refreshConflict() {
  if (loading.value || saving.value) return;
  preserveDraft();
  mode.value = 'overview';
  conflict.value = false;
  commandError.value = '';
  await load({ force: true, focus: true });
}

/** @param {string} url @param {Record<string, any>} body @param {string} success */
async function mutate(url, body, success) {
  if (saving.value || error.value || conflict.value) return;
  saving.value = true;
  commandError.value = '';
  announcement.value = '';
  controller?.abort();
  let completed = false;
  try {
    await request(url, { method: 'POST', body, idempotencyKey: commandKey() });
    if (!mounted) return;
    completed = true;
    formDrafts.delete(formTarget.value?.id ?? selectedId.value);
    mode.value = 'overview';
    announcement.value = success;
    emit('changed');
  } catch (cause) {
    if (!mounted) return;
    preserveDraft();
    conflict.value = [403, 409].includes(Number(cause?.status));
    commandError.value =
      Number(cause?.status) === 409
        ? 'A providência mudou. Atualize a fila antes de tentar novamente. Seus dados digitados foram preservados.'
        : Number(cause?.status) === 403
          ? 'Você não pode mais alterar esta providência. Atualize a fila para conferir o responsável.'
          : 'Não foi possível concluir a ação. Confira os dados e tente novamente.';
    await nextTick();
    region.value?.querySelector('.dashboard-command-error')?.focus();
  } finally {
    saving.value = false;
  }
  if (completed && mounted) {
    await load({ force: true });
    await nextTick();
    if (detailOpen.value && selected.value) detailHeading.value?.focus();
    else focusRow();
  }
}
async function confirmPayment() {
  const target = formTarget.value;
  if (
    !target ||
    !order.value ||
    !receivedInFull.value ||
    !paidOn.value ||
    paidOn.value > today.value ||
    !canMutate.value
  )
    return;
  await mutate(
    `/api/v1/orders/${encodeURIComponent(target.targetId)}/payment-confirmation`,
    {
      expectedVersion: target.targetVersion,
      paidOn: paidOn.value,
      receivedInFull: true,
    },
    `Quitação integral do pedido ${order.value.number} registrada.`,
  );
}
async function confirmDelivery() {
  const target = formTarget.value;
  if (!target || !order.value || !canMutate.value) return;
  await mutate(
    `/api/v1/orders/${encodeURIComponent(target.targetId)}/delivery-confirmation`,
    {
      expectedVersion: target.targetVersion,
    },
    `Entrega do pedido ${order.value.number} registrada.`,
  );
}
/** @param {'snooze'|'resume'|'dismiss'|'schedule'} decision */
async function decide(decision) {
  const item = mode.value !== 'overview' ? formTarget.value : selected.value;
  if (
    !item ||
    (decision !== 'resume' && !canMutate.value) ||
    saving.value ||
    conflict.value
  )
    return;
  const instant = ['snooze', 'schedule'].includes(decision)
    ? reminderInstant(remindAt.value)
    : null;
  if (
    ['snooze', 'schedule'].includes(decision) &&
    (!instant || Date.parse(instant) <= Date.parse(generatedAt.value))
  ) {
    commandError.value = 'Escolha um horário futuro válido em São Paulo.';
    return;
  }
  const messages = {
    snooze: 'Lembrete salvo. A pendência continua aberta.',
    resume: 'Providência trazida para agora.',
    dismiss: 'Sugestão dispensada. A conversa continua aberta.',
    schedule: 'Retorno agendado. Nenhuma mensagem foi enviada ao cliente.',
  };
  await mutate(
    `/api/v1/dashboard/actions/${encodeURIComponent(item.id)}/decision`,
    {
      decision,
      expectedVersion: item.targetVersion,
      sourceRevision: item.sourceRevision,
      expectedDecisionVersion: item.decisionVersion,
      ...(instant ? { remindAt: instant } : {}),
    },
    messages[decision],
  );
}

function scheduleRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load();
  }, 250);
}
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.conversation.changed',
      'inbox.contact.changed',
    ].includes(event?.type)
  )
    scheduleRefresh();
});
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  mounted = false;
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <section
    ref="region"
    class="dashboard-actions"
    :class="{ 'dashboard-detail-open': detailOpen }"
    aria-labelledby="dashboard-actions-title"
  >
    <div class="dashboard-actions-head">
      <h2 id="dashboard-actions-title" ref="heading" tabindex="-1">
        O que precisa de você
      </h2>
      <p>Conversas e pedidos sob sua responsabilidade.</p>
    </div>
    <p class="dashboard-action-announcement" role="status" aria-live="polite">
      {{ announcement }}
    </p>
    <div v-if="error" class="audit-note" role="alert">
      <p>{{ error }}</p>
      <button
        type="button"
        :aria-disabled="loading || saving ? 'true' : undefined"
        @click="!loading && !saving && load({ force: true, focus: true })"
      >
        {{ loading ? 'Consultando…' : 'Atualizar providências' }}
      </button>
    </div>
    <div
      class="dashboard-action-filters"
      role="group"
      aria-label="Filtrar providências"
    >
      <button
        v-for="option in ACTION_FILTERS"
        :key="option.key"
        type="button"
        :aria-pressed="filter === option.key"
        :aria-disabled="saving ? 'true' : undefined"
        @click="chooseFilter(option.key)"
      >
        {{ option.label
        }}<span class="dashboard-action-count">{{
          filterCount(option.key)
        }}</span>
      </button>
    </div>
    <p v-if="loading && !loaded" class="dashboard-data-loading" role="status">
      Carregando providências…
    </p>
    <div class="dashboard-action-workspace">
      <div class="dashboard-action-queue">
        <section
          v-for="group in groups"
          :key="group.key"
          class="dashboard-action-group"
          :aria-labelledby="`dashboard-action-group-${group.key}`"
        >
          <div class="dashboard-action-group-head">
            <h3 :id="`dashboard-action-group-${group.key}`">
              {{ group.label }}
            </h3>
            <span>{{ group.items.length }}</span>
          </div>
          <ul>
            <li v-for="item in group.items" :key="item.id">
              <button
                type="button"
                class="dashboard-action-row"
                :data-action-id="item.id"
                :aria-label="`Abrir ${item.title}`"
                :aria-pressed="selectedId === item.id"
                :aria-disabled="saving ? 'true' : undefined"
                @click="choose(item)"
              >
                <span class="dashboard-action-avatar" aria-hidden="true">{{
                  actionInitials(item.title)
                }}</span
                ><span class="dashboard-action-row-copy"
                  ><strong>{{ item.title }}</strong
                  ><span>{{ item.subtitle }}</span></span
                ><span class="dashboard-action-row-meta"
                  ><span>{{ rowTime(item) }}</span
                  ><span>{{ rowContext(item) }}</span></span
                >
              </button>
            </li>
          </ul>
        </section>
        <div
          v-if="loaded && !groups.length && !error"
          class="dashboard-action-empty"
        >
          <h3>
            {{
              filter === 'deferred'
                ? 'Nenhum lembrete adiado'
                : 'Nenhuma providência nesta visão'
            }}
          </h3>
          <p>
            {{
              filter === 'deferred'
                ? 'Os lembretes que você adiar aparecem aqui.'
                : 'Confira os outros filtros ou acompanhe seus resultados.'
            }}
          </p>
        </div>
        <p v-if="hasMore" class="dashboard-performance-note">
          Mostrando {{ items.length }} itens; há mais na lista completa. Os
          contadores consideram apenas os itens carregados.
          <RouterLink to="/inbox?fila=minhas"
            >Ver todas as minhas conversas</RouterLink
          >
          ou <RouterLink to="/pedidos?vendedor=eu">meus pedidos</RouterLink>.
        </p>
      </div>
      <div class="dashboard-action-detail-column">
        <button
          type="button"
          class="quiet dashboard-action-back"
          :aria-disabled="saving ? 'true' : undefined"
          @click="back"
        >
          <AppIcon name="back" />Voltar às providências
        </button>
        <section
          v-if="loaded"
          class="dashboard-action-detail"
          aria-labelledby="dashboard-action-detail-title"
        >
          <template v-if="selected">
            <div class="dashboard-action-detail-head">
              <div>
                <h3
                  id="dashboard-action-detail-title"
                  ref="detailHeading"
                  tabindex="-1"
                >
                  {{ selected.title }}
                </h3>
                <p>
                  {{
                    order
                      ? `${order.number} · ${order.totalPieces} peças`
                      : selected.subtitle
                  }}
                </p>
              </div>
              <span v-if="order" class="dashboard-action-status">{{
                order.status === 'confirmado' ? 'Confirmado' : 'Pendente'
              }}</span>
            </div>
            <div
              v-if="commandError"
              class="audit-note dashboard-command-error"
              role="alert"
              tabindex="-1"
            >
              <p>{{ commandError }}</p>
              <button
                v-if="conflict"
                type="button"
                :aria-disabled="loading || saving ? 'true' : undefined"
                @click="refreshConflict"
              >
                Atualizar antes de tentar
              </button>
            </div>
            <p
              v-if="refreshPending && mode !== 'overview'"
              class="dashboard-performance-note"
              role="status"
            >
              Há uma atualização pendente. Seus dados digitados foram
              preservados.
            </p>
            <template v-if="mode === 'overview'">
              <template v-if="order">
                <dl class="dashboard-action-order-meta">
                  <div>
                    <dt>Valor do pedido</dt>
                    <dd>{{ performanceMoney(order.finalAmountCents) }}</dd>
                  </div>
                  <div>
                    <dt>Entrega prometida</dt>
                    <dd>
                      {{
                        order.promisedDeliveryOn
                          ? dayLabel(order.promisedDeliveryOn)
                          : 'Sem prazo informado'
                      }}
                    </dd>
                  </div>
                </dl>
                <template v-if="isConfirmedOrder">
                  <section class="dashboard-action-question">
                    <h4>O valor integral já foi pago?</h4>
                    <p v-if="paymentRecorded" class="dashboard-action-recorded">
                      <AppIcon name="check" />Pagamento integral registrado em
                      {{ dayLabel(order.paidOn) }}.
                    </p>
                    <template v-else
                      ><p>
                        {{
                          order.paymentReviewRequired
                            ? 'A data antiga precisa de revisão explícita da quitação integral.'
                            : 'Ainda sem quitação integral registrada.'
                        }}
                      </p>
                      <button
                        type="button"
                        :aria-disabled="!canMutate ? 'true' : undefined"
                        @click="start('pay')"
                      >
                        {{
                          order.paymentReviewRequired
                            ? 'Revisar quitação'
                            : 'Registrar pagamento'
                        }}
                      </button></template
                    >
                  </section>
                  <section class="dashboard-action-question">
                    <h4>O cliente já recebeu o pedido?</h4>
                    <p
                      v-if="order.deliveredOn"
                      class="dashboard-action-recorded"
                    >
                      <AppIcon name="check" />Entrega registrada em
                      {{ dayLabel(order.deliveredOn) }}.
                    </p>
                    <template v-else
                      ><p>Ainda sem confirmação de entrega.</p>
                      <button
                        type="button"
                        :aria-disabled="!canMutate ? 'true' : undefined"
                        @click="start('delivery')"
                      >
                        Registrar entrega
                      </button></template
                    >
                  </section>
                </template>
                <template v-else
                  ><p class="dashboard-performance-note">
                    Este pedido ainda precisa ser completado e confirmado.
                    Pagamento e entrega continuam separados do fechamento
                    comercial.
                  </p>
                  <RouterLink class="button-link" :to="orderTo"
                    >Revisar pedido</RouterLink
                  ></template
                >
              </template>
              <template v-else
                ><p class="dashboard-performance-note">
                  {{
                    ['send_pending', 'send_failure', 'send_unknown'].includes(
                      selected.reason,
                    )
                      ? 'Confira o resultado do envio na Caixa de Entrada. Falha ou ausência de confirmação não comprova que o cliente está sem responder; não reenvie sem conferir.'
                      : selected.kind === 'followup'
                        ? 'Sua última mensagem ficou sem resposta. Esta é uma sugestão de retomada, sem compromisso inventado ou envio automático.'
                        : selected.kind === 'reminder'
                          ? 'Este retorno foi agendado por você. Abra a conversa para conferir o contexto.'
                          : selected.kind === 'handoff'
                            ? 'Esta conversa aguarda uma pessoa. Abra a Caixa de Entrada para assumir o atendimento.'
                            : 'O cliente aguarda atendimento. Confira a conversa e decida a resposta.'
                  }}
                </p>
                <RouterLink
                  v-if="conversationTo"
                  class="button-link primary"
                  :to="conversationTo"
                  >{{
                    ['send_pending', 'send_failure', 'send_unknown'].includes(
                      selected.reason,
                    )
                      ? 'Verificar envio na conversa'
                      : selected.kind === 'followup'
                        ? 'Abrir conversa para retomar'
                        : selected.kind === 'handoff'
                          ? 'Abrir conversa para assumir'
                          : 'Abrir conversa para responder'
                  }}<AppIcon name="chevron" /></RouterLink
              ></template>
              <p v-if="selected.deferred" class="dashboard-performance-note">
                Lembrar em {{ reminderLabel(selected.remindAt) }} · horário de
                São Paulo.
              </p>
              <div
                v-if="selected.kind !== 'handoff'"
                class="dashboard-action-detail-actions"
              >
                <button
                  v-if="selected.deferred"
                  type="button"
                  :aria-disabled="
                    saving || error || conflict ? 'true' : undefined
                  "
                  @click="decide('resume')"
                >
                  Trazer para agora</button
                ><template v-else
                  ><button
                    type="button"
                    class="quiet"
                    :aria-disabled="!canMutate ? 'true' : undefined"
                    @click="start('snooze')"
                  >
                    Lembrar depois</button
                  ><button
                    v-if="selected.targetType === 'conversation'"
                    type="button"
                    class="quiet"
                    :aria-disabled="!canMutate ? 'true' : undefined"
                    @click="start('schedule')"
                  >
                    Agendar retorno</button
                  ><button
                    v-if="selected.kind === 'followup'"
                    type="button"
                    class="quiet"
                    :aria-disabled="!canMutate ? 'true' : undefined"
                    @click="decide('dismiss')"
                  >
                    Dispensar sugestão
                  </button></template
                >
              </div>
              <RouterLink
                v-if="orderTo"
                class="dashboard-action-object-link"
                :to="orderTo"
                >Ver pedido {{ order?.number }}</RouterLink
              >
            </template>
            <form
              v-else-if="mode === 'pay'"
              class="dashboard-action-form"
              @submit.prevent="confirmPayment"
            >
              <h4>Registrar quitação integral</h4>
              <p>
                Confirme o recebimento de
                {{ performanceMoney(order?.finalAmountCents) }}. Um sinal não
                quita o pedido.
              </p>
              <label for="dashboard-payment-date"
                >Data do recebimento integral</label
              ><input
                id="dashboard-payment-date"
                ref="firstField"
                v-model="paidOn"
                type="date"
                :max="today"
                required
                :readonly="saving"
              /><label class="dashboard-action-checkbox"
                ><input
                  v-model="receivedInFull"
                  type="checkbox"
                  required
                  :disabled="saving"
                />Confirmo que o valor integral foi recebido.</label
              >
              <div class="dashboard-action-form-actions">
                <button
                  type="submit"
                  class="primary"
                  :aria-disabled="!canMutate ? 'true' : undefined"
                >
                  {{ saving ? 'Registrando…' : 'Confirmar pagamento' }}</button
                ><button
                  type="button"
                  class="quiet"
                  :aria-disabled="saving ? 'true' : undefined"
                  @click="cancel"
                >
                  Cancelar
                </button>
              </div>
            </form>
            <div v-else-if="mode === 'delivery'" class="dashboard-action-form">
              <h4>O cliente recebeu hoje?</h4>
              <p>
                A entrega será registrada em {{ dayLabel(today) }}, no horário
                de São Paulo. O pagamento permanece como está.
              </p>
              <div class="dashboard-action-form-actions">
                <button
                  type="button"
                  class="primary"
                  :aria-disabled="!canMutate ? 'true' : undefined"
                  @click="confirmDelivery"
                >
                  {{
                    saving ? 'Registrando…' : 'Confirmar entrega de hoje'
                  }}</button
                ><button
                  type="button"
                  class="quiet"
                  :aria-disabled="saving ? 'true' : undefined"
                  @click="cancel"
                >
                  Cancelar
                </button>
              </div>
            </div>
            <form
              v-else
              class="dashboard-action-form"
              @submit.prevent="
                decide(mode === 'schedule' ? 'schedule' : 'snooze')
              "
            >
              <h4>
                {{
                  mode === 'schedule'
                    ? 'Agendar um retorno'
                    : 'Quando lembrar você?'
                }}
              </h4>
              <p>
                {{
                  mode === 'schedule'
                    ? 'Você define o compromisso. Nenhuma mensagem será enviada automaticamente.'
                    : 'Adiar não registra pagamento, entrega ou conclusão.'
                }}
              </p>
              <label for="dashboard-reminder-date"
                >Data e horário de São Paulo</label
              ><input
                id="dashboard-reminder-date"
                ref="firstField"
                v-model="remindAt"
                type="datetime-local"
                required
                :readonly="saving"
              />
              <div class="dashboard-action-form-actions">
                <button
                  type="submit"
                  class="primary"
                  :aria-disabled="!canMutate ? 'true' : undefined"
                >
                  {{
                    saving
                      ? 'Salvando…'
                      : mode === 'schedule'
                        ? 'Agendar retorno'
                        : 'Salvar lembrete'
                  }}</button
                ><button
                  type="button"
                  class="quiet"
                  :aria-disabled="saving ? 'true' : undefined"
                  @click="cancel"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </template>
          <template v-else
            ><h3
              id="dashboard-action-detail-title"
              ref="detailHeading"
              tabindex="-1"
            >
              Escolha uma providência
            </h3>
            <p class="dashboard-performance-note">
              Confira o contexto e decida o próximo passo.
            </p></template
          >
        </section>
        <slot name="summary" />
      </div>
    </div>
  </section>
</template>
