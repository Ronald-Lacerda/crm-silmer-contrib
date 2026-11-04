<script setup>
import { computed, inject } from 'vue';
import { nextOrderStep, orderSteps } from '../../lib/order-format.js';
import OrderIcon from './OrderIcon.vue';
import AppHint from '../AppHint.vue';

/*
 * PFI-15 (RFC 024): the real progress to generate the order, at the top of
 * the page. The steps come from the server's missingFields only, and only the
 * next one has a button. On a phone that button lives in the fixed footer
 * (PFI-16), so this list only says where the order stands.
 */
const props = defineProps({
  order: { type: Object, required: true },
});

const editing = inject('orderEditing');
const steps = computed(() => orderSteps(props.order));
const next = computed(() => nextOrderStep(props.order));
const doneCount = computed(
  () => steps.value.filter((step) => step.done).length,
);
// RFC 024 (≤ 1.800 px on a phone): with every step done the list only
// repeats "pronto", so the progress folds into one line. It is never shown
// as ready while the server still lists a blocker (next is null only then).
const ready = computed(() => steps.value.length > 0 && next.value === null);
// PFI-06: one section in edit at a time; the step waits for Salvar or
// Cancelar and says so, instead of disappearing.
const sectionOpen = computed(() => editing.editingSection.value !== '');

function goToNext() {
  if (sectionOpen.value || !next.value) return;
  void editing.goToSection(next.value.section);
}
</script>

<template>
  <section
    class="op-progress"
    aria-labelledby="order-progress-title"
    :data-ready="ready || undefined"
  >
    <div class="op-progress-head">
      <!-- Ready: the heading stays for headings navigation; the line says it. -->
      <h2 id="order-progress-title" :class="{ 'op-visually-hidden': ready }">
        Para gerar o pedido
      </h2>
      <p
        role="status"
        class="op-progress-count op-num"
        :data-ready="ready || undefined"
      >
        <template v-if="ready">
          <span class="op-progress-mark" aria-hidden="true"
            ><OrderIcon name="check"
          /></span>
          Tudo pronto para gerar · {{ doneCount }} de {{ steps.length }}
        </template>
        <template v-else>
          {{ doneCount }} de {{ steps.length }} prontos
        </template>
      </p>
    </div>

    <ol v-if="!ready" class="op-progress-steps">
      <li
        v-for="(step, index) in steps"
        :key="step.key"
        :data-done="step.done || undefined"
        :aria-current="step.key === next?.key ? 'step' : undefined"
      >
        <span class="op-progress-mark" aria-hidden="true">
          <OrderIcon v-if="step.done" name="check" />
          <template v-else>{{ index + 1 }}</template>
        </span>
        <span class="op-progress-text">
          <span class="op-progress-label">{{ step.label }}</span>
          <span class="op-progress-state">{{
            step.done ? 'pronto' : step.missing
          }}</span>
        </span>
        <div v-if="step.key === next?.key" class="op-progress-action">
          <button
            type="button"
            class="primary op-progress-go"
            :aria-disabled="sectionOpen || undefined"
            :aria-describedby="
              sectionOpen ? 'order-progress-reason' : undefined
            "
            @click="goToNext"
          >
            {{ step.action }}
          </button>
          <AppHint v-if="sectionOpen" id="order-progress-reason" tone="warning">
            Salve ou cancele a edição aberta.
          </AppHint>
        </div>
      </li>
    </ol>

    <p v-if="!ready" class="op-progress-note">
      Valor e forma de pagamento: você informa ao gerar o pedido.
    </p>
  </section>
</template>
