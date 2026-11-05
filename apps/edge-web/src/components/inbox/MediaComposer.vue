<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import { ApiError, commandKey, request } from '../../lib/api-client.js';
import { openDialog } from '../../lib/ui.js';

const props = defineProps({
  conversationId: { type: String, required: true },
  expectedVersion: { type: Number, required: true },
  disabled: { type: Boolean, default: false },
  recording: { type: Object, default: null },
});
const emit = defineEmits(['sent', 'sending-change', 'recording-dismissed']);
const inputId = useId(),
  captionId = useId(),
  statusId = useId();
const fileInput = ref(null),
  attachButton = ref(null),
  captionInput = ref(null),
  sendButton = ref(null);
const previewViewer = ref(null);
const previewExpanded = ref(false);
function openPreview(event) {
  previewExpanded.value = true;
  if (previewViewer.value) openDialog(previewViewer.value, event.currentTarget);
}
function closePreview() {
  previewExpanded.value = false;
  previewViewer.value?.close();
}
const file = ref(/** @type {File|null} */ (null)),
  preview = ref(''),
  kind = ref(''),
  caption = ref('');
const state = ref('empty'),
  error = ref(''),
  mediaId = ref('');
const fileOrigin = ref('attachment');
/** @type {{conversationId:string,expectedVersion:number,uploadKey:string}|null} */ let context =
  null;
/** @type {{key:string,body:Record<string,any>}|null} */ let sendAttempt = null;
/** @type {AbortController|null} */ let controller = null;
let generation = 0;
const captionLength = computed(() => Array.from(caption.value).length);
const busy = computed(() =>
  ['uploading', 'processing', 'sending'].includes(state.value),
);
watch(
  () => state.value === 'sending',
  (sending) => emit('sending-change', sending),
  { immediate: true },
);
const sendAllowed = computed(
  () =>
    !props.disabled &&
    !busy.value &&
    state.value === 'ready' &&
    Boolean(mediaId.value) &&
    (kind.value === 'audio' || captionLength.value <= 1024),
);
const status = computed(
  () =>
    ({
      empty: '',
      selected: 'Revise o anexo antes de enviar.',
      uploading: 'Carregando anexo…',
      processing: 'Validando arquivo…',
      ready: 'Pronto para enviar.',
      sending: 'Enviando anexo…',
      rejected: 'Arquivo rejeitado. Remova e escolha outro.',
      blocked: 'Envio recusado. O rascunho foi preservado para revisão.',
      error: 'Não foi possível concluir. A prévia foi preservada.',
    })[state.value],
);
const mimeHints = Object.freeze({
  'image/jpeg': 'image',
  'image/png': 'image',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'video/mp4': 'video',
});
const extensionHints = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
});
/** @param {File} candidate */
function hint(candidate) {
  const normalized = ['audio/m4a', 'audio/x-m4a'].includes(candidate.type)
    ? 'audio/mp4'
    : candidate.type;
  const mime = Object.hasOwn(mimeHints, normalized)
    ? normalized
    : extensionHints[candidate.name.split('.').at(-1)?.toLowerCase()];
  return mime ? { mime, kind: mimeHints[mime] } : null;
}
function cancel() {
  generation++;
  controller?.abort();
  controller = null;
}
function clear() {
  closePreview();
  cancel();
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = '';
  file.value = null;
  kind.value = '';
  caption.value = '';
  mediaId.value = '';
  fileOrigin.value = 'attachment';
  error.value = '';
  state.value = 'empty';
  context = null;
  sendAttempt = null;
  if (fileInput.value) fileInput.value.value = '';
}
async function remove() {
  clear();
  emit('recording-dismissed');
  await nextTick();
  attachButton.value?.focus();
}
/** @param {Event} event */
async function selectFile(event) {
  const files = Array.from(
    /** @type {HTMLInputElement} */ (event.target).files ?? [],
  );
  clear();
  emit('recording-dismissed');
  if (!files?.length) return;
  if (files.length !== 1) {
    error.value = 'Selecione apenas um arquivo.';
    return;
  }
  await selectCandidate(files[0]);
}
/** @param {File} selected @param {string} [origin] */
async function selectCandidate(selected, origin = 'attachment') {
  const actualMime = selected.type.split(';')[0].trim().toLowerCase();
  const declaration =
    origin === 'recording' &&
    ['audio/webm', 'audio/ogg', 'audio/mp4'].includes(actualMime)
      ? { mime: selected.type, kind: 'audio' }
      : hint(selected);
  if (!declaration) {
    error.value = 'Escolha JPEG, PNG, MP3, OGG, M4A ou MP4.';
    return;
  }
  const limit = (declaration.kind === 'image' ? 5 : 16) * 1024 * 1024;
  if (selected.size < 1 || selected.size > limit) {
    error.value = `O arquivo deve ter até ${declaration.kind === 'image' ? 5 : 16} MiB e não pode estar vazio.`;
    return;
  }
  // Browser MIME/extension is only a declaration hint. The worker validates
  // actual bytes, format and codecs before this draft can ever be sent.
  file.value =
    selected.type === declaration.mime
      ? selected
      : new File([selected], selected.name, {
          type: declaration.mime,
          lastModified: selected.lastModified,
        });
  kind.value = declaration.kind;
  fileOrigin.value = origin;
  preview.value = URL.createObjectURL(file.value);
  context = {
    conversationId: props.conversationId,
    expectedVersion: props.expectedVersion,
    uploadKey: commandKey(),
  };
  state.value = 'selected';
  await nextTick();
  captionInput.value?.focus();
  void prepare();
}
/** @param {number} token */
function current(token) {
  return (
    token === generation &&
    !props.disabled &&
    context?.conversationId === props.conversationId
  );
}
/** @param {AbortSignal} signal */
function delay(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Cancelado', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(undefined);
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** @param {number} token @param {AbortSignal} signal @param {string} conversationId */
async function poll(token, signal, conversationId) {
  // Local processing permits 340 seconds plus storage/database I/O. Bound the
  // complete polling attempt while preserving the media ID for a later refresh.
  const deadline = Date.now() + 600000;
  const polling = new AbortController();
  const abort = () => polling.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => polling.abort(new Error('MEDIA_PROCESSING_TIMEOUT')),
    600000,
  );
  try {
    while (current(token)) {
      if (Date.now() > deadline) throw new Error('MEDIA_PROCESSING_TIMEOUT');
      const { data } = await request(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/media/${encodeURIComponent(mediaId.value)}`,
        { signal: polling.signal },
      );
      if (!current(token)) return;
      if (data.state === 'ready') {
        state.value = 'ready';
        await nextTick();
        // Background validation must not interrupt editing or playback.
        if (
          document.activeElement === document.body ||
          document.activeElement === attachButton.value
        )
          sendButton.value?.focus();
        return;
      }
      if (['rejected', 'unavailable', 'lost', 'expired'].includes(data.state)) {
        const retryable = /** @type {Record<string, string>} */ ({
          stale_signatures:
            'A verificação de segurança está temporariamente indisponível. Aguarde a atualização do serviço e tente validar novamente.',
          scanner_unavailable:
            'A verificação de segurança está temporariamente indisponível. Tente validar novamente em alguns instantes.',
          storage_unavailable:
            'O armazenamento está temporariamente indisponível. Tente validar novamente em alguns instantes.',
          processing_failed:
            'Não foi possível concluir a validação. Tente validar novamente em alguns instantes.',
        })[data.reason];
        if (data.state === 'unavailable' && typeof retryable === 'string') {
          state.value = 'error';
          error.value = retryable;
          return;
        }
        state.value = 'rejected';
        error.value =
          data.reason === 'invalid_format'
            ? 'Formato inválido. Escolha outro arquivo.'
            : 'Arquivo indisponível. Escolha outro arquivo.';
        return;
      }
      if (!['uploaded', 'processing'].includes(data.state))
        throw new Error('MEDIA_INVALID_STATE');
      state.value = 'processing';
      await delay(polling.signal);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
async function prepare() {
  if (props.disabled || busy.value || !file.value || !context) return;
  cancel();
  const token = generation;
  controller = new AbortController();
  const signal = controller.signal;
  const captured = context;
  error.value = '';
  state.value = 'uploading';
  try {
    if (!mediaId.value) {
      const form = new FormData();
      form.set('kind', kind.value);
      form.set('origin', fileOrigin.value);
      form.set('expectedVersion', String(captured.expectedVersion));
      form.set('file', file.value, file.value.name);
      const { data } = await request(
        `/api/v1/conversations/${encodeURIComponent(captured.conversationId)}/media`,
        {
          method: 'POST',
          body: form,
          idempotencyKey: captured.uploadKey,
          signal,
        },
      );
      if (!current(token)) return;
      if (typeof data.mediaId !== 'string' || !data.mediaId)
        throw new Error('MEDIA_INVALID_RESPONSE');
      mediaId.value = data.mediaId;
    }
    await poll(token, signal, captured.conversationId);
  } catch (cause) {
    if (!current(token) || cause?.name === 'AbortError') return;
    state.value = 'error';
    error.value =
      {
        401: 'Sua sessão expirou. Entre novamente para anexar o arquivo.',
        403: 'Você não pode anexar arquivos nesta conversa. Verifique o responsável pelo atendimento.',
        404: 'Anexos estão indisponíveis neste ambiente. O arquivo foi preservado.',
        413: 'O arquivo ultrapassa o limite permitido. Escolha um arquivo menor.',
        429: 'Há muitos arquivos sendo carregados. Aguarde um pouco e tente novamente.',
        503: 'O serviço de anexos está temporariamente indisponível. Tente novamente.',
      }[cause?.status] ??
      'Não foi possível carregar ou validar o anexo. Tente novamente.';
  } finally {
    if (token === generation) controller = null;
  }
}
async function send() {
  if (!sendAllowed.value || !context) return;
  sendAttempt ??= {
    key: commandKey(),
    body: {
      expectedVersion: context.expectedVersion,
      messageType: kind.value,
      content:
        kind.value === 'audio'
          ? { mediaId: mediaId.value }
          : { mediaId: mediaId.value, caption: caption.value },
      reason: 'Envio humano de anexo',
    },
  };
  cancel();
  const token = generation;
  controller = new AbortController();
  const captured = context,
    attempt = sendAttempt;
  state.value = 'sending';
  error.value = '';
  try {
    const { data } = await request(
      `/api/v1/conversations/${encodeURIComponent(captured.conversationId)}/messages`,
      {
        method: 'POST',
        body: attempt.body,
        idempotencyKey: attempt.key,
        signal: controller.signal,
      },
    );
    if (!current(token)) return;
    clear();
    emit('sent', data);
    await nextTick();
    attachButton.value?.focus();
  } catch (cause) {
    if (!current(token) || cause?.name === 'AbortError') return;
    state.value = 'ready';
    error.value =
      'Não foi possível confirmar o envio. Tente novamente para consultar o mesmo envio.';
    if (
      cause instanceof ApiError &&
      cause.problem.accepted === false &&
      cause.code === 'NON_PRODUCTION_CONVERSATION'
    ) {
      error.value =
        'Esta conversa é de teste e não envia mensagens pelo WhatsApp.';
      state.value = 'blocked';
      return;
    }
    // Only the API's explicit refusal contract permits distinguishing a
    // rejected command from an uncertain request. Never render server details.
    if (
      cause instanceof ApiError &&
      cause.problem.accepted === false &&
      [
        'INVALID_REQUEST',
        'INBOX_INVALID',
        'INBOX_FORBIDDEN',
        'FORBIDDEN',
        'INBOX_CONFLICT',
      ].includes(cause.code)
    ) {
      const refusal = /** @type {Record<number, string>} */ ({
        400: 'O anexo ou a legenda foi recusado. Remova o anexo, revise o arquivo e selecione novamente antes de enviar.',
        401: 'Sua sessão expirou. Entre novamente antes de tentar o mesmo envio.',
        403: 'Este envio não é permitido. Verifique o responsável pelo atendimento e a disponibilidade dos anexos antes de tentar novamente.',
        404: 'A conversa ou o serviço de anexos não está disponível. Remova o anexo e confira a conversa antes de selecionar novamente.',
        409: 'A conversa ou o anexo mudou. Remova o anexo, atualize a conversa e selecione novamente antes de enviar.',
        413: 'O arquivo ultrapassa o limite permitido. Remova o anexo e escolha um arquivo menor.',
        422: 'O anexo ou a legenda foi recusado. Remova o anexo, revise o arquivo e selecione novamente antes de enviar.',
        429: 'Há muitos envios em andamento. Aguarde um pouco antes de tentar o mesmo envio.',
      })[cause.status];
      if (refusal) {
        error.value = refusal;
        if ([400, 404, 409, 413, 422].includes(cause.status))
          state.value = 'blocked';
      }
    }
  } finally {
    if (token === generation) controller = null;
  }
}
watch(
  () => [props.conversationId, props.expectedVersion],
  () => clear(),
);
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      cancel();
      if (busy.value) {
        // An aborted message request can already have committed. Keep its
        // immutable attempt eligible for an explicit idempotent retry.
        state.value = sendAttempt ? 'ready' : 'error';
        error.value = 'Envio indisponível nesta conversa.';
      }
    }
  },
);
onBeforeUnmount(() => clear());
watch(
  () => props.recording,
  async (recording) => {
    if (!recording && fileOrigin.value !== 'recording') return;
    clear();
    if (recording instanceof File)
      await selectCandidate(recording, 'recording');
  },
);
</script>

<template>
  <section class="media-composer" aria-label="Anexar mídia" :aria-busy="busy">
    <input
      :id="inputId"
      ref="fileInput"
      type="file"
      class="media-composer__file-input"
      aria-label="Arquivo para anexar"
      accept=".jpg,.jpeg,.png,.mp3,.ogg,.m4a,.mp4,image/jpeg,image/png,audio/mpeg,audio/ogg,audio/mp4,video/mp4"
      :disabled="disabled || state === 'sending'"
      :aria-describedby="statusId"
      @change="selectFile"
    />
    <div v-if="file" class="media-composer__review">
      <div class="media-composer__file-heading">
        <p>
          <span class="media-composer__filename" :title="file.name">{{
            file.name
          }}</span>
          <small>{{ (file.size / 1024 / 1024).toFixed(2) }} MiB</small>
        </p>
        <button
          type="button"
          class="media-composer__remove"
          :disabled="state === 'sending'"
          aria-label="Remover anexo"
          @click="remove"
        >
          <AppIcon name="close" />
        </button>
      </div>
      <template v-if="kind === 'image'">
        <button
          type="button"
          class="media-composer__image"
          aria-label="Ampliar prévia do anexo"
          aria-haspopup="dialog"
          @click="openPreview"
        >
          <img :src="preview" alt="Prévia do anexo" /><span aria-hidden="true"
            ><AppIcon name="maximize"
          /></span>
        </button>
        <dialog
          ref="previewViewer"
          class="media-composer__viewer"
          aria-label="Prévia ampliada do anexo"
          @close="previewExpanded = false"
          @click="
            (event) => {
              if (event.target === previewViewer) closePreview();
            }
          "
        >
          <button
            type="button"
            class="media-composer__remove"
            aria-label="Fechar prévia ampliada"
            @click="closePreview"
          >
            <AppIcon name="close" /></button
          ><img
            v-if="previewExpanded"
            :src="preview"
            alt="Prévia ampliada do anexo"
          />
        </dialog>
      </template>
      <audio
        v-else-if="kind === 'audio'"
        :src="preview"
        controls
        preload="metadata"
        aria-label="Prévia do áudio"
      ></audio>
      <video
        v-else
        :src="preview"
        controls
        preload="metadata"
        aria-label="Prévia do vídeo"
      ></video>
      <template v-if="kind !== 'audio'">
        <label class="media-composer__sr-only" :for="captionId">Legenda</label>
        <textarea
          :id="captionId"
          ref="captionInput"
          v-model="caption"
          placeholder="Adicione uma legenda…"
          rows="1"
          :disabled="disabled || state === 'sending' || Boolean(sendAttempt)"
          :aria-invalid="captionLength > 1024"
          :aria-describedby="`${captionId}-count`"
        ></textarea>
        <p
          :id="`${captionId}-count`"
          :class="{ 'media-composer__sr-only': captionLength < 900 }"
        >
          {{ captionLength }}/1024 caracteres
        </p>
      </template>
    </div>
    <slot v-else name="message" />
    <slot name="recording-status" />
    <p v-if="status" :id="statusId" role="status" aria-live="polite">
      {{ status }}
    </p>
    <p v-if="error" role="alert" class="media-composer__error">{{ error }}</p>
    <div class="media-composer__toolbar">
      <div class="media-composer__tools">
        <button
          ref="attachButton"
          type="button"
          title="Anexar arquivo"
          aria-label="Anexar arquivo"
          :disabled="disabled || state === 'sending'"
          :aria-describedby="status ? statusId : undefined"
          @click="fileInput?.click()"
        >
          <AppIcon name="paperclip" />
        </button>
        <slot name="tools" />
      </div>
      <div class="media-composer__actions">
        <button
          v-if="file && state === 'error' && !sendAttempt"
          type="button"
          :disabled="disabled || busy"
          @click="prepare"
        >
          {{ mediaId ? 'Atualizar validação' : 'Tentar carregar novamente' }}
        </button>
        <button
          v-if="file"
          ref="sendButton"
          type="button"
          class="primary"
          :disabled="!sendAllowed"
          :aria-label="
            state === 'blocked'
              ? 'Envio indisponível'
              : sendAttempt
                ? 'Tentar enviar novamente'
                : 'Enviar anexo'
          "
          :title="
            state === 'blocked'
              ? 'Envio indisponível'
              : sendAttempt
                ? 'Tentar enviar novamente'
                : 'Enviar anexo'
          "
          @click="send"
        >
          <AppIcon name="send" />
        </button>
        <slot v-else name="send" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.media-composer {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.media-composer__review {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}
.media-composer__review:has(.media-composer__image) {
  grid-template-columns: var(--space-16) minmax(0, 1fr);
  align-items: center;
}
.media-composer__review:has(.media-composer__image)
  > .media-composer__file-heading {
  grid-column: 2;
  grid-row: 1;
  min-inline-size: 0;
}
.media-composer__review:has(.media-composer__image) > textarea,
.media-composer__review:has(.media-composer__image) > p {
  grid-column: 1 / -1;
}
.media-composer__sr-only {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.media-composer .media-composer__image {
  grid-column: 1;
  grid-row: 1;
  position: relative;
  justify-self: start;
  padding: 0;
  inline-size: var(--space-16);
  block-size: var(--space-16);
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-md);
  cursor: zoom-in;
}
.media-composer__image img {
  display: block;
  inline-size: var(--space-16);
  block-size: var(--space-16);
  object-fit: cover;
}
.media-composer__image span {
  position: absolute;
  inset-inline-end: var(--space-1);
  inset-block-end: var(--space-1);
  display: grid;
  place-items: center;
  inline-size: var(--space-6);
  block-size: var(--space-6);
  color: var(--color-text);
  background: var(--color-surface);
  border-radius: var(--radius-sm);
}
.media-composer__viewer {
  inline-size: min(48rem, calc(100% - var(--space-4)));
  max-block-size: calc(100dvh - var(--space-4));
  margin: auto;
  padding: var(--space-4);
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.media-composer__viewer::backdrop {
  background: var(--color-overlay);
}
.media-composer__viewer button {
  display: flex;
  margin-inline-start: auto;
  margin-block-end: var(--space-2);
}
.media-composer__viewer img {
  display: block;
  inline-size: 100%;
  max-block-size: 70dvh;
  object-fit: contain;
}
.media-composer__file-input {
  display: none;
}
.media-composer__file-heading,
.media-composer__toolbar,
.media-composer__tools,
.media-composer__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.media-composer__file-heading,
.media-composer__toolbar {
  justify-content: space-between;
}
.media-composer__file-heading p {
  margin: 0;
  min-width: 0;
}
.media-composer__filename {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-composer__file-heading small {
  display: block;
  color: var(--color-text-muted);
}
.media-composer__tools,
.media-composer__actions,
.media-composer__toolbar {
  flex-wrap: wrap;
}
.media-composer__actions {
  margin-inline-start: auto;
}
.media-composer__toolbar {
  padding-top: 0;
}
.media-composer button,
.media-composer :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-width: var(--target-min);
  min-height: var(--target-min);
  padding: var(--space-2);
}
.media-composer svg,
.media-composer :deep(svg) {
  width: var(--space-4);
  height: var(--space-4);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.media-composer__remove {
  flex-shrink: 0;
}
.media-composer__error {
  margin: 0;
}
.media-composer :deep(.composer) {
  margin: 0;
  padding: 0;
  border: 0;
}
.media-composer__review p {
  overflow-wrap: anywhere;
}
img,
video {
  max-width: 100%;
  max-height: 20rem;
  object-fit: contain;
}
audio,
textarea {
  width: 100%;
}
textarea {
  min-height: var(--control-height);
  resize: vertical;
}
@media (max-width: 480px) {
  .media-composer {
    padding: var(--space-3);
  }
}
@media (pointer: coarse) {
  .media-composer button,
  .media-composer :deep(button) {
    min-width: var(--target-min);
    min-height: var(--target-min);
  }
}
</style>
