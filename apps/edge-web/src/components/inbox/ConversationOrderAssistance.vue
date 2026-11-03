<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import { dateTimeBR } from '../../lib/format.js';
import {
  ORDER_ASSISTANCE_REASONS,
  orderAssistanceEvidence,
  orderAssistanceReason,
  orderAssistanceStatus,
} from '../../lib/order-assistance.js';

const props = defineProps({
  conversationId: { type: String, required: true },
  canManage: { type: Boolean, default: false },
  refreshKey: { type: [String, Number], default: '' },
  messages: { type: Array, default: () => [] },
});
const emit = defineEmits(['created', 'changed', 'evidence', 'review']);
const heading = ref(null);
const errorNotice = ref(null);
const reasonField = ref(null);
const evidenceField = ref(null);
/** @type {import('vue').Ref<Record<string, any>|null>} */
const answer = ref(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const unavailable = ref(false);
const mode = ref('');
const selectedId = ref('');
const reason = ref('');
const sourceMessageId = ref('');
let readController;
let writeController;
let queuedRefresh = false;
let disposed = false;
const commandKeys = new Map();
const titleId = computed(() => `order-assistance-${props.conversationId}`);
const base = computed(
  () =>
    `/api/v1/inbox/conversations/${encodeURIComponent(props.conversationId)}/order-assistance`,
);
const pending = computed(() =>
  (answer.value?.suggestions ?? []).filter((item) => item.status === 'pending'),
);
const history = computed(() =>
  (answer.value?.suggestions ?? []).filter((item) => item.status !== 'pending'),
);
const evaluations = computed(() => answer.value?.evaluations ?? []);
const blockedHint = computed(() =>
  answer.value?.blockedReason === 'subject_target_required'
    ? 'Escolha um assunto sem pedido em Detalhes do atendimento para revisar esta compra.'
    : answer.value?.blockedReason === 'pending_order_exists'
      ? 'Já existe um pedido pendente neste atendimento. Revise o pedido antes de criar outro.'
      : '',
);
const evidence = computed(() => orderAssistanceEvidence(props.messages));
const actionable = computed(
  () =>
    props.canManage &&
    !loading.value &&
    !busy.value &&
    !!answer.value &&
    !error.value,
);

/** @param {string} id */
function evidenceFor(id) {
  return evidence.value.find((item) => item.id === id);
}

/** @param {unknown} cause */
function failure(cause) {
  const status = /** @type {any} */ (cause)?.status;
  if (status === 403)
    return 'Só o responsável pelo atendimento ou um administrador pode decidir. Atualize a conversa para conferir o responsável.';
  if (status === 409)
    return 'A conversa ou a sugestão mudou. Atualize e revise a confirmação do cliente antes de decidir novamente.';
  return 'Não foi possível salvar a decisão. Tente novamente para conferir o resultado.';
}

async function load() {
  if (disposed || !props.conversationId) return;
  if (busy.value) {
    queuedRefresh = true;
    return;
  }
  readController?.abort();
  const own = new AbortController();
  readController = own;
  loading.value = true;
  try {
    const response = await request(base.value, { signal: own.signal });
    if (own !== readController || own.signal.aborted) return;
    if (
      !Array.isArray(response.data?.suggestions) ||
      !Array.isArray(response.data?.evaluations)
    )
      throw new Error('INVALID_ORDER_ASSISTANCE_RESPONSE');
    answer.value = response.data;
    unavailable.value = false;
    error.value = '';
  } catch (cause) {
    if (own !== readController || own.signal.aborted) return;
    const status = /** @type {any} */ (cause)?.status;
    unavailable.value = status === 404 || status === 403;
    error.value = unavailable.value
      ? ''
      : 'Não foi possível consultar as sugestões de pedido. Atualize antes de decidir.';
  } finally {
    if (own === readController) loading.value = false;
  }
}

function closeForm() {
  mode.value = '';
  selectedId.value = '';
  reason.value = '';
  sourceMessageId.value = '';
}

/** @param {'defer'|'reject'|'missed'} decision @param {string} [id] */
async function openForm(decision, id = '') {
  if (!actionable.value) return;
  mode.value = decision;
  selectedId.value = id;
  reason.value = '';
  sourceMessageId.value = '';
  notice.value = '';
  await nextTick();
  if (decision === 'missed') evidenceField.value?.focus();
  else reasonField.value?.focus();
}

/** @param {string} decision @param {any} [suggestion] */
async function decide(decision, suggestion = null) {
  if (!actionable.value) return;
  if (decision === 'accept' && answer.value?.blockedReason) return;
  const selected =
    suggestion ?? pending.value.find((item) => item.id === selectedId.value);
  if (decision !== 'missed' && !selected) return;
  if (decision === 'missed' && !sourceMessageId.value) {
    await nextTick();
    evidenceField.value?.focus();
    return;
  }
  if (['defer', 'reject'].includes(decision) && !reason.value) {
    await nextTick();
    reasonField.value?.focus();
    return;
  }
  const conversation = props.conversationId;
  const body = {
    decision,
    reason: ['accept', 'missed'].includes(decision) ? 'ready' : reason.value,
    ...(selected
      ? { suggestionId: selected.id, expectedVersion: selected.version }
      : {}),
    ...(decision === 'missed'
      ? { sourceMessageId: sourceMessageId.value }
      : {}),
    expectedConversationVersion: answer.value.conversationVersion,
    expectedSourceRevision: answer.value.sourceRevision,
  };
  const signature = JSON.stringify(body);
  if (!commandKeys.has(signature)) commandKeys.set(signature, commandKey());
  const own = new AbortController();
  writeController = own;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const response = await request(`${base.value}/decisions`, {
      method: 'POST',
      body,
      signal: own.signal,
      idempotencyKey: commandKeys.get(signature),
    });
    if (
      own !== writeController ||
      own.signal.aborted ||
      conversation !== props.conversationId
    )
      return;
    commandKeys.delete(signature);
    notice.value =
      decision === 'accept'
        ? 'Pedido criado com os dados coletados. Ele continua pendente para revisão.'
        : decision === 'missed'
          ? 'Omissão registrada para avaliar o agente.'
          : decision === 'defer'
            ? 'Sugestão adiada. O motivo foi registrado.'
            : 'Decisão registrada. Nenhum pedido foi criado.';
    closeForm();
    if (response.data?.order) emit('created', response.data.order);
    emit('changed');
    busy.value = false;
    await load();
    await nextTick();
    if (!disposed && conversation === props.conversationId)
      heading.value?.focus();
  } catch (cause) {
    if (
      own !== writeController ||
      own.signal.aborted ||
      conversation !== props.conversationId
    )
      return;
    error.value = failure(cause);
    const status = /** @type {any} */ (cause)?.status;
    if (status >= 400 && status < 500) commandKeys.delete(signature);
    await nextTick();
    errorNotice.value?.focus();
  } finally {
    if (own === writeController) {
      busy.value = false;
      if (queuedRefresh) {
        queuedRefresh = false;
        if (!error.value) void load();
      }
    }
  }
}

async function retry() {
  if (busy.value || loading.value) return;
  closeForm();
  await load();
  await nextTick();
  if (error.value) errorNotice.value?.focus();
  else heading.value?.focus();
}

watch(
  () => props.conversationId,
  () => {
    readController?.abort();
    writeController?.abort();
    readController = undefined;
    writeController = undefined;
    answer.value = null;
    error.value = '';
    notice.value = '';
    busy.value = false;
    unavailable.value = false;
    queuedRefresh = false;
    commandKeys.clear();
    closeForm();
    void load();
  },
  { immediate: true },
);
watch(
  () => props.refreshKey,
  () => void load(),
);
watch(
  () => props.canManage,
  (allowed) => {
    if (!allowed) closeForm();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  readController?.abort();
  writeController?.abort();
});
</script>

<template>
  <section
    v-if="!unavailable"
    class="order-assistance"
    :aria-labelledby="titleId"
    :aria-busy="loading || busy ? 'true' : undefined"
  >
    <h3 :id="titleId" ref="heading" tabindex="-1">Sugestões de pedido</h3>
    <p v-if="loading && !answer" class="op-hint" role="status">
      Consultando sugestões…
    </p>
    <div v-if="error" class="order-assistance-error">
      <p ref="errorNotice" role="alert" tabindex="-1">{{ error }}</p>
      <button
        type="button"
        :aria-disabled="loading || busy ? 'true' : undefined"
        @click="retry"
      >
        {{ loading ? 'Atualizando…' : 'Atualizar sugestões' }}
      </button>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="blockedHint" class="order-assistance-review">
      <p class="op-hint">{{ blockedHint }}</p>
      <button type="button" class="quiet" @click="emit('review')">
        Revisar atendimento
      </button>
    </div>
    <div
      v-for="suggestion in pending"
      :key="suggestion.id"
      class="order-assistance-card"
    >
      <p>
        <strong
          >Cliente confirmou que quer fechar
          {{ suggestion.productSummary || 'a compra' }}. Criar pedido?</strong
        >
      </p>
      <p class="op-hint">
        Sugestão interna · {{ dateTimeBR(suggestion.createdAt) }}
      </p>
      <blockquote v-if="evidenceFor(suggestion.evidenceMessageId)?.text">
        {{ evidenceFor(suggestion.evidenceMessageId).text }}
      </blockquote>
      <button
        v-if="evidenceFor(suggestion.evidenceMessageId)"
        class="quiet"
        type="button"
        @click="emit('evidence', suggestion.evidenceMessageId)"
      >
        Ver mensagem do cliente
      </button>
      <template v-if="canManage">
        <p class="op-hint">
          Ao criar, você confirma que o cliente decidiu fechar esta compra.
        </p>
        <div class="order-assistance-actions">
          <button
            type="button"
            class="primary"
            :disabled="!actionable || Boolean(answer?.blockedReason)"
            @click="decide('accept', suggestion)"
          >
            Criar pedido
          </button>
          <button
            type="button"
            :disabled="!actionable"
            @click="openForm('defer', suggestion.id)"
          >
            Ainda não
          </button>
          <button
            type="button"
            class="quiet"
            :disabled="!actionable"
            @click="openForm('reject', suggestion.id)"
          >
            Não vai seguir
          </button>
        </div>
      </template>
      <p v-else class="op-hint">
        O responsável pelo atendimento ou um administrador decide a criação.
      </p>
    </div>
    <p
      v-if="answer && !pending.length && !notice && !blockedHint"
      class="op-hint"
    >
      Nenhuma sugestão aguardando decisão.
    </p>
    <button
      v-if="canManage && answer"
      type="button"
      class="quiet"
      :disabled="!actionable || !evidence.length"
      @click="openForm('missed')"
    >
      Já deveria ter sugerido
    </button>
    <form
      v-if="mode"
      class="order-assistance-form"
      @submit.prevent="decide(mode)"
    >
      <p>
        <strong>{{
          mode === 'missed'
            ? 'O cliente já confirmou que quer fechar?'
            : mode === 'defer'
              ? 'Por que ainda não é hora de criar?'
              : 'Por que não vai seguir?'
        }}</strong>
      </p>
      <template v-if="mode === 'missed'">
        <label :for="`${titleId}-evidence`"
          >Mensagem em que o cliente confirmou o fechamento</label
        >
        <select
          :id="`${titleId}-evidence`"
          ref="evidenceField"
          v-model="sourceMessageId"
          required
          :disabled="busy"
        >
          <option value="">Selecione a mensagem do cliente</option>
          <option
            v-for="message in evidence"
            :key="message.id"
            :value="message.id"
          >
            {{ message.occurredAt ? `${dateTimeBR(message.occurredAt)} · ` : ''
            }}{{ message.text || 'Mensagem de mídia do cliente' }}
          </option>
        </select>
        <p class="op-hint">
          Registra um caso que o agente deixou passar. Isso não cria um pedido.
        </p>
      </template>
      <template v-else>
        <label :for="`${titleId}-reason`">Motivo</label>
        <select
          :id="`${titleId}-reason`"
          ref="reasonField"
          v-model="reason"
          required
          :disabled="busy"
        >
          <option value="">Selecione o motivo</option>
          <option
            v-for="item in ORDER_ASSISTANCE_REASONS"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option>
        </select>
      </template>
      <div class="order-assistance-actions">
        <button type="submit" :disabled="!actionable">
          {{ busy ? 'Salvando…' : 'Registrar decisão' }}
        </button>
        <button
          type="button"
          class="quiet"
          :disabled="busy"
          @click="
            closeForm();
            heading?.focus();
          "
        >
          Cancelar
        </button>
      </div>
    </form>
    <details
      v-if="history.length || evaluations.length"
      :key="conversationId"
      class="order-assistance-history"
    >
      <summary>Histórico das decisões</summary>
      <ul>
        <li v-for="suggestion in history" :key="suggestion.id">
          <strong>{{ orderAssistanceStatus(suggestion.status) }}</strong>
          <span v-if="suggestion.productSummary">
            · {{ suggestion.productSummary }}</span
          >
          <span v-if="orderAssistanceReason(suggestion.reason)">
            · {{ orderAssistanceReason(suggestion.reason) }}</span
          >
          <time
            v-if="
              suggestion.decidedAt ||
              suggestion.resolvedAt ||
              suggestion.createdAt
            "
            :datetime="
              suggestion.decidedAt ||
              suggestion.resolvedAt ||
              suggestion.createdAt
            "
          >
            ·
            {{
              dateTimeBR(
                suggestion.decidedAt ||
                  suggestion.resolvedAt ||
                  suggestion.createdAt,
              )
            }}</time
          >
        </li>
        <li
          v-for="evaluation in evaluations.filter(
            (item) => item.decision === 'missed',
          )"
          :key="evaluation.id"
        >
          Omissão registrada pelo vendedor ·
          {{ dateTimeBR(evaluation.createdAt) }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.order-assistance {
  padding: var(--space-3);
  border-block-end: 1px solid var(--color-border);
}
.order-assistance h3 {
  margin-block: 0 var(--space-2);
  font-size: var(--text-sm);
}
.order-assistance p {
  margin-block: var(--space-2);
  overflow-wrap: anywhere;
}
.order-assistance-card {
  border-inline-start: 3px solid var(--color-focus);
  padding-inline-start: var(--space-3);
  margin-block: var(--space-3);
}
.order-assistance blockquote {
  margin: var(--space-2) 0;
  padding-inline-start: var(--space-3);
  border-inline-start: 1px solid var(--color-border-strong);
  overflow-wrap: anywhere;
}
.order-assistance-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-block: var(--space-2);
}
.order-assistance-form {
  display: grid;
  gap: var(--space-2);
  margin-block: var(--space-3);
}
.order-assistance-form select {
  min-inline-size: 0;
  inline-size: 100%;
}
.order-assistance-history {
  margin-block-start: var(--space-3);
}
.order-assistance-history summary {
  cursor: pointer;
  min-block-size: var(--target-min);
  align-content: center;
}
.order-assistance-history ul {
  padding-inline-start: var(--space-5);
}
.order-assistance-history li {
  margin-block: var(--space-2);
  overflow-wrap: anywhere;
}
</style>
