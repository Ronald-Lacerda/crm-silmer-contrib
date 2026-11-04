<script setup>
import { computed } from 'vue';
import { assistantOf } from '../../lib/assistant-performance.js';
import {
  deliveryFailureCode,
  deliveryFailureHint,
} from '../../lib/delivery-failure.js';

// INBOX-DELIVERY-01 / MSG-02/03: a status check never authorizes a new send.
// INBOX-DELIVERY-02: the agent's messages carry their own failure code too.
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
const technicalCode = computed(() =>
  deliveryFailureCode(props.message.deliveryErrorCode),
);
const technicalHint = computed(() =>
  deliveryFailureHint(props.message.deliveryErrorCode),
);
// OPS-INBOX-SEND-06: only a known pre-send failure can say it was not sent.
const recipientFailure = computed(() =>
  props.message.deliveryStatus === 'failed' ? technicalCode.value : null,
);
const fromAssistant = computed(() => props.message.authorKind === 'assistant');
const title = computed(() => {
  if (uncertain.value) return 'Ainda não conseguimos confirmar o envio';
  if (recipientFailure.value === 'EVOLUTION_RECIPIENT_NOT_FOUND')
    return 'WhatsApp não reconheceu este número';
  if (recipientFailure.value === 'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE')
    return 'Não foi possível verificar o número no WhatsApp';
  return fromAssistant.value
    ? `A resposta ${assistantOf()} não foi enviada`
    : 'O envio encontrou um problema';
});
const description = computed(() => {
  if (recipientFailure.value === 'EVOLUTION_RECIPIENT_NOT_FOUND')
    return 'A mensagem não foi enviada. Confira o telefone do cliente antes de enviar outra mensagem.';
  if (recipientFailure.value === 'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE')
    return 'A mensagem não foi enviada porque a verificação do número não pôde ser concluída. Verifique o status atualizado antes de tentar outra mensagem.';
  if (fromAssistant.value) {
    return uncertain.value
      ? `A confirmação desta resposta ${assistantOf()} está demorando. Verifique o envio antes de repetir a informação ao cliente.`
      : `O cliente pode não ter recebido esta resposta ${assistantOf()}. Verifique o status atualizado; se for preciso, assuma o atendimento e responda.`;
  }
  return uncertain.value
    ? 'A confirmação está demorando mais que o esperado. Verifique o envio antes de repetir a mensagem para evitar duplicidade.'
    : 'O envio encontrou um problema. Verifique o status atualizado. Se o problema continuar, informe a referência abaixo ao suporte.';
});

function check() {
  if (!props.checking) emit('check');
}
</script>

<template>
  <div v-if="visible" class="message-delivery-notice">
    <p class="message-delivery-notice__title">
      <strong>{{ title }}</strong>
    </p>
    <p :id="descriptionId">{{ description }}</p>
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
      <p v-if="technicalHint">{{ technicalHint }}</p>
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
