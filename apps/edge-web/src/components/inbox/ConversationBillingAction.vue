<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { request } from '../../lib/api-client.js';
import { openDialog } from '../../lib/ui.js';
import AppIcon from '../AppIcon.vue';
import OrderBillingWorkspace from '../order/OrderBillingWorkspace.vue';

const props = defineProps({
  conversationId: { type: String, required: true },
  conversationVersion: { type: Number, required: true },
  destinationLabel: { type: String, default: '' },
  subjects: { type: Array, default: () => [] },
  linkedOrder: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
  revision: { type: Number, default: 0 },
});
const dialog = ref(null);
const orderId = ref('');
const order = ref(null);
const loading = ref(false);
const error = ref('');
let controller;
const targets = computed(() => [
  ...new Map(
    [
      ...(props.linkedOrder?.id
        ? [
            {
              orderId: props.linkedOrder.id,
              orderNumber: props.linkedOrder.number,
              label: 'Pedido vinculado à conversa',
            },
          ]
        : []),
      ...props.subjects.filter((subject) => subject.orderId),
    ].map((target) => [target.orderId, target]),
  ).values(),
]);
async function open(event) {
  if (props.disabled) return;
  openDialog(dialog.value, event.currentTarget);
  await nextTick();
  dialog.value?.querySelector('select')?.focus();
}
async function loadOrder() {
  controller?.abort();
  order.value = null;
  error.value = '';
  if (!orderId.value) return;
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(orderId.value)}`,
      { signal: own.signal },
    );
    if (!own.signal.aborted) {
      if (
        response.data.order.status !== 'confirmado' ||
        response.data.order.origin === 'loja'
      )
        error.value =
          'Escolha um pedido de atendimento confirmado para consultar as cobranças.';
      else order.value = response.data.order;
    }
  } catch {
    if (!own.signal.aborted)
      error.value =
        'Não foi possível carregar o pedido. Escolha-o novamente para tentar.';
  } finally {
    if (own === controller) loading.value = false;
  }
}
watch(orderId, loadOrder);
watch(
  () => props.revision,
  () => {
    if (orderId.value) void loadOrder();
  },
);
watch(
  () => props.conversationId,
  () => {
    controller?.abort();
    dialog.value?.close();
    orderId.value = '';
    order.value = null;
  },
);
watch(
  () => props.disabled,
  (value) => {
    if (value) dialog.value?.close();
  },
);
onBeforeUnmount(() => {
  controller?.abort();
  dialog.value?.close();
});
</script>

<template>
  <div class="conversation-billing-action">
    <button
      type="button"
      title="Cobranças e pagamentos"
      aria-label="Cobranças e pagamentos"
      :disabled="disabled"
      @click="open"
    >
      <AppIcon name="credit-card" /><span class="sr-only"
        >Cobranças e pagamentos</span
      >
    </button>
    <Teleport to="body"
      ><dialog
        ref="dialog"
        class="conversation-billing-dialog"
        aria-labelledby="conversation-billing-title"
      >
        <div class="conversation-billing-head">
          <h2 id="conversation-billing-title">Cobranças e pagamentos</h2>
          <button type="button" @click="dialog?.close()">
            Fechar cobranças
          </button>
        </div>
        <p>
          Escolha o pedido deste atendimento. Confira o destino e o valor antes
          de enviar uma cobrança.
        </p>
        <p v-if="!targets.length" role="status">
          Vincule um pedido confirmado a um assunto deste atendimento para
          consultar as cobranças.
        </p>
        <template v-else>
          <label for="conversation-billing-order"
            >Pedido deste atendimento</label
          >
          <select id="conversation-billing-order" v-model="orderId">
            <option value="">Escolha o pedido</option>
            <option
              v-for="target in targets"
              :key="target.orderId"
              :value="target.orderId"
            >
              Pedido {{ target.orderNumber }} ·
              {{ target.label || target.title || 'Assunto do pedido' }}
            </option>
          </select>
          <p v-if="loading" role="status">Carregando pedido…</p>
          <p v-if="error" role="alert">{{ error }}</p>
          <OrderBillingWorkspace
            v-if="order"
            :key="order.id"
            :order="order"
            :conversation-id="conversationId"
            :conversation-version="conversationVersion"
            :destination-label="destinationLabel"
            :disabled="disabled"
          />
        </template></dialog
    ></Teleport>
  </div>
</template>

<style scoped>
.conversation-billing-action {
  display: contents;
}
.conversation-billing-dialog {
  box-sizing: border-box;
  inline-size: min(46rem, calc(100vw - 2rem));
  max-inline-size: calc(100vw - 2rem);
  max-block-size: 90dvh;
  overflow-y: auto;
  padding: var(--space-4);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.conversation-billing-dialog::backdrop {
  background: var(--color-overlay);
}
.conversation-billing-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.conversation-billing-head h2 {
  margin: 0;
}
.conversation-billing-dialog select {
  box-sizing: border-box;
  inline-size: 100%;
  margin-block: var(--space-2) var(--space-4);
}
.conversation-billing-dialog p {
  overflow-wrap: anywhere;
}
.conversation-billing-dialog button {
  min-block-size: 44px;
}
</style>
