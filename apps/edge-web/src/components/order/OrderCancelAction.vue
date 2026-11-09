<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import { dateTimeBR } from '../../lib/format.js';
import {
  CANCEL_REASON_MAX,
  describeCancelError,
  needsPaymentNotice,
  normalizeCancelReason,
  validateCancelReason,
} from '../../lib/order-cancel.js';
import { openDialog } from '../../lib/ui.js';
import OrderIcon from './OrderIcon.vue';

// OLIST-T13 (RFC 050, ADR 068): cancelamento local, terminal e motivado, com
// ação própria. O componente só pede o POST; quem decide se a ação existe
// (ACL comercial, trava Olist, pedido já cancelado) é a tela, por `canCancel`.
const props = defineProps({
  order: { type: Object, required: true },
  canCancel: { type: Boolean, default: false },
  // Uma seção em edição: a ação espera, para não descartar um rascunho.
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['cancelled', 'refresh']);

const notify = inject('notify', () => {});

/** @type {import('vue').Ref<HTMLDialogElement|null>} */
const dialog = ref(null);
/** @type {import('vue').Ref<HTMLTextAreaElement|null>} */
const reasonField = ref(null);
/** @type {import('vue').Ref<HTMLElement|null>} */
const dialogAlert = ref(null);
/** @type {import('vue').Ref<HTMLElement|null>} */
const outcomeAlert = ref(null);
/** @type {import('vue').Ref<HTMLElement|null>} */
const cancelledTitle = ref(null);
const open = ref(false);
const busy = ref(false);
const reason = ref('');
const reasonError = ref('');
const dialogMessage = ref('');
// Recusa definitiva fora do diálogo: fica na seção, sem botão de nova tentativa.
const outcome = ref('');
// A versão mudou depois de aberto o diálogo: nada é enviado por cima dela.
const stale = ref(false);
// A versão que o diálogo mostrou; é a que o servidor confere (PCL-09).
const openVersion = ref(0);
/** @type {HTMLElement|null} */
let opener = null;
// Mesmo comando (chave + corpo) enquanto o resultado for incerto: reenviar
// devolve o recibo, não cria um segundo cancelamento.
/** @type {{key: string, body: {expectedVersion: number, reason: string}}|null} */
let pending = null;
let announceNext = false;

const cancelled = computed(() => Boolean(props.order.cancelledAt));
const visible = computed(
  () => props.canCancel || cancelled.value || outcome.value !== '',
);
const paymentNotice = computed(() => needsPaymentNotice(props.order));
const triggerHint = computed(() =>
  props.disabled
    ? 'Salve ou cancele a seção em edição antes de cancelar o pedido.'
    : 'Encerra o pedido no CRM: sai das vendas ativas e das filas. Não é exclusão nem estorno.',
);
const describedBy = computed(() =>
  [
    'order-cancel-description',
    'order-cancel-impact',
    paymentNotice.value ? 'order-cancel-payment' : '',
  ]
    .filter(Boolean)
    .join(' '),
);
const reasonDescribedBy = computed(() =>
  reasonError.value ? 'order-cancel-reason-error' : 'order-cancel-reason-hint',
);

/**
 * @param {EventTarget|null} trigger o botão que pediu, para onde Esc e Voltar
 * devolvem o foco.
 */
async function requestCancel(trigger) {
  if (!props.canCancel || props.disabled || busy.value) return;
  opener = trigger instanceof globalThis.HTMLElement ? trigger : null;
  outcome.value = '';
  dialogMessage.value = '';
  reasonError.value = '';
  stale.value = false;
  openVersion.value = props.order.version;
  open.value = true;
  await nextTick();
  if (!dialog.value) return;
  if (opener) openDialog(dialog.value, opener);
  else dialog.value.showModal?.();
  // O campo do motivo, e não o botão que o ajudante focou.
  reasonField.value?.focus();
}

/**
 * Fecha sem enviar. Esc e Voltar devolvem o foco a quem abriu; os desfechos
 * movem o foco sozinhos, depois do evento `close` (e do retorno que o
 * ajudante faz nele), para a palavra final ser deles.
 *
 * @param {{restoreFocus?: boolean}} [options]
 * @returns {Promise<void>}
 */
function closeDialog({ restoreFocus = true } = {}) {
  const element = dialog.value;
  const closed = element?.open
    ? new Promise((resolve) => {
        element.addEventListener('close', () => resolve(undefined), {
          once: true,
        });
      })
    : Promise.resolve();
  element?.close?.();
  if (restoreFocus && opener?.isConnected) opener.focus();
  opener = null;
  return closed.then(() => {
    if (!element?.open) open.value = false;
  });
}

// Voltar e Esc: nada é enviado e o texto só fica se a versão mudou (o motivo
// digitado vale para a revisão que o servidor pediu).
function leave() {
  if (busy.value) return;
  if (!stale.value) reason.value = '';
  reasonError.value = '';
  dialogMessage.value = '';
  pending = null;
  void closeDialog();
}

async function submit() {
  if (busy.value || stale.value || !props.canCancel) return;
  dialogMessage.value = '';
  const text = normalizeCancelReason(reason.value);
  const problem = validateCancelReason(text);
  if (problem) {
    reasonError.value = problem;
    await nextTick();
    reasonField.value?.focus();
    return;
  }
  reasonError.value = '';
  if (
    !pending ||
    pending.body.reason !== text ||
    pending.body.expectedVersion !== openVersion.value
  ) {
    pending = {
      key: commandKey(),
      body: { expectedVersion: openVersion.value, reason: text },
    };
  }
  // Duplo clique, Enter repetido: só o primeiro chega aqui.
  busy.value = true;
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.order.id)}/cancel`,
      {
        body: pending.body,
        idempotencyKey: pending.key,
        method: 'POST',
      },
    );
    // O corpo é conferido ANTES de fechar o diálogo e limpar o motivo: um 200
    // malformado ou um 204 não prova o cancelamento, então o pedido é relido.
    const done = response?.data?.order;
    if (!isCancelledOrder(done)) {
      await settleUncertain();
      return;
    }
    pending = null;
    reason.value = '';
    await closeDialog({ restoreFocus: false });
    announceNext = true;
    emit('cancelled', done);
  } catch (cause) {
    await fail(cause);
  } finally {
    busy.value = false;
  }
}

/** @param {any} value */
function isCancelledOrder(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.id === props.order.id &&
    value.cancelledAt,
  );
}

/** A resposta não confirmou o cancelamento: o resultado é incerto, o diálogo
 * se encerra e o pedido persistido é relido (a tela mostra o que o servidor
 * guardou), sem oferecer repetir. */
async function settleUncertain() {
  pending = null;
  reason.value = '';
  outcome.value =
    'O servidor respondeu sem confirmar o cancelamento. Não sabemos se o pedido foi cancelado: o estado atual foi recarregado, confira antes de tentar de novo.';
  emit('refresh');
  await closeDialog({ restoreFocus: false });
  await nextTick();
  outcomeAlert.value?.focus();
}

/** @param {any} cause */
async function fail(cause) {
  const result = describeCancelError(cause);
  if (!result.retryable) pending = null;
  if (result.refresh) emit('refresh');
  if (result.closes) {
    reason.value = '';
    outcome.value = result.message;
    await closeDialog({ restoreFocus: false });
    await nextTick();
    outcomeAlert.value?.focus();
    return;
  }
  if (result.kind === 'invalid') {
    reasonError.value = result.message;
    await nextTick();
    reasonField.value?.focus();
    return;
  }
  if (result.kind === 'stale') stale.value = true;
  dialogMessage.value = result.message;
  await nextTick();
  dialogAlert.value?.focus();
}

// Versão nova com o diálogo aberto (outra pessoa mexeu, ou a tela releu):
// nada é enviado por cima dela; o texto fica para a próxima abertura.
watch(
  () => props.order.version,
  (version) => {
    if (
      open.value &&
      version !== openVersion.value &&
      !busy.value &&
      !stale.value
    ) {
      stale.value = true;
      dialogMessage.value =
        'Este pedido mudou depois que você abriu a confirmação. Volte, confira o pedido atualizado e abra Cancelar pedido de novo; o motivo digitado será mantido.';
    }
  },
);

// A ação deixou de valer com o diálogo aberto (uma operação Olist apareceu):
// fecha sem enviar e diz por quê, para o foco não se perder.
watch(
  () => props.canCancel,
  async (allowed) => {
    if (allowed || !open.value || busy.value || cancelled.value) return;
    reason.value = '';
    outcome.value =
      'Cancelar este pedido deixou de estar disponível: ele passou a ter uma operação Olist ou mudou de dono.';
    await closeDialog({ restoreFocus: false });
    await nextTick();
    outcomeAlert.value?.focus();
  },
);

// O pedido passou a Cancelado por esta ação: o foco vai ao estado Cancelado e
// o aviso é anunciado uma única vez pela região de status do shell.
watch(cancelled, async (isCancelled) => {
  if (!isCancelled || !announceNext) return;
  announceNext = false;
  await nextTick();
  cancelledTitle.value?.focus();
  notify(`Pedido ${props.order.number} cancelado.`);
});
</script>

<template>
  <div v-if="visible" class="op-cancel">
    <p
      v-if="outcome"
      ref="outcomeAlert"
      role="alert"
      tabindex="-1"
      class="op-alert"
    >
      {{ outcome }}
    </p>

    <!-- A compact row, with no heading of its own: the page keeps its
         sections and its height (RFC 024); the state Cancelado gets one. -->
    <section
      v-if="cancelled"
      class="op-sheet"
      aria-labelledby="order-cancel-title"
    >
      <div class="op-sheet-head">
        <h2 id="order-cancel-title" ref="cancelledTitle" tabindex="-1">
          Cancelado no CRM
        </h2>
      </div>
      <div class="op-sheet-body op-cancel-body">
        <dl class="op-cancel-facts">
          <div>
            <dt>Cancelado por</dt>
            <dd>{{ order.cancelledBy?.name || 'Não informado' }}</dd>
          </div>
          <div>
            <dt>Data e hora</dt>
            <dd class="op-num">{{ dateTimeBR(order.cancelledAt) }}</dd>
          </div>
          <div v-if="order.cancellationReason">
            <dt>Motivo</dt>
            <dd class="op-cancel-reason">{{ order.cancellationReason }}</dd>
          </div>
        </dl>
        <p class="op-hint">
          Cancelamento local: o pedido saiu das vendas e das filas ativas. O
          histórico, o pagamento e a ficha continuam consultáveis. Não é
          exclusão nem estorno, e nada foi alterado no Olist.
        </p>
      </div>
    </section>

    <div v-else-if="canCancel" class="op-cancel-action">
      <p id="order-cancel-hint" class="op-hint">{{ triggerHint }}</p>
      <button
        type="button"
        class="danger"
        :aria-disabled="disabled || undefined"
        aria-describedby="order-cancel-hint"
        @click="requestCancel($event.currentTarget)"
      >
        Cancelar pedido
      </button>
    </div>

    <dialog
      v-if="open"
      ref="dialog"
      class="op-dialog op-generate-dialog op-cancel-dialog"
      aria-modal="true"
      aria-labelledby="order-cancel-dialog-title"
      :aria-describedby="describedBy"
      @cancel.prevent="leave"
    >
      <h2 id="order-cancel-dialog-title">
        Cancelar o pedido {{ order.number }}?
      </h2>
      <p id="order-cancel-description">
        O cancelamento é definitivo: o pedido não pode ser reaberto nem
        restaurado.
      </p>
      <ul id="order-cancel-impact" class="op-cancel-impact">
        <li>
          Sai das vendas ativas, da receita vendida, dos afazeres, das filas de
          produção e de entrega e da fila financeira ativa.
        </li>
        <li>
          O histórico, o pagamento e o check anteriores e os registros da ficha
          continuam consultáveis.
        </li>
        <li>
          Não é exclusão de dados, não é estorno e nada é cancelado no Olist ou
          no ERP.
        </li>
      </ul>
      <p
        v-if="paymentNotice"
        id="order-cancel-payment"
        class="op-cancel-notice"
      >
        Este pedido consta como pago ou veio da loja do site. Cancelar aqui não
        devolve dinheiro e não altera o gateway de pagamento nem o checkout; uma
        devolução, se houver, é tratada à parte.
      </p>

      <form class="op-closing-form" novalidate @submit.prevent="submit">
        <p
          v-if="dialogMessage"
          ref="dialogAlert"
          role="alert"
          tabindex="-1"
          class="op-alert"
        >
          {{ dialogMessage }}
        </p>

        <div class="op-field">
          <label for="order-cancel-reason">Motivo do cancelamento</label>
          <textarea
            id="order-cancel-reason"
            ref="reasonField"
            v-model="reason"
            rows="3"
            :maxlength="CANCEL_REASON_MAX"
            required
            aria-required="true"
            autocomplete="off"
            :aria-invalid="reasonError ? 'true' : undefined"
            :aria-describedby="reasonDescribedBy"
          ></textarea>
          <p
            v-if="reasonError"
            id="order-cancel-reason-error"
            role="alert"
            class="op-field-error"
          >
            {{ reasonError }}
          </p>
          <p v-else id="order-cancel-reason-hint" class="op-hint">
            Obrigatório, até {{ CANCEL_REASON_MAX }} caracteres. Fica registrado
            com o seu nome, aparece para quem consulta o pedido e não pode ser
            editado depois. Não inclua dados pessoais do cliente.
          </p>
        </div>

        <div class="op-dialog-actions">
          <button
            type="button"
            :aria-disabled="busy || undefined"
            @click="leave"
          >
            Voltar
          </button>
          <button
            type="submit"
            class="danger"
            :aria-disabled="busy || stale || undefined"
            :aria-busy="busy || undefined"
          >
            {{ busy ? 'Cancelando…' : `Cancelar pedido ${order.number}` }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.op-cancel-body {
  display: grid;
  gap: var(--space-3);
}
.op-cancel-action {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}
.op-cancel-action .op-hint {
  flex: 1 1 16rem;
}
.op-cancel-action button {
  min-block-size: var(--target-min);
}
.op-cancel-facts {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}
.op-cancel-facts > div {
  display: grid;
  gap: var(--space-1);
}
.op-cancel-facts dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}
.op-cancel-facts dd {
  margin: 0;
  font-size: var(--text-sm);
}
.op-cancel-reason {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.op-cancel-impact {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding-inline-start: 1.25rem;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: 1.55;
}
.op-cancel-notice {
  padding: var(--space-3);
  margin: var(--space-3) 0 0;
  color: var(--status-warning-text);
  font-size: var(--text-sm);
  line-height: 1.55;
  background: var(--status-warning-surface);
  border-radius: var(--radius-md);
}
.op-cancel-dialog form {
  display: grid;
  gap: var(--space-3);
  margin-block-start: var(--space-3);
}
.op-cancel-dialog textarea {
  inline-size: 100%;
  min-block-size: 5.5rem;
  resize: vertical;
}
</style>
