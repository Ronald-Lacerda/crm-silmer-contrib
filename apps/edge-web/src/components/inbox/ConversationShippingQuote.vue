<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import { amountLabel } from '../../lib/order-format.js';
import { dateTimeBR } from '../../lib/format.js';
import { openDialog } from '../../lib/ui.js';
import OrderShippingEstimate from '../order/OrderShippingEstimate.vue';
import AppIcon from '../AppIcon.vue';

const props = defineProps({
  conversationId: { type: String, required: true },
  subjects: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  hasDraft: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
});
const emit = defineEmits(['draft']);
const dialog = ref(null);
const subjectId = ref('');
const order = ref(null);
const quote = ref(null);
const busy = ref(false);
const loadingOrder = ref(false);
const error = ref('');
const notice = ref('');
const resultsHeading = ref(null);
const draftButton = ref(null);
const errorNotice = ref(null);
const estimateRevision = ref(0);
const fields = reactive({
  fromPostalCode: '',
  toPostalCode: '',
  weightGrams: '',
  widthCm: '',
  heightCm: '',
  lengthCm: '',
  insuranceValue: '0,00',
});
let controller;
let orderController;
let calculateKey;
const selectionKeys = new Map();
const targets = computed(() =>
  props.subjects.filter((subject) => subject.orderId),
);
const target = computed(() =>
  targets.value.find((subject) => subject.id === subjectId.value),
);
const selected = computed(() =>
  quote.value?.services?.find(
    (service) => service.id === quote.value.selectedServiceId,
  ),
);
const fieldDefinitions = [
  { key: 'weightGrams', label: 'Peso total (g)', max: 300000 },
  { key: 'widthCm', label: 'Largura (cm)', max: 300 },
  { key: 'heightCm', label: 'Altura (cm)', max: 300 },
  { key: 'lengthCm', label: 'Comprimento (cm)', max: 300 },
];

function invalidate() {
  controller?.abort();
  controller = undefined;
  busy.value = false;
  quote.value = null;
  calculateKey = undefined;
  selectionKeys.clear();
  error.value = '';
  notice.value = '';
}
function close() {
  dialog.value?.close();
}
/** @param {HTMLElement} trigger @param {string} [postalCode] */
async function open(trigger, postalCode = '') {
  if (props.disabled) return;
  if (postalCode) fields.toPostalCode = postalCode;
  if (target.value) void loadOrder();
  estimateRevision.value += 1;
  openDialog(dialog.value, trigger);
  await nextTick();
  dialog.value?.querySelector('select')?.focus();
}
function closeWork() {
  controller?.abort();
  controller = undefined;
  busy.value = false;
}
/** @param {any} cause */
function failure(cause) {
  if (cause?.status === 403)
    return 'Somente o vendedor responsável ou administrador pode cotar neste atendimento. Assuma o atendimento antes de cotar.';
  if (cause?.status === 409)
    return 'O pedido, o assunto ou a conexão mudou. Selecione o pedido novamente e refaça a cotação.';
  if (cause?.status === 429)
    return 'Aguarde um momento antes de consultar novamente.';
  if (cause?.status === 400 || cause?.status === 422)
    return 'Confira o pedido, os CEPs, o peso, as medidas e o valor segurado.';
  return 'Não foi possível consultar o Melhor Envio. Tente novamente; se continuar, peça ao administrador para conferir a conexão.';
}
async function loadOrder() {
  orderController?.abort();
  orderController = undefined;
  invalidate();
  order.value = null;
  if (!target.value) {
    loadingOrder.value = false;
    return;
  }
  const own = new AbortController();
  orderController = own;
  loadingOrder.value = true;
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(target.value.orderId)}`,
      { signal: own.signal },
    );
    if (!own.signal.aborted && own === orderController)
      order.value = response.data.order;
  } catch (cause) {
    if (!own.signal.aborted && own === orderController)
      error.value =
        'Não foi possível carregar o pedido. Selecione-o novamente para tentar.';
  } finally {
    if (own === orderController) loadingOrder.value = false;
  }
}
async function calculate() {
  if (
    busy.value ||
    loadingOrder.value ||
    props.disabled ||
    !target.value ||
    !order.value
  )
    return;
  const amount = fields.insuranceValue.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(amount)) {
    error.value =
      'Informe o valor segurado em reais, com até duas casas decimais.';
    await nextTick();
    errorNotice.value?.focus();
    return;
  }
  controller?.abort();
  const own = new AbortController();
  controller = own;
  busy.value = true;
  error.value = '';
  notice.value = '';
  quote.value = null;
  calculateKey ??= commandKey();
  try {
    const response = await request(
      `/api/v1/conversations/${encodeURIComponent(props.conversationId)}/shipping-quotes`,
      {
        method: 'POST',
        signal: own.signal,
        idempotencyKey: calculateKey,
        body: {
          subjectId: target.value.id,
          orderId: order.value.id,
          orderVersion: order.value.version,
          fromPostalCode: fields.fromPostalCode,
          toPostalCode: fields.toPostalCode,
          weightGrams: Number(fields.weightGrams),
          widthCm: Number(fields.widthCm),
          heightCm: Number(fields.heightCm),
          lengthCm: Number(fields.lengthCm),
          insuranceValueCents: Math.round(Number(amount) * 100),
        },
      },
    );
    if (own !== controller) return;
    quote.value = response.data.quote;
    calculateKey = undefined;
    await nextTick();
    resultsHeading.value?.focus();
    resultsHeading.value?.scrollIntoView({ block: 'start' });
  } catch (cause) {
    if (!own.signal.aborted && own === controller) {
      error.value = failure(cause);
      if (
        /** @type {any} */ (cause)?.status >= 400 &&
        /** @type {any} */ (cause)?.status < 500
      )
        calculateKey = undefined;
      await nextTick();
      errorNotice.value?.focus();
    }
  } finally {
    if (own === controller) busy.value = false;
  }
}
/** @param {number} serviceId */
async function selectService(serviceId) {
  if (
    busy.value ||
    props.disabled ||
    !quote.value ||
    quote.value.stale ||
    !target.value ||
    !order.value
  )
    return;
  const own = new AbortController();
  controller?.abort();
  controller = own;
  busy.value = true;
  error.value = '';
  notice.value = '';
  if (!selectionKeys.has(serviceId)) selectionKeys.set(serviceId, commandKey());
  try {
    const response = await request(
      `/api/v1/conversations/${encodeURIComponent(props.conversationId)}/shipping-quotes/${encodeURIComponent(quote.value.id)}/select`,
      {
        method: 'POST',
        signal: own.signal,
        idempotencyKey: selectionKeys.get(serviceId),
        body: {
          subjectId: target.value.id,
          orderId: order.value.id,
          orderVersion: order.value.version,
          serviceId,
        },
      },
    );
    if (own !== controller) return;
    quote.value = response.data.quote;
    estimateRevision.value += 1;
    notice.value =
      'Frete estimado vinculado ao pedido. O valor final permanece igual.';
    await nextTick();
    draftButton.value?.focus();
  } catch (cause) {
    if (!own.signal.aborted && own === controller) {
      error.value = failure(cause);
      await nextTick();
      errorNotice.value?.focus();
    }
  } finally {
    if (own === controller) busy.value = false;
  }
}
function draft() {
  if (!selected.value || !quote.value || quote.value.stale || props.disabled)
    return;
  const service = selected.value;
  const testLabel =
    quote.value.environment === 'sandbox' ? 'Cotação de teste — Sandbox. ' : '';
  const text = `${testLabel}Frete estimado para ${quote.value.totalPieces} peças: ${service.company} ${service.name}, ${amountLabel(service.priceCents)}, prazo previsto de ${service.deliveryDays} dias úteis. Cotação de ${dateTimeBR(quote.value.createdAt)}, sujeita a nova consulta.`;
  // Native dialog close restores its trigger first. Only then focus the composer.
  dialog.value?.addEventListener('close', () => emit('draft', text), {
    once: true,
  });
  close();
}
watch(fields, invalidate, { flush: 'sync' });
watch(() => [subjectId.value, target.value?.orderId], loadOrder);
watch(
  () => props.revision,
  () => {
    if (target.value) void loadOrder();
  },
);
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      close();
      invalidate();
    }
  },
);
watch(
  () => props.conversationId,
  () => {
    close();
    invalidate();
    orderController?.abort();
    subjectId.value = '';
    order.value = null;
  },
);
onBeforeUnmount(() => {
  controller?.abort();
  orderController?.abort();
});
defineExpose({ open });
</script>

<template>
  <div class="conversation-shipping-action">
    <button
      type="button"
      title="Cotar frete"
      aria-label="Cotar frete"
      :disabled="disabled"
      @click="open($event.currentTarget)"
    >
      <AppIcon name="truck" /><span class="sr-only">Cotar frete</span>
    </button>
    <dialog
      ref="dialog"
      class="conversation-shipping-dialog"
      aria-labelledby="conversation-shipping-title"
      @close="closeWork"
    >
      <div class="conversation-shipping-head">
        <h2 id="conversation-shipping-title">Cotar frete para o pedido</h2>
        <button type="button" @click="close">Fechar cotação</button>
      </div>
      <p id="conversation-shipping-help">
        Escolha o pedido e informe o peso total e as medidas da embalagem
        fechada. A estimativa fica separada do valor final.
      </p>
      <p v-if="!targets.length" role="status">
        Vincule um pedido a um assunto deste atendimento para cotar o frete.
      </p>
      <form
        v-else
        :aria-busy="busy || loadingOrder"
        aria-describedby="conversation-shipping-help"
        @submit.prevent="calculate"
      >
        <label for="shipping-target">Pedido deste atendimento</label>
        <select id="shipping-target" v-model="subjectId" required>
          <option value="">Escolha o pedido</option>
          <option
            v-for="subject in targets"
            :key="subject.id"
            :value="subject.id"
          >
            Pedido {{ subject.orderNumber }} ·
            {{ subject.label || subject.title || 'Assunto do pedido' }}
          </option>
        </select>
        <p v-if="loadingOrder" role="status">Carregando pedido…</p>
        <button
          v-if="target && !order && !loadingOrder"
          type="button"
          @click="loadOrder"
        >
          Carregar pedido novamente
        </button>
        <OrderShippingEstimate
          v-if="order"
          :order-id="order.id"
          :revision="estimateRevision + revision"
          show-empty
        />
        <fieldset
          class="conversation-shipping-fields"
          :disabled="!order || loadingOrder || disabled"
        >
          <legend>Embalagem para a cotação</legend>
          <div
            v-for="field in [
              { key: 'fromPostalCode', label: 'CEP de origem' },
              { key: 'toPostalCode', label: 'CEP de destino' },
            ]"
            :key="field.key"
          >
            <label :for="`conversation-shipping-${field.key}`">{{
              field.label
            }}</label>
            <input
              :id="`conversation-shipping-${field.key}`"
              v-model="fields[field.key]"
              inputmode="numeric"
              autocomplete="off"
              pattern="[0-9]{5}-?[0-9]{3}"
              maxlength="9"
              required
            />
          </div>
          <div v-for="field in fieldDefinitions" :key="field.key">
            <label :for="`conversation-shipping-${field.key}`">{{
              field.label
            }}</label>
            <input
              :id="`conversation-shipping-${field.key}`"
              v-model="fields[field.key]"
              type="number"
              inputmode="numeric"
              min="1"
              :max="field.max"
              step="1"
              required
            />
          </div>
          <div>
            <label for="conversation-shipping-insurance"
              >Valor segurado (R$)</label
            >
            <input
              id="conversation-shipping-insurance"
              v-model="fields.insuranceValue"
              inputmode="decimal"
              maxlength="12"
              required
            />
          </div>
        </fieldset>
        <button
          type="submit"
          class="primary"
          :disabled="busy || loadingOrder || !order || disabled"
        >
          {{ busy ? 'Consultando ou salvando…' : 'Consultar frete' }}
        </button>
      </form>
      <p v-if="error" ref="errorNotice" role="alert" tabindex="-1">
        {{ error }}
      </p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <section v-if="quote" aria-labelledby="conversation-shipping-results">
        <h3
          id="conversation-shipping-results"
          ref="resultsHeading"
          tabindex="-1"
        >
          Opções de frete
        </h3>
        <p v-if="quote.environment === 'sandbox'">Cotação de teste — Sandbox</p>
        <p>{{ quote.totalPieces }} peças · {{ dateTimeBR(quote.createdAt) }}</p>
        <p v-if="quote.stale" role="status">
          Cotação desatualizada. Consulte novamente antes de vincular o frete.
        </p>
        <p v-if="!quote.services.length">
          Nenhum serviço disponível para esta embalagem e estes CEPs.
        </p>
        <ul class="conversation-shipping-services">
          <li v-for="service in quote.services" :key="service.id">
            <p>
              <strong>{{ service.company }} · {{ service.name }}</strong> ·
              {{ amountLabel(service.priceCents) }} ·
              {{ service.deliveryDays }} dias úteis previstos
            </p>
            <button
              type="button"
              :disabled="
                busy ||
                disabled ||
                quote.stale ||
                quote.selectedServiceId === service.id
              "
              @click="selectService(service.id)"
            >
              {{
                quote.selectedServiceId === service.id
                  ? 'Frete vinculado'
                  : `Vincular ${service.name} ao pedido`
              }}
            </button>
          </li>
        </ul>
        <p v-for="service in quote.unavailable" :key="service.id">
          {{ service.name }}: {{ service.message }}
        </p>
        <button
          v-if="selected"
          ref="draftButton"
          type="button"
          :disabled="busy || disabled || quote.stale"
          @click="draft"
        >
          {{
            hasDraft
              ? 'Acrescentar resposta com o frete'
              : 'Escrever resposta com o frete'
          }}
        </button>
      </section>
    </dialog>
  </div>
</template>

<style scoped>
.conversation-shipping-action {
  display: contents;
}
.conversation-shipping-dialog {
  box-sizing: border-box;
  inline-size: min(46rem, calc(100vw - 2rem));
  max-inline-size: calc(100vw - 2rem);
  max-block-size: 90dvh;
  padding: var(--space-4);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow-y: auto;
}
.conversation-shipping-dialog::backdrop {
  background: var(--color-overlay);
}
.conversation-shipping-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.conversation-shipping-head h2 {
  margin: 0;
}
.conversation-shipping-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: var(--space-3);
  margin-block: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.conversation-shipping-fields div {
  display: grid;
  gap: var(--space-1);
  min-inline-size: 0;
}
.conversation-shipping-fields input {
  box-sizing: border-box;
  inline-size: 100%;
  min-inline-size: 0;
}
.conversation-shipping-services {
  display: grid;
  gap: var(--space-3);
  padding: 0;
  list-style: none;
}
.conversation-shipping-services li {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.conversation-shipping-dialog p {
  overflow-wrap: anywhere;
}
</style>
