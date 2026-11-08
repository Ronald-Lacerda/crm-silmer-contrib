<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { brand } from '../../brand/index.js';
import { dateTimeBR } from '../../lib/format.js';
import { openDialog } from '../../lib/ui.js';
import {
  amountLabel,
  fichaPrintedLabel,
  formatBrl,
  isItemGap,
  isPageGap,
  isStoreOrder,
  joinPt,
  missingFieldLabels,
  nextOrderStep,
  parseBrl,
  PAYMENT_CONDITION_OPTIONS,
  paymentConditionLabel,
  storeConfirmationLabel,
} from '../../lib/order-format.js';
import OrderIcon from './OrderIcon.vue';
import AppHint from '../AppHint.vue';

// PCL-05: what each blocker outside the items means to the seller when the
// server refuses it; the item points are named one by one (PIT-06).
const BLOCKER_MESSAGES = Object.freeze({
  artwork: 'Marque quem faz a arte em Arte do pedido.',
  finalAmount: 'Informe o valor final aprovado pelo cliente.',
  paymentCondition: 'Escolha a forma de pagamento.',
  'summary.data_entrega_confirmada':
    'Informe a entrega prometida no Resumo do pedido.',
});
const AMOUNT_FORMAT_MESSAGE = 'Use o formato 4.820,00.';
// PFI-19 (RFC 024): the amount and the payment method are typed only in the
// dialog "Gerar o pedido", so the rail says where they are asked.
const ASKED_WHEN_GENERATING =
  'Valor e forma de pagamento você informa ao gerar.';
const OFFLINE_MESSAGE =
  'Sem conexão com o servidor. O pedido não foi gerado; tente de novo.';
// ADR 020, PFI-20 (ADR 035): who makes the art, in the words of the Arte do
// pedido section; the company's name comes from the brand.
const ARTWORK_LABELS = Object.freeze([
  Object.freeze({ key: 'feito_pelo_cliente', label: 'O cliente envia a arte' }),
  Object.freeze({
    key: 'feito_pela_silmer',
    label: `A ${brand.companyName} cria a arte`,
  }),
  Object.freeze({ key: 'sem_estampa', label: 'Sem estampa' }),
]);

const props = defineProps({
  order: { type: Object, required: true },
});

const editing = inject('orderEditing');
const notify = inject('notify', () => {});
const dialog = ref(null);
const amountInput = ref(null);
const dialogAlert = ref(null);
const reopenDialog = ref(null);
const reopenOpen = ref(false);
const closingTitle = ref(null);
const amountText = ref(formatBrl(props.order.finalAmountCents));
const paymentCondition = ref(props.order.paymentCondition ?? '');
const busy = ref(false);
const confirmOpen = ref(false);
const justGenerated = ref(false);
// The rail's alert (a failed reopening) and the dialog's own alert.
const errorMessage = ref('');
const dialogMessage = ref('');
/** @type {import('vue').Ref<Record<string, string>>} */
const fieldErrors = ref({});
/** @type {import('vue').Ref<{field: string, message: string}[]>} */
const blockerNotes = ref([]);
/**
 * Who opened the dialog — "Gerar pedido" in the rail or in the phone's
 * footer — so Esc and "Voltar" give the focus back to it.
 *
 * @type {HTMLElement|null}
 */
let opener = null;

const confirmVersion = ref(0);
const confirmationStale = ref(false);
const calculatedPricing = computed(() => Boolean(props.order.pricing));
const confirmationHint = computed(() =>
  calculatedPricing.value
    ? 'O total vem dos subtotais revisados. A forma de pagamento é conferida ao gerar.'
    : ASKED_WHEN_GENERATING,
);
const isPending = computed(() => props.order.status === 'pendente');
// LOJ-34 (ADR 031): a site order shows this panel confirmed, like an order
// generated here, with what the site confirmed and no reopening.
const isStore = computed(() => isStoreOrder(props.order));
const fichaPrinted = computed(() => fichaPrintedLabel(props.order));
const canCommand = computed(
  () => (editing.canConfirm ?? editing.canEdit).value && !isStore.value,
);
const canReopen = computed(() => editing.canEdit.value && !isStore.value);
const sectionOpenElsewhere = computed(
  () => editing.editingSection.value !== '',
);
const missing = computed(() => (props.order.missingFields ?? []).map(String));
const amountValid = computed(() =>
  calculatedPricing.value
    ? props.order.pricing.complete === true &&
      Number.isSafeInteger(props.order.pricing.totalCents) &&
      props.order.pricing.totalCents > 0
    : parseBrl(amountText.value) !== null,
);
const items = computed(() => props.order.ficha?.items ?? []);
const itemsHeadline = computed(() => {
  const count = items.value.length;
  return `${count} ${count === 1 ? 'item' : 'itens'} · ${props.order.totalPieces} peças`;
});
const artworkHeadline = computed(() => {
  const artwork = props.order.ficha?.artwork ?? {};
  const marked = ARTWORK_LABELS.filter(({ key }) => artwork[key] === true);
  return marked.length > 0 ? marked.map(({ label }) => label).join(' · ') : '—';
});
// PFI-15/PFI-16 (RFC 024): the progress at the top of the page replaced the
// checklist that lived here. While a step is missing or a section is open,
// "Gerar pedido" stays focusable but unavailable (aria-disabled); activating
// it leads to the step instead of opening the dialog.
const nextStep = computed(() => nextOrderStep(props.order));
const generateBlocked = computed(
  () => nextStep.value !== null || sectionOpenElsewhere.value,
);
// PIT-06: "Falta para gerar" names every point of the page, item by item,
// then who makes the art and the promised delivery. The amount and the
// payment method are asked in the dialog (PFI-19), never listed here.
const pendingLabels = computed(() =>
  missingFieldLabels(missing.value.filter(isPageGap)),
);
const readiness = computed(() => {
  if (pendingLabels.value.length > 0) {
    return `Falta para gerar: ${joinPt(pendingLabels.value)}. ${confirmationHint.value}`;
  }
  if (sectionOpenElsewhere.value) {
    return 'Salve ou cancele a seção em edição antes de gerar.';
  }
  return `Tudo pronto. ${confirmationHint.value}`;
});

/** @param {unknown} value */
function dateBR(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
}

// PCL-07: reopening keeps the amount and the condition already recorded, so
// the dialog comes back filled with what was confirmed. Only a change of
// those two values rewrites them: saving another section while the dialog is
// closed (ADR 016) keeps what the seller already typed in it.
watch(
  [() => props.order.finalAmountCents, () => props.order.paymentCondition],
  ([cents, condition]) => {
    amountText.value = formatBrl(cents);
    paymentCondition.value = condition ?? '';
  },
);

// A condition picked after the warning clears the warning.
watch(paymentCondition, (value) => {
  if (value === '' || !fieldErrors.value.paymentCondition) return;
  const { paymentCondition: _cleared, ...rest } = fieldErrors.value;
  fieldErrors.value = rest;
});

/**
 * On leaving the field, a plain number ("4820", "4820,5") is written the way
 * the rule reads it ("4.820,00"); anything else is left as typed and, when it
 * still is not an amount, the message shows now instead of on "Confirmar".
 */
function settleAmount() {
  const text = amountText.value.trim();
  const plain = /^(\d+)(?:,(\d{1,2}))?$/u.exec(text);
  if (plain) {
    const cents =
      Number(plain[1]) * 100 + Number((plain[2] ?? '').padEnd(2, '0'));
    if (Number.isSafeInteger(cents) && cents > 0) {
      amountText.value = formatBrl(cents);
    }
  }
  if (amountText.value.trim() !== '' && !amountValid.value) {
    fieldErrors.value = {
      ...fieldErrors.value,
      finalAmount: AMOUNT_FORMAT_MESSAGE,
    };
    return;
  }
  const { finalAmount: _cleared, ...rest } = fieldErrors.value;
  fieldErrors.value = rest;
}

/**
 * The item points in one sentence, from the keys the server uses.
 *
 * @param {string[]} fields
 */
function itemsMessage(fields) {
  if (fields.includes('items')) return 'O pedido precisa de ao menos um item.';
  return `Complete os itens antes de gerar: ${joinPt(missingFieldLabels(fields))}.`;
}

/**
 * One message per blocker: the item points together, the rest each on its
 * own, next to the field when it has one.
 *
 * @param {string[]} fields
 * @returns {Record<string, string>}
 */
function blockerErrors(fields) {
  /** @type {Record<string, string>} */
  const errors = {};
  const gaps = fields.filter(isItemGap);
  if (gaps.length > 0) errors.items = itemsMessage(gaps);
  for (const field of fields.filter((name) => !isItemGap(name))) {
    errors[field] =
      BLOCKER_MESSAGES[/** @type {keyof typeof BLOCKER_MESSAGES} */ (field)] ??
      field;
  }
  return errors;
}

/**
 * PFI-16/PFI-19: while a step is missing, "Gerar pedido" leads to it and
 * never opens the dialog nor sends the confirmation; with a section open it
 * waits for Salvar or Cancelar, as #closing-readiness says. Once the three
 * steps are done it opens the dialog "Gerar o pedido", the only place where
 * the amount and the payment method are typed.
 *
 * @param {EventTarget|null} [trigger] the button that asked for it
 * @returns {Promise<'busy'|'section'|'step'|'dialog'>}
 */
async function requestGenerate(trigger) {
  if (busy.value || !canCommand.value) return 'busy';
  if (sectionOpenElsewhere.value) return 'section';
  if (nextStep.value) {
    void editing.goToSection(nextStep.value.section);
    return 'step';
  }
  fieldErrors.value = {};
  blockerNotes.value = [];
  dialogMessage.value = '';
  errorMessage.value = '';
  justGenerated.value = false;
  opener = trigger instanceof globalThis.HTMLElement ? trigger : null;
  confirmationStale.value = false;
  confirmVersion.value = props.order.version;
  confirmOpen.value = true;
  await nextTick();
  if (!dialog.value) return 'dialog';
  if (opener) openDialog(dialog.value, opener);
  else dialog.value.showModal?.();
  // The first field of the dialog, whatever the helper focused.
  if (calculatedPricing.value)
    dialog.value?.querySelector('input[name="payment-condition"]')?.focus();
  else amountInput.value?.focus();
  return 'dialog';
}

/**
 * Mobile first: "Gerar pedido" also lives in the page's fixed footer, far
 * from this panel. It opens the same dialog and the focus comes back to it.
 *
 * @param {EventTarget|null} [trigger]
 */
function generateFromFooter(trigger) {
  return requestGenerate(trigger ?? null);
}

defineExpose({ generateFromFooter });
watch(
  () => props.order.version,
  (version) => {
    if (confirmOpen.value && version !== confirmVersion.value && !busy.value) {
      confirmationStale.value = true;
      dialogMessage.value =
        'Este pedido mudou. Volte e confira o pedido atual antes de confirmar.';
    }
  },
);
watch(canCommand, (allowed) => {
  if (!allowed && confirmOpen.value && !busy.value) void closeDialog();
});
watch(canReopen, (allowed) => {
  if (!allowed && reopenOpen.value && !busy.value) closeReopen();
});

/**
 * Closes the dialog without writing anything. Esc and "Voltar" give the
 * focus back to whoever opened it (the helper does it again on `close`,
 * harmlessly). The outcomes of the confirmation move the focus themselves,
 * once the `close` event — and the helper's own return of the focus — has
 * passed, so the last word on the focus is theirs.
 *
 * @param {{restoreFocus?: boolean}} [options]
 * @returns {Promise<void>}
 */
function closeDialog({ restoreFocus = true } = {}) {
  /** @type {HTMLDialogElement|null} */
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
  // The element leaves the page after its `close` event, unless the dialog
  // was opened again in between.
  return closed.then(() => {
    if (!element?.open) confirmOpen.value = false;
  });
}

// Esc waits for the answer of a confirmation already sent.
function cancelDialog() {
  if (busy.value) return;
  closeDialog();
}

/** The first field the seller has to fix, in the order of the dialog. */
async function focusFirstError() {
  await nextTick();
  const errors = fieldErrors.value;
  /** @type {HTMLElement|null|undefined} */
  const target = errors.finalAmount
    ? amountInput.value
    : errors.paymentCondition
      ? dialog.value?.querySelector('input[name="payment-condition"]')
      : null;
  target?.focus();
}

/**
 * PFI-11/PFI-12: a malformed amount ("4,820") or a missing method is caught
 * here, next to its field, and nothing is sent; the server parses the same
 * text again and would answer 422. A second Enter while the first is on its
 * way is ignored.
 */
async function submitGenerate() {
  if (busy.value || confirmationStale.value || !canCommand.value) return;
  dialogMessage.value = '';
  /** @type {Record<string, string>} */
  const errors = {};
  if (!amountValid.value)
    errors.finalAmount = calculatedPricing.value
      ? 'Revise os subtotais dos itens antes de gerar.'
      : AMOUNT_FORMAT_MESSAGE;
  if (paymentCondition.value === '') {
    errors.paymentCondition = BLOCKER_MESSAGES.paymentCondition;
  }
  fieldErrors.value = errors;
  if (Object.keys(errors).length > 0) {
    await focusFirstError();
    return;
  }
  await generate();
}

/** PCL-04: the human transition that dates the order and frees the ficha. */
async function generate() {
  busy.value = true;
  const result = await editing.command('confirm', {
    ...(calculatedPricing.value ? {} : { amountText: amountText.value.trim() }),
    expectedVersion: confirmVersion.value,
    paymentCondition: paymentCondition.value,
  });
  busy.value = false;
  if (result.ok) {
    justGenerated.value = true;
    await closeDialog({ restoreFocus: false });
    // The button is gone with the confirmed view; the panel's title keeps
    // the focus next to the confirmation and the ficha.
    await nextTick();
    closingTitle.value?.focus();
    return;
  }
  const fields = (result.fields ?? []).map(String);
  if (result.code === 'ORDER_NOT_CONFIRMABLE' && fields.some(isPageGap)) {
    // PFI-19: a blocker outside the dialog closes it; the rail names every
    // blocker the server listed, the progress is read again and the focus
    // goes to the next step. The order stays pending (PCL-05).
    blockerNotes.value = Object.entries(blockerErrors(fields)).map(
      ([field, message]) => ({ field, message }),
    );
    await closeDialog({ restoreFocus: false });
    await editing.revisitNextStep();
    return;
  }
  if (
    result.code === 'ORDER_NOT_CONFIRMABLE' ||
    result.code === 'INVALID_AMOUNT'
  ) {
    fieldErrors.value =
      result.code === 'INVALID_AMOUNT'
        ? { finalAmount: AMOUNT_FORMAT_MESSAGE }
        : blockerErrors(fields);
    if (Object.keys(fieldErrors.value).length > 0) {
      await focusFirstError();
      return;
    }
  }
  // 409, 403, the server down or the connection lost: the dialog stays open
  // with what happened, nothing recorded, and the focus on the message.
  if (result.status === 409) confirmationStale.value = true;
  dialogMessage.value = result.status === 0 ? OFFLINE_MESSAGE : result.message;
  await nextTick();
  dialogAlert.value?.focus();
}

/**
 * Pesquisa UX 2026-10-15, achado 6: reopening blocks the print the shop
 * floor may already be using, so it asks first and says what happens.
 */
async function requestReopen() {
  if (!canReopen.value || busy.value) return;
  errorMessage.value = '';
  justGenerated.value = false;
  reopenOpen.value = true;
  await nextTick();
  reopenDialog.value?.showModal?.();
}

function closeReopen() {
  reopenDialog.value?.close?.();
  reopenOpen.value = false;
}

async function reopen() {
  if (!canReopen.value || busy.value) return;
  const number = props.order.number;
  busy.value = true;
  const result = await editing.command('reopen', {});
  busy.value = false;
  closeReopen();
  if (!result.ok) {
    errorMessage.value = result.message;
    return;
  }
  notify(
    `Pedido ${number} reaberto. A ficha só volta a ser impressa depois de gerar de novo.`,
  );
  // The button is gone with the confirmed view; the panel's title keeps the
  // focus where the seller was working.
  await nextTick();
  closingTitle.value?.focus();
}
</script>

<template>
  <section class="op-sheet op-closing" aria-labelledby="order-closing-title">
    <div class="op-sheet-head">
      <h2 id="order-closing-title" ref="closingTitle" tabindex="-1">
        Fechamento e pagamento
      </h2>
      <p>{{ isPending ? 'pedido pendente' : 'pedido confirmado' }}</p>
    </div>

    <div class="op-sheet-body op-closing-body">
      <p v-if="errorMessage" role="alert" class="op-alert">
        {{ errorMessage }}
      </p>

      <p v-if="justGenerated && !isPending" role="status" class="op-success">
        <OrderIcon name="check" />
        Pedido confirmado e ficha gerada.
      </p>

      <!-- PFI-19: one editing model. The amount and the payment method are
           typed only in the dialog; the rail keeps what is missing and the
           action that opens it. -->
      <div v-if="isPending && canCommand" class="op-closing-action">
        <p
          v-for="note in blockerNotes"
          :key="note.field"
          role="alert"
          class="op-field-error"
        >
          {{ note.message }}
        </p>

        <!-- PFI-13: the only primary button of the page once every step is
             done; until then the next step is (PFI-16). -->
        <button
          class="op-generate op-generate--inline"
          :class="{ primary: nextStep === null }"
          type="button"
          :aria-disabled="generateBlocked || undefined"
          aria-describedby="closing-readiness"
          @click="requestGenerate($event.currentTarget)"
        >
          <OrderIcon name="ficha" />Gerar pedido
        </button>
        <AppHint
          id="closing-readiness"
          role="status"
          class="op-readiness"
          :tone="
            pendingLabels.length === 0 && !sectionOpenElsewhere
              ? 'success'
              : 'warning'
          "
          :data-ready="
            (pendingLabels.length === 0 && !sectionOpenElsewhere) || undefined
          "
        >
          {{ readiness }}
        </AppHint>
      </div>

      <template v-else>
        <dl class="op-deal">
          <div>
            <dt>Valor final</dt>
            <dd class="op-num">{{ amountLabel(order.finalAmountCents) }}</dd>
          </div>
          <div>
            <dt>Forma de pagamento</dt>
            <dd>{{ paymentConditionLabel(order.paymentCondition) }}</dd>
          </div>
          <div v-if="isStore">
            <dt>Confirmação</dt>
            <dd>{{ storeConfirmationLabel(order) }}</dd>
          </div>
          <div v-else-if="order.confirmedAt">
            <dt>Confirmação</dt>
            <dd>
              Confirmado por {{ order.confirmedBy?.name || 'vendedor' }} ·
              {{ dateTimeBR(order.confirmedAt) }}
            </dd>
          </div>
          <div v-if="order.reopenedAt">
            <dt>Última reabertura</dt>
            <dd>
              Reaberto por {{ order.reopenedBy?.name || 'vendedor' }} ·
              {{ dateTimeBR(order.reopenedAt) }}
            </dd>
          </div>
        </dl>

        <div v-if="!isPending" class="op-ficha-card">
          <span class="op-ficha-thumb" aria-hidden="true">
            <OrderIcon name="ficha" />
          </span>
          <span class="op-ficha-name">
            <strong>Ficha {{ order.number }}</strong>
            <span v-if="isStore">1 página · pedido da loja</span>
            <span v-else>2 páginas · pedido e controle de produção</span>
          </span>
          <!-- LOJ-34: whether the site order already left the notice. -->
          <p
            v-if="isStore"
            class="op-ficha-status"
            :data-tone="fichaPrinted ? 'success' : 'warning'"
          >
            {{
              fichaPrinted ||
              (order.isTest
                ? 'PDF ainda não gerado.'
                : 'PDF ainda não gerado. Ao gerar, o pedido sai do aviso do Dashboard.')
            }}
          </p>
          <button type="button" class="op-save" @click="editing.print">
            Baixar ficha em PDF
          </button>
        </div>

        <p v-if="isStore" class="op-hint">
          Pedido da loja não é reaberto: valor e itens vieram do pagamento.
        </p>

        <div v-if="!isPending && canReopen" class="op-reopen">
          <button
            type="button"
            class="quiet"
            :disabled="busy"
            @click="requestReopen"
          >
            {{ busy ? 'Reabrindo…' : 'Reabrir pedido' }}
          </button>
          <p class="op-hint">
            Reabrir libera a edição. A ficha é gerada de novo na próxima
            confirmação.
          </p>
        </div>
      </template>
    </div>

    <!-- PFI-19: review what is generated, then the amount and the payment
         method; one primary action. -->
    <dialog
      v-if="confirmOpen"
      ref="dialog"
      class="op-dialog op-generate-dialog"
      aria-modal="true"
      aria-labelledby="generate-title"
      aria-describedby="generate-description"
      @cancel.prevent="cancelDialog"
    >
      <h2 id="generate-title">Gerar o pedido {{ order.number }}?</h2>
      <p id="generate-description">
        O pedido é confirmado, a data do pedido passa a ser hoje e o PDF da
        ficha fica disponível.
        {{
          order.olistLocked
            ? 'O conteúdo já conferido no Olist permanece protegido.'
            : 'Para mudar algo depois, reabra o pedido.'
        }}
      </p>
      <dl>
        <div>
          <dt>Cliente</dt>
          <dd>{{ order.ficha?.summary?.cliente || '—' }}</dd>
        </div>
        <div>
          <dt>Itens</dt>
          <dd class="op-num">{{ itemsHeadline }}</dd>
        </div>
        <div>
          <dt>Entrega prometida</dt>
          <dd class="op-num">
            {{ dateBR(order.ficha?.summary?.data_entrega_confirmada) }}
          </dd>
        </div>
        <div>
          <dt>Arte do pedido</dt>
          <dd>{{ artworkHeadline }}</dd>
        </div>
      </dl>

      <form class="op-closing-form" novalidate @submit.prevent="submitGenerate">
        <p
          v-if="dialogMessage"
          ref="dialogAlert"
          role="alert"
          tabindex="-1"
          class="op-alert"
        >
          {{ dialogMessage }}
        </p>

        <div v-if="calculatedPricing" class="op-field">
          <span>Total calculado do pedido</span>
          <output class="op-num">{{
            amountLabel(order.pricing.totalCents)
          }}</output>
          <p class="op-hint">
            Soma dos subtotais revisados por tamanho. Para mudar o total, revise
            os itens antes de gerar.
          </p>
          <p v-if="fieldErrors.finalAmount" class="op-field-error" role="alert">
            {{ fieldErrors.finalAmount }}
          </p>
        </div>
        <div v-else class="op-field">
          <label for="closing-amount">Valor final</label>
          <div class="op-amount">
            <span aria-hidden="true">R$</span>
            <input
              id="closing-amount"
              ref="amountInput"
              v-model="amountText"
              class="op-num"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0,00"
              enterkeyhint="done"
              @blur="settleAmount"
              :aria-invalid="Boolean(fieldErrors.finalAmount) || undefined"
              :aria-describedby="
                fieldErrors.finalAmount
                  ? 'closing-amount-error'
                  : 'closing-amount-hint'
              "
            />
          </div>
          <p
            v-if="fieldErrors.finalAmount"
            id="closing-amount-error"
            role="alert"
            class="op-field-error"
          >
            {{ fieldErrors.finalAmount }}
          </p>
          <p v-else id="closing-amount-hint" class="op-hint">
            Aprovado pelo cliente. O agente nunca informa preço.
          </p>
        </div>

        <fieldset class="op-conditions">
          <legend>Forma de pagamento</legend>
          <div class="op-condition-chips">
            <label
              v-for="option in PAYMENT_CONDITION_OPTIONS"
              :key="option.value"
              class="op-condition"
            >
              <input
                v-model="paymentCondition"
                type="radio"
                name="payment-condition"
                :disabled="order.olistLocked === true"
                :value="option.value"
                :aria-invalid="
                  Boolean(fieldErrors.paymentCondition) || undefined
                "
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
          <p
            v-if="fieldErrors.paymentCondition"
            role="alert"
            class="op-field-error"
          >
            {{ fieldErrors.paymentCondition }}
          </p>
          <p class="op-hint">
            Fica no CRM. A ficha impressa não mostra preço e nenhuma cobrança é
            enviada.
          </p>
        </fieldset>

        <div class="op-dialog-actions">
          <button type="button" :disabled="busy" @click="closeDialog()">
            Voltar
          </button>
          <button
            type="submit"
            class="primary op-generate"
            :aria-disabled="busy || confirmationStale || undefined"
            :disabled="confirmationStale"
            :aria-busy="busy || undefined"
          >
            <OrderIcon name="ficha" />
            {{ busy ? 'Gerando…' : 'Confirmar e gerar ficha' }}
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      v-if="reopenOpen"
      ref="reopenDialog"
      class="op-dialog"
      aria-labelledby="reopen-title"
      aria-describedby="reopen-description"
      @cancel.prevent="closeReopen"
    >
      <h2 id="reopen-title">Reabrir o pedido {{ order.number }}?</h2>
      <p id="reopen-description">
        O pedido volta a Pendente e a ficha deixa de poder ser impressa até ser
        gerada de novo. Se a produção já recebeu a ficha, avise antes. O número,
        o valor e a forma de pagamento continuam registrados, e a reabertura
        fica no histórico com o seu nome.
      </p>
      <div class="op-dialog-actions">
        <button type="button" :disabled="busy" @click="closeReopen">
          Manter confirmado
        </button>
        <button type="button" class="danger" :disabled="busy" @click="reopen">
          {{ busy ? 'Reabrindo…' : `Reabrir pedido ${order.number}` }}
        </button>
      </div>
    </dialog>
  </section>
</template>
