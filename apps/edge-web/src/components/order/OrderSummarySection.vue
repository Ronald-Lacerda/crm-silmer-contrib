<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import {
  fabLabel,
  orderSteps,
  quantityWarning,
} from '../../lib/order-format.js';
import OrderIcon from './OrderIcon.vue';
import OrderSheetHead from './OrderSheetHead.vue';

const SECTION = 'summary';

const props = defineProps({
  order: { type: Object, required: true },
});

const editing = inject('orderEditing');
const firstField = ref(null);
const draft = ref({ data_entrega_confirmada: '', nome: '' });
const saving = ref(false);
const errorMessage = ref('');

const isEditing = computed(() => editing.editingSection.value === SECTION);
// PFI-10: a confirmed order is read-only; to change it the seller reopens it.
const canEdit = computed(
  () => editing.canEdit.value && props.order.status === 'pendente',
);
const summary = computed(() => props.order.ficha.summary);
// PIT-09: a warning only when the sizes add up to something other than what
// the customer said (ADR 020: the figure itself is not repeated beside it).
const warning = computed(() => quantityWarning(props.order));
const otherSectionOpen = computed(
  () => editing.editingSection.value !== '' && !isEditing.value,
);
// PFI-18: on a phone the body is shown only while the accordion opens it.
const open = computed(() => editing.isSectionOpen?.(SECTION) ?? true);

/** The stored value is an ISO day; the operation reads dd/mm/yyyy. */
/** @param {unknown} value */
function dateBR(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

// PFI-17: the promised delivery is what this section owes to "Gerar"; the
// server's missingFields says whether it is still missing (PFI-15).
const headState = computed(() => {
  const step = orderSteps(props.order).find((one) => one.key === 'delivery');
  if (step && !step.done) {
    return { text: 'Falta previsão de entrega', tone: 'missing' };
  }
  const day = dateBR(summary.value.data_entrega_confirmada);
  if (day) return { text: `Entrega ${day}`, tone: 'ok' };
  return { text: 'Sem previsão de entrega', tone: 'neutral' };
});

async function startEditing() {
  draft.value = {
    data_entrega_confirmada: summary.value.data_entrega_confirmada ?? '',
    nome: summary.value.nome ?? '',
  };
  errorMessage.value = '';
  editing.start(SECTION);
  await nextTick();
  firstField.value?.focus();
}

function cancel() {
  errorMessage.value = '';
  editing.stop();
}

// ADR 016: "Informar no Resumo" from "Gerar pedido" opens this editor on
// Previsão de entrega; with another section open, it only brings the summary
// into view.
const sheet = ref(null);
watch(
  () => editing.editRequest?.value,
  (request) => {
    if (request?.section !== SECTION || isEditing.value) return;
    if (canEdit.value && !otherSectionOpen.value) {
      void startEditing();
      return;
    }
    sheet.value?.scrollIntoView?.({ block: 'start' });
  },
);

/**
 * PFI-06: the whole section travels in one write. ADR 020: the technique
 * lives on each item, so the summary no longer sends one.
 */
async function save() {
  saving.value = true;
  errorMessage.value = '';
  const result = await editing.save(SECTION, {
    data_entrega_confirmada: draft.value.data_entrega_confirmada.trim() || null,
    nome: draft.value.nome.trim() || null,
  });
  saving.value = false;
  if (result.ok) {
    editing.stop();
    return;
  }
  errorMessage.value = result.message;
}
</script>

<template>
  <section
    ref="sheet"
    class="op-sheet"
    :data-editing="isEditing || undefined"
    aria-labelledby="order-summary-title"
  >
    <OrderSheetHead
      title-id="order-summary-title"
      title="Resumo do pedido"
      :state="headState.text"
      :tone="headState.tone"
      edit-label="Editar resumo"
      :can-edit="canEdit"
      :blocked="otherSectionOpen"
      :editing="isEditing"
      section="summary"
      body-id="order-summary-body"
      @edit="startEditing"
    />

    <p v-if="errorMessage" role="alert" class="op-alert" :hidden="!open">
      {{ errorMessage }}
    </p>

    <form
      v-if="isEditing"
      id="order-summary-body"
      class="op-form"
      :hidden="!open"
      @submit.prevent="save"
    >
      <div class="op-form-grid">
        <div class="op-field">
          <label for="summary-cliente">Cliente</label>
          <div class="op-input-lock">
            <input
              id="summary-cliente"
              :value="summary.cliente"
              type="text"
              disabled
              aria-describedby="summary-cliente-hint"
            />
            <OrderIcon name="lock" />
          </div>
          <p id="summary-cliente-hint" class="op-hint">
            {{
              order.status === 'pendente'
                ? 'Acompanha o cadastro do cliente até gerar o pedido.'
                : 'Nome registrado quando o pedido foi gerado.'
            }}
          </p>
        </div>

        <div class="op-field">
          <label for="summary-entrega">Previsão de entrega</label>
          <input
            id="summary-entrega"
            ref="firstField"
            v-model="draft.data_entrega_confirmada"
            type="date"
            aria-describedby="summary-entrega-hint"
          />
          <p id="summary-entrega-hint" class="op-hint">
            A data combinada com o cliente.
          </p>
        </div>

        <div class="op-field">
          <label for="summary-nome">Nome do pedido</label>
          <input
            id="summary-nome"
            v-model="draft.nome"
            type="text"
            autocomplete="off"
            aria-describedby="summary-nome-hint"
          />
          <p id="summary-nome-hint" class="op-hint">
            Evento, empresa, time ou turma.
          </p>
        </div>
      </div>

      <p class="op-locked-note">
        <OrderIcon name="lock" />
        Calculados pelo sistema: total de peças ({{ order.totalPieces }}),
        vendedor, data do pedido e FAB.
      </p>

      <div class="op-form-actions">
        <button type="button" :disabled="saving" @click="cancel">
          Cancelar
        </button>
        <!-- PFI-13: "Gerar pedido" is the only primary button here. -->
        <button type="submit" class="op-save" :disabled="saving">
          {{ saving ? 'Salvando…' : 'Salvar resumo' }}
        </button>
      </div>
    </form>

    <div v-else id="order-summary-body" class="op-sheet-body" :hidden="!open">
      <dl class="op-summary-main">
        <div>
          <dt>Cliente</dt>
          <dd>
            {{ summary.cliente || '—' }}
            <span v-if="order.conversationId" class="op-origin-note">
              vem da conversa
            </span>
          </dd>
        </div>
        <div>
          <dt>Previsão de entrega</dt>
          <dd class="op-num">
            {{ dateBR(summary.data_entrega_confirmada) || '—' }}
          </dd>
        </div>
        <div>
          <dt>Total de peças</dt>
          <dd class="op-num op-pieces">{{ order.totalPieces }}</dd>
        </div>
      </dl>
      <p v-if="warning" class="op-quantity-warning">
        <OrderIcon name="alert" />{{ warning }}
      </p>
      <dl class="op-summary-meta">
        <div>
          <dt>Nome do pedido</dt>
          <dd>{{ summary.nome || '—' }}</dd>
        </div>
        <div>
          <dt>Vendedor</dt>
          <dd>{{ order.seller?.name || 'sem vendedor' }}</dd>
        </div>
        <div>
          <dt>Data do pedido</dt>
          <dd class="op-num" :data-muted="!order.orderDate || undefined">
            {{ dateBR(order.orderDate) || 'definida ao gerar' }}
          </dd>
        </div>
        <div>
          <dt>FAB</dt>
          <dd>{{ fabLabel(order.fabCode) }}</dd>
        </div>
      </dl>
      <p class="op-hint">
        Total de peças é somado a partir dos tamanhos dos itens. O número do
        pedido já existe desde a criação; a data do pedido é definida ao gerar.
      </p>
    </div>
  </section>
</template>
