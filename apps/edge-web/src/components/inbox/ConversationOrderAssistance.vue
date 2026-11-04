<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
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
  detailsTarget: { type: Object, default: null },
  detailsOpen: { type: Boolean, default: false },
});
const emit = defineEmits(['created', 'changed', 'evidence', 'review']);
const heading = ref(null);
const detailsHeading = ref(null);
const detailsFeedbackTarget = ref(null);
const detailsFormTarget = ref(null);
const expanded = ref(true);
const feedbackInDetails = ref(false);
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
const decisionBodyVisible = computed(
  () =>
    pending.value.length > 0 || Boolean(mode.value && mode.value !== 'missed'),
);
const feedbackAtDetails = computed(
  () => feedbackInDetails.value && props.detailsOpen,
);
const footerVisible = computed(
  () =>
    pending.value.length > 0 ||
    (loading.value && !answer.value) ||
    (!feedbackAtDetails.value && Boolean(error.value || notice.value)) ||
    Boolean(mode.value && mode.value !== 'missed'),
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
  expanded.value = true;
  feedbackInDetails.value = decision === 'missed';
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
  feedbackInDetails.value = decision === 'missed';
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
      (feedbackAtDetails.value ? detailsHeading.value : heading.value)?.focus();
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
  if (
    !error.value &&
    !pending.value.length &&
    !notice.value &&
    !unavailable.value
  )
    notice.value =
      'Sugestões atualizadas. Nenhuma sugestão aguardando decisão.';
  await nextTick();
  if (error.value) errorNotice.value?.focus();
  else
    (feedbackAtDetails.value ? detailsHeading.value : heading.value)?.focus();
}

watch(
  () => props.conversationId,
  () => {
    readController?.abort();
    writeController?.abort();
    readController = undefined;
    writeController = undefined;
    expanded.value = true;
    feedbackInDetails.value = false;
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
    v-show="footerVisible"
    class="order-assistance"
    :aria-labelledby="titleId"
    :aria-busy="loading || busy ? 'true' : undefined"
  >
    <header
      class="order-assistance-heading"
      :class="{
        'order-assistance-heading--error-only': error && !decisionBodyVisible,
      }"
    >
      <h3 :id="titleId" ref="heading" tabindex="-1">Sugestões de pedido</h3>
      <span class="order-assistance-internal">Só para a equipe</span>
      <time
        v-if="pending.length === 1"
        class="order-assistance-date"
        :datetime="pending[0].createdAt"
        :title="`Sugestão interna · ${dateTimeBR(pending[0].createdAt)}`"
        >{{ dateTimeBR(pending[0].createdAt) }}</time
      >
      <button
        v-if="pending.length || (mode && mode !== 'missed')"
        type="button"
        class="quiet order-assistance-toggle"
        :aria-label="
          expanded
            ? 'Recolher sugestões de pedido'
            : 'Expandir sugestões de pedido'
        "
        :aria-expanded="expanded"
        :aria-controls="`${titleId}-body`"
        @click="expanded = !expanded"
      >
        <AppIcon name="chevron-down" />
      </button>
    </header>
    <Teleport
      :to="detailsFeedbackTarget || detailsTarget || 'body'"
      :disabled="!detailsTarget || !feedbackAtDetails"
    >
      <div
        v-if="(loading && !answer) || error || notice"
        class="order-assistance-feedback"
        role="group"
        aria-label="Atualizações das sugestões"
        tabindex="0"
      >
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
      </div>
    </Teleport>
    <div
      :id="`${titleId}-body`"
      v-show="expanded && decisionBodyVisible"
      class="order-assistance-body"
      role="group"
      :tabindex="decisionBodyVisible ? 0 : undefined"
      aria-label="Sugestões e decisão"
    >
      <div
        v-for="suggestion in pending"
        :key="suggestion.id"
        class="order-assistance-card"
      >
        <p>
          <strong
            >Cliente confirmou o fechamento ·
            {{ suggestion.productSummary || 'a compra' }}.</strong
          >
        </p>
        <p v-if="pending.length > 1" class="order-assistance-date">
          Sugestão interna · {{ dateTimeBR(suggestion.createdAt) }}
        </p>
        <div class="order-assistance-evidence">
          <blockquote v-if="evidenceFor(suggestion.evidenceMessageId)?.text">
            {{ evidenceFor(suggestion.evidenceMessageId).text }}
          </blockquote>
          <button
            v-if="evidenceFor(suggestion.evidenceMessageId)"
            class="quiet"
            type="button"
            @click="emit('evidence', suggestion.evidenceMessageId)"
          >
            Ver mensagem
          </button>
        </div>
        <template v-if="canManage">
          <p class="order-assistance-confirmation">
            Ao criar, você confirma que o cliente decidiu fechar. O pedido nasce
            pendente.
          </p>
          <p v-if="answer?.blockedReason" class="order-assistance-blocked">
            {{ blockedHint }}
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

      <Teleport
        :to="detailsFormTarget || detailsTarget || 'body'"
        :disabled="!detailsTarget || mode !== 'missed'"
      >
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
                {{
                  message.occurredAt
                    ? `${dateTimeBR(message.occurredAt)} · `
                    : ''
                }}{{ message.text || 'Mensagem de mídia do cliente' }}
              </option>
            </select>
            <p class="op-hint">
              Registra um caso que o agente deixou passar. Isso não cria um
              pedido.
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
                (feedbackInDetails ? detailsHeading : heading)?.focus();
              "
            >
              Cancelar
            </button>
          </div>
        </form>
      </Teleport>
    </div>
    <Teleport :to="detailsTarget || 'body'" :disabled="!detailsTarget">
      <section
        class="order-assistance-details"
        :aria-labelledby="`${titleId}-details`"
        :aria-busy="loading || busy ? 'true' : undefined"
      >
        <h3 :id="`${titleId}-details`" ref="detailsHeading" tabindex="-1">
          Avaliar sugestões de pedido
        </h3>
        <div ref="detailsFeedbackTarget" />
        <div v-if="blockedHint" class="order-assistance-review">
          <p class="op-hint">{{ blockedHint }}</p>
          <button type="button" class="quiet" @click="emit('review')">
            Revisar atendimento
          </button>
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

        <div ref="detailsFormTarget" />
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
    </Teleport>
  </section>
</template>

<style scoped>
.order-assistance {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-block-size: var(--target-min);
  max-block-size: 30%;
  padding: 0 var(--space-4);
  color: var(--status-info-text);
  background: var(--status-info-surface);
  font-size: var(--text-sm);
}
.order-assistance-heading {
  flex: none;
  min-block-size: var(--target-min);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.order-assistance h3,
.order-assistance-details h3 {
  margin: 0;
  font-size: var(--text-sm);
}
.order-assistance-internal,
.order-assistance-date,
.order-assistance-confirmation {
  font-size: var(--text-xs);
}
.order-assistance-toggle {
  margin-inline-start: auto;
  color: inherit;
  min-inline-size: var(--control-height);
  min-block-size: var(--control-height);
  padding: var(--space-1);
}
.order-assistance-toggle[aria-expanded='true'] svg {
  transform: rotate(180deg);
}
.order-assistance-heading--error-only {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  min-block-size: 0;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.order-assistance-body,
.order-assistance-feedback {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
.order-assistance p,
.order-assistance-details p {
  margin-block: var(--space-1);
  overflow-wrap: anywhere;
}
.order-assistance-card {
  display: grid;
  gap: var(--space-1);
  padding-block-end: var(--space-1);
  font-size: var(--text-xs);
}
.order-assistance-card > p {
  margin: 0;
}
.order-assistance-card > p:first-child strong {
  font-weight: 500;
}
.order-assistance-card .order-assistance-actions {
  margin-block: 0;
}
.order-assistance-card .order-assistance-actions button {
  font-size: var(--text-xs);
  padding-inline: var(--space-2);
}
.order-assistance-card + .order-assistance-card {
  border-block-start: 1px solid var(--color-border);
  padding-block-start: var(--space-2);
  margin-block-start: var(--space-2);
}
.order-assistance blockquote {
  margin: 0;
  max-inline-size: 65ch;
  font-style: italic;
  overflow-wrap: anywhere;
}
.order-assistance-evidence {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--space-2);
}
.order-assistance .op-hint {
  color: inherit;
}
.order-assistance-evidence > .quiet {
  color: inherit;
  padding-inline: 0;
  text-decoration: underline;
  text-underline-offset: var(--space-1);
}
.order-assistance-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-block: var(--space-2);
}
.order-assistance-actions .quiet {
  color: inherit;
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
.order-assistance-details {
  padding-block: var(--space-3);
  border-block-start: 1px solid var(--color-border);
  font-size: var(--text-sm);
}
.order-assistance-details p {
  color: var(--color-text-muted);
}
.order-assistance-error {
  padding: var(--space-2);
  background: var(--status-error-surface);
  border-radius: var(--radius-sm);
}
.order-assistance-error p {
  color: var(--status-error-text);
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
@media (max-width: 768px) {
  .order-assistance {
    padding-inline: var(--space-3);
  }
  .order-assistance-internal {
    display: none;
  }
}
</style>
