<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { commandKey, request } from '../lib/api-client.js';
import { dayLabel } from '../lib/order-format.js';

const emit = defineEmits(['confirmed']);
const liveEvent = inject('liveEvent', ref(null));
/** @type {import('vue').Ref<Record<string, any>[]>} */
const items = ref([]);
const loading = ref(true);
const error = ref('');
const announcement = ref('');
const confirming = ref('');
const region = ref(null);
const heading = ref(null);
let controller;
let refreshTimer = 0;
let mounted = true;

async function load() {
  if (confirming.value) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const response = await request('/api/v1/orders/delivery-tasks', {
      signal: current.signal,
    });
    if (controller !== current || !mounted) return;
    items.value = response.data.items;
    error.value = '';
  } catch (cause) {
    if (controller !== current || !mounted || cause?.name === 'AbortError')
      return;
    error.value = 'Não foi possível atualizar seus afazeres de entrega.';
  } finally {
    if (controller === current && mounted) loading.value = false;
  }
}

async function retry() {
  if (loading.value || confirming.value) return;
  await load();
  if (!error.value) heading.value?.focus();
}

/** @param {Record<string, any>} order @param {Event} event */
async function confirm(order, event) {
  const checkbox = /** @type {HTMLInputElement} */ (event.target);
  // Keep the checkbox focusable while the request runs. Repeated Space or
  // clicks cannot issue another command, including from a different row.
  checkbox.checked = confirming.value === order.id;
  if (loading.value || confirming.value || error.value) return;
  confirming.value = order.id;
  announcement.value = '';
  controller?.abort();
  let confirmed = false;
  try {
    await request(
      `/api/v1/orders/${encodeURIComponent(order.id)}/delivery-confirmation`,
      {
        method: 'POST',
        body: { expectedVersion: order.version },
        idempotencyKey: commandKey(),
      },
    );
    if (!mounted) return;
    confirmed = true;
    items.value = items.value.filter((item) => item.id !== order.id);
    announcement.value = `Entrega do pedido ${order.number} confirmada.`;
    emit('confirmed');
    await nextTick();
    const next = region.value?.querySelector('input[type="checkbox"]');
    (next ?? heading.value)?.focus();
  } catch (cause) {
    if (!mounted) return;
    checkbox.checked = false;
    error.value =
      Number(cause?.status) === 409
        ? 'O pedido mudou. Atualize os afazeres antes de confirmar a entrega.'
        : 'Não foi possível confirmar a entrega. Atualize os afazeres e tente novamente.';
    checkbox.focus();
  } finally {
    confirming.value = '';
    if (confirmed && mounted) void load();
  }
}

watch(liveEvent, (event) => {
  if (
    !event?.reset &&
    !['inbox.order.changed', 'inbox.conversation.changed'].includes(event?.type)
  )
    return;
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load();
  }, 250);
});

onMounted(() => void load());
onBeforeUnmount(() => {
  mounted = false;
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <section
    ref="region"
    class="dashboard-section delivery-tasks"
    aria-labelledby="delivery-tasks-title"
  >
    <div class="dashboard-section-head">
      <h2 id="delivery-tasks-title" ref="heading" tabindex="-1">
        Meus afazeres de entrega
      </h2>
    </div>
    <p class="delivery-tasks-hint">
      Marque quando o cliente receber o pedido. A data de hoje será registrada
      em Entregue em.
    </p>
    <div v-if="error" class="audit-note" role="alert">
      <p>{{ error }}</p>
      <button
        type="button"
        :aria-disabled="loading || confirming ? 'true' : undefined"
        @click="retry"
      >
        {{ loading ? 'Atualizando…' : 'Atualizar afazeres' }}
      </button>
    </div>
    <p v-if="loading && !items.length">Carregando afazeres…</p>
    <ul v-else-if="items.length" class="delivery-task-list" role="list">
      <li v-for="order in items" :key="order.id" class="delivery-task">
        <label class="delivery-task-check">
          <input
            type="checkbox"
            :checked="confirming === order.id"
            :aria-disabled="loading || confirming || error ? 'true' : undefined"
            @change="confirm(order, $event)"
          />
          <span>O pedido {{ order.number }} já foi entregue?</span>
        </label>
        <span class="delivery-task-detail">
          <RouterLink :to="`/pedidos/${encodeURIComponent(order.id)}`">
            Ver pedido {{ order.number }}
          </RouterLink>
          <span v-if="order.ficha?.summary?.data_entrega_confirmada">
            Previsto para
            {{ dayLabel(order.ficha.summary.data_entrega_confirmada) }}
          </span>
        </span>
      </li>
    </ul>
    <p v-else-if="!error">Nenhuma entrega para confirmar.</p>
    <p v-if="announcement" class="delivery-task-announcement" role="status">
      {{ announcement }}
    </p>
  </section>
</template>
