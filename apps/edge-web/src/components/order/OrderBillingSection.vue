<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import {
  billingError,
  billingMoney,
  billingReason,
  billingUrl,
} from '../../lib/order-billing.js';
import { parseBrl } from '../../lib/order-format.js';
import { dateTimeBR } from '../../lib/format.js';
import OrderSheetHead from './OrderSheetHead.vue';

// COB-T04: the seller creates a link; only the verified gateway callback
// records a payment. Card details and installments stay in InfinitePay.
const props = defineProps({ order: { type: Object, required: true } });
const emit = defineEmits(['state', 'changed']);
const editing = inject('orderEditing', null);
const billing = ref(null);
const readAt = ref(Date.now());
const loading = ref(false);
const unavailable = ref(false);
const error = ref('');
const feedback = ref('');
const liveMessage = ref('');
const choosing = ref(true);
const plan = ref('partial');
const percent = ref('30');
const fieldError = ref('');
const busy = ref(false);
const modal = ref('');
const dialog = ref(null);
const sectionRoot = ref(null);
const percentInput = ref(null);
const selectedCharge = ref(null);
const refundAmount = ref('');
const providerReviewed = ref(false);
const reconcileDecision = ref('apply_current');
const dialogError = ref('');
const uncertain = ref(false);
let controller;
let timer;
let returnFocus;
let commandRecord;
let pendingContext;
let initialized = false;

const open = computed(() => editing?.isSectionOpen?.('billing') ?? true);
const visible = computed(
  () =>
    !unavailable.value &&
    (props.order.status === 'confirmado' || billing.value?.managed),
);
const charges = computed(() => billing.value?.charges ?? []);
const active = computed(() =>
  charges.value.find((charge) =>
    ['queued', 'creating', 'waiting', 'unknown', 'review'].includes(
      charge.status,
    ),
  ),
);
const canManage = computed(() => Boolean(billing.value?.canManage));
const canInspectPrivate = computed(
  () =>
    canManage.value &&
    !error.value &&
    !loading.value &&
    Number(billing.value?.orderVersion) === Number(props.order.version),
);
const activeExpired = computed(() => {
  const until = Date.parse(active.value?.validUntil ?? '');
  return Number.isFinite(until) && until <= readAt.value;
});
const canShareActive = computed(
  () =>
    canInspectPrivate.value &&
    props.order.status === 'confirmado' &&
    !uncertain.value &&
    !billing.value?.reviewRequired &&
    active.value?.status === 'waiting' &&
    Number.isFinite(Date.parse(active.value?.validUntil ?? '')) &&
    !activeExpired.value &&
    Boolean(billingUrl(active.value?.checkoutUrl)),
);
const otherEditing = computed(
  () =>
    editing?.editingSection?.value &&
    editing.editingSection.value !== 'billing',
);
const received = computed(() => billing.value?.receivedAmountCents ?? 0);
const balance = computed(() => billing.value?.balanceAmountCents ?? 0);
const total = computed(() => billing.value?.totalAmountCents ?? 0);
const paid = computed(() => total.value > 0 && balance.value === 0);
const statusLabel = computed(() => {
  if (!billing.value) return loading.value ? 'Consultando' : 'Indisponível';
  if (active.value?.status === 'review') return 'Precisa de conferência';
  if (active.value?.status === 'unknown') return 'Resultado a conferir';
  if (active.value?.status === 'waiting' && activeExpired.value)
    return 'Link vencido';
  if (paid.value) return 'Quitado';
  return received.value > 0 ? 'Pago parcialmente' : 'A receber';
});
const selectedPercent = computed(() =>
  plan.value === 'none'
    ? 0
    : plan.value === 'full'
      ? 100
      : Number(percent.value),
);
const nextAmount = computed(() => {
  if (charges.value.length || (!choosing.value && billing.value?.percent === 0))
    return balance.value;
  return Math.round((total.value * selectedPercent.value) / 100);
});
const canIssue = computed(
  () =>
    canManage.value &&
    !uncertain.value &&
    billing.value?.enabled &&
    !active.value &&
    !paid.value &&
    ![
      'BILLING_LEGACY_PAYMENT',
      'BILLING_REVIEW_REQUIRED',
      'BILLING_ORDER_NOT_CONFIRMED',
    ].includes(billing.value?.blockedReason),
);
const conditionLabel = computed(() => {
  const value = billing.value?.percent;
  if (value === 0) return 'Sem entrada · 0%';
  if (value === 100) return 'Pagamento integral · 100%';
  return `${value}% de entrada e ${100 - Number(value)}% depois`;
});
const shareText = computed(() => {
  const charge = selectedCharge.value;
  if (!charge) return '';
  return `Olá! Aqui está o link para pagar ${charge.kind === 'signal' ? 'o sinal' : charge.kind === 'balance' ? 'o saldo' : 'o valor integral'} do pedido ${props.order.number}, no valor de ${billingMoney(charge.amountCents)}. Você pode escolher Pix ou cartão na InfinitePay.\n\n${billingUrl(charge.checkoutUrl)}`;
});

function currentState(ready = true) {
  emit('state', {
    ready,
    managed: Boolean(billing.value?.managed),
    available:
      Boolean(billing.value) &&
      !unavailable.value &&
      (props.order.status === 'confirmado' || Boolean(billing.value?.managed)),
  });
}
function billingSignature(value) {
  return JSON.stringify([
    value?.receivedAmountCents,
    value?.balanceAmountCents,
    value?.reviewRequired,
    value?.enabled,
    (value?.charges ?? []).map((charge) => [charge.id, charge.status]),
  ]);
}
function applyBilling(value) {
  const previous = billing.value;
  const previouslyExpired = activeExpired.value;
  readAt.value = Date.now();
  billing.value = value;
  if (
    previous &&
    !busy.value &&
    (billingSignature(previous) !== billingSignature(value) ||
      previouslyExpired !== activeExpired.value)
  )
    liveMessage.value = `${statusLabel.value}. Recebido: ${billingMoney(value.receivedAmountCents)}. Falta receber: ${billingMoney(value.balanceAmountCents)}.`;
  currentState();
  if (modal.value === 'share' && !canShareActive.value) {
    dialog.value?.close();
    feedback.value =
      'A cobrança mudou ou venceu. Confira o estado atual antes de compartilhar.';
  }
  if (!initialized) {
    const valuePercent = value?.percent;
    plan.value =
      valuePercent === 0 ? 'none' : valuePercent === 100 ? 'full' : 'partial';
    if (valuePercent > 0 && valuePercent < 100)
      percent.value = String(valuePercent);
    choosing.value = !value?.managed;
    initialized = true;
  }
  if (Number(value?.orderVersion) > Number(props.order.version))
    emit('changed');
}
async function load(silent = false) {
  controller?.abort();
  globalThis.clearTimeout(timer);
  const own = new AbortController();
  controller = own;
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.order.id)}/billing`,
      { signal: own.signal },
    );
    if (own.signal.aborted) return;
    unavailable.value = false;
    error.value = '';
    applyBilling(response.data.billing);
  } catch (cause) {
    if (own.signal.aborted) return;
    if (Number(cause?.status) === 404) {
      unavailable.value = true;
      billing.value = null;
      liveMessage.value = '';
      currentState();
    } else {
      error.value =
        'Não foi possível consultar as cobranças. Os valores anteriores foram preservados.';
      currentState(false);
    }
  } finally {
    if (own === controller) {
      loading.value = false;
      if (active.value && !unavailable.value)
        timer = globalThis.setTimeout(
          () => {
            if (globalThis.document?.visibilityState === 'visible')
              void load(true);
            else void scheduleLater();
          },
          active.value.status === 'queued' || active.value.status === 'creating'
            ? 3000
            : 10000,
        );
    }
  }
}
function scheduleLater() {
  timer = globalThis.setTimeout(() => void load(true), 10000);
}
function validatePercent() {
  if (
    !Number.isInteger(selectedPercent.value) ||
    selectedPercent.value < 0 ||
    selectedPercent.value > 100
  )
    return 'Informe um percentual inteiro de 1% a 99%.';
  if (
    plan.value === 'partial' &&
    (selectedPercent.value < 1 || selectedPercent.value > 99)
  )
    return 'Informe um percentual inteiro de 1% a 99%.';
  if (selectedPercent.value > 0 && selectedPercent.value < 100) {
    const signal = Math.round((total.value * selectedPercent.value) / 100);
    if (signal < 100 || total.value - signal < 100)
      return 'O sinal e o saldo precisam ser de pelo menos R$ 1,00. Ajuste a entrada ou escolha 100%.';
  }
  return '';
}
function editCondition() {
  if (otherEditing.value || busy.value || charges.value.length) return;
  choosing.value = true;
  editing?.start?.('billing');
  void nextTick(() => percentInput.value?.focus());
}
function markEditing() {
  if (!otherEditing.value) editing?.start?.('billing');
  fieldError.value = '';
}
function cancelCondition() {
  const value = billing.value?.percent;
  plan.value = value === 0 ? 'none' : value === 100 ? 'full' : 'partial';
  percent.value = String(value > 0 && value < 100 ? value : 30);
  choosing.value = !billing.value?.managed;
  fieldError.value = '';
  editing?.stop?.();
}
async function showDialog(mode, event, charge = null) {
  if (busy.value || otherEditing.value) return;
  if (mode === 'share') {
    readAt.value = Date.now();
    if (!canShareActive.value || charge?.id !== active.value?.id) {
      feedback.value =
        'Confira o estado atual da cobrança antes de compartilhar.';
      return;
    }
  }
  if (uncertain.value && mode !== 'share') {
    await resumePending(event);
    return;
  }
  returnFocus =
    event?.submitter ??
    event?.currentTarget ??
    globalThis.document?.activeElement;
  selectedCharge.value = charge;
  dialogError.value = '';
  providerReviewed.value = false;
  refundAmount.value = '';
  reconcileDecision.value = 'apply_current';
  modal.value = mode;
  await nextTick();
  dialog.value?.showModal();
}
function closeDialog() {
  if (busy.value) return;
  dialog.value?.close();
}
function dialogClosed() {
  modal.value = '';
  dialogError.value = '';
  if (returnFocus?.isConnected) returnFocus.focus();
  else sectionRoot.value?.querySelector('button')?.focus();
}
function versions() {
  return {
    expectedVersion: billing.value?.orderVersion ?? props.order.version,
    expectedBillingVersion: billing.value?.version ?? 0,
  };
}
async function write(path, body) {
  // An uncertain response may already have committed. Freeze the WHOLE
  // intent, including versions, across a later GET/poll and every retry.
  if (!commandRecord) {
    commandRecord = {
      path,
      orderId: props.order.id,
      body: Object.freeze({ ...body }),
      key: commandKey(),
    };
    pendingContext = {
      mode: modal.value || 'plan',
      charge: selectedCharge.value,
      amount: refundAmount.value,
      reviewed: providerReviewed.value,
      decision: reconcileDecision.value,
    };
  }
  const intent = commandRecord;
  let response;
  try {
    response = await request(
      `/api/v1/orders/${encodeURIComponent(intent.orderId)}/billing/${intent.path}`,
      { method: 'POST', body: intent.body, idempotencyKey: intent.key },
    );
  } catch (cause) {
    const status = Number(cause?.status);
    uncertain.value = uncertain.value || !status || status >= 500;
    if (!uncertain.value) {
      commandRecord = null;
      pendingContext = null;
    }
    throw cause;
  }
  commandRecord = null;
  pendingContext = null;
  uncertain.value = false;
  if (response.data?.billing) applyBilling(response.data.billing);
  else await load(true);
  choosing.value = false;
  editing?.stop?.();
  emit('changed');
  return response;
}
async function resumePending(event) {
  if (!commandRecord || !pendingContext || busy.value) return;
  if (pendingContext.mode === 'plan') {
    busy.value = true;
    try {
      await write(commandRecord.path, commandRecord.body);
      feedback.value =
        'Condição sem entrada conferida. Nenhum link foi gerado.';
      error.value = '';
    } catch (cause) {
      error.value = billingError(cause);
    } finally {
      busy.value = false;
    }
    return;
  }
  returnFocus = event?.currentTarget ?? globalThis.document?.activeElement;
  selectedCharge.value = pendingContext.charge;
  refundAmount.value = pendingContext.amount;
  providerReviewed.value = pendingContext.reviewed;
  reconcileDecision.value = pendingContext.decision;
  modal.value = pendingContext.mode;
  dialogError.value =
    'O resultado anterior ainda precisa ser conferido. A próxima tentativa mantém exatamente o mesmo registro.';
  await nextTick();
  dialog.value?.showModal();
}
async function prepare(event) {
  if (busy.value || !canIssue.value || otherEditing.value) return;
  fieldError.value = validatePercent();
  if (fieldError.value) {
    await nextTick();
    percentInput.value?.focus();
    return;
  }
  if (selectedPercent.value === 0 && choosing.value) {
    busy.value = true;
    try {
      await write('plan', { ...versions(), percent: 0 });
      feedback.value = 'Condição sem entrada salva. Nenhum link foi gerado.';
    } catch (cause) {
      error.value = billingError(cause);
    } finally {
      busy.value = false;
    }
    return;
  }
  await showDialog('issue', event);
}
async function submitDialog() {
  if (busy.value) return;
  dialogError.value = '';
  let path = 'charges';
  let body = {
    ...versions(),
    percent: choosing.value
      ? selectedPercent.value
      : (billing.value?.percent ?? selectedPercent.value),
  };
  if (uncertain.value && commandRecord) {
    path = commandRecord.path;
    body = commandRecord.body;
  } else if (modal.value === 'refund') {
    const amount = parseBrl(refundAmount.value);
    if (
      !providerReviewed.value ||
      !amount ||
      amount > selectedCharge.value.refundableAmountCents
    ) {
      dialogError.value =
        'Informe o valor já devolvido e confirme a conferência na InfinitePay.';
      return;
    }
    path = `charges/${encodeURIComponent(selectedCharge.value.id)}/refund`;
    body = { ...versions(), amountCents: amount };
  } else if (modal.value === 'reconcile') {
    if (!providerReviewed.value) {
      dialogError.value =
        'Confira a cobrança na InfinitePay e marque a confirmação.';
      return;
    }
    path = 'reconcile';
    body = {
      ...versions(),
      decision: reconcileDecision.value,
      confirmedProviderReview: true,
    };
  }
  busy.value = true;
  try {
    await write(path, body);
    feedback.value =
      modal.value === 'issue'
        ? 'Solicitação de cobrança registrada.'
        : 'Conferência registrada no histórico do pedido.';
    busy.value = false;
    closeDialog();
    await load(true);
  } catch (cause) {
    dialogError.value = billingError(cause);
    if (uncertain.value)
      dialogError.value =
        'Não foi possível confirmar a resposta. Os valores desta operação ficam preservados; confira o resultado antes de iniciar outro registro.';
  } finally {
    busy.value = false;
  }
}
async function copyLink(charge) {
  readAt.value = Date.now();
  if (!canShareActive.value || charge?.id !== active.value?.id) {
    feedback.value =
      'Confira o estado atual da cobrança antes de compartilhar.';
    return;
  }
  const link = billingUrl(charge.checkoutUrl);
  if (!link) return;
  try {
    await globalThis.navigator.clipboard.writeText(link);
    feedback.value = 'Link copiado. Compartilhe manualmente com o cliente.';
  } catch {
    feedback.value = 'Selecione o link e copie pelo menu do aparelho.';
  }
}
function checkActiveLink(event) {
  readAt.value = Date.now();
  if (canShareActive.value) return;
  event.preventDefault();
  feedback.value = 'Confira o estado atual da cobrança antes de compartilhar.';
}
function chargeName(charge) {
  return charge.kind === 'signal'
    ? 'Sinal'
    : charge.kind === 'balance'
      ? 'Saldo'
      : 'Pagamento integral';
}
function chargeStatus(charge) {
  return (
    {
      queued: 'Aguardando emissão',
      creating: 'Gerando link',
      waiting: 'Aguardando pagamento',
      unknown: 'Resultado a conferir',
      paid: 'Pagamento confirmado',
      review: 'Precisa de conferência',
      closed: 'Encerrada sem pagamento',
    }[charge.status] ?? 'Precisa de conferência'
  );
}
watch(
  () => [props.order.id, props.order.version],
  (next, previous) => {
    if (!previous || next[0] !== previous[0]) {
      billing.value = null;
      unavailable.value = false;
      initialized = false;
      currentState(false);
    }
    void load(Boolean(billing.value));
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  controller?.abort();
  globalThis.clearTimeout(timer);
  dialog.value?.close();
});
</script>

<template>
  <section
    v-if="visible"
    ref="sectionRoot"
    class="op-sheet billing-section"
    aria-labelledby="order-billing-title"
  >
    <OrderSheetHead
      title-id="order-billing-title"
      title="Cobranças"
      :state="statusLabel"
      :tone="paid ? 'ok' : 'neutral'"
      section="billing"
      body-id="order-billing-body"
      :can-edit="canManage && !charges.length && !choosing && billing?.enabled"
      edit-label="Alterar condição"
      :blocked="Boolean(otherEditing)"
      @edit="editCondition"
    />
    <p
      class="sr-only billing-live"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ liveMessage }}
    </p>
    <div id="order-billing-body" class="op-sheet-body" :hidden="!open">
      <p v-if="loading && !billing" role="status">Consultando cobranças…</p>
      <div v-if="error" class="op-alert" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="load()">Atualizar cobranças</button>
      </div>
      <template v-if="billing">
        <div v-if="uncertain" class="op-alert" role="alert">
          <p>
            Há um registro com resultado incerto. Confira esta operação antes de
            iniciar outra.
          </p>
          <button type="button" :disabled="busy" @click="resumePending">
            Conferir registro pendente
          </button>
        </div>
        <dl class="billing-totals" aria-label="Valores do pedido">
          <div>
            <dt>Total do pedido</dt>
            <dd>{{ billingMoney(total) }}</dd>
          </div>
          <div>
            <dt>Recebido</dt>
            <dd>{{ billingMoney(received) }}</dd>
          </div>
          <div>
            <dt>Falta receber</dt>
            <dd>{{ billingMoney(balance) }}</dd>
          </div>
        </dl>
        <p v-if="!billing.enabled" class="op-hint">
          {{ billingReason('BILLING_DISABLED') }}
        </p>
        <p v-else-if="!canManage" class="op-hint">
          {{ billingReason('FORBIDDEN') }}
        </p>
        <div
          v-if="active"
          class="billing-state"
          :data-attention="
            ['unknown', 'review'].includes(active.status) || undefined
          "
        >
          <strong>{{
            activeExpired && active.status === 'waiting'
              ? 'Link vencido'
              : chargeStatus(active)
          }}</strong>
          <p v-if="active.status === 'unknown'">
            Precisamos conferir se o link foi criado. Não gere outra cobrança
            para substituir esta emissão.
          </p>
          <p v-else-if="active.status === 'review'">
            O pagamento ou o acordo do pedido mudou. Confira a cobrança antes de
            aplicar o recebimento ao pedido atual.
          </p>
          <p v-else-if="['queued', 'creating'].includes(active.status)">
            A cobrança está reservada. Aguarde o link; repetir a emissão não
            cria outra cobrança.
          </p>
          <p v-else-if="activeExpired">
            A validade deste link terminou. Não o envie ao cliente. Confira a
            cobrança antes de encerrar esta emissão ou gerar outra.
          </p>
          <p v-else>
            O recebido só muda depois da confirmação do pagamento pela
            InfinitePay.
          </p>
        </div>
        <div v-else-if="paid" class="billing-state" data-success="true">
          <strong>Pedido integralmente pago</strong>
          <p>
            Não há saldo a cobrar. O status comercial do pedido continua o
            mesmo.
          </p>
        </div>
        <p
          v-else-if="
            billing.blockedReason &&
            !['BILLING_ACTIVE_CHARGE', 'BILLING_ALREADY_PAID'].includes(
              billing.blockedReason,
            )
          "
          class="op-hint"
        >
          {{ billingReason(billing.blockedReason) }}
        </p>
        <form
          v-if="canIssue && choosing"
          class="billing-plan"
          novalidate
          @submit.prevent="prepare"
        >
          <fieldset :disabled="busy || Boolean(otherEditing)">
            <legend>Entrada combinada com o cliente</legend>
            <div class="billing-choices">
              <label
                v-for="choice in [
                  { value: 'none', title: '0%', label: 'Sem entrada' },
                  { value: 'partial', title: 'X%', label: 'Entrada parcial' },
                  { value: 'full', title: '100%', label: 'Pagamento integral' },
                ]"
                :key="choice.value"
              >
                <input
                  v-model="plan"
                  type="radio"
                  name="billing-plan"
                  :value="choice.value"
                  @change="markEditing"
                />
                <span
                  ><strong>{{ choice.title }}</strong
                  ><small>{{ choice.label }}</small></span
                >
              </label>
            </div>
            <div v-if="plan === 'partial'" class="op-field billing-percent">
              <label for="billing-percent">Percentual de entrada</label>
              <div>
                <input
                  id="billing-percent"
                  ref="percentInput"
                  v-model="percent"
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  inputmode="numeric"
                  :aria-invalid="Boolean(fieldError) || undefined"
                  aria-describedby="billing-percent-hint billing-percent-error"
                  @input="markEditing"
                /><span>%</span>
              </div>
              <p id="billing-percent-hint" class="op-hint">
                De 1% a 99%. O restante será cobrado depois.
              </p>
            </div>
          </fieldset>
          <p
            v-if="fieldError"
            id="billing-percent-error"
            role="alert"
            class="op-field-error"
          >
            {{ fieldError }}
          </p>
          <dl class="billing-preview">
            <div>
              <dt>
                {{
                  plan === 'none'
                    ? 'Entrada agora'
                    : plan === 'partial'
                      ? 'Cobrar sinal agora'
                      : 'Cobrar agora'
                }}
              </dt>
              <dd>{{ billingMoney(plan === 'none' ? 0 : nextAmount) }}</dd>
            </div>
            <div>
              <dt>
                {{
                  plan === 'none'
                    ? 'Cobrar depois'
                    : 'Saldo após este pagamento'
                }}
              </dt>
              <dd>
                {{ billingMoney(plan === 'none' ? total : total - nextAmount) }}
              </dd>
            </div>
          </dl>
          <p class="op-hint">
            Pix ou cartão, com parcelamento na InfinitePay. O cliente escolhe no
            pagamento.
          </p>
          <div class="billing-actions">
            <p v-if="otherEditing" class="op-hint">
              Salve ou cancele a edição aberta.
            </p>
            <button
              v-if="editing?.editingSection?.value === 'billing'"
              type="button"
              :disabled="busy"
              @click="cancelCondition"
            >
              Cancelar edição
            </button>
            <button
              type="submit"
              class="primary"
              :aria-disabled="busy || Boolean(otherEditing) || undefined"
              :aria-busy="busy || undefined"
            >
              {{
                busy
                  ? 'Salvando…'
                  : plan === 'none'
                    ? 'Salvar sem entrada'
                    : 'Revisar cobrança'
              }}
            </button>
          </div>
        </form>
        <template v-else-if="canIssue">
          <p class="billing-condition">
            <strong>{{ conditionLabel }}</strong>
          </p>
          <p v-if="billing.percent === 0 && !charges.length" class="op-hint">
            Nenhum link de entrada foi gerado. Você decide quando cobrar o valor
            integral.
          </p>
          <div class="billing-actions">
            <button
              type="button"
              class="primary"
              :aria-disabled="Boolean(otherEditing) || undefined"
              @click="prepare"
            >
              {{
                received > 0
                  ? `Cobrar saldo de ${billingMoney(balance)}`
                  : `Cobrar ${billingMoney(balance)}`
              }}
            </button>
          </div>
        </template>
        <div v-if="canShareActive" class="billing-link">
          <p>
            <strong
              >{{ chargeName(active) }} de
              {{ billingMoney(active.amountCents) }}</strong
            >
          </p>
          <p class="op-hint">Válido até {{ dateTimeBR(active.validUntil) }}</p>
          <label for="billing-checkout-link">Link da cobrança</label>
          <input
            id="billing-checkout-link"
            readonly
            :value="billingUrl(active.checkoutUrl)"
            @focus="$event.target.select()"
          />
          <div class="billing-actions">
            <button type="button" @click="copyLink(active)">Copiar link</button
            ><a
              class="button-link billing-open-link"
              :href="billingUrl(active.checkoutUrl)"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              @click="checkActiveLink"
              >Abrir cobrança</a
            ><button
              type="button"
              class="quiet"
              @click="showDialog('share', $event, active)"
            >
              Preparar mensagem
            </button>
          </div>
        </div>
        <section
          v-if="charges.length"
          class="billing-history"
          aria-label="Histórico de cobranças"
        >
          <h3>Histórico de cobranças</h3>
          <ol>
            <li v-for="charge in charges" :key="charge.id">
              <div>
                <strong>{{ chargeName(charge) }}</strong>
                <p>{{ chargeStatus(charge) }}</p>
                <small v-if="charge.paidAt"
                  >{{ dateTimeBR(charge.paidAt) }} ·
                  {{
                    charge.method === 'credit_card'
                      ? `Cartão em ${charge.installments}x`
                      : 'Pix'
                  }}</small
                ><small v-if="charge.refundedAmountCents"
                  >Devolução conciliada:
                  {{ billingMoney(charge.refundedAmountCents) }}</small
                ><a
                  v-if="canInspectPrivate && billingUrl(charge.receiptUrl)"
                  :href="billingUrl(charge.receiptUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerpolicy="no-referrer"
                  >Comprovante InfinitePay</a
                >
              </div>
              <strong class="op-num">{{
                billingMoney(charge.amountCents)
              }}</strong>
            </li>
          </ol>
        </section>
        <details
          v-if="canManage && (billing.managed || charges.length)"
          class="billing-review"
        >
          <summary>Conferência e devoluções</summary>
          <p class="op-hint">
            Use após conferir a cobrança na InfinitePay. Estas ações só
            conciliam o CRM; não cancelam links nem devolvem dinheiro.
          </p>
          <a
            v-if="
              canInspectPrivate &&
              !canShareActive &&
              billingUrl(active?.checkoutUrl)
            "
            class="button-link billing-open-link"
            :href="billingUrl(active.checkoutUrl)"
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
            >Abrir cobrança anterior para conferência</a
          >
          <button
            v-if="
              ['unknown', 'review'].includes(active?.status) ||
              activeExpired ||
              billing.blockedReason === 'BILLING_REVIEW_REQUIRED'
            "
            type="button"
            @click="showDialog('reconcile', $event)"
          >
            Conferir cobrança</button
          ><template v-for="charge in charges" :key="`refund-${charge.id}`"
            ><button
              v-if="
                ['paid', 'review'].includes(charge.status) &&
                charge.refundableAmountCents > 0
              "
              type="button"
              @click="showDialog('refund', $event, charge)"
            >
              Registrar devolução do
              {{ chargeName(charge).toLocaleLowerCase('pt-BR') }}
            </button></template
          >
        </details>
        <div class="billing-refresh">
          <button
            v-if="!error"
            type="button"
            class="quiet"
            :aria-busy="loading || undefined"
            @click="load()"
          >
            Atualizar cobranças
          </button>
        </div>
      </template>
      <p v-if="feedback" role="status" class="op-hint">{{ feedback }}</p>
    </div>
    <dialog
      v-if="modal"
      ref="dialog"
      class="op-dialog"
      aria-labelledby="billing-dialog-title"
      @close="dialogClosed"
      @cancel="busy && $event.preventDefault()"
    >
      <h2 id="billing-dialog-title">
        {{
          modal === 'share'
            ? 'Mensagem para o cliente'
            : modal === 'refund'
              ? 'Registrar devolução já realizada'
              : modal === 'reconcile'
                ? 'Conferir cobrança'
                : received > 0
                  ? 'Gerar cobrança do saldo'
                  : 'Gerar link de pagamento'
        }}
      </h2>
      <p v-if="dialogError" role="alert" class="op-alert">{{ dialogError }}</p>
      <template v-if="modal === 'share'"
        ><label for="billing-share-message"
          >Texto para compartilhar manualmente</label
        ><textarea
          id="billing-share-message"
          :value="shareText"
          readonly
          @focus="$event.target.select()"
        ></textarea>
        <p class="op-hint">
          Copie o texto e envie pela conversa. Nenhuma mensagem é enviada
          automaticamente.
        </p></template
      >
      <template v-else-if="modal === 'issue'"
        ><dl class="billing-preview">
          <div>
            <dt>Pedido</dt>
            <dd>{{ order.number }}</dd>
          </div>
          <div>
            <dt>Valor da cobrança</dt>
            <dd>{{ billingMoney(nextAmount) }}</dd>
          </div>
          <div>
            <dt>Formas de pagamento</dt>
            <dd>Pix ou cartão</dd>
          </div>
          <div>
            <dt>Saldo após o pagamento</dt>
            <dd>{{ billingMoney(balance - nextAmount) }}</dd>
          </div>
        </dl>
        <p class="op-hint">
          Gerar o link não envia uma mensagem nem confirma o pagamento.
        </p></template
      >
      <template v-else-if="modal === 'refund'"
        ><p>
          Registre somente um valor que já foi devolvido e conferido na
          InfinitePay.
        </p>
        <div class="op-field">
          <label for="billing-refund-amount">Valor já devolvido</label
          ><input
            id="billing-refund-amount"
            v-model="refundAmount"
            :disabled="busy || uncertain"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0,00"
          />
        </div>
        <label class="op-check"
          ><input
            v-model="providerReviewed"
            type="checkbox"
            :disabled="busy || uncertain"
          /><span
            >Conferi a devolução na InfinitePay e quero conciliá-la no
            CRM.</span
          ></label
        ></template
      >
      <template v-else-if="modal === 'reconcile'"
        ><fieldset class="billing-reconcile" :disabled="busy || uncertain">
          <legend>Resultado da conferência</legend>
          <label
            ><input
              v-model="reconcileDecision"
              type="radio"
              value="apply_current"
              name="billing-reconcile"
            /><span
              >Aplicar os pagamentos confirmados ao acordo atual do pedido</span
            ></label
          ><label
            ><input
              v-model="reconcileDecision"
              type="radio"
              value="close_unpaid"
              name="billing-reconcile"
            /><span
              >Encerrar emissão sem pagamento, após a validade do link</span
            ></label
          >
        </fieldset>
        <label class="op-check"
          ><input
            v-model="providerReviewed"
            type="checkbox"
            :disabled="busy || uncertain"
          /><span
            >Conferi os registros na InfinitePay e confirmo este
            resultado.</span
          ></label
        >
        <p class="op-hint">
          Encerrar no CRM não cancela o link na InfinitePay. A API impede
          encerrar antes da validade.
        </p></template
      >
      <div class="op-dialog-actions">
        <button type="button" :disabled="busy" @click="closeDialog">
          {{ modal === 'share' ? 'Voltar ao pedido' : 'Voltar' }}</button
        ><button
          v-if="modal !== 'share'"
          type="button"
          class="primary"
          :aria-disabled="busy || undefined"
          :aria-busy="busy || undefined"
          @click="submitDialog"
        >
          {{
            busy
              ? 'Registrando…'
              : modal === 'issue'
                ? 'Gerar link de pagamento'
                : 'Registrar conferência'
          }}
        </button>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.billing-totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
  margin-block: 0 var(--space-5);
  padding-block-end: var(--space-5);
  border-block-end: 1px solid var(--color-border);
}
.billing-totals dt {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.billing-totals dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.billing-plan fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.billing-plan legend {
  font-weight: 600;
  margin-block-end: var(--space-3);
}
.billing-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}
.billing-choices label {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  min-height: var(--target-min);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
}
.billing-choices label:has(:checked) {
  background: var(--color-selected);
  border-color: var(--color-selection-border);
}
.billing-choices input {
  width: var(--space-4);
  height: var(--space-4);
  min-height: 0;
  flex-shrink: 0;
  accent-color: var(--color-focus);
}
.billing-choices strong,
.billing-choices small {
  display: block;
}
.billing-choices small {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.billing-percent {
  margin-block-start: var(--space-4);
}
.billing-percent > div {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.billing-percent input {
  width: 5rem;
}
.billing-preview {
  display: grid;
  gap: var(--space-2);
  padding-block: var(--space-4);
  margin-block: var(--space-4);
  border-block: 1px solid var(--color-border);
}
.billing-preview > div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
}
.billing-preview dt {
  color: var(--color-text-muted);
}
.billing-preview dd {
  margin: 0;
  font-weight: 600;
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.billing-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
  margin-block-start: var(--space-4);
}
.billing-state {
  padding: var(--space-4);
  margin-block: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--status-info-surface);
  color: var(--status-info-text);
}
.billing-state[data-attention] {
  color: var(--status-warning-text);
  background: var(--status-warning-surface);
}
.billing-state[data-success] {
  color: var(--status-success-text);
  background: var(--status-success-surface);
}
.billing-state p {
  margin-block: var(--space-1) 0;
}
.billing-link {
  margin-block: var(--space-5);
}
.billing-link > label {
  display: block;
  margin-block-end: var(--space-2);
  font-weight: 500;
}
.billing-link input {
  width: 100%;
}
.billing-open-link {
  min-block-size: var(--target-min);
}
.billing-condition {
  margin-block-start: var(--space-4);
}
.billing-history {
  margin-block-start: var(--space-5);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border);
}
.billing-history h3 {
  font-size: var(--text-base);
}
.billing-history ol {
  list-style: none;
  padding: 0;
  margin: 0;
}
.billing-history li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding-block: var(--space-3);
  border-block-end: 1px solid var(--color-border-subtle);
}
.billing-history li > strong {
  white-space: nowrap;
}
.billing-history p {
  margin: 0;
}
.billing-history small,
.billing-history a {
  display: block;
  font-size: var(--text-xs);
}
.billing-history small {
  color: var(--color-text-muted);
}
.billing-history a {
  display: flex;
  align-items: center;
  min-block-size: var(--target-min);
  margin-block-start: var(--space-2);
}
.billing-review {
  margin-block-start: var(--space-4);
}
.billing-review summary {
  min-height: var(--target-min);
  display: list-item;
  align-content: center;
}
.billing-review button {
  margin: var(--space-2) var(--space-2) 0 0;
}
.billing-refresh {
  display: flex;
  justify-content: flex-end;
  margin-block-start: var(--space-3);
}
.billing-reconcile {
  border: 0;
  margin: var(--space-4) 0;
  padding: 0;
}
.billing-reconcile legend {
  font-weight: 600;
}
.billing-reconcile label {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  min-height: var(--target-min);
  margin-block-start: var(--space-2);
  margin-block-end: 0;
}
.billing-reconcile input {
  width: var(--space-4);
  min-height: 0;
  flex-shrink: 0;
  margin-block-start: var(--space-1);
}
.op-dialog textarea {
  min-height: 12rem;
  width: 100%;
}
@media (max-width: 520px) {
  .billing-totals {
    gap: var(--space-2);
  }
  .billing-totals dd {
    font-size: var(--text-base);
  }
  .billing-totals dt {
    min-block-size: calc(var(--text-xs) * 3);
  }
  .billing-choices label {
    flex-direction: column;
    align-items: flex-start;
    padding: var(--space-2);
  }
  .billing-actions button.primary {
    width: 100%;
  }
}
@media (max-width: 360px) {
  .billing-totals {
    grid-template-columns: 1fr;
  }
  .billing-totals > div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .billing-totals dt {
    min-block-size: 0;
  }
  .billing-choices {
    grid-template-columns: 1fr;
  }
  .billing-choices label,
  .billing-choices label > span {
    flex-direction: row;
    align-items: center;
    display: flex;
    gap: var(--space-3);
  }
  .billing-choices strong {
    min-width: var(--space-12);
  }
}
</style>
