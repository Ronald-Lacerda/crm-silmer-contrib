<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import {
  billingError,
  billingMoney,
  billingUrl,
} from '../../lib/order-billing.js';
import { parseBrl } from '../../lib/order-format.js';
import { dateTimeBR } from '../../lib/format.js';
import { openDialog } from '../../lib/ui.js';

const props = defineProps({
  order: { type: Object, required: true },
  conversationId: { type: String, default: '' },
  conversationVersion: { type: Number, default: 0 },
  destinationLabel: { type: String, default: '' },
  initialBilling: { type: Object, default: null },
  compact: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['changed']);
const uid = useId();
const billing = ref(props.initialBilling);
const history = ref([]);
const nextCursor = ref(null);
const today = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
}).format(new Date());
const conversation = ref(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const noticeElement = ref(null);
const mode = ref('');
const stage = ref('choose');
const action = ref('issue');
const percent = ref('30');
const amount = ref('');
const chargeId = ref('');
const intentId = ref('');
const selectedIntent = ref(null);
const retryLoading = ref(false);
const providerReviewed = ref(false);
const agreed = ref(false);
const receivedOn = ref('');
const method = ref('cash');
const note = ref('');
const reason = ref('');
const invoiceSlug = ref('');
const transactionNsu = ref('');
const dialog = ref(null);
const dialogError = ref('');
const dialogStatus = ref(null);
const pending = ref(null);
const selectedReceipt = ref(null);
const reviewedRecord = ref(null);
let controller;
let timer;
let generation = 0;
let disposed = false;

const base = computed(
  () => `/api/v1/orders/${encodeURIComponent(props.order.id)}/billing`,
);
const charges = computed(() => billing.value?.charges ?? []);
const payments = computed(() => billing.value?.payments ?? []);
const checks = computed(() => billing.value?.paymentChecks ?? []);
const balance = computed(() => billing.value?.balanceAmountCents ?? 0);
const received = computed(() => billing.value?.receivedAmountCents ?? 0);
const targetConversationId = computed(
  () => props.conversationId || props.order.conversationId || '',
);
const targetVersion = computed(() =>
  Number(conversation.value?.version ?? props.conversationVersion),
);
const destination = computed(
  () =>
    conversation.value?.conversation?.contact?.label ||
    conversation.value?.contact?.label ||
    props.destinationLabel ||
    'Conversa vinculada ao pedido',
);
const mutable = computed(
  () =>
    billing.value?.canManage &&
    !props.disabled &&
    !loading.value &&
    !error.value &&
    !pending.value,
);
const privateReadable = computed(() =>
  Boolean(
    billing.value?.canManage &&
    !props.disabled &&
    !loading.value &&
    !error.value,
  ),
);
const canSend = computed(
  () =>
    mutable.value &&
    billing.value?.enabled &&
    billing.value?.chatSendEnabled &&
    targetConversationId.value &&
    targetVersion.value > 0 &&
    props.order.status === 'confirmado',
);
const selectedCharge = computed(() =>
  charges.value.find((item) => item.id === chargeId.value),
);
const activeCharge = computed(() =>
  charges.value.some((item) =>
    ['queued', 'creating', 'waiting', 'unknown', 'review'].includes(
      item.status,
    ),
  ),
);
const corrected = computed(() =>
  charges.value.filter(
    (item) =>
      item.status === 'closed' && Date.parse(item.validUntil) <= Date.now(),
  ),
);
const existing = computed(() =>
  charges.value.filter(
    (item) =>
      item.status === 'waiting' &&
      item.amountCents <= balance.value &&
      balance.value > 0 &&
      Date.parse(item.validUntil) > Date.now() &&
      billingUrl(item.checkoutUrl),
  ),
);
const failedIntents = computed(() =>
  history.value
    .filter((item) => item.intentId && item.status === 'failed')
    .filter(
      (item, index, all) =>
        all.findIndex((candidate) => candidate.intentId === item.intentId) ===
        index,
    ),
);
const sendAmount = computed(() =>
  ['send_existing', 'retry'].includes(action.value)
    ? action.value === 'retry'
      ? selectedIntent.value?.amountCents
      : selectedCharge.value?.amountCents
    : action.value === 'balance'
      ? balance.value
      : action.value === 'correct'
        ? parseBrl(amount.value)
        : Math.round(
            ((billing.value?.totalAmountCents ?? 0) * Number(percent.value)) /
              100,
          ),
);
const labels = {
  waiting_link: 'Aguardando o link',
  queued: 'Na fila',
  creating: 'Gerando link',
  waiting: 'Aguardando pagamento',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregue',
  failed: 'Falhou',
  unknown: 'Resultado a conferir',
  blocked: 'Envio bloqueado',
  paid: 'Pagamento confirmado',
  review: 'Precisa de conferência',
  closed: 'Encerrada',
  not_paid: 'Pagamento ainda não confirmado',
};
const methods = {
  cash: 'Dinheiro',
  pix: 'Pix',
  pix_external: 'Pix fora da InfinitePay',
  bank_transfer: 'Transferência bancária',
  credit_card: 'Cartão',
  card_external: 'Cartão em outra maquininha',
};
const eventLabels = {
  charge: 'Cobrança criada',
  receipt: 'Pagamento registrado',
  intent: 'Envio da cobrança',
  correction: 'Correção da cobrança',
  refund: 'Devolução registrada',
  external_receipt: 'Recebimento externo',
  external_reversal: 'Estorno do registro externo',
  payment_check: 'Conferência de pagamento',
};
const title = computed(() =>
  mode.value === 'send'
    ? 'Gerar e enviar cobrança'
    : mode.value === 'external'
      ? 'Registrar recebimento externo'
      : mode.value === 'reverse'
        ? 'Estornar registro de recebimento'
        : mode.value === 'close-charge'
          ? 'Encerrar cobrança vencida'
          : 'Conferir pagamento na InfinitePay',
);

function versions() {
  return {
    expectedVersion: billing.value.orderVersion,
    expectedBillingVersion: billing.value.version,
  };
}
async function load(append = false) {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  const target = props.order.id;
  loading.value = true;
  try {
    const [summary, events] = await Promise.all([
      request(base.value, { signal: own.signal }),
      request(
        `${base.value}/history?limit=20${append && nextCursor.value ? `&cursor=${encodeURIComponent(nextCursor.value)}` : ''}`,
        { signal: own.signal },
      ),
    ]);
    if (own.signal.aborted || props.order.id !== target) return;
    billing.value = summary.data.billing;
    history.value = append
      ? [
          ...new Map(
            [...history.value, ...(events.data.items ?? [])].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ]
      : (events.data.items ?? []);
    nextCursor.value = events.data.nextCursor ?? null;
    error.value = '';
  } catch (cause) {
    if (!own.signal.aborted) {
      error.value = billingError(cause);
      if ([401, 403, 404].includes(Number(cause?.status))) {
        billing.value = null;
        history.value = [];
      }
    }
  } finally {
    if (controller === own) loading.value = false;
  }
}
async function refreshConversation() {
  conversation.value = null;
  if (!targetConversationId.value) return;
  const target = targetConversationId.value;
  const ownGeneration = generation;
  const response = await request(
    `/api/v1/inbox/conversations/${encodeURIComponent(target)}`,
  );
  if (ownGeneration === generation && target === targetConversationId.value)
    conversation.value = response.data.conversation;
}
async function show(nextMode, event, item = null) {
  if (busy.value || props.disabled || pending.value) return;
  const trigger = event.currentTarget;
  const ownGeneration = generation;
  mode.value = nextMode;
  reviewedRecord.value = null;
  stage.value = 'choose';
  dialogError.value = '';
  notice.value = '';
  providerReviewed.value = false;
  agreed.value = false;
  selectedReceipt.value = item;
  reason.value = '';
  note.value = '';
  amount.value = '';
  invoiceSlug.value = '';
  transactionNsu.value = '';
  receivedOn.value = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());
  if (nextMode === 'send') {
    try {
      await refreshConversation();
    } catch {
      dialogError.value =
        'Não foi possível conferir a conversa. Atualize os dados antes de enviar.';
    }
    action.value =
      received.value > 0
        ? 'balance'
        : existing.value.length
          ? 'send_existing'
          : 'issue';
    percent.value = String(
      billing.value?.percent > 0 ? billing.value.percent : 100,
    );
    chargeId.value = existing.value[0]?.id ?? corrected.value[0]?.id ?? '';
  }
  if (nextMode === 'check')
    chargeId.value = item?.id ?? charges.value[0]?.id ?? '';
  await nextTick();
  if (ownGeneration === generation && trigger?.isConnected)
    openDialog(dialog.value, trigger);
}
async function selectRetry() {
  selectedIntent.value = null;
  if (!intentId.value) return;
  retryLoading.value = true;
  try {
    const response = await request(
      `${base.value}/send-intents/${encodeURIComponent(intentId.value)}`,
    );
    selectedIntent.value = response.data;
  } catch (cause) {
    dialogError.value = billingError(cause);
  } finally {
    retryLoading.value = false;
  }
}
function review() {
  dialogError.value = '';
  if (mode.value === 'send') {
    if (!canSend.value)
      dialogError.value =
        'O envio integrado não está disponível para este pedido e conversa.';
    else if (['issue', 'balance'].includes(action.value) && activeCharge.value)
      dialogError.value =
        'Há uma cobrança em andamento ou que precisa de conferência. Não gere outro link.';
    else if (action.value === 'issue' && received.value > 0)
      dialogError.value =
        'Já há recebimento confirmado. Revise a cobrança somente do saldo.';
    else if (action.value === 'balance' && received.value <= 0)
      dialogError.value =
        'A cobrança do saldo exige recebimento parcial confirmado.';
    else if (
      action.value === 'issue' &&
      (!Number.isInteger(Number(percent.value)) ||
        Number(percent.value) < 1 ||
        Number(percent.value) > 100)
    )
      dialogError.value = 'Informe um percentual inteiro de 1% a 100%.';
    else if (
      ['send_existing', 'correct'].includes(action.value) &&
      !selectedCharge.value
    )
      dialogError.value = 'Escolha a cobrança.';
    else if (
      action.value === 'correct' &&
      (!agreed.value || !providerReviewed.value)
    )
      dialogError.value =
        'Confirme o novo acordo e a conferência da cobrança anterior.';
    else if (
      action.value === 'retry' &&
      selectedIntent.value?.canRetry !== true
    )
      dialogError.value =
        'Esta tentativa não tem confirmação de falha anterior ao envio. Não reenvie sem conferência.';
    else if (
      !Number.isSafeInteger(sendAmount.value) ||
      sendAmount.value < 100 ||
      sendAmount.value > balance.value
    )
      dialogError.value =
        'Confira o valor da cobrança e o saldo disponível. A cobrança mínima é R$ 1,00.';
  } else if (mode.value === 'external') {
    if (
      !parseBrl(amount.value) ||
      parseBrl(amount.value) > balance.value ||
      !receivedOn.value ||
      receivedOn.value > today
    )
      dialogError.value =
        'Informe o valor recebido, limitado ao saldo, e a data do recebimento.';
  } else if (mode.value === 'reverse' && !reason.value.trim())
    dialogError.value = 'Informe o motivo do estorno do registro.';
  else if (mode.value === 'close-charge' && !providerReviewed.value)
    dialogError.value =
      'Confira na InfinitePay a ausência de pagamento e confirme a revisão.';
  else if (
    mode.value === 'check' &&
    (!chargeId.value ||
      !invoiceSlug.value.trim() ||
      !transactionNsu.value.trim())
  )
    dialogError.value =
      'Informe a cobrança e os identificadores do pagamento obtidos no comprovante ou painel da InfinitePay.';
  if (!dialogError.value) {
    reviewedRecord.value = {
      ...createRecord(),
      reviewAmountCents:
        mode.value === 'external'
          ? parseBrl(amount.value)
          : mode.value === 'reverse'
            ? selectedReceipt.value?.amountCents
            : sendAmount.value,
      destination: destination.value,
    };
    stage.value = 'review';
  }
}
function createRecord() {
  const v = versions();
  if (mode.value === 'send') {
    const fields =
      action.value === 'issue'
        ? { percent: Number(percent.value) }
        : action.value === 'send_existing'
          ? { chargeId: chargeId.value }
          : action.value === 'correct'
            ? {
                chargeId: chargeId.value,
                amountCents: sendAmount.value,
                confirmedAgreement: true,
                confirmedProviderReview: true,
              }
            : action.value === 'retry'
              ? {
                  intentId: intentId.value,
                  expectedIntentVersion: selectedIntent.value.version,
                }
              : {};
    return {
      path: 'send-intents',
      body: {
        ...v,
        action: action.value,
        conversationId: targetConversationId.value,
        expectedConversationVersion: targetVersion.value,
        ...fields,
      },
    };
  }
  if (mode.value === 'external')
    return {
      path: 'external-receipts',
      body: {
        ...v,
        amountCents: parseBrl(amount.value),
        receivedOn: receivedOn.value,
        method: method.value,
        note: note.value.trim(),
      },
    };
  if (mode.value === 'reverse')
    return {
      path: `external-receipts/${encodeURIComponent(selectedReceipt.value.id)}/reverse`,
      body: { ...v, reason: reason.value.trim() },
    };
  if (mode.value === 'close-charge')
    return {
      path: 'reconcile',
      body: { ...v, decision: 'close_unpaid', confirmedProviderReview: true },
    };
  return {
    path: `charges/${encodeURIComponent(chargeId.value)}/check-payment`,
    body: {
      ...v,
      invoiceSlug: invoiceSlug.value.trim(),
      transactionNsu: transactionNsu.value.trim(),
    },
  };
}
async function submit() {
  if (busy.value) return;
  if (
    !pending.value &&
    (!mutable.value || (mode.value === 'send' && !canSend.value))
  ) {
    dialogError.value =
      'A operação não está disponível. Atualize os dados e revise novamente.';
    return;
  }
  const ownGeneration = generation;
  pending.value ??= {
    ...(reviewedRecord.value ?? createRecord()),
    key: commandKey(),
    orderId: props.order.id,
    mode: mode.value,
  };
  const record = pending.value;
  busy.value = true;
  dialogError.value = '';
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(record.orderId)}/billing/${record.path}`,
      { method: 'POST', body: record.body, idempotencyKey: record.key },
    );
    if (ownGeneration !== generation) return;
    pending.value = null;
    if (record.mode === 'send') {
      notice.value = `Solicitação registrada: ${labels[response.data.state] ?? 'aguardando processamento'}. Envio e pagamento são confirmados separadamente.`;
      selectedIntent.value = response.data;
    } else if (record.mode === 'check')
      notice.value =
        'Conferência solicitada. O pagamento só será registrado depois da verificação pela InfinitePay.';
    else
      notice.value =
        record.mode === 'external'
          ? 'Recebimento externo registrado no histórico.'
          : 'Registro estornado no histórico. Nenhum dinheiro foi devolvido por esta ação.';
    await new Promise((resolve) => {
      const current = dialog.value;
      if (!current?.open) {
        resolve();
        return;
      }
      current.addEventListener('close', () => resolve(), { once: true });
      current.close();
    });
    await load();
    emit('changed');
    await nextTick();
    noticeElement.value?.focus();
  } catch (cause) {
    if (ownGeneration !== generation) return;
    const status = Number(cause?.status);
    if (status >= 400 && status < 500) pending.value = null;
    if (status === 409) {
      reviewedRecord.value = null;
      stage.value = 'choose';
      await Promise.all([
        load(),
        refreshConversation().catch(() => {
          conversation.value = null;
        }),
      ]);
      dialogError.value =
        'Os dados do pedido ou da conversa mudaram. Confira as informações atualizadas e revise novamente antes de confirmar.';
      await nextTick();
      dialogStatus.value?.focus();
      return;
    }
    dialogError.value = pending.value
      ? 'A resposta não foi confirmada. Confira o mesmo registro antes de iniciar outra operação; não houve reenvio automático.'
      : billingError(cause);
    await nextTick();
    dialogStatus.value?.focus();
  } finally {
    if (ownGeneration === generation) busy.value = false;
  }
}
async function recover(event) {
  if (!pending.value || busy.value) return;
  const trigger = event.currentTarget;
  mode.value = pending.value.mode;
  stage.value = 'review';
  await nextTick();
  if (trigger?.isConnected) openDialog(dialog.value, trigger);
}
function close() {
  if (!busy.value) dialog.value?.close();
}
function eventLabel(item) {
  return eventLabels[item.kind] ?? 'Atualização do pagamento';
}
function externalDetails(payment) {
  return (billing.value?.externalReceipts ?? []).find(
    (item) => item.id === payment.id,
  );
}
function chargeLabel(item) {
  return item.kind === 'signal'
    ? 'Sinal'
    : item.kind === 'balance'
      ? 'Saldo'
      : 'Cobrança';
}
watch(
  () => [props.order.id, props.order.version],
  async (value, previous) => {
    if (!previous || value[0] !== previous[0]) {
      generation++;
      pending.value = null;
      notice.value = '';
      error.value = '';
      history.value = [];
      billing.value = props.initialBilling;
      dialog.value?.close();
    }
    await load();
  },
  { immediate: true },
);
watch(
  () => props.initialBilling,
  (value) => {
    if (value) billing.value = value;
  },
);
watch(action, () => {
  stage.value = 'choose';
  dialogError.value = '';
});
watch(
  () => props.disabled,
  (value) => {
    if (value) dialog.value?.close();
  },
);
async function poll() {
  if (disposed) return;
  await load();
  if (!disposed) timer = globalThis.setTimeout(poll, 5000);
}
timer = globalThis.setTimeout(poll, 5000);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  controller?.abort();
  globalThis.clearTimeout(timer);
  dialog.value?.close();
});
</script>

<template>
  <div class="billing-workspace" :aria-busy="busy || loading || undefined">
    <p v-if="loading && !billing" role="status">
      Consultando cobranças e pagamentos…
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" ref="noticeElement" role="status" tabindex="-1">
      {{ notice }}
    </p>
    <template v-if="billing">
      <dl
        v-if="!compact"
        class="workspace-totals"
        aria-label="Valores do pedido"
      >
        <div>
          <dt>Total do pedido</dt>
          <dd>{{ billingMoney(billing.totalAmountCents) }}</dd>
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
      <div class="workspace-actions">
        <button
          v-for="charge in compact &&
          billing.canManage &&
          billing.paymentCheckEnabled
            ? charges
            : []"
          :key="`check-${charge.id}`"
          type="button"
          :disabled="!mutable"
          @click="show('check', $event, charge)"
        >
          Conferir pagamento de {{ billingMoney(charge.amountCents) }}
        </button>
        <button
          v-if="
            billing.canManage && billing.chatSendEnabled && targetConversationId
          "
          type="button"
          class="primary"
          :disabled="!mutable || balance <= 0"
          @click="show('send', $event)"
        >
          Gerar e enviar cobrança
        </button>
        <button
          v-if="billing.canManage"
          type="button"
          :disabled="!mutable || balance <= 0 || billing.reviewRequired"
          @click="show('external', $event)"
        >
          Registrar recebimento externo
        </button>
        <button v-if="pending" type="button" :disabled="busy" @click="recover">
          Conferir registro pendente
        </button>
      </div>
      <p v-if="pending" role="status">
        Há uma operação sem resposta confirmada. Não inicie outro registro.
      </p>
      <p v-if="!compact && !billing.chatSendEnabled" class="op-hint">
        O envio integrado de cobranças está desativado. O histórico continua
        disponível.
      </p>
      <section v-if="!compact && charges.length" aria-label="Cobranças e links">
        <h3>Cobranças e links</h3>
        <ol class="workspace-list">
          <li v-for="charge in charges" :key="charge.id">
            <p>
              <strong
                >{{ chargeLabel(charge) }} ·
                {{ billingMoney(charge.amountCents) }}</strong
              ><br />{{ labels[charge.status] ?? charge.status }}
            </p>
            <p v-if="charge.validUntil">
              {{
                Date.parse(charge.validUntil) <= Date.now()
                  ? 'Validade encerrada'
                  : 'Válido até'
              }}
              · {{ dateTimeBR(charge.validUntil) }}
            </p>
            <a
              v-if="privateReadable && billingUrl(charge.checkoutUrl)"
              :href="billingUrl(charge.checkoutUrl)"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              >Abrir
              {{
                charge.status === 'closed'
                  ? 'link anterior para conferência'
                  : 'cobrança'
              }}</a
            >
            <button
              v-if="billing.canManage && billing.paymentCheckEnabled"
              type="button"
              :disabled="!mutable"
              @click="show('check', $event, charge)"
            >
              Conferir pagamento
            </button>
            <button
              v-if="
                billing.canManage &&
                charge.status === 'waiting' &&
                Date.parse(charge.validUntil) <= Date.now()
              "
              type="button"
              :disabled="!mutable"
              @click="show('close-charge', $event, charge)"
            >
              Encerrar cobrança vencida
            </button>
          </li>
        </ol>
      </section>
      <section v-if="payments.length" aria-label="Pagamentos registrados">
        <h3>Pagamentos registrados</h3>
        <ol class="workspace-list">
          <li v-for="payment in payments" :key="payment.id">
            <p>
              <strong>{{ billingMoney(payment.amountCents) }}</strong> ·
              {{
                payment.source === 'external'
                  ? 'Recebimento externo'
                  : 'InfinitePay'
              }}<br />{{ methods[payment.method] ?? payment.method
              }}<template v-if="payment.installments > 1">
                em {{ payment.installments }}x</template
              >
              · {{ payment.receivedOn }}
            </p>
            <p v-if="externalDetails(payment)?.reversedAt">
              Registro estornado em
              {{ dateTimeBR(externalDetails(payment).reversedAt) }} por
              {{
                externalDetails(payment).reversedByName ||
                'responsável pelo registro'
              }}.
            </p>
            <p v-else-if="payment.active === false">
              Recebimento pendente de conferência ou sem crédito aplicado.
            </p>
            <p v-if="externalDetails(payment)?.note">
              Observação: {{ externalDetails(payment).note }}
            </p>
            <p v-if="externalDetails(payment)?.reversalReason">
              Motivo do estorno: {{ externalDetails(payment).reversalReason }}
            </p>
            <p v-if="payment.recordedBy || payment.recordedByName">
              Registrado por
              {{ payment.recordedByName || 'responsável pelo registro' }} em
              {{ dateTimeBR(payment.recordedAt) }}
            </p>
            <a
              v-if="privateReadable && billingUrl(payment.receiptUrl)"
              :href="billingUrl(payment.receiptUrl)"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              >Comprovante InfinitePay</a
            >
            <button
              v-if="
                payment.source === 'external' &&
                externalDetails(payment) &&
                !externalDetails(payment).reversedAt &&
                billing.canManage
              "
              type="button"
              :disabled="!mutable"
              @click="show('reverse', $event, payment)"
            >
              Estornar registro
            </button>
          </li>
        </ol>
      </section>
      <p v-if="checks.length" role="status">
        Última conferência: {{ labels[checks[0].state] ?? checks[0].state }}.
        <template v-if="checks[0].nextCheckAt"
          >Nova consulta prevista em
          {{ dateTimeBR(checks[0].nextCheckAt) }}.</template
        >
      </p>
      <details v-if="history.length" class="workspace-history">
        <summary>Histórico de cobranças, envios e pagamentos</summary>
        <ol class="workspace-list">
          <li v-for="item in history" :key="item.id">
            <p>
              <strong>{{ eventLabel(item) }}</strong> ·
              {{ billingMoney(item.amountCents) }}<br />{{
                labels[item.status] ?? item.status
              }}
              · {{ dateTimeBR(item.occurredAt) }}
            </p>
            <p v-if="item.supersedesChargeId">
              Correção da cobrança anterior de
              {{
                billingMoney(
                  charges.find(
                    (charge) => charge.id === item.supersedesChargeId,
                  )?.amountCents,
                )
              }}
            </p>
            <p v-if="item.retryOfIntentId">
              Nova tentativa vinculada ao envio anterior, preservado neste
              histórico.
            </p>
          </li>
        </ol>
        <button
          v-if="nextCursor"
          type="button"
          :disabled="loading"
          @click="load(true)"
        >
          Carregar histórico anterior
        </button>
      </details>
      <button
        v-if="!compact"
        type="button"
        :disabled="loading || busy"
        @click="load()"
      >
        Atualizar pagamentos
      </button>
    </template>
    <Teleport to="body"
      ><dialog
        ref="dialog"
        class="op-dialog workspace-dialog"
        :aria-labelledby="`${uid}-title`"
        @cancel="busy && $event.preventDefault()"
      >
        <h2 :id="`${uid}-title`">{{ title }}</h2>
        <p v-if="dialogError" ref="dialogStatus" role="alert" tabindex="-1">
          {{ dialogError }}
        </p>
        <form
          @submit.prevent="stage === 'choose' && !pending ? review() : submit()"
        >
          <template v-if="stage === 'choose' && !pending">
            <template v-if="mode === 'send'">
              <label :for="`${uid}-action`">O que deseja cobrar?</label>
              <select :id="`${uid}-action`" v-model="action">
                <option v-if="received === 0 && !activeCharge" value="issue">
                  Sinal ou valor integral
                </option>
                <option
                  v-if="received > 0 && !activeCharge && balance > 0"
                  value="balance"
                >
                  Cobrar somente o saldo
                </option>
                <option v-if="existing.length" value="send_existing">
                  Enviar o link existente
                </option>
                <option v-if="corrected.length" value="correct">
                  Corrigir cobrança encerrada
                </option>
                <option v-if="failedIntents.length" value="retry">
                  Conferir nova tentativa de envio
                </option>
              </select>
              <template v-if="action === 'issue'"
                ><label :for="`${uid}-percent`">Percentual de entrada</label
                ><input
                  :id="`${uid}-percent`"
                  v-model="percent"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  required
              /></template>
              <template
                v-if="action === 'send_existing' || action === 'correct'"
                ><label :for="`${uid}-charge`">Cobrança</label
                ><select :id="`${uid}-charge`" v-model="chargeId" required>
                  <option value="">Escolha a cobrança</option>
                  <option
                    v-for="charge in action === 'correct'
                      ? corrected
                      : existing"
                    :key="charge.id"
                    :value="charge.id"
                  >
                    {{ chargeLabel(charge) }} ·
                    {{ billingMoney(charge.amountCents) }}
                  </option>
                </select></template
              >
              <template v-if="action === 'correct'"
                ><label :for="`${uid}-amount`"
                  >Novo valor da cobrança (R$)</label
                ><input
                  :id="`${uid}-amount`"
                  v-model="amount"
                  inputmode="decimal"
                  required
                /><label class="op-check"
                  ><input v-model="agreed" type="checkbox" /><span
                    >Combinei o novo valor com o cliente.</span
                  ></label
                ><label class="op-check"
                  ><input v-model="providerReviewed" type="checkbox" /><span
                    >Conferi na InfinitePay que a cobrança anterior venceu e foi
                    encerrada sem pagamento.</span
                  ></label
                >
                <p>
                  O link anterior permanece no histórico. Esta ação não o
                  cancela na InfinitePay.
                </p></template
              >
              <template v-if="action === 'retry'"
                ><label :for="`${uid}-intent`">Tentativa anterior</label
                ><select
                  :id="`${uid}-intent`"
                  v-model="intentId"
                  @change="selectRetry"
                >
                  <option value="">Escolha a tentativa</option>
                  <option
                    v-for="item in failedIntents"
                    :key="item.intentId"
                    :value="item.intentId"
                  >
                    {{ dateTimeBR(item.occurredAt) }} ·
                    {{ billingMoney(item.amountCents) }}
                  </option>
                </select>
                <p>
                  Uma nova tentativa exige falha comprovada antes do envio e o
                  mesmo link ainda válido.
                </p></template
              >
              <p
                v-if="
                  activeCharge &&
                  !existing.length &&
                  !corrected.length &&
                  !failedIntents.length
                "
              >
                Há uma cobrança em andamento ou que precisa de conferência.
                Atualize os dados antes de iniciar outra.
              </p>
            </template>
            <template v-else-if="mode === 'external'">
              <p>
                Registre somente um valor recebido fora da InfinitePay. Um
                pagamento da InfinitePay ainda não reconhecido deve ser
                conferido pela integração.
              </p>
              <label :for="`${uid}-amount`">Valor recebido (R$)</label
              ><input
                :id="`${uid}-amount`"
                v-model="amount"
                inputmode="decimal"
                required
              />
              <label :for="`${uid}-date`">Data do recebimento</label
              ><input
                :id="`${uid}-date`"
                v-model="receivedOn"
                type="date"
                :max="today"
                required
              />
              <label :for="`${uid}-method`">Forma de pagamento</label
              ><select :id="`${uid}-method`" v-model="method">
                <option
                  v-for="key in [
                    'cash',
                    'pix_external',
                    'bank_transfer',
                    'card_external',
                  ]"
                  :key="key"
                  :value="key"
                >
                  {{ methods[key] }}
                </option>
              </select>
              <label :for="`${uid}-note`">Observação (opcional)</label
              ><textarea
                :id="`${uid}-note`"
                v-model="note"
                maxlength="500"
              ></textarea>
              <p v-if="activeCharge">
                Um link já enviado não é cancelado por este registro. Se ele for
                pago depois, será necessária conferência.
              </p>
            </template>
            <template v-else-if="mode === 'reverse'"
              ><p>
                O registro original permanece no histórico. Esta ação não
                devolve dinheiro.
              </p>
              <label :for="`${uid}-reason`">Motivo do estorno do registro</label
              ><textarea
                :id="`${uid}-reason`"
                v-model="reason"
                maxlength="500"
                required
              ></textarea>
            </template>
            <template v-else-if="mode === 'close-charge'"
              ><p>
                Confira na InfinitePay que o link venceu e não foi pago. O link
                anterior permanece no histórico; encerrar este registro não
                cancela o link no provedor.
              </p>
              <label class="op-check"
                ><input v-model="providerReviewed" type="checkbox" /><span
                  >Conferi a ausência de pagamento na InfinitePay.</span
                ></label
              ></template
            >
            <template v-else-if="mode === 'check'"
              ><p>
                Use os identificadores do comprovante ou painel da InfinitePay.
                A conferência verifica o pagamento no servidor; não registra um
                recebimento externo.
              </p>
              <label :for="`${uid}-slug`"
                >Identificador da fatura (invoice_slug)</label
              ><input
                :id="`${uid}-slug`"
                v-model="invoiceSlug"
                maxlength="128"
                required /><label :for="`${uid}-nsu`"
                >Identificador da transação (transaction_nsu)</label
              ><input
                :id="`${uid}-nsu`"
                v-model="transactionNsu"
                maxlength="128"
                required
            /></template>
          </template>
          <template v-else>
            <dl class="workspace-review">
              <div>
                <dt>Pedido</dt>
                <dd>{{ order.number }}</dd>
              </div>
              <div v-if="mode === 'send'">
                <dt>Destino</dt>
                <dd>
                  {{
                    pending?.destination ??
                    reviewedRecord?.destination ??
                    destination
                  }}
                </dd>
              </div>
              <div v-if="!['check', 'close-charge'].includes(mode)">
                <dt>Valor</dt>
                <dd>
                  {{
                    billingMoney(
                      pending
                        ? pending.reviewAmountCents
                        : mode === 'external'
                          ? parseBrl(amount)
                          : mode === 'reverse'
                            ? selectedReceipt?.amountCents
                            : sendAmount,
                    )
                  }}
                </dd>
              </div>
            </dl>
            <p v-if="mode === 'send'">
              O link será enviado para esta conversa após a última conferência
              do servidor. Pix e cartão são escolhidos pelo cliente na
              InfinitePay. Envio não confirma pagamento.
            </p>
            <dl v-if="mode === 'check'" class="workspace-review">
              <div>
                <dt>Fatura</dt>
                <dd>{{ pending?.body.invoiceSlug ?? invoiceSlug }}</dd>
              </div>
              <div>
                <dt>Transação</dt>
                <dd>{{ pending?.body.transactionNsu ?? transactionNsu }}</dd>
              </div>
            </dl>
            <p v-if="mode === 'external'">
              {{ methods[method] }} · {{ receivedOn }}. O recebido e o saldo
              serão atualizados pelo servidor.
            </p>
          </template>
          <div class="workspace-actions">
            <button type="button" :disabled="busy" @click="close">Fechar</button
            ><button
              v-if="stage === 'review' && !pending"
              type="button"
              :disabled="busy"
              @click="stage = 'choose'"
            >
              Voltar à edição</button
            ><button
              type="submit"
              class="primary"
              :disabled="busy || retryLoading"
            >
              {{
                busy
                  ? 'Registrando…'
                  : pending
                    ? 'Conferir o mesmo registro'
                    : stage === 'choose'
                      ? 'Revisar'
                      : mode === 'send'
                        ? 'Confirmar envio da cobrança'
                        : mode === 'external'
                          ? 'Confirmar recebimento externo'
                          : mode === 'reverse'
                            ? 'Confirmar estorno do registro'
                            : mode === 'close-charge'
                              ? 'Confirmar encerramento local'
                              : 'Solicitar conferência'
              }}
            </button>
          </div>
        </form>
      </dialog></Teleport
    >
  </div>
</template>

<style scoped>
.billing-workspace {
  display: grid;
  gap: var(--space-3);
  min-inline-size: 0;
}
.workspace-totals,
.workspace-review {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin: 0;
}
.workspace-totals dd,
.workspace-review dd {
  margin: var(--space-1) 0 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.workspace-totals dt,
.workspace-review dt {
  color: var(--color-text-muted);
}
.workspace-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.billing-workspace button,
.workspace-dialog button {
  min-block-size: 44px;
}
.workspace-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}
.workspace-list li {
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--color-border);
  overflow-wrap: anywhere;
}
.workspace-list p {
  margin-block: var(--space-1);
}
.workspace-list a {
  display: inline-block;
  margin-inline-end: var(--space-3);
}
.workspace-history summary {
  cursor: pointer;
  padding-block: var(--space-2);
  min-block-size: 44px;
}
.workspace-dialog {
  max-inline-size: calc(100vw - 2rem);
  box-sizing: border-box;
}
.workspace-dialog form {
  display: grid;
  gap: var(--space-3);
}
.workspace-dialog input:not([type='checkbox']),
.workspace-dialog select,
.workspace-dialog textarea {
  box-sizing: border-box;
  min-inline-size: 0;
  inline-size: 100%;
}
.workspace-dialog p {
  overflow-wrap: anywhere;
}
</style>
