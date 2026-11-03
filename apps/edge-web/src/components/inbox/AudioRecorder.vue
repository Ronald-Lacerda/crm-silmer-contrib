<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import MediaComposer from './MediaComposer.vue';
const props = defineProps({
  conversationId: { type: String, required: true },
  expectedVersion: { type: Number, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['sent', 'sending-change']);
const startButton = ref(null),
  stopButton = ref(null);
const state = ref('idle'),
  error = ref(''),
  seconds = ref(0);
const recording = ref(/** @type {File|null} */ (null));
const sending = ref(false);
const active = computed(() =>
  ['requesting', 'recording', 'stopping'].includes(state.value),
);
/** @type {MediaStream|null} */ let stream = null;
/** @type {MediaRecorder|null} */ let recorder = null;
/** @type {ReturnType<typeof setInterval>|null} */ let timer = null;
let generation = 0;
const limit = 16 * 1024 * 1024;
function stopTracks() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (timer !== null) clearInterval(timer);
  timer = null;
}
function clear() {
  generation++;
  if (recorder?.state !== 'inactive') recorder?.stop();
  recorder = null;
  stopTracks();
  recording.value = null;
  state.value = 'idle';
  error.value = '';
  seconds.value = 0;
}
async function discard() {
  if (sending.value) return;
  clear();
  await nextTick();
  startButton.value?.focus();
}
function stop() {
  if (!recorder || recorder.state === 'inactive') return;
  state.value = 'stopping';
  recorder.stop();
  stopTracks();
}
async function start() {
  if (props.disabled || active.value || sending.value) return;
  clear();
  const token = generation;
  if (
    !globalThis.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    !globalThis.MediaRecorder
  ) {
    error.value =
      'Gravação indisponível neste navegador. Você pode anexar um arquivo de áudio.';
    return;
  }
  state.value = 'requesting';
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== generation || props.disabled) {
      acquired.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquired;
    // Support claims can fail at construction/start. Keep the recorder's actual MIME.
    let capture = null;
    for (const mimeType of [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
    ]) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        capture = new MediaRecorder(acquired, { mimeType });
        break;
      } catch {
        /* Try the next approved container. */
      }
    }
    if (!capture)
      throw new DOMException(
        'Unsupported recording format',
        'NotSupportedError',
      );
    recorder = capture;
    const chunks = /** @type {Blob[]} */ ([]);
    let size = 0,
      invalid = false;
    capture.addEventListener('dataavailable', (event) => {
      if (token !== generation || invalid || !event.data.size) return;
      size += event.data.size;
      if (size > limit) {
        invalid = true;
        error.value =
          'A gravação ultrapassou 16 MiB. Grave novamente ou anexe outro áudio.';
        stop();
        return;
      }
      chunks.push(event.data);
      if (size === limit) stop();
    });
    capture.addEventListener('error', () => {
      if (token !== generation) return;
      invalid = true;
      error.value =
        'Não foi possível gravar. Você pode anexar um arquivo de áudio.';
      stop();
      stopTracks();
      state.value = 'idle';
    });
    capture.addEventListener('stop', async () => {
      if (token !== generation) return;
      stopTracks();
      recorder = null;
      if (invalid || !size) {
        state.value = 'idle';
        if (!invalid)
          error.value =
            'A gravação está vazia. Grave novamente ou anexe um áudio.';
        await nextTick();
        startButton.value?.focus();
        return;
      }
      const mimeType = capture.mimeType;
      const extension = {
        'audio/webm': 'webm',
        'audio/ogg': 'ogg',
        'audio/mp4': 'm4a',
      }[mimeType.split(';')[0].trim().toLowerCase()];
      if (!extension) {
        state.value = 'idle';
        error.value = 'Formato de gravação indisponível. Anexe um áudio.';
        return;
      }
      recording.value = new File(chunks, `gravacao.${extension}`, {
        type: mimeType,
      });
      state.value = 'review';
    });
    capture.start(250);
    const started = performance.now();
    state.value = 'recording';
    timer = setInterval(() => {
      seconds.value = Math.min(
        300,
        Math.floor((performance.now() - started) / 1000),
      );
      if (performance.now() - started >= 300000) stop();
    }, 250);
    await nextTick();
    stopButton.value?.focus();
  } catch (cause) {
    if (token !== generation) return;
    stopTracks();
    recorder = null;
    state.value = 'idle';
    error.value =
      /** @type {Record<string, string>} */ ({
        NotAllowedError:
          'Acesso ao microfone negado. Você pode anexar um arquivo de áudio.',
        NotFoundError:
          'Nenhum microfone foi encontrado. Conecte um microfone e confira o dispositivo de entrada do sistema.',
        NotReadableError:
          'Não foi possível acessar o microfone. Confira o dispositivo de entrada e o acesso ao microfone nas configurações do sistema.',
        SecurityError:
          'Este navegador bloqueou o acesso ao microfone. Permita o microfone ou abra o chat no Chrome ou Edge.',
        NotSupportedError:
          'Este navegador não conseguiu iniciar o gravador de áudio. Abra o chat no Chrome ou Edge ou anexe um áudio.',
        AbortError:
          'A abertura do microfone foi interrompida. Tente gravar novamente.',
      })[cause?.name] ??
      'Não foi possível iniciar a gravação. Você pode anexar um arquivo de áudio.';
    await nextTick();
    startButton.value?.focus();
  }
}
function sent(data) {
  clear();
  emit('sent', data);
}
function recordingDismissed() {
  recording.value = null;
  state.value = 'idle';
  error.value = '';
}
function sendingChanged(value) {
  sending.value = value;
  emit('sending-change', value);
}
watch(() => [props.conversationId, props.expectedVersion], clear);
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && active.value) clear();
  },
);
onBeforeUnmount(clear);
</script>
<template>
  <section
    aria-label="Gravar áudio"
    class="audio-recorder"
    @keydown.esc="discard"
  >
    <MediaComposer
      :conversation-id="conversationId"
      :expected-version="expectedVersion"
      :disabled="disabled || active"
      :recording="recording"
      @sending-change="sendingChanged"
      @recording-dismissed="recordingDismissed"
      @sent="sent"
    >
      <template #message
        ><slot name="message" :recording-active="active"
      /></template>
      <template #send><slot name="send" :recording-active="active" /></template>
      <template #tools>
        <slot name="tools" :disabled="disabled || active || sending" />
        <button
          ref="startButton"
          type="button"
          title="Gravar áudio"
          aria-label="Gravar áudio"
          :disabled="disabled || active || sending"
          @click="start"
        >
          <AppIcon name="mic" />
        </button>
        <button
          v-if="state === 'recording'"
          ref="stopButton"
          type="button"
          aria-label="Parar gravação"
          title="Parar gravação"
          @click="stop"
        >
          <AppIcon name="square" />
        </button>
        <button
          v-if="active || recording"
          type="button"
          aria-label="Descartar gravação"
          title="Descartar gravação"
          :disabled="sending"
          @click="discard"
        >
          <AppIcon name="trash" />
        </button>
      </template>
      <template #recording-status>
        <p v-if="state !== 'idle'" role="status" aria-live="polite">
          {{
            state === 'requesting'
              ? 'Aguardando permissão do microfone.'
              : state === 'recording'
                ? 'Gravando áudio. Pare para revisar.'
                : state === 'review'
                  ? 'Ouça a gravação e envie quando quiser.'
                  : 'Finalizando gravação…'
          }}
        </p>
        <p v-if="state === 'recording'" aria-live="off">
          {{ seconds }} de 300 segundos
        </p>
        <p v-if="error" role="alert">{{ error }}</p>
      </template>
    </MediaComposer>
  </section>
</template>
<style scoped>
.audio-recorder {
  display: grid;
  gap: var(--space-3);
}
</style>
