<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../lib/api-client.js';
import { olistAdminFailure } from '../lib/olist-admin-feedback.js';

// OLIST-T11: explicit, bounded reads. Mapping identity comes from the ledger;
// this panel cannot create, remap, reconcile, or export any ERP entity.
const props = defineProps({ connected: { type: Boolean, required: true } });
const emit = defineEmits(['access-denied']);
const base = '/api/v1/integrations/olist';
const catalogs = [
  { key: 'sellers', label: 'Vendedores' },
  { key: 'warehouses', label: 'Depósitos' },
  { key: 'paymentMethods', label: 'Formas de pagamento' },
  { key: 'receivingMethods', label: 'Formas de recebimento' },
  { key: 'priceLists', label: 'Listas de preços' },
];
const kindLabels = {
  customer: 'Cliente',
  product: 'Produto pai',
  variation: 'Variação de tamanho',
};
const stateLabels = {
  pending: 'Pendente',
  reserved: 'Reservado',
  confirmed: 'Confirmado',
  uncertain: 'Resultado incerto',
  rejected: 'Recusado',
};
const kind = ref('sellers');
const resourceId = ref('');
const items = ref(null);
const mapping = ref(null);
const catalogBusy = ref(false);
const mappingBusy = ref(false);
const catalogError = ref('');
const mappingError = ref('');
const catalogNotice = ref(null);
const mappingNotice = ref(null);
const catalogHeading = ref(null);
const mappingHeading = ref(null);
let catalogController;
let mappingController;
let disposed = false;

/** @param {import('vue').Ref<any>} target */
async function focus(target) {
  await nextTick();
  if (!disposed) target.value?.focus();
}
function clearCatalog() {
  catalogController?.abort();
  catalogController = undefined;
  items.value = null;
  catalogBusy.value = false;
  catalogError.value = '';
}
function clearMapping() {
  mappingController?.abort();
  mappingController = undefined;
  mapping.value = null;
  mappingBusy.value = false;
  mappingError.value = '';
}
watch(kind, clearCatalog, { flush: 'sync' });
watch(resourceId, clearMapping, { flush: 'sync' });
watch(
  () => props.connected,
  () => {
    clearCatalog();
    clearMapping();
  },
  { flush: 'sync' },
);

async function consultCatalog() {
  if (!props.connected || catalogBusy.value) return;
  clearCatalog();
  const own = new AbortController();
  catalogController = own;
  catalogBusy.value = true;
  try {
    const response = await request(`${base}/lookups`, {
      method: 'POST',
      body: { kind: kind.value },
      idempotencyKey: commandKey(),
      signal: own.signal,
    });
    if (
      disposed ||
      own.signal.aborted ||
      catalogController !== own ||
      !props.connected
    )
      return;
    items.value = response.data.items;
    await focus(catalogHeading);
  } catch (cause) {
    if (disposed || own.signal.aborted || catalogController !== own) return;
    if ([401, 403].includes(/** @type {any} */ (cause)?.status)) {
      emit('access-denied');
      return;
    }
    catalogError.value = olistAdminFailure(cause);
    await focus(catalogNotice);
  } finally {
    if (!disposed && catalogController === own) catalogBusy.value = false;
  }
}
async function consultMapping() {
  if (mappingBusy.value) return;
  clearMapping();
  const value = resourceId.value.trim();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value,
    )
  ) {
    mappingError.value =
      'Informe o identificador UUID completo do recurso no CRM.';
    await focus(mappingNotice);
    return;
  }
  const own = new AbortController();
  mappingController = own;
  mappingBusy.value = true;
  try {
    const response = await request(`${base}/mappings`, {
      method: 'POST',
      body: { resourceId: value },
      idempotencyKey: commandKey(),
      signal: own.signal,
    });
    if (disposed || own.signal.aborted || mappingController !== own) return;
    mapping.value = response.data;
    await focus(mappingHeading);
  } catch (cause) {
    if (disposed || own.signal.aborted || mappingController !== own) return;
    if ([401, 403].includes(/** @type {any} */ (cause)?.status)) {
      emit('access-denied');
      return;
    }
    mappingError.value = olistAdminFailure(cause);
    await focus(mappingNotice);
  } finally {
    if (!disposed && mappingController === own) mappingBusy.value = false;
  }
}
onBeforeUnmount(() => {
  disposed = true;
  catalogController?.abort();
  mappingController?.abort();
});
</script>

<template>
  <section
    class="surface olist-mappings"
    aria-labelledby="olist-mappings-title"
  >
    <h2 id="olist-mappings-title">Mapeamentos e referências</h2>
    <p class="field-help">
      Consulte identificadores da conta para conferir os parâmetros comerciais e
      os vínculos registrados no CRM.
    </p>
    <details class="olist-disclosure">
      <summary>Consultar referências no Olist</summary>
      <p v-if="!connected" class="field-help">
        Conecte ou reconecte a empresa para consultar referências no Olist.
      </p>
      <form class="olist-consult-form" @submit.prevent="consultCatalog">
        <div class="olist-field">
          <label for="olist-catalog">Referência comercial</label>
          <select id="olist-catalog" v-model="kind" :disabled="!connected">
            <option
              v-for="catalog in catalogs"
              :key="catalog.key"
              :value="catalog.key"
            >
              {{ catalog.label }}
            </option>
          </select>
        </div>
        <button type="submit" :disabled="!connected || catalogBusy">
          {{ catalogBusy ? 'Consultando…' : 'Consultar referências' }}
        </button>
      </form>
      <p class="field-help">
        Natureza de operação e origem CRM devem ser conferidas diretamente no
        Olist. As consultas aqui não cadastram nem alteram dados.
      </p>
      <p v-if="catalogBusy" role="status">
        Consultando as referências da conta…
      </p>
      <p
        v-if="catalogError"
        ref="catalogNotice"
        class="inline-error"
        role="alert"
        tabindex="-1"
      >
        {{ catalogError }}
      </p>
      <div v-if="items" class="olist-consult-result">
        <h3 ref="catalogHeading" tabindex="-1">
          Referências encontradas: {{ items.length }}
        </h3>
        <p v-if="!items.length">
          Nenhuma referência encontrada nesta categoria.
        </p>
        <ul
          v-else
          class="olist-reference-list"
          tabindex="0"
          aria-label="Referências comerciais da conta"
        >
          <li v-for="item in items" :key="item.id">
            <span>{{ item.name }}</span
            ><span class="field-help">ID: {{ item.id }}</span>
          </li>
        </ul>
      </div>
    </details>
    <details class="olist-disclosure">
      <summary>Consultar mapeamento registrado</summary>
      <p id="olist-resource-help" class="field-help">
        Use o identificador do recurso registrado no CRM, não o ID do cliente ou
        produto no Olist. Esta consulta não altera o vínculo.
      </p>
      <form class="olist-consult-form" @submit.prevent="consultMapping">
        <div class="olist-field">
          <label for="olist-resource">Identificador do recurso no CRM</label>
          <input
            id="olist-resource"
            v-model="resourceId"
            type="text"
            maxlength="36"
            autocomplete="off"
            required
            aria-describedby="olist-resource-help"
            :aria-invalid="mappingError ? 'true' : undefined"
          />
        </div>
        <button type="submit" :disabled="mappingBusy">
          {{ mappingBusy ? 'Consultando…' : 'Consultar mapeamento' }}
        </button>
      </form>
      <p v-if="mappingBusy" role="status">Consultando o vínculo nesta conta…</p>
      <p
        v-if="mappingError"
        ref="mappingNotice"
        class="inline-error"
        role="alert"
        tabindex="-1"
      >
        {{ mappingError }}
      </p>
      <div v-if="mapping" class="olist-consult-result">
        <h3 ref="mappingHeading" tabindex="-1">Mapeamento registrado</h3>
        <dl class="olist-mapping-list">
          <dt>Recurso CRM</dt>
          <dd>{{ mapping.id }}</dd>
          <dt>Tipo</dt>
          <dd>{{ kindLabels[mapping.kind] || 'Tipo indisponível' }}</dd>
          <dt>Situação</dt>
          <dd>{{ stateLabels[mapping.state] || 'Situação indisponível' }}</dd>
          <dt>ID no Olist</dt>
          <dd>{{ mapping.remoteId || 'Ainda não confirmado' }}</dd>
        </dl>
        <p v-if="mapping.state === 'uncertain'" class="field-help">
          Resultado incerto exige reconciliação administrativa antes de qualquer
          nova criação.
        </p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.olist-disclosure {
  margin-block-start: var(--space-4);
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border-subtle);
}
.olist-disclosure summary {
  cursor: pointer;
  min-block-size: var(--target-min);
  align-content: center;
  font-weight: 600;
}
.olist-consult-form {
  display: grid;
  gap: var(--space-4);
  align-items: end;
  margin-block: var(--space-4);
}
.olist-field {
  display: grid;
  gap: var(--space-2);
  min-inline-size: 0;
}
.olist-field label {
  margin: 0;
}
.olist-field input,
.olist-field select {
  inline-size: 100%;
  min-inline-size: 0;
}
.olist-consult-result {
  margin-block-start: var(--space-4);
}
.olist-reference-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-block-size: 24rem;
  overflow-y: auto;
}
.olist-reference-list li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  padding-block: var(--space-3);
  border-block-end: 1px solid var(--color-border-subtle);
  overflow-wrap: anywhere;
}
.olist-mapping-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: var(--space-2) var(--space-4);
}
.olist-mapping-list dt {
  color: var(--color-text-muted);
}
.olist-mapping-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (width >= 48rem) {
  .olist-consult-form {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
