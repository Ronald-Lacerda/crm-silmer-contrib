<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError, commandKey, upload } from '../../lib/api-client.js';
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
      const file = new globalThis.File(
        [bytes],
        `imagem-${props.media.mediaId}.${extensions[mime]}`,
        { type: mime },
      );
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
onBeforeUnmount(() => controller?.abort());
const failed = ref(false);
const player = ref(null),
  noticeElement = ref(null),
  orderTools = ref(null);
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
  if (
    !value ||
    (!player.value?.contains(document.activeElement) &&
      !orderTools.value?.contains(document.activeElement))
  )
    return;
  await nextTick();
  noticeElement.value?.focus();
});
watch(
  () => [props.media.mediaId, props.media.state, props.media.contentUrl],
  () => {
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
    <img
      v-else-if="media.kind === 'image'"
      ref="player"
      :src="contentUrl"
      alt="Imagem da conversa"
      @error="failed = true"
    />
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
