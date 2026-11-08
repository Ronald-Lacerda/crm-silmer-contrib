<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { openDialog } from '../../lib/ui.js';
import { commandKey, request } from '../../lib/api-client.js';
import {
  amountLabel,
  dayLabel,
  paymentConditionLabel,
} from '../../lib/order-format.js';
import {
  olistIssueLabel,
  olistFailure,
  registrationAction,
} from '../../lib/olist-feedback.js';

const props = defineProps({
  orderId: { type: String, required: true },
  revision: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['operation']);
const user = inject('sessionUser', ref({}));
const liveEvent = inject('liveEvent', ref(null));
const canOperate = computed(() => user.value.olistEnabled === true);
const projection = ref(null);
const preview = ref(null);
const busy = ref(false);
const message = ref('');
const error = ref('');
const denied = ref(false);
const notice = ref(null);
const reviewOpen = ref(false);
const reviewDialog = ref(null);
const reviewToken = ref('');
const reviewGate = ref(false);
const checkDisabled = ref(false);
const exportState = ref('idle');
let exportKey = '';
let exportTrigger = null;
let attemptOrderId = '';
const UNCERTAIN_MESSAGE =
  'A solicitação pode ter sido recebida. Não repita a geração; peça a conferência administrativa da operação.';
let controller;
let disposed = false;
let expiration = 0;
const base = computed(
  () => `/api/v1/orders/${encodeURIComponent(props.orderId)}/olist`,
);
const hasOperation = computed(() => Boolean(projection.value?.operation));
const generationAllowed = computed(
  () =>
    canOperate.value &&
    !denied.value &&
    !props.disabled &&
    !hasOperation.value &&
    exportState.value === 'idle' &&
    !checkDisabled.value &&
    projection.value?.creationEnabled === true &&
    preview.value?.creationEnabled === true &&
    preview.value?.eligible === true &&
    typeof preview.value?.previewToken === 'string' &&
    preview.value.previewToken.length > 0,
);
const operationLabel = computed(() => {
  const state = projection.value?.operation?.state;
  if (state === 'confirmed' || state === 'linked')
    return 'Venda Olist conferida';
  if (
    ['outcome_unknown', 'divergent', 'reconciliation_required'].includes(state)
  )
    return 'Operação bloqueada para conferência administrativa';
  return 'Operação Olist em acompanhamento';
});
const expiryLabel = computed(() => {
  const stamp = Date.parse(preview.value?.expiresAt ?? '');
  return Number.isFinite(stamp)
    ? new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }).format(stamp)
    : '';
});

function clearPreview() {
  if (expiration) globalThis.clearTimeout(expiration);
  expiration = 0;
  preview.value = null;
  message.value = '';
  reviewGate.value = false;
  reviewToken.value = '';
  void closeReview();
}
function invalidate() {
  if (exportState.value === 'submitting') markUncertain();
  controller?.abort();
  controller = undefined;
  busy.value = false;
  clearPreview();
}
async function focusNotice() {
  await nextTick();
  if (!disposed) notice.value?.focus();
}
/** Only the current request may publish data, including after access changes. */
async function run(path, body, focusError = true) {
  if (busy.value || props.disabled || denied.value) return;
  const own = new AbortController();
  controller?.abort();
  controller = own;
  const id = props.orderId;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const response = await request(`${base.value}${path}`, {
      signal: own.signal,
      ...(body === undefined
        ? {}
        : { method: 'POST', body, idempotencyKey: commandKey() }),
    });
    if (
      disposed ||
      own.signal.aborted ||
      controller !== own ||
      props.orderId !== id
    )
      return;
    return response.data;
  } catch (cause) {
    if (disposed || own.signal.aborted || controller !== own) return;
    clearPreview();
    if ([401, 403].includes(Number(cause?.status))) {
      denied.value = true;
      projection.value = null;
      emit('operation', { unavailable: true });
    }
    error.value = olistFailure(cause);
    if (focusError) await focusNotice();
  } finally {
    if (controller === own && !disposed) busy.value = false;
  }
}
async function load(interactive = false) {
  if (props.disabled || denied.value || busy.value) return;
  clearPreview();
  const data = await run('', undefined, interactive);
  if (!data) return;
  projection.value = data;
  emit(
    'operation',
    data.operation ??
      (['accepted', 'uncertain'].includes(exportState.value)
        ? { unavailable: true }
        : null),
  );
}
async function confer() {
  if (
    !canOperate.value ||
    busy.value ||
    props.disabled ||
    hasOperation.value ||
    exportState.value !== 'idle'
  )
    return;
  clearPreview();
  checkDisabled.value = false;
  const data = await run('/preview', {});
  if (!data || !canOperate.value) return;
  preview.value = data;
  if (data.previewToken && data.expiresAt) {
    const remaining = Date.parse(data.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      clearPreview();
      error.value =
        'A prévia expirou. Confira uma nova prévia antes de continuar.';
    } else {
      expiration = globalThis.setTimeout(
        () => {
          clearPreview();
          error.value =
            'A prévia expirou. Confira uma nova prévia antes de continuar.';
        },
        Math.min(remaining, 900000),
      );
    }
  }
  await focusNotice();
}
async function validate() {
  if (
    !canOperate.value ||
    !preview.value?.previewToken ||
    busy.value ||
    props.disabled ||
    hasOperation.value ||
    exportState.value !== 'idle'
  )
    return;
  const data = await run('/preview/check', {
    previewToken: preview.value.previewToken,
  });
  if (!data || !canOperate.value) return;
  if (data.valid !== true) {
    clearPreview();
    error.value = 'A prévia mudou. Confira novamente os dados do pedido.';
  } else {
    checkDisabled.value = data.creationEnabled !== true;
    message.value =
      data.creationEnabled === true && generationAllowed.value
        ? 'Prévia validada. Confira a geração e confirme somente se estiver de acordo.'
        : 'Prévia validada. A geração de vendas continua desativada.';
  }
  await focusNotice();
}
function receiptCurrent(token) {
  return (
    token === preview.value?.previewToken &&
    Number.isFinite(Date.parse(preview.value?.expiresAt ?? '')) &&
    Date.parse(preview.value.expiresAt) > Date.now()
  );
}
function markUncertain() {
  exportState.value = 'uncertain';
  error.value = UNCERTAIN_MESSAGE;
  if (attemptOrderId === props.orderId)
    emit('operation', { unavailable: true });
}
async function closeReview() {
  const dialog = reviewDialog.value;
  if (dialog?.open) {
    const closed = new Promise((resolve) =>
      dialog.addEventListener('close', resolve, { once: true }),
    );
    dialog.close();
    await closed;
  }
  reviewOpen.value = false;
  reviewGate.value = false;
  reviewToken.value = '';
}
async function cancelReview() {
  if (exportState.value === 'submitting') return;
  await closeReview();
}
async function requestExport(event) {
  if (busy.value || !generationAllowed.value || reviewOpen.value) return;
  const token = preview.value.previewToken;
  if (!receiptCurrent(token)) {
    clearPreview();
    error.value =
      'A prévia expirou. Confira uma nova prévia antes de continuar.';
    await focusNotice();
    return;
  }
  // Capture before awaiting: event.currentTarget is cleared after dispatch.
  const trigger = event.currentTarget;
  const data = await run('/preview/check', { previewToken: token });
  if (!data || !canOperate.value) return;
  if (data.valid !== true || !receiptCurrent(token)) {
    clearPreview();
    error.value =
      'A prévia mudou ou expirou. Confira novamente os dados do pedido.';
    await focusNotice();
    return;
  }
  checkDisabled.value = data.creationEnabled !== true;
  if (!generationAllowed.value) {
    message.value =
      'A geração de vendas continua desativada. Nenhuma solicitação foi enviada.';
    await focusNotice();
    return;
  }
  exportTrigger = trigger;
  exportKey = commandKey();
  reviewToken.value = token;
  reviewGate.value = true;
  reviewOpen.value = true;
  await nextTick();
  if (!disposed && generationAllowed.value && reviewDialog.value)
    openDialog(reviewDialog.value, exportTrigger);
}
async function submitExport() {
  if (
    busy.value ||
    !reviewOpen.value ||
    !reviewGate.value ||
    !generationAllowed.value
  )
    return;
  const token = reviewToken.value;
  if (!receiptCurrent(token)) {
    clearPreview();
    error.value =
      'A prévia expirou. Confira uma nova prévia antes de continuar.';
    await focusNotice();
    return;
  }
  const own = new AbortController();
  controller?.abort();
  controller = own;
  const id = props.orderId;
  const number = projection.value.number;
  attemptOrderId = id;
  exportState.value = 'submitting';
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    // Only this human confirmation reaches the local command. No ERP URL,
    // prices, account, snapshot or authority is accepted from the browser.
    const response = await request(`${base.value}/export`, {
      method: 'POST',
      body: { previewToken: token },
      idempotencyKey: exportKey,
      signal: own.signal,
    });
    if (
      disposed ||
      own.signal.aborted ||
      controller !== own ||
      props.orderId !== id
    )
      return;
    const data = response.data;
    if (
      data?.orderId !== id ||
      data?.number !== number ||
      typeof data?.operationId !== 'string' ||
      !data.operationId ||
      typeof data?.state !== 'string' ||
      typeof data?.stage !== 'string'
    ) {
      markUncertain();
      clearPreview();
    } else {
      exportState.value = 'accepted';
      // response.number is the CRM number, never the remote sale number.
      projection.value = {
        ...projection.value,
        operation: { state: data.state, stage: data.stage, number: null },
      };
      clearPreview();
      emit('operation', projection.value.operation);
      message.value =
        'Solicitação registrada para o pedido ' +
        number +
        '. Acompanhe a operação sem repetir o envio.';
    }
  } catch (cause) {
    if (
      disposed ||
      own.signal.aborted ||
      controller !== own ||
      props.orderId !== id
    )
      return;
    markUncertain();
    clearPreview();
    if ([401, 403].includes(Number(cause?.status))) {
      denied.value = true;
      projection.value = null;
    }
  } finally {
    if (controller === own && !disposed) {
      busy.value = false;
      await closeReview();
      await focusNotice();
    }
  }
}
watch(
  () => [props.orderId, props.revision],
  (next, previous) => {
    invalidate();
    if (!previous || next[0] !== previous[0]) exportState.value = 'idle';
    checkDisabled.value = false;
    projection.value = null;
    denied.value = false;
    void load();
  },
  { immediate: true },
);
watch(
  () => props.disabled,
  (disabled) => {
    invalidate();
    if (!disabled) void load();
  },
);
watch(
  () => [
    user.value.id,
    user.value.olistEnabled,
    user.value.olistAuthorizationVersion,
  ],
  () => {
    invalidate();
    projection.value = null;
    denied.value = !canOperate.value;
    if (!denied.value) void load();
  },
);
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.contact.changed',
      'identity.user.changed',
    ].includes(event?.type)
  ) {
    invalidate();
    // Explicit refresh avoids ERP polling and never reuses a receipt after a live change.
    error.value =
      'Os dados ou o acesso podem ter mudado. Atualize a preparação e confira uma nova prévia.';
  }
});
onBeforeUnmount(() => {
  disposed = true;
  invalidate();
});
</script>

<template>
  <section
    class="op-sheet olist-preparation"
    :aria-labelledby="`olist-preparation-${orderId}`"
    :aria-busy="busy"
  >
    <div class="op-sheet-head">
      <h2 :id="`olist-preparation-${orderId}`">Preparação para o Olist</h2>
      <p v-if="projection">
        Pedido {{ projection.number }} ·
        {{ projection.status === 'confirmado' ? 'Confirmado' : 'Pendente' }}
      </p>
    </div>
    <div class="op-sheet-body">
      <p :id="`olist-generation-${orderId}`">
        {{
          generationAllowed
            ? 'A geração exige sua conferência e confirmação humana.'
            : 'A geração de vendas está desativada.'
        }}
        Conferir a prévia consulta os cadastros e não cria cliente, produto ou
        venda no Olist.
      </p>
      <p v-if="exportState === 'uncertain'" class="field-help">
        O resultado da solicitação precisa de conferência administrativa.
        Atualizar a preparação só consulta a operação; não autoriza repetir a
        geração.
      </p>
      <p v-if="!canOperate" class="field-help">
        Seu usuário não está habilitado para conferir a prévia Olist.
      </p>
      <p v-if="disabled" class="field-help">
        Salve ou cancele a edição aberta antes de conferir.
      </p>
      <p v-if="busy" role="status">Conferindo a preparação…</p>
      <div v-if="error || message || preview" ref="notice" tabindex="-1">
        <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <template v-if="preview && !denied">
          <h3>
            {{
              preview.eligible
                ? 'Prévia pronta para conferência'
                : 'Pendências para o Olist'
            }}
          </h3>
          <ul v-if="preview.issues?.length">
            <li
              v-for="(issue, index) in preview.issues"
              :key="`${issue.code}:${issue.field}:${index}`"
            >
              {{ olistIssueLabel(issue, preview.commercial?.groups) }}
            </li>
          </ul>
          <p v-if="preview.issues?.length" class="field-help">
            Peça a uma pessoa autorizada a corrigir o pedido, o cadastro de
            origem ou os parâmetros. A habilitação Olist não concede edição.
          </p>
          <dl class="olist-preview-summary">
            <div v-if="preview.customer">
              <dt>Comprador</dt>
              <dd>
                {{ preview.customer.name }} · documento final
                {{ preview.customer.documentSuffix }}
              </dd>
            </div>
            <div>
              <dt>Data da venda Olist</dt>
              <dd>
                {{ dayLabel(preview.commercial?.orderDate) || 'Não definida' }}
              </dd>
            </div>
            <div>
              <dt>Entrega prometida</dt>
              <dd>
                {{
                  dayLabel(preview.commercial?.deliveryOn) || 'Não informada'
                }}
              </dd>
            </div>
            <div>
              <dt>Forma de pagamento</dt>
              <dd>
                {{
                  paymentConditionLabel(preview.commercial?.paymentCondition)
                }}
              </dd>
            </div>
            <div>
              <dt>Total do pedido</dt>
              <dd>{{ amountLabel(preview.commercial?.totalCents) }}</dd>
            </div>
          </dl>
          <p class="field-help">
            Exportar um pedido pendente não o confirma no CRM. A data da venda é
            conferida novamente ao aceitar o comando.
          </p>
          <section
            v-for="(group, index) in preview.commercial?.groups ?? []"
            :key="group.groupId"
            class="olist-preview-group"
            :aria-labelledby="`olist-group-${group.groupId}`"
          >
            <h3 :id="`olist-group-${group.groupId}`">
              Item {{ index + 1 }} · {{ group.attributes?.garment }} ·
              {{ group.attributes?.color }}
            </h3>
            <table>
              <caption class="sr-only">
                Tamanhos e subtotais do item
                {{
                  index + 1
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tamanho</th>
                  <th scope="col">Quantidade</th>
                  <th scope="col">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in group.lines" :key="line.lineId">
                  <th scope="row">{{ line.size }}</th>
                  <td>{{ line.quantity }}</td>
                  <td>{{ amountLabel(line.subtotalCents) }}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section v-if="preview.registrations" aria-label="Plano de cadastros">
            <h3>Plano de cadastros</h3>
            <p>
              Comprador:
              {{ registrationAction(preview.registrations.customer?.action) }}
            </p>
            <ul>
              <li
                v-for="(group, index) in preview.registrations.groups ?? []"
                :key="group.groupId"
              >
                Item {{ index + 1 }}: {{ registrationAction(group.action) }}
                <ul>
                  <li v-for="line in group.lines ?? []" :key="line.lineId">
                    Tamanho
                    {{
                      preview.commercial?.groups
                        ?.find((item) => item.groupId === group.groupId)
                        ?.lines?.find((item) => item.lineId === line.lineId)
                        ?.size || 'não conferido'
                    }}: {{ registrationAction(line.action) }}
                  </li>
                </ul>
              </li>
            </ul>
          </section>
          <p v-if="expiryLabel" class="field-help">
            Prévia válida até {{ expiryLabel }} (São Paulo). Mudanças no pedido,
            cadastro, configuração ou acesso exigem nova conferência.
          </p>
        </template>
      </div>
      <template v-if="hasOperation && !denied">
        <p>
          {{ operationLabel
          }}<span v-if="projection.operation.number">
            · Venda {{ projection.operation.number }}</span
          >
        </p>
        <p class="field-help">
          Não repita a geração. A conferência e a recuperação da operação são
          administrativas.
        </p>
      </template>
      <div class="form-actions">
        <button
          v-if="!preview?.eligible || exportState !== 'idle' || hasOperation"
          type="button"
          :disabled="busy || disabled || denied"
          @click="load(true)"
        >
          Atualizar preparação
        </button>
        <button
          v-if="
            canOperate && !denied && !hasOperation && exportState === 'idle'
          "
          type="button"
          :disabled="busy || disabled"
          @click="confer"
        >
          Conferir prévia Olist
        </button>
        <button
          v-if="
            canOperate &&
            preview?.eligible &&
            preview?.previewToken &&
            !hasOperation &&
            exportState === 'idle'
          "
          type="button"
          :disabled="busy || disabled"
          @click="validate"
        >
          Validar prévia
        </button>
        <button
          v-if="
            canOperate &&
            preview?.eligible &&
            !hasOperation &&
            exportState === 'idle'
          "
          type="button"
          :class="{ primary: generationAllowed }"
          :aria-disabled="!generationAllowed || busy || undefined"
          :aria-describedby="`olist-generation-${orderId}`"
          @click="requestExport"
        >
          Gerar venda no Olist
        </button>
      </div>
    </div>
    <dialog
      v-if="reviewOpen"
      ref="reviewDialog"
      class="op-dialog"
      aria-modal="true"
      aria-labelledby="olist-export-title"
      aria-describedby="olist-export-description"
      @cancel.prevent="cancelReview"
    >
      <h2 id="olist-export-title">Gerar venda no Olist?</h2>
      <p id="olist-export-description">
        A sequência poderá criar ou reutilizar o comprador, os produtos e os
        tamanhos conferidos e gerar uma venda no Olist. Esta ação não confirma o
        pedido no CRM.
      </p>
      <dl>
        <div>
          <dt>Pedido CRM</dt>
          <dd>{{ projection?.number }}</dd>
        </div>
        <div>
          <dt>Total conferido</dt>
          <dd>{{ amountLabel(preview?.commercial?.totalCents) }}</dd>
        </div>
      </dl>
      <p>
        Confira a composição e o plano de cadastros antes de continuar. Se o
        resultado ficar incerto, não repita a solicitação.
      </p>
      <div class="op-dialog-actions">
        <button type="button" :disabled="busy" @click="cancelReview">
          Voltar à prévia
        </button>
        <button
          type="button"
          class="primary"
          :disabled="busy || !generationAllowed || !reviewGate"
          :aria-busy="busy || undefined"
          @click="submitExport"
        >
          {{ busy ? 'Solicitando…' : 'Gerar venda conferida' }}
        </button>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.olist-preparation {
  margin-block: var(--space-6);
  min-inline-size: 0;
}
.olist-preparation .op-sheet-body {
  display: grid;
  gap: var(--space-4);
}
.olist-preparation p {
  margin: 0;
}
.olist-preparation h3 {
  font-size: var(--text-base);
  margin-block: var(--space-4) var(--space-2);
}
.olist-preview-summary {
  display: grid;
  gap: var(--space-3);
}
.olist-preview-summary dt {
  color: var(--color-text-muted);
}
.olist-preview-summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.olist-preview-group {
  min-inline-size: 0;
}
.olist-preview-group table {
  inline-size: 100%;
  table-layout: fixed;
  font-variant-numeric: tabular-nums;
}
.olist-preview-group th,
.olist-preview-group td {
  overflow-wrap: anywhere;
  padding: var(--space-2);
  text-align: start;
}
.olist-preparation .form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.olist-preparation button {
  min-block-size: var(--target-min);
}
@media (width <= 30rem) {
  .olist-preview-group table {
    table-layout: auto;
    font-size: var(--text-xs);
  }
  .olist-preview-group th,
  .olist-preview-group td {
    padding: var(--space-1);
  }
  .olist-preview-group th[scope='col'] {
    overflow-wrap: normal;
  }
  .olist-preparation .form-actions {
    display: grid;
  }
}
</style>
