<script setup>
import { computed } from 'vue';

// INBOX-DELIVERY-01 / MSG-02/03: a status check never authorizes a new send.
const props = defineProps({
  message: { type: Object, required: true },
  checking: { type: Boolean, default: false },
  checkFailed: { type: Boolean, default: false },
});
const emit = defineEmits(['check']);

const visible = computed(() =>
  ['failed', 'outcome_unknown'].includes(props.message.deliveryStatus),
);
const uncertain = computed(
  () => props.message.deliveryStatus === 'outcome_unknown',
);
const descriptionId = computed(
  () => `message-delivery-help-${props.message.id}`,
);
const technicalCode = computed(() => {
  const code = props.message.deliveryErrorCode;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code
    : null;
});

function check() {
  if (!props.checking) emit('check');
}
</script>

<template>
  <div v-if="visible" class="message-delivery-notice">
    <p class="message-delivery-notice__title">
      <strong>{{
        uncertain
          ? 'Ainda não conseguimos confirmar o envio'
          : 'O envio encontrou um problema'
      }}</strong>
    </p>
    <p :id="descriptionId">
      {{
        uncertain
          ? 'A confirmação está demorando mais que o esperado. Verifique o envio antes de repetir a mensagem para evitar duplicidade.'
          : 'O envio encontrou um problema. Verifique o status atualizado. Se o problema continuar, informe a referência abaixo ao suporte.'
      }}
    </p>
    <button
      type="button"
      :aria-describedby="descriptionId"
      :aria-disabled="checking || undefined"
      :aria-busy="checking || undefined"
      @click="check"
    >
      {{
        checking
          ? 'Verificando…'
          : checkFailed
            ? 'Tentar novamente'
            : 'Verificar envio'
      }}
    </button>
    <details>
      <summary>Detalhes para suporte</summary>
      <p>
        Referência: <code>{{ message.id }}</code>
      </p>
      <p v-if="technicalCode">
        Código técnico: <code>{{ technicalCode }}</code>
      </p>
    </details>
  </div>
</template>

<style scoped>
.message-delivery-notice {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--text-sm);
}
.message-delivery-notice p {
  margin: 0;
}
.message-delivery-notice__title {
  color: var(--status-warning-text);
}
.message-delivery-notice button {
  justify-self: start;
  min-block-size: var(--target-min);
}
.message-delivery-notice summary {
  min-block-size: var(--target-min);
  align-content: center;
  cursor: pointer;
}
.message-delivery-notice details {
  min-width: 0;
  color: var(--color-text-muted);
}
.message-delivery-notice details p + p {
  margin-top: var(--space-1);
}
.message-delivery-notice code {
  overflow-wrap: anywhere;
}
</style>
