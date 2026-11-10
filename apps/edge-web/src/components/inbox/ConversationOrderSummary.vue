<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { request } from '../../lib/api-client.js';
import {
  amountLabel,
  itemPieces,
  missingFieldLabels,
  orderStatusLabel,
} from '../../lib/order-format.js';

/**
 * PCX-12: Detalhes › Pedido. The order beside the conversation, read only:
 * number, status, what is still missing to generate it, items, pieces and
 * amount, with one way into the order page. Every change belongs there.
 */
const props = defineProps({
  conversationId: { type: String, required: true },
  /** The read model's `{id, number, status}`, or null when there is none. */
  order: { type: Object, default: null },
  /** An explicit ready order linked by a subject may differ from the canonical one. */
  readById: { type: Boolean, default: false },
  /** Only a visible panel reads the order. */
  open: { type: Boolean, default: false },
  /** Bumped by the Inbox when the order changed (`inbox.order.changed`). */
  revision: { type: Number, default: 0 },
});

const heading = ref(null);
const detail = ref(null);
const loading = ref(false);
const error = ref('');
let controller;

/** The fuller read wins once it is about the same order. */
const current = computed(() =>
  detail.value && detail.value.id === props.order?.id
    ? detail.value
    : props.order,
);
const statusLabel = computed(() => orderStatusLabel(current.value?.status));
const statusTone = computed(() =>
  current.value?.status === 'confirmado' ? 'success' : 'warning',
);
/** PIT-06: the same words the order page uses for what blocks "Gerar". */
const missingGroups = computed(() => {
  if (detail.value?.status !== 'pendente') return [];
  const groups = new Map();
  for (const field of detail.value.missingFields ?? []) {
    const match = /^items\[(\d+)\]\./u.exec(field);
    const group = match ? `Item ${Number(match[1]) + 1}` : 'Pedido';
    const label = missingFieldLabels([field])[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(label);
  }
  return [...groups].map(([label, fields]) => ({ label, fields }));
});
const items = computed(() =>
  (detail.value?.ficha?.items ?? []).map(
    (/** @type {Record<string, any>} */ item, /** @type {number} */ index) => {
      const type = item.tipo || 'Modelo não informado';
      const collar = item.gola || item.vies_gola;
      return {
        key: `${index}`,
        label: collar ? `${type} · ${collar}` : type,
        pieces: itemPieces(item),
      };
    },
  ),
);
const orderPath = computed(() =>
  props.order
    ? `/pedidos/${encodeURIComponent(props.order.id)}?conversa=${encodeURIComponent(props.conversationId)}`
    : '',
);

async function load() {
  controller?.abort();
  if (!props.open || !props.order) {
    loading.value = false;
    if (!props.order) {
      detail.value = null;
      error.value = '';
    }
    return;
  }
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const response = await request(
      props.readById
        ? `/api/v1/orders/${encodeURIComponent(props.order.id)}`
        : `/api/v1/conversations/${encodeURIComponent(props.conversationId)}/order`,
      { signal: own.signal },
    );
    if (own !== controller) return;
    detail.value = response.data.order ?? null;
    error.value = '';
  } catch (cause) {
    if (own !== controller || /** @type {any} */ (cause)?.name === 'AbortError')
      return;
    detail.value = null;
    error.value = 'Não foi possível carregar o resumo do pedido.';
  } finally {
    if (own === controller) loading.value = false;
  }
}

/** The retry button leaves with the error; focus waits on the heading. */
async function retry() {
  await load();
  await nextTick();
  heading.value?.focus();
}

watch(
  () => [
    props.conversationId,
    props.order?.id,
    props.order?.status,
    props.readById,
    props.revision,
    props.open,
  ],
  (next, previous) => {
    // Another conversation never shows the summary of the one before it.
    if (previous && (next[0] !== previous[0] || next[1] !== previous[1])) {
      detail.value = null;
      error.value = '';
    }
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    class="context-section context-order-summary"
    aria-labelledby="context-order-title"
    :aria-busy="loading"
  >
    <h3 id="context-order-title" ref="heading" tabindex="-1">Pedido</h3>
    <p v-if="!order" class="op-hint">Sem pedido nesta conversa.</p>
    <template v-else>
      <p class="context-order">
        <strong>{{ current.number }}</strong>
        <span class="badge" :data-tone="statusTone">{{ statusLabel }}</span>
      </p>
      <p v-if="loading" class="op-hint" role="status">Carregando pedido…</p>
      <div v-else-if="error" class="context-order-error" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="retry">Tentar novamente</button>
      </div>
      <template v-else-if="detail">
        <ul class="context-order-items" aria-label="Itens do pedido">
          <li v-for="item in items" :key="item.key">
            <span>{{ item.label }}</span>
            <span>{{
              item.pieces > 0 ? `${item.pieces} peças` : 'A definir'
            }}</span>
          </li>
          <li v-if="!items.length">Nenhum item registrado.</li>
        </ul>
        <dl class="context-facts context-order-facts">
          <div>
            <dt>Total de peças</dt>
            <dd>
              {{
                detail.totalPieces > 0
                  ? `${detail.totalPieces} peças`
                  : 'A definir'
              }}
            </dd>
          </div>
          <div>
            <dt>Valor</dt>
            <dd>
              {{
                detail.finalAmountCents > 0
                  ? amountLabel(detail.finalAmountCents)
                  : 'A definir'
              }}
            </dd>
          </div>
        </dl>
        <details v-if="missingGroups.length" class="context-order-missing">
          <summary>Pendências do pedido</summary>
          <div
            v-for="group in missingGroups"
            :key="group.label"
            class="context-order-gap-group"
          >
            <h4>{{ group.label }}</h4>
            <ul>
              <li v-for="field in group.fields" :key="field">{{ field }}</li>
            </ul>
          </div>
        </details>
        <p v-else-if="detail.status === 'pendente'" class="op-hint">
          Pronto para gerar.
        </p>
      </template>
      <div class="inline-actions">
        <RouterLink class="button-link" :to="orderPath"
          >Abrir pedido</RouterLink
        >
      </div>
    </template>
  </section>
</template>
