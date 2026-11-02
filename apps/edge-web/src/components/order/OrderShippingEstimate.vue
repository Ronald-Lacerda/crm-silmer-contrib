<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { request } from '../../lib/api-client.js';
import { amountLabel } from '../../lib/order-format.js';
import { dateTimeBR } from '../../lib/format.js';

const props = defineProps({
  orderId: { type: String, required: true },
  revision: { type: Number, default: 0 },
  showEmpty: { type: Boolean, default: false },
});
const quote = ref(null);
const loading = ref(false);
const error = ref('');
let controller;
const selected = computed(() =>
  quote.value?.services?.find(
    (service) => service.id === quote.value.selectedServiceId,
  ),
);
async function load() {
  controller?.abort();
  controller = undefined;
  error.value = '';
  if (!props.orderId) return;
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.orderId)}/shipping-quote`,
      { signal: own.signal },
    );
    if (!own.signal.aborted && own === controller) {
      quote.value = response.data.quote;
    }
  } catch (cause) {
    if (!own.signal.aborted && own === controller)
      error.value = 'Não foi possível consultar o frete estimado.';
  } finally {
    if (own === controller) loading.value = false;
  }
}
watch(
  () => [props.orderId, props.revision],
  (next, previous) => {
    if (!previous || next[0] !== previous[0]) quote.value = null;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    v-if="showEmpty || selected"
    class="shipping-estimate surface"
    aria-label="Frete estimado"
    :aria-busy="loading"
  >
    <h3>Frete estimado</h3>
    <p v-if="loading" role="status">Consultando frete estimado…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="load">
        Tentar consultar frete novamente
      </button>
    </div>
    <template v-else-if="quote && selected">
      <p v-if="quote.environment === 'sandbox'" class="shipping-stale">
        Cotação de teste — Sandbox
      </p>
      <p>
        <strong>{{ selected.company }} · {{ selected.name }}</strong> ·
        {{ amountLabel(selected.priceCents) }} ·
        {{ selected.deliveryDays }} dias úteis previstos
      </p>
      <p>
        {{ quote.totalPieces }} peças · Cotado por {{ quote.createdBy.name }} em
        {{ dateTimeBR(quote.createdAt) }}.
      </p>
      <p v-if="quote.stale" class="shipping-stale" role="status">
        Cotação desatualizada. Consulte novamente antes de combinar o frete.
      </p>
      <p class="op-hint">
        Estimativa separada do valor final do pedido. Preço e prazo sujeitos a
        nova consulta.
      </p>
    </template>
    <p v-else class="op-hint">Nenhum frete estimado vinculado ao pedido.</p>
  </section>
</template>

<style scoped>
.shipping-estimate {
  padding: var(--space-4);
  margin-block: var(--space-3);
}
.shipping-estimate h3 {
  margin-block-start: 0;
}
.shipping-estimate p {
  overflow-wrap: anywhere;
}
.shipping-stale {
  font-weight: 600;
}
</style>
