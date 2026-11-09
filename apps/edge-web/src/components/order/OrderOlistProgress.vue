<script setup>
import { computed, ref, watch } from 'vue';
import {
  deriveOlistProgress,
  progressAnnouncement,
} from '../../lib/olist-progress.js';

const props = defineProps({
  orderId: { type: String, required: true },
  crmNumber: { type: String, default: '' },
  /** Projeção mínima: {state, stage, number, errorCode?}. */
  operation: { type: Object, default: null },
  /** Recursos do diagnóstico administrativo; só admin recebe. */
  resources: { type: Array, default: null },
});

const progress = computed(() =>
  deriveOlistProgress(props.operation, props.resources),
);
const heading = ref(null);
const announcement = ref('');
// Só a mudança relevante é anunciada; a lista de etapas nunca é relida.
watch(progress, (next, previous) => {
  const text = progressAnnouncement(previous, next);
  if (text) announcement.value = text;
});
defineExpose({ focus: () => heading.value?.focus() });
</script>

<template>
  <section
    v-if="progress"
    class="olist-progress"
    :aria-labelledby="`olist-progress-${orderId}`"
    :data-kind="progress.kind"
  >
    <h3 :id="`olist-progress-${orderId}`" ref="heading" tabindex="-1">
      Progresso no Olist
    </h3>
    <p class="olist-progress-headline">
      {{ progress.headline
      }}<span v-if="progress.saleNumber">
        · Venda {{ progress.saleNumber }}</span
      >
    </p>
    <ol class="olist-steps" aria-label="Etapas da operação Olist">
      <li
        v-for="(step, index) in progress.steps"
        :key="step.key"
        class="olist-step"
        :data-status="step.status"
        :data-step="step.key"
      >
        <span class="olist-step-mark" aria-hidden="true">{{
          step.status === 'done' ? '✓' : index + 1
        }}</span>
        <div class="olist-step-body">
          <p class="olist-step-title">
            <strong>{{ step.label }}</strong>
            <span class="olist-step-status">{{ step.statusLabel }}</span>
          </p>
          <p v-if="step.detail" class="field-help">{{ step.detail }}</p>
        </div>
      </li>
    </ol>
    <p
      v-for="line in progress.guidance"
      :key="line"
      class="olist-progress-guidance"
    >
      {{ line }}
    </p>
    <dl v-if="progress.done" class="olist-progress-numbers">
      <div v-if="crmNumber">
        <dt>Pedido CRM</dt>
        <dd>{{ crmNumber }}</dd>
      </div>
      <div>
        <dt>Venda Olist</dt>
        <dd>{{ progress.saleNumber ?? 'Número não informado' }}</dd>
      </div>
      <div v-if="progress.origin === 'linked'">
        <dt>Origem</dt>
        <dd>Vinculada a uma venda que já existia no Olist</dd>
      </div>
    </dl>
    <p v-if="progress.done" class="field-help">
      Venda enviada ou vinculada: o pedido não pode ser editado, reaberto nem
      gerado de novo. Nenhuma ação deste painel altera a venda no Olist.
    </p>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </section>
</template>

<style scoped>
.olist-progress {
  display: grid;
  gap: var(--space-3);
  min-inline-size: 0;
}
.olist-progress h3 {
  margin-block: 0;
}
.olist-progress h3:focus {
  outline: none;
}
.olist-progress h3:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.olist-progress p {
  margin: 0;
}
.olist-steps {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.olist-step {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
}
.olist-step-mark {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border: 2px solid var(--color-border-strong);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
  background: var(--color-surface);
}
.olist-step-body {
  min-inline-size: 0;
}
.olist-step-title {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  align-items: baseline;
  overflow-wrap: anywhere;
}
.olist-step-status {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.olist-step .field-help {
  margin-block-start: var(--space-1);
  overflow-wrap: anywhere;
}
.olist-step[data-status='done'] .olist-step-mark {
  border-color: var(--status-success-text);
  background: var(--status-success-surface);
  color: var(--status-success-text);
}
.olist-step[data-status='done'] .olist-step-status {
  color: var(--status-success-text);
}
.olist-step[data-status='active'] .olist-step-mark {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.olist-step[data-status='active'] .olist-step-status {
  color: var(--color-text);
}
.olist-step[data-status='blocked'] .olist-step-mark,
.olist-step[data-status='invalidated'] .olist-step-mark {
  border-color: var(--status-warning-text);
  background: var(--status-warning-surface);
  color: var(--status-warning-text);
}
.olist-step[data-status='blocked'] .olist-step-status,
.olist-step[data-status='invalidated'] .olist-step-status {
  color: var(--status-warning-text);
  font-weight: 600;
}
.olist-step[data-status='rejected'] .olist-step-mark {
  border-color: var(--status-error-text);
  background: var(--status-error-surface);
  color: var(--status-error-text);
}
.olist-step[data-status='rejected'] .olist-step-status {
  color: var(--status-error-text);
  font-weight: 600;
}
.olist-progress-guidance {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}
.olist-progress-numbers {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}
.olist-progress-numbers dt {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.olist-progress-numbers dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: no-preference) {
  .olist-step[data-status='active'] .olist-step-mark {
    animation: olist-step-pulse 2.4s ease-in-out infinite;
  }
}
@keyframes olist-step-pulse {
  50% {
    box-shadow: 0 0 0 4px var(--color-focus-halo);
  }
}
@media (width >= 48rem) {
  .olist-progress-numbers {
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }
}
</style>
