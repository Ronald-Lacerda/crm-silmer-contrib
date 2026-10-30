<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
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
        <span>Ampliar imagem</span>
      </button>
      <div ref="imageTools" class="media-message__actions">
        <button
          type="button"
          :aria-disabled="downloading || undefined"
          :aria-busy="downloading || undefined"
          @click="downloadImage"
        >
          {{ downloading ? 'Baixando imagem…' : 'Baixar imagem' }}
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
            <button type="button" @click="closeImage">Fechar imagem</button>
            <button
              type="button"
              :aria-disabled="downloading || undefined"
              :aria-busy="downloading || undefined"
              @click="downloadImage"
            >
              {{ downloading ? 'Baixando imagem…' : 'Baixar imagem' }}
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
    <audio
      v-else-if="media.kind === 'audio'"
      ref="player"
      :src="contentUrl"
      controls
      preload="metadata"
      aria-label="Áudio da conversa"
      @error="failed = true"
    ></audio>
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
      v-if="!unavailable && media.kind === 'image' && orders.length"
      ref="orderTools"
      class="media-message__order"
    >
      <label :for="selectionId">Anexar imagem ao pedido</label>
      <select :id="selectionId" v-model="orderId" :disabled="saving">
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
  display: grid;
  gap: var(--space-2);
  max-width: 100%;
  padding: var(--space-2);
  cursor: zoom-in;
}
.media-message__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
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
