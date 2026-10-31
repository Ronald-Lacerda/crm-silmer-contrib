<script setup>
import { computed, ref, watch } from 'vue';
import { messageTranscript } from '../../lib/message-transcript.js';

/**
 * INBOX-AUDIO-TRANSCRIPT-01: under the audio player, what the automatic
 * transcription understood. Selectable text; a long one opens in place and
 * the focus stays on the button. A failed transcription is a quiet note,
 * never an alert: the audio is still there.
 */
const props = defineProps({
  messageId: { type: String, required: true },
  transcript: { type: Object, default: null },
});

const expanded = ref(false);
const view = computed(() => messageTranscript(props.transcript));
const textId = computed(() => `message-transcript-${props.messageId}`);

watch(
  () => props.messageId,
  () => {
    expanded.value = false;
  },
);
</script>

<template>
  <div v-if="view" class="message-transcript">
    <template v-if="view.status === 'ok'">
      <p class="message-transcript__label">Transcrição automática</p>
      <p :id="textId" class="message-transcript__text">
        {{ view.long && !expanded ? view.preview : view.text }}
      </p>
      <button
        v-if="view.long"
        type="button"
        class="link-button"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-controls="textId"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Mostrar menos' : 'Ler transcrição completa' }}
      </button>
    </template>
    <p v-else class="message-transcript__failed">
      Não foi possível transcrever este áudio. Ouça a gravação.
    </p>
  </div>
</template>

<style scoped>
.message-transcript {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}
.message-transcript p {
  margin: 0;
}
.message-transcript__label {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}
.message-transcript__text {
  overflow-wrap: anywhere;
  white-space: pre-line;
  user-select: text;
}
.message-transcript__failed {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.message-transcript button {
  justify-self: start;
  min-block-size: var(--target-min);
}
</style>
