<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import { ApiError, commandKey, upload } from '../../lib/api-client.js';
import { openDialog } from '../../lib/ui.js';
import {
  filesUrl,
  thumbnailFor,
  uploadErrorMessage,
} from '../../lib/order-files.js';

const props = defineProps({
  media: { type: Object, required: true },
  orders: { type: Array, default: () => [] },
});
const orderId = ref('');
const saving = ref(false);
const saveError = ref('');
const saved = ref('');
const selectionId = `media-order-${globalThis.crypto.randomUUID()}`;
let controller;
let downloadController;
const viewer = ref(null);
const expanded = ref(false);
const downloading = ref(false);
const downloadError = ref('');
const downloadUrls = new Map();
const orderFormOpen = ref(false);
const orderToggle = ref(null);
const orderSelect = ref(null);
const audioElement = ref(null);
const playing = ref(false);
const duration = ref(0);
const currentTime = ref(0);
const volume = ref(1);
const volumeOpen = ref(false);
const volumeToggle = ref(null);
watch(volume, (value) => {
  if (audioElement.value) audioElement.value.volume = value;
});
async function closeVolume() {
  volumeOpen.value = false;
  await nextTick();
  volumeToggle.value?.focus();
}
const audioPercent = computed(() =>
  duration.value ? (currentTime.value / duration.value) * 100 : 0,
);
const clockTime = (value) => {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
function audioProgress() {
  const audio = audioElement.value;
  if (!audio) return;
  duration.value = Number.isFinite(audio.duration) ? audio.duration : 0;
  currentTime.value = audio.currentTime;
}
async function toggleAudio() {
  const audio = audioElement.value;
  if (!audio) return;
  if (!audio.paused) return audio.pause();
  try {
    await audio.play();
  } catch {
    failed.value = true;
  }
}
function seekAudio(event) {
  if (!audioElement.value || !duration.value) return;
  audioElement.value.currentTime =
    (Number(event.target.value) / 100) * duration.value;
  audioProgress();
}
function changeVolume(event) {
  volume.value = Number(event.target.value);
  if (audioElement.value) audioElement.value.volume = volume.value;
}
async function toggleOrderForm() {
  if (saving.value) return;
  orderFormOpen.value = !orderFormOpen.value;
  await nextTick();
  (orderFormOpen.value ? orderSelect.value : orderToggle.value)?.focus();
}

function openImage(event) {
  if (unavailable.value || !viewer.value) return;
  expanded.value = true;
  openDialog(viewer.value, event.currentTarget);
}
function closeImage() {
  expanded.value = false;
  viewer.value?.close();
}
function closeOnBackdrop(event) {
  if (event.target === viewer.value) closeImage();
}
function containFocus(event) {
  if (event.key !== 'Tab') return;
  const buttons = viewer.value?.querySelectorAll('button');
  const first = buttons?.[0];
  const last = buttons?.[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
function clearDownload() {
  downloadController?.abort();
  downloading.value = false;
  downloadError.value = '';
  for (const [url, timer] of downloadUrls) {
    globalThis.clearTimeout(timer);
    globalThis.URL.revokeObjectURL(url);
  }
  downloadUrls.clear();
}
async function imageFile(signal) {
  const response = await globalThis.fetch(contentUrl.value, {
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new ApiError(response.status, {});
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const mime = (response.headers.get('Content-Type') ?? '')
    .split(';')[0]
    .trim();
  if (!(mime in extensions))
    throw new ApiError(415, { code: 'FILE_TYPE_NOT_ALLOWED' });
  const bytes = await response.blob();
  if (!bytes.size || bytes.size > 5 * 1024 * 1024)
    throw new Error('Invalid image size');
  return new globalThis.File(
    [bytes],
    `imagem-${props.media.mediaId}.${extensions[mime]}`,
    { type: mime },
  );
}
async function downloadImage() {
  if (downloading.value || unavailable.value) return;
  downloading.value = true;
  downloadError.value = '';
  downloadController = new AbortController();
  const signal = downloadController.signal;
  try {
    const file = await imageFile(signal);
    signal.throwIfAborted();
    const url = globalThis.URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    // Keep the URL alive while the browser starts the download.
    downloadUrls.set(
      url,
      globalThis.setTimeout(() => {
        globalThis.URL.revokeObjectURL(url);
        downloadUrls.delete(url);
      }, 60_000),
    );
  } catch (cause) {
    if (signal.aborted) return;
    downloadError.value = [401, 403].includes(cause?.status)
      ? 'Sem permissão para baixar esta imagem. Atualize a conversa.'
      : [404, 410].includes(cause?.status)
        ? 'Esta imagem não está mais disponível para baixar.'
        : 'Não foi possível baixar a imagem. Tente novamente.';
  } finally {
    if (!signal.aborted) downloading.value = false;
  }
}
// Reuse the exact form and key after a lost response; a retry must not add
// another reference or regenerate a different thumbnail under the same key.
const attempts = new Map();
const selectedOrder = computed(() =>
  props.orders.find((order) => order.id === orderId.value),
);
async function attachToOrder() {
  if (saving.value || unavailable.value || !selectedOrder.value) return;
  const target = selectedOrder.value;
  saving.value = true;
  saveError.value = '';
  saved.value = '';
  controller = new AbortController();
  const signal = controller.signal;
  try {
    let attempt = attempts.get(target.id);
    if (!attempt) {
      const file = await imageFile(signal);
      const form = new globalThis.FormData();
      form.append('slot', 'reference');
      form.append('file', file, file.name);
      const thumbnail = await thumbnailFor(file);
      if (thumbnail) form.append('thumbnail', thumbnail, 'thumbnail.webp');
      signal.throwIfAborted();
      attempt = { form, key: commandKey() };
      attempts.set(target.id, attempt);
    }
    await upload(filesUrl(target.id), attempt.form, {
      idempotencyKey: attempt.key,
      signal,
    });
    signal.throwIfAborted();
    saved.value = `Imagem anexada ao pedido ${target.number}.`;
  } catch (cause) {
    if (signal.aborted) return;
    saveError.value = [404, 410].includes(cause?.status)
      ? 'Esta imagem não está mais disponível para anexar.'
      : uploadErrorMessage(cause, 'Imagem da conversa');
  } finally {
    if (!signal.aborted) saving.value = false;
  }
}
onBeforeUnmount(() => {
  closeImage();
  controller?.abort();
  clearDownload();
});
const failed = ref(false);
const player = ref(null),
  noticeElement = ref(null),
  orderTools = ref(null),
  imageTools = ref(null);
const contentUrl = computed(() => {
  const url = props.media.contentUrl;
  return typeof url === 'string' &&
    /^\/api\/v1\/conversations\/[^/?#]+\/media\/[^/?#]+\/content$/.test(url)
    ? url
    : null;
});
const unavailable = computed(
  () => failed.value || !contentUrl.value || props.media.state !== 'attached',
);
const notice = computed(() =>
  props.media.state === 'lost'
    ? 'Arquivo perdido. O histórico da mensagem foi preservado.'
    : props.media.state === 'missing'
      ? 'Imagem recebida sem arquivo disponível. O histórico foi preservado.'
      : 'Arquivo indisponível no momento.',
);
watch(unavailable, async (value) => {
  if (!value) return;
  const moveFocus =
    viewer.value?.open ||
    player.value?.contains(document.activeElement) ||
    imageTools.value?.contains(document.activeElement) ||
    orderTools.value?.contains(document.activeElement);
  closeImage();
  clearDownload();
  if (!moveFocus) return;
  await nextTick();
  noticeElement.value?.focus();
});
watch(
  () => props.orders.map((order) => order.id),
  async (ids) => {
    if (ids.length) {
      if (orderId.value && !ids.includes(orderId.value)) orderId.value = '';
      return;
    }
    const moveFocus =
      orderTools.value?.contains(document.activeElement) ||
      document.activeElement === orderToggle.value;
    orderFormOpen.value = false;
    orderId.value = '';
    if (!moveFocus) return;
    await nextTick();
    if (unavailable.value) noticeElement.value?.focus();
    else player.value?.querySelector('button')?.focus();
  },
);
watch(
  () => [
    props.media.mediaId,
    props.media.kind,
    props.media.state,
    props.media.contentUrl,
  ],
  () => {
    closeImage();
    clearDownload();
    controller?.abort();
    attempts.clear();
    saving.value = false;
    saved.value = '';
    saveError.value = '';
    orderId.value = '';
    orderFormOpen.value = false;
    playing.value = false;
    duration.value = 0;
    currentTime.value = 0;
    volume.value = 1;
    volumeOpen.value = false;
    failed.value = false;
  },
);
</script>

<template>
  <section class="media-message" aria-label="Mídia da mensagem">
    <p
      v-if="unavailable"
      ref="noticeElement"
      tabindex="-1"
      role="status"
      aria-live="polite"
    >
      {{ notice }}
    </p>
    <div v-else-if="media.kind === 'image'" ref="player">
      <button
        type="button"
        class="media-message__preview"
        aria-label="Ampliar imagem"
        aria-haspopup="dialog"
        @click="openImage"
      >
        <img
          :src="contentUrl"
          alt="Imagem da conversa"
          @error="failed = true"
        />
        <span class="media-message__expand" aria-hidden="true"
          ><AppIcon name="maximize"
        /></span>
      </button>
      <div ref="imageTools" class="media-message__actions">
        <button
          type="button"
          class="media-message__icon"
          aria-label="Baixar imagem"
          title="Baixar imagem"
          :aria-disabled="downloading || undefined"
          :aria-busy="downloading || undefined"
          @click="downloadImage"
        >
          <AppIcon name="download" />
        </button>
        <button
          v-if="orders.length"
          ref="orderToggle"
          type="button"
          class="media-message__icon"
          aria-label="Anexar imagem ao pedido"
          title="Anexar imagem ao pedido"
          :aria-expanded="orderFormOpen"
          :aria-controls="`${selectionId}-form`"
          @click="toggleOrderForm"
        >
          <AppIcon name="paperclip" />
        </button>
        <p v-if="downloadError" role="alert">{{ downloadError }}</p>
      </div>
      <dialog
        ref="viewer"
        class="media-message__viewer"
        aria-label="Imagem ampliada"
        @click="closeOnBackdrop"
        @close="expanded = false"
        @keydown="containFocus"
      >
        <div class="media-message__viewer-panel">
          <div class="media-message__actions">
            <button
              type="button"
              class="media-message__icon"
              aria-label="Fechar imagem"
              title="Fechar imagem"
              @click="closeImage"
            >
              <AppIcon name="close" />
            </button>
            <button
              type="button"
              class="media-message__icon"
              aria-label="Baixar imagem"
              title="Baixar imagem"
              :aria-disabled="downloading || undefined"
              :aria-busy="downloading || undefined"
              @click="downloadImage"
            >
              <AppIcon name="download" />
            </button>
          </div>
          <p v-if="downloadError" role="alert">{{ downloadError }}</p>
          <img
            v-if="expanded"
            :src="contentUrl"
            alt="Imagem da conversa ampliada"
            @error="failed = true"
          />
        </div>
      </dialog>
    </div>
    <div
      v-else-if="media.kind === 'audio'"
      ref="player"
      class="media-message__audio"
      role="group"
      aria-label="Mensagem de voz"
    >
      <audio
        ref="audioElement"
        :src="contentUrl"
        preload="metadata"
        aria-label="Áudio da conversa"
        @loadedmetadata="audioProgress"
        @durationchange="audioProgress"
        @timeupdate="audioProgress"
        @play="playing = true"
        @pause="playing = false"
        @ended="playing = false"
        @error="failed = true"
      ></audio>
      <button
        type="button"
        class="media-message__play"
        :aria-label="
          playing ? 'Pausar mensagem de voz' : 'Reproduzir mensagem de voz'
        "
        :title="playing ? 'Pausar' : 'Reproduzir'"
        @click="toggleAudio"
      >
        <AppIcon :name="playing ? 'pause' : 'play'" />
      </button>
      <input
        class="media-message__seek"
        type="range"
        min="0"
        max="100"
        step="0.1"
        :value="audioPercent"
        aria-label="Posição da mensagem de voz"
        :aria-valuetext="`${clockTime(currentTime)} de ${clockTime(duration)}`"
        :disabled="!duration"
        @input="seekAudio"
      />
      <span class="media-message__time">{{
        clockTime(playing || currentTime ? currentTime : duration)
      }}</span>
      <div
        class="media-message__volume"
        @keydown.esc.stop.prevent="closeVolume"
      >
        <button
          ref="volumeToggle"
          type="button"
          class="media-message__icon"
          aria-label="Volume da mensagem de voz"
          title="Volume"
          :aria-expanded="volumeOpen"
          @click="volumeOpen = !volumeOpen"
        >
          <AppIcon :name="volume ? 'volume' : 'volume-muted'" />
        </button>
        <label v-if="volumeOpen" class="media-message__volume-control"
          >Volume<input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="volume"
            aria-label="Volume"
            @input="changeVolume"
        /></label>
      </div>
    </div>
    <video
      v-else-if="media.kind === 'video'"
      ref="player"
      :src="contentUrl"
      controls
      preload="metadata"
      aria-label="Vídeo da conversa"
      @error="failed = true"
    ></video>
    <div
      v-if="
        !unavailable && media.kind === 'image' && orders.length && orderFormOpen
      "
      :id="`${selectionId}-form`"
      ref="orderTools"
      class="media-message__order"
      @keydown.esc.stop.prevent="toggleOrderForm"
    >
      <label :for="selectionId">Anexar imagem ao pedido</label>
      <select
        :id="selectionId"
        ref="orderSelect"
        v-model="orderId"
        :disabled="saving"
      >
        <option value="">Selecione o pedido</option>
        <option v-for="order in orders" :key="order.id" :value="order.id">
          {{ order.number }}
        </option>
      </select>
      <button
        type="button"
        :aria-disabled="saving || !selectedOrder ? 'true' : undefined"
        :aria-busy="saving || undefined"
        @click="attachToOrder"
      >
        {{ saving ? 'Anexando imagem…' : 'Anexar ao pedido' }}
      </button>
      <p v-if="saved" role="status">{{ saved }}</p>
      <p v-if="saveError" role="alert">{{ saveError }}</p>
    </div>
  </section>
</template>

<style scoped>
.media-message {
  min-width: 0;
}
.media-message__order {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.media-message__preview {
  position: relative;
  display: block;
  width: 15rem;
  max-width: 100%;
  padding: 0;
  overflow: hidden;
  background: var(--color-surface-raised);
  border: 0;
  border-radius: var(--radius-md);
  cursor: zoom-in;
}
.media-message__preview img {
  width: 100%;
  max-height: 15rem;
  object-fit: cover;
  border-radius: inherit;
}
.media-message__expand {
  position: absolute;
  inset-inline-end: var(--space-2);
  inset-block-end: var(--space-2);
  display: grid;
  place-items: center;
  width: var(--space-8);
  height: var(--space-8);
  color: var(--color-text);
  background: var(--color-surface);
  border-radius: var(--radius-sm);
}
.media-message .app-icon {
  width: var(--space-4);
  height: var(--space-4);
}
.media-message .media-message__icon,
.media-message .media-message__play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-inline-size: var(--control-height);
  min-block-size: var(--control-height);
  padding: var(--space-2);
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
}
.media-message .media-message__play {
  color: var(--color-link);
  background: var(--color-selected);
  border-radius: var(--radius-pill);
}
.media-message__audio {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  inline-size: 18rem;
  max-inline-size: 100%;
}
.media-message__audio audio {
  display: none;
}
.media-message__seek {
  flex: 1;
  min-inline-size: 3rem;
  inline-size: 100%;
  margin: 0;
  padding: 0;
  accent-color: var(--color-link);
}
.media-message__time {
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.media-message__volume {
  position: relative;
}
.media-message__volume-control {
  position: absolute;
  inset-inline-end: 0;
  inset-block-end: 100%;
  z-index: 1;
  display: grid;
  gap: var(--space-2);
  inline-size: 9rem;
  padding: var(--space-3);
  color: var(--color-text);
  font-size: var(--text-xs);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.media-message__volume-control input {
  min-inline-size: 0;
  inline-size: 100%;
  padding: 0;
  accent-color: var(--color-link);
}
.media-message__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.media-message button {
  min-block-size: var(--target-min);
}
.media-message__viewer {
  box-sizing: border-box;
  width: calc(100% - var(--space-4));
  max-width: 80rem;
  max-height: calc(100dvh - var(--space-4));
  margin: auto;
  padding: var(--space-4);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.media-message__viewer::backdrop {
  background: var(--color-overlay);
}
.media-message__viewer-panel {
  display: grid;
  gap: var(--space-3);
}
.media-message__viewer img {
  width: 100%;
  max-height: 75dvh;
}
@media (pointer: coarse) {
  .media-message .media-message__icon,
  .media-message .media-message__play {
    min-inline-size: var(--target-min);
    min-block-size: var(--target-min);
  }
  .media-message__seek {
    min-block-size: var(--target-min);
  }
}
img,
video {
  display: block;
  max-width: 100%;
  max-height: 20rem;
  object-fit: contain;
}
audio {
  max-width: 100%;
}
</style>
