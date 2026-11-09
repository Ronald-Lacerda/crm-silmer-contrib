<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import { openDialog } from '../../lib/ui.js';
import { normalizeReasonText } from '../../lib/order-cancel.js';
import {
  olistOperationReason,
  olistRecoveryFailure,
} from '../../lib/olist-feedback.js';
import {
  OLIST_RECONCILE_FOLLOW_MS,
  canOfferLink,
  olistOperationHeadline,
  olistRequestStatusLabel,
  olistResourceStateLabel,
  olistStageLabel,
  olistTime,
  reconcileTargets,
  resourceLabel,
  safeAttempts,
  safeCode,
  safeRemoteId,
} from '../../lib/olist-progress.js';

const props = defineProps({
  orderId: { type: String, required: true },
  /** Muda a cada releitura da projeção Olist do CRM. */
  refreshSignal: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
  /** Pedido cancelado localmente: nada de conferir nem vincular. */
  cancelled: { type: Boolean, default: false },
});
const emit = defineEmits(['administration', 'refresh']);

const base = computed(
  () => `/api/v1/orders/${encodeURIComponent(props.orderId)}/olist`,
);
const heading = ref(null);
const requestsHeading = ref(null);
const data = ref(null);
const loading = ref(false);
const loadError = ref('');
const accessMessage = ref('');
const busy = ref(false);
const resultMessage = ref('');
const overrides = ref(/** @type {Record<string, any>} */ ({}));
let disposed = false;
let loadController;
const followTimers = new Map();

// Conferir no Olist.
const rcOpen = ref(false);
const rcDialog = ref(null);
const rcTarget = ref(null);
const rcReason = ref('');
const rcError = ref('');
const rcAlert = ref(null);
const rcReasonField = ref(null);
let rcKey = '';
let rcSettled = false;
let rcKeyReason = '';

// Vincular venda existente.
const lkOpen = ref(false);
const lkDialog = ref(null);
const lkStep = ref('sale');
const lkSaleId = ref('');
const lkSaleField = ref(null);
const lkReasonField = ref(null);
const lkPreview = ref(null);
const lkReason = ref('');
const lkError = ref('');
const lkAlert = ref(null);
const lkReview = ref(null);
let lkKey = '';
let lkSettled = false;
let lkKeyReason = '';

const operation = computed(() => data.value?.operation ?? null);
const resources = computed(() => data.value?.resources ?? []);
const targets = computed(() => reconcileTargets(data.value));
const targetByKey = computed(
  () => new Map(targets.value.map((target) => [target.key, target])),
);
const resourceRows = computed(() => {
  const seen = /** @type {Record<string, number>} */ ({});
  const total = /** @type {Record<string, number>} */ ({});
  for (const resource of resources.value)
    total[resource.kind] = (total[resource.kind] ?? 0) + 1;
  return resources.value.map((/** @type {any} */ resource) => {
    seen[resource.kind] = (seen[resource.kind] ?? 0) + 1;
    return {
      id: resource.id,
      label: resourceLabel(resource, seen[resource.kind], total[resource.kind]),
      stateLabel: olistResourceStateLabel(resource.state),
      remoteId: safeRemoteId(resource.remoteId),
      target: targetByKey.value.get(resource.id) ?? null,
    };
  });
});
const saleTarget = computed(() => targetByKey.value.get('sale') ?? null);
const labelByResource = computed(
  () => new Map(resourceRows.value.map((row) => [row.id, row.label])),
);
const requests = computed(() => {
  const server = (data.value?.requests ?? []).map((/** @type {any} */ item) => {
    const id = item.requestId ?? item.id;
    return overrides.value[id] ?? item;
  });
  const known = new Set(
    server.map((/** @type {any} */ item) => item.requestId ?? item.id),
  );
  const extra = Object.values(overrides.value).filter(
    (item) => !known.has(item.requestId ?? item.id),
  );
  return [...extra, ...server].slice(0, 20).map((item) => ({
    id: String(item.requestId ?? item.id),
    stage: olistStageLabel(item.stage),
    target:
      item.stage === 'sale'
        ? 'Venda'
        : (labelByResource.value.get(item.resourceId) ?? ''),
    status: item.status,
    statusLabel: olistRequestStatusLabel(item.status),
    code: safeCode(item.code),
    reason: item.code ? olistOperationReason(item.code, '') : '',
  }));
});
const attempts = computed(() => safeAttempts(data.value?.attempts));
const linkOffered = computed(
  () =>
    Boolean(data.value) && !props.cancelled && canOfferLink(operation.value),
);
const operationHeadline = computed(() =>
  operation.value ? olistOperationHeadline(operation.value) : '',
);

function loseAccess(cause) {
  accessMessage.value = olistRecoveryFailure(cause, 'load');
  data.value = null;
  rcOpen.value = false;
  lkOpen.value = false;
  clearFollow();
  emit('administration', null);
  // Os controles saem da tela: o foco vai ao título, que explica o motivo.
  void focusElement(heading);
}
async function focusElement(target) {
  await nextTick();
  if (!disposed) target.value?.focus();
}
/** O elemento que tinha o foco quando uma releitura começou. */
function focusSnapshot() {
  return globalThis.document.activeElement;
}
/** Se a releitura tirou da tela o botão que tinha o foco (e o foco caiu no
 * corpo), leva o foco ao título da região de resultado. Não toca no foco que
 * a pessoa já moveu para outro lugar. */
async function rescueFocus(before) {
  await nextTick();
  const doc = globalThis.document;
  if (disposed || !before || before === doc.body || before.isConnected) return;
  const now = doc.activeElement;
  if (now && now !== doc.body && now.isConnected) return;
  (requestsHeading.value ?? heading.value)?.focus();
}

async function loadAdministration(before = focusSnapshot()) {
  if (accessMessage.value) return;
  loadController?.abort();
  const own = new AbortController();
  loadController = own;
  const id = props.orderId;
  loading.value = true;
  loadError.value = '';
  try {
    const response = await request(`${base.value}/administration`, {
      signal: own.signal,
    });
    if (disposed || own.signal.aborted || props.orderId !== id) return;
    const next = response.data;
    if (
      !next ||
      typeof next !== 'object' ||
      !Array.isArray(next.resources) ||
      !Array.isArray(next.requests) ||
      !Array.isArray(next.attempts)
    ) {
      loadError.value = olistRecoveryFailure({}, 'load');
      return;
    }
    data.value = next;
    for (const item of next.requests)
      delete overrides.value[item.requestId ?? item.id];
    emit('administration', next);
    await rescueFocus(before);
  } catch (cause) {
    if (disposed || own.signal.aborted) return;
    if ([401, 403].includes(Number(cause?.status))) loseAccess(cause);
    else loadError.value = olistRecoveryFailure(cause, 'load');
  } finally {
    if (loadController === own && !disposed) loading.value = false;
  }
}
watch(
  () => [props.orderId, props.refreshSignal],
  (next, previous) => {
    if (previous && next[0] !== previous[0]) {
      data.value = null;
      overrides.value = {};
      resultMessage.value = '';
      clearFollow();
    }
    void loadAdministration();
  },
  { immediate: true },
);

function clearFollow(id) {
  if (id) {
    globalThis.clearTimeout(followTimers.get(id));
    followTimers.delete(id);
    return;
  }
  for (const timer of followTimers.values()) globalThis.clearTimeout(timer);
  followTimers.clear();
}
function upsertRequest(item) {
  overrides.value = { ...overrides.value, [item.requestId ?? item.id]: item };
}
/** Leitura persistida do CRM; nunca consulta o Olist. */
async function readRequest(requestId, label, manual) {
  const id = props.orderId;
  const before = focusSnapshot();
  try {
    const response = await request(
      `${base.value}/reconciliations/${encodeURIComponent(requestId)}`,
    );
    if (disposed || props.orderId !== id) return true;
    const item = response.data;
    if (
      !item ||
      typeof item !== 'object' ||
      !['queued', 'succeeded', 'blocked'].includes(item.status)
    )
      return true;
    upsertRequest(item);
    if (item.status === 'queued') {
      if (manual)
        resultMessage.value = `A conferência de ${label} ainda está na fila. Tente atualizar mais tarde.`;
      return false;
    }
    resultMessage.value =
      item.status === 'succeeded'
        ? `Conferência de ${label} concluída. O progresso foi atualizado.`
        : `Conferência de ${label} concluída sem provar o resultado. Nenhuma criação foi liberada.`;
    await loadAdministration(before);
    emit('refresh', { focus: false });
    return true;
  } catch (cause) {
    if (disposed) return true;
    if ([401, 403].includes(Number(cause?.status))) loseAccess(cause);
    else loadError.value = olistRecoveryFailure(cause, 'read');
    return true;
  }
}
function follow(requestId, label, attempt = 0) {
  clearFollow(requestId);
  if (disposed || attempt >= OLIST_RECONCILE_FOLLOW_MS.length) return;
  followTimers.set(
    requestId,
    globalThis.setTimeout(async () => {
      followTimers.delete(requestId);
      const finished = await readRequest(requestId, label, false);
      if (!finished) follow(requestId, label, attempt + 1);
    }, OLIST_RECONCILE_FOLLOW_MS[attempt]),
  );
}
async function refreshResult(item) {
  clearFollow(item.id);
  const finished = await readRequest(
    item.id,
    item.target || item.stage.toLowerCase(),
    true,
  );
  if (!finished) follow(item.id, item.target || item.stage.toLowerCase(), 1);
}

async function closeDialogElement(dialog) {
  if (dialog?.open) {
    const closed = new Promise((resolve) =>
      dialog.addEventListener('close', resolve, { once: true }),
    );
    dialog.close();
    await closed;
  }
}
/** O acionador fica desabilitado enquanto o comando corre; depois que a tela
 * atualiza, ele recebe o foco de volta, ou o título se saiu da tela. */
async function restoreFocus(trigger) {
  await nextTick();
  if (disposed || !trigger) return;
  if (trigger.isConnected && !trigger.disabled) {
    if (globalThis.document.activeElement !== trigger) trigger.focus();
  } else heading.value?.focus();
}

/** Sem resposta, resposta ilegível ou 5xx: o resultado do comando é incerto.
 * @param {any} cause */
function uncertainFailure(cause) {
  const status = Number(cause?.status) || 0;
  return status === 0 || status >= 500;
}

// Pedido cancelado com um diálogo aberto: ele se encerra sem enviar.
watch(
  () => props.cancelled,
  async (cancelled) => {
    if (!cancelled || busy.value) return;
    if (rcOpen.value) await closeReconcile();
    if (lkOpen.value) await closeLink();
  },
);

/* Conferir no Olist ------------------------------------------------------ */
let rcTrigger = null;
async function openReconcile(target, event) {
  if (busy.value || props.disabled || rcOpen.value || lkOpen.value) return;
  rcTrigger = event.currentTarget;
  const trigger = rcTrigger;
  rcTarget.value = target;
  rcReason.value = '';
  rcError.value = '';
  rcKey = commandKey();
  rcKeyReason = '';
  rcSettled = false;
  rcOpen.value = true;
  await nextTick();
  if (disposed || !rcDialog.value) return;
  openDialog(rcDialog.value, trigger);
  rcReasonField.value?.focus();
}
async function closeReconcile() {
  await closeDialogElement(rcDialog.value);
  rcOpen.value = false;
  await restoreFocus(rcTrigger);
}
async function cancelReconcile() {
  if (busy.value) return;
  await closeReconcile();
}
async function submitReconcile() {
  if (busy.value || rcSettled || !rcTarget.value) return;
  if (props.cancelled) {
    rcError.value = olistRecoveryFailure(
      { code: 'ORDER_CANCELLED' },
      'reconcile',
    );
    await focusElement(rcAlert);
    return;
  }
  // O servidor recusa qualquer caractere de controle: quebras e tabs viram um
  // espaço antes de validar e de enviar.
  const reason = normalizeReasonText(rcReason.value);
  if (!reason || reason.length > 1000) {
    rcError.value = reason
      ? 'O motivo pode ter no máximo 1000 caracteres.'
      : 'Informe o motivo da conferência.';
    await focusElement(rcReasonField);
    return;
  }
  if (rcKeyReason !== reason) {
    rcKey = commandKey();
    rcKeyReason = reason;
  }
  const target = rcTarget.value;
  const id = props.orderId;
  busy.value = true;
  rcError.value = '';
  try {
    const response = await request(`${base.value}/reconcile`, {
      method: 'POST',
      body: {
        stage: target.stage,
        resourceId: target.resourceId,
        expectedVersion: target.expectedVersion,
        reason,
      },
      idempotencyKey: rcKey,
    });
    if (disposed || props.orderId !== id) return;
    const receipt = response.data;
    const requestId = receipt?.requestId ?? receipt?.id;
    if (typeof requestId !== 'string' || !requestId) {
      rcError.value =
        'A resposta não confirmou a solicitação. Atualize o diagnóstico antes de repetir.';
      await focusElement(rcAlert);
      return;
    }
    upsertRequest({ ...receipt, status: receipt.status ?? 'queued' });
    resultMessage.value = `Conferência de ${target.label} solicitada. O resultado aparece em Conferências solicitadas.`;
    // Settled: the dialog is closing and must not accept another command.
    rcSettled = true;
    busy.value = false;
    await closeReconcile();
    follow(requestId, target.label);
  } catch (cause) {
    if (disposed || props.orderId !== id) return;
    if ([401, 403].includes(Number(cause?.status))) {
      await closeDialogElement(rcDialog.value);
      loseAccess(cause);
      return;
    }
    rcError.value = olistRecoveryFailure(cause, 'reconcile');
    if (cause?.code === 'VERSION_CONFLICT') void loadAdministration();
    else if (uncertainFailure(cause)) {
      // Sem resposta ou 5xx: a solicitação pode ter sido gravada. Relê o
      // diagnóstico e a projeção; nada é repetido por conta própria.
      void loadAdministration();
      emit('refresh', { focus: false });
    }
    await focusElement(rcAlert);
  } finally {
    busy.value = false;
  }
}

/* Vincular venda existente ----------------------------------------------- */
let lkTrigger = null;
async function openLink(event) {
  if (busy.value || props.disabled || rcOpen.value || lkOpen.value) return;
  lkTrigger = event.currentTarget;
  const trigger = lkTrigger;
  lkStep.value = 'sale';
  lkSaleId.value = '';
  lkPreview.value = null;
  lkReason.value = '';
  lkError.value = '';
  lkKey = '';
  lkKeyReason = '';
  lkSettled = false;
  lkOpen.value = true;
  await nextTick();
  if (disposed || !lkDialog.value) return;
  openDialog(lkDialog.value, trigger);
  lkSaleField.value?.focus();
}
async function closeLink() {
  await closeDialogElement(lkDialog.value);
  lkOpen.value = false;
  lkPreview.value = null;
  await restoreFocus(lkTrigger);
}
async function cancelLink() {
  if (busy.value) return;
  await closeLink();
}
async function backToSale() {
  if (busy.value) return;
  lkStep.value = 'sale';
  lkPreview.value = null;
  lkError.value = '';
  lkKey = '';
  await focusElement(lkSaleField);
}
/** Primeiro gesto: conferir a venda. Não cria nada nem vincula. */
async function previewLink() {
  if (busy.value) return;
  const saleId = lkSaleId.value.trim();
  if (!/^[1-9][0-9]{0,15}$/u.test(saleId)) {
    lkError.value =
      'Informe o ID da venda no Olist: somente números e sem zeros à esquerda.';
    await focusElement(lkSaleField);
    return;
  }
  const id = props.orderId;
  busy.value = true;
  lkError.value = '';
  try {
    const response = await request(`${base.value}/existing/previews`, {
      method: 'POST',
      body: { saleId },
      idempotencyKey: commandKey(),
    });
    if (disposed || props.orderId !== id) return;
    const result = response.data;
    if (
      result?.eligible !== true ||
      typeof result.previewToken !== 'string' ||
      !result.previewToken ||
      String(result.sale?.id) !== saleId ||
      typeof result.sale?.number !== 'string' ||
      !Number.isFinite(Date.parse(result.expiresAt ?? ''))
    ) {
      lkError.value =
        'A conferência não devolveu uma venda utilizável. Nenhum vínculo foi criado.';
      await focusElement(lkAlert);
      return;
    }
    lkPreview.value = {
      token: result.previewToken,
      saleId,
      number: result.sale.number.slice(0, 40),
      expiresAt: result.expiresAt,
    };
    lkReason.value = '';
    lkKey = commandKey();
    lkKeyReason = '';
    lkStep.value = 'review';
    await focusElement(lkReview);
  } catch (cause) {
    if (disposed || props.orderId !== id) return;
    if ([401, 403].includes(Number(cause?.status))) {
      await closeDialogElement(lkDialog.value);
      loseAccess(cause);
      return;
    }
    lkError.value = olistRecoveryFailure(cause, 'preview');
    await focusElement(lkAlert);
  } finally {
    busy.value = false;
  }
}
/** Segundo gesto: motivo e confirmação. Só vincula; nunca cria venda. */
async function submitLink() {
  if (busy.value || lkSettled || lkStep.value !== 'review' || !lkPreview.value)
    return;
  if (props.cancelled) {
    lkError.value = olistRecoveryFailure({ code: 'ORDER_CANCELLED' }, 'link');
    await focusElement(lkAlert);
    return;
  }
  const reason = normalizeReasonText(lkReason.value);
  if (!reason || reason.length > 1000) {
    lkError.value = reason
      ? 'O motivo pode ter no máximo 1000 caracteres.'
      : 'Informe o motivo do vínculo.';
    await focusElement(lkReasonField);
    return;
  }
  if (Date.parse(lkPreview.value.expiresAt) <= Date.now()) {
    lkStep.value = 'sale';
    lkPreview.value = null;
    lkError.value = olistRecoveryFailure(
      { code: 'OLIST_PREVIEW_EXPIRED' },
      'link',
    );
    await focusElement(lkAlert);
    return;
  }
  if (lkKeyReason !== reason) {
    lkKey = commandKey();
    lkKeyReason = reason;
  }
  const id = props.orderId;
  const preview = lkPreview.value;
  busy.value = true;
  lkError.value = '';
  try {
    const response = await request(`${base.value}/links`, {
      method: 'POST',
      body: { previewToken: preview.token, reason },
      idempotencyKey: lkKey,
    });
    if (disposed || props.orderId !== id) return;
    const receipt = response.data;
    const valid =
      typeof receipt?.operationId === 'string' &&
      ['linked', 'confirmed'].includes(receipt?.state) &&
      typeof receipt?.number === 'string' &&
      receipt.number;
    resultMessage.value = valid
      ? `Venda Olist ${receipt.number.slice(0, 40)} vinculada ao pedido. Nenhuma venda foi criada no Olist.`
      : 'O resultado do vínculo não foi confirmado pela resposta. Atualize o progresso antes de tentar de novo.';
    lkSettled = true;
    busy.value = false;
    await closeLink();
    await loadAdministration();
    emit('refresh', { focus: true });
  } catch (cause) {
    if (disposed || props.orderId !== id) return;
    if ([401, 403].includes(Number(cause?.status))) {
      await closeDialogElement(lkDialog.value);
      loseAccess(cause);
      return;
    }
    if (uncertainFailure(cause)) {
      // O vínculo pode ter sido gravado: lê o diagnóstico antes de dizer o que
      // aconteceu. Se já consta vinculado, o diálogo se encerra.
      await loadAdministration();
      emit('refresh', { focus: false });
      if (['linked', 'confirmed'].includes(data.value?.operation?.state)) {
        resultMessage.value =
          'O vínculo foi gravado, apesar da falha na resposta. Nenhuma venda foi criada no Olist.';
        lkSettled = true;
        busy.value = false;
        await closeLink();
        emit('refresh', { focus: true });
        return;
      }
    }
    lkError.value = olistRecoveryFailure(cause, 'link');
    if (
      [
        'OLIST_PREVIEW_EXPIRED',
        'OLIST_PREVIEW_STALE',
        'OLIST_PREVIEW_INVALID',
        'OLIST_CONNECTION_CHANGED',
      ].includes(cause?.code)
    ) {
      lkStep.value = 'sale';
      lkPreview.value = null;
      lkKey = '';
    }
    if (cause?.status === 409) void loadAdministration();
    await focusElement(lkAlert);
  } finally {
    busy.value = false;
  }
}

defineExpose({ focus: () => heading.value?.focus() });
onBeforeUnmount(() => {
  disposed = true;
  loadController?.abort();
  clearFollow();
});
</script>

<template>
  <section
    class="olist-recovery"
    :aria-labelledby="`olist-recovery-${orderId}`"
  >
    <h3 :id="`olist-recovery-${orderId}`" ref="heading" tabindex="-1">
      Conferência administrativa
    </h3>
    <p class="field-help">
      Conferir lê o Olist e vincular usa uma venda que já existe. Nenhuma das
      duas ações cria cliente, produto ou venda, e nenhuma libera repetir a
      geração.
    </p>
    <p v-if="accessMessage" role="alert" class="inline-error">
      {{ accessMessage }}
    </p>
    <template v-else>
      <p v-if="loadError" role="alert" class="inline-error">{{ loadError }}</p>
      <p v-if="loading && !data" role="status">Carregando o diagnóstico…</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p v-if="resultMessage" class="olist-recovery-result">
          {{ resultMessage }}
        </p>
      </div>
      <template v-if="data">
        <p v-if="cancelled" class="field-help">
          Pedido cancelado. A conferência e o vínculo estão bloqueados; o
          diagnóstico continua disponível para consulta.
        </p>
        <section
          v-if="resourceRows.length || saleTarget"
          :aria-labelledby="`olist-resources-${orderId}`"
        >
          <h4 :id="`olist-resources-${orderId}`">Cadastros e venda</h4>
          <ul class="olist-recovery-list">
            <li v-for="row in resourceRows" :key="row.id">
              <div class="olist-recovery-item">
                <p>
                  <strong>{{ row.label }}</strong> · {{ row.stateLabel }}
                  <span v-if="row.remoteId" class="field-help">
                    · ID Olist {{ row.remoteId }}</span
                  >
                </p>
                <button
                  v-if="row.target && !cancelled"
                  type="button"
                  :disabled="busy || disabled"
                  :aria-label="`Conferir no Olist: ${row.label}`"
                  @click="openReconcile(row.target, $event)"
                >
                  Conferir no Olist
                </button>
              </div>
            </li>
            <li v-if="saleTarget">
              <div class="olist-recovery-item">
                <p><strong>Venda</strong> · {{ operationHeadline }}</p>
                <button
                  v-if="!cancelled"
                  type="button"
                  :disabled="busy || disabled"
                  aria-label="Conferir no Olist: Venda"
                  @click="openReconcile(saleTarget, $event)"
                >
                  Conferir no Olist
                </button>
              </div>
            </li>
          </ul>
        </section>
        <section
          v-if="requests.length"
          :aria-labelledby="`olist-requests-${orderId}`"
        >
          <h4
            :id="`olist-requests-${orderId}`"
            ref="requestsHeading"
            tabindex="-1"
          >
            Conferências solicitadas
          </h4>
          <ul class="olist-recovery-list">
            <li v-for="item in requests" :key="item.id">
              <div class="olist-recovery-item">
                <p>
                  <strong>{{ item.target || item.stage }}</strong> ·
                  {{ item.statusLabel }}
                  <span v-if="item.reason" class="field-help">
                    · {{ item.reason }}</span
                  >
                  <code v-if="item.code" class="olist-code">{{
                    item.code
                  }}</code>
                </p>
                <button
                  v-if="item.status === 'queued'"
                  type="button"
                  :disabled="busy"
                  :aria-label="`Atualizar resultado: ${item.target || item.stage}`"
                  @click="refreshResult(item)"
                >
                  Atualizar resultado
                </button>
              </div>
            </li>
          </ul>
        </section>
        <details v-if="attempts.length" class="olist-attempts">
          <summary>Histórico de tentativas ({{ attempts.length }})</summary>
          <ol class="olist-recovery-list">
            <li v-for="attempt in attempts" :key="attempt.id">
              <p>
                <strong>{{ attempt.stage }}</strong> · {{ attempt.outcome }}
                <code v-if="attempt.code" class="olist-code">{{
                  attempt.code
                }}</code>
              </p>
              <p v-if="attempt.reason" class="field-help">
                {{ attempt.reason }}
              </p>
              <p class="field-help">
                Iniciada {{ olistTime(attempt.createdAt) }}
                <template v-if="attempt.finishedAt">
                  · concluída {{ olistTime(attempt.finishedAt) }}</template
                >
                <template v-if="attempt.remoteId">
                  · ID Olist observado {{ attempt.remoteId }}</template
                >
              </p>
            </li>
          </ol>
          <p v-if="data.attemptHistoryTruncated" class="field-help">
            Mostrando as 100 tentativas mais recentes; o histórico completo
            continua na auditoria.
          </p>
        </details>
        <p v-else-if="operation" class="field-help">
          Nenhuma tentativa registrada para esta operação.
        </p>
        <div v-if="linkOffered" class="olist-recovery-link">
          <button type="button" :disabled="busy || disabled" @click="openLink">
            Vincular venda existente
          </button>
          <p class="field-help">
            Use quando a venda deste pedido já foi lançada no Olist. O CRM
            confere cliente, itens e total antes de vincular.
          </p>
        </div>
      </template>
    </template>

    <dialog
      v-if="rcOpen"
      ref="rcDialog"
      class="op-dialog olist-dialog"
      aria-modal="true"
      :aria-labelledby="`olist-rc-title-${orderId}`"
      :aria-describedby="`olist-rc-desc-${orderId}`"
      @cancel.prevent="cancelReconcile"
    >
      <h2 :id="`olist-rc-title-${orderId}`">
        Conferir {{ rcTarget?.label }} no Olist?
      </h2>
      <p :id="`olist-rc-desc-${orderId}`">
        A conferência só lê o Olist. Não cria nem altera cadastro ou venda e não
        libera nova geração. O resultado fica no diagnóstico.
      </p>
      <form novalidate @submit.prevent="submitReconcile">
        <div class="olist-dialog-field">
          <label :for="`olist-rc-reason-${orderId}`"
            >Motivo da conferência (obrigatório)</label
          >
          <textarea
            :id="`olist-rc-reason-${orderId}`"
            ref="rcReasonField"
            v-model="rcReason"
            rows="3"
            maxlength="1000"
            required
            :aria-invalid="rcError ? 'true' : undefined"
            :aria-describedby="`olist-rc-help-${orderId}`"
          ></textarea>
          <p :id="`olist-rc-help-${orderId}`" class="field-help">
            Fica cifrado na auditoria. Não inclua dados pessoais do cliente.
            Quebras de linha viram espaço.
          </p>
        </div>
        <p
          v-if="rcError"
          ref="rcAlert"
          role="alert"
          class="inline-error"
          tabindex="-1"
        >
          {{ rcError }}
        </p>
        <div class="op-dialog-actions">
          <button type="button" :disabled="busy" @click="cancelReconcile">
            Voltar
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="busy"
            :aria-busy="busy || undefined"
          >
            {{ busy ? 'Solicitando…' : 'Solicitar conferência' }}
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      v-if="lkOpen"
      ref="lkDialog"
      class="op-dialog olist-dialog"
      aria-modal="true"
      :aria-labelledby="`olist-lk-title-${orderId}`"
      :aria-describedby="`olist-lk-desc-${orderId}`"
      @cancel.prevent="cancelLink"
    >
      <h2 :id="`olist-lk-title-${orderId}`">Vincular venda existente</h2>
      <p :id="`olist-lk-desc-${orderId}`">
        Nenhuma venda será criada no Olist. Primeiro o CRM confere a venda
        informada; depois você confirma o vínculo com um motivo.
      </p>
      <form v-if="lkStep === 'sale'" novalidate @submit.prevent="previewLink">
        <div class="olist-dialog-field">
          <label :for="`olist-lk-sale-${orderId}`">ID da venda no Olist</label>
          <input
            :id="`olist-lk-sale-${orderId}`"
            ref="lkSaleField"
            v-model="lkSaleId"
            inputmode="numeric"
            autocomplete="off"
            maxlength="16"
            required
            :aria-invalid="lkError ? 'true' : undefined"
            :aria-describedby="`olist-lk-sale-help-${orderId}`"
          />
          <p :id="`olist-lk-sale-help-${orderId}`" class="field-help">
            Somente o número do ID, sem endereço de página.
          </p>
        </div>
        <p
          v-if="lkError"
          ref="lkAlert"
          role="alert"
          class="inline-error"
          tabindex="-1"
        >
          {{ lkError }}
        </p>
        <div class="op-dialog-actions">
          <button type="button" :disabled="busy" @click="cancelLink">
            Cancelar
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="busy"
            :aria-busy="busy || undefined"
          >
            {{ busy ? 'Conferindo…' : 'Conferir venda' }}
          </button>
        </div>
      </form>
      <form v-else novalidate @submit.prevent="submitLink">
        <h3 ref="lkReview" tabindex="-1" class="olist-dialog-review">
          Venda conferida
        </h3>
        <dl>
          <div>
            <dt>Venda Olist</dt>
            <dd>{{ lkPreview?.number }}</dd>
          </div>
          <div>
            <dt>ID no Olist</dt>
            <dd>{{ lkPreview?.saleId }}</dd>
          </div>
          <div>
            <dt>Válida até</dt>
            <dd>{{ olistTime(lkPreview?.expiresAt) }}</dd>
          </div>
        </dl>
        <p class="field-help">
          O Olist confirmou comprador, itens, quantidades e total desta venda
          com o pedido. Vincular não altera a venda nem o pedido.
        </p>
        <div class="olist-dialog-field">
          <label :for="`olist-lk-reason-${orderId}`"
            >Motivo do vínculo (obrigatório)</label
          >
          <textarea
            :id="`olist-lk-reason-${orderId}`"
            ref="lkReasonField"
            v-model="lkReason"
            rows="3"
            maxlength="1000"
            required
            :aria-invalid="lkError ? 'true' : undefined"
            :aria-describedby="`olist-lk-reason-help-${orderId}`"
          ></textarea>
          <p :id="`olist-lk-reason-help-${orderId}`" class="field-help">
            Fica cifrado na auditoria. Não inclua dados pessoais do cliente.
            Quebras de linha viram espaço.
          </p>
        </div>
        <p
          v-if="lkError"
          ref="lkAlert"
          role="alert"
          class="inline-error"
          tabindex="-1"
        >
          {{ lkError }}
        </p>
        <div class="op-dialog-actions">
          <button type="button" :disabled="busy" @click="backToSale">
            Voltar
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="busy"
            :aria-busy="busy || undefined"
          >
            {{ busy ? 'Vinculando…' : 'Vincular venda ao pedido' }}
          </button>
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.olist-recovery {
  display: grid;
  gap: var(--space-4);
  min-inline-size: 0;
  padding-block-start: var(--space-4);
  border-block-start: 1px solid var(--color-border-subtle);
}
.olist-recovery h3,
.olist-recovery h4 {
  margin-block: 0;
}
.olist-recovery h3:focus,
.olist-recovery h4:focus {
  outline: none;
}
.olist-recovery h3:focus-visible,
.olist-recovery h4:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.olist-recovery h4 {
  font-size: var(--text-base);
  margin-block-end: var(--space-2);
}
.olist-recovery p {
  margin: 0;
}
.olist-recovery .inline-error {
  color: var(--status-error-text);
}
.olist-recovery-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.olist-recovery-item {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: center;
  justify-content: space-between;
}
.olist-recovery-item p {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.olist-recovery-item button,
.olist-recovery-link button,
.olist-attempts summary {
  min-block-size: var(--target-min);
}
.olist-attempts summary {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-weight: 600;
}
.olist-attempts > ol {
  margin-block-start: var(--space-3);
}
.olist-attempts li {
  padding-block-end: var(--space-3);
  border-block-end: 1px solid var(--color-border-subtle);
}
.olist-code {
  margin-inline-start: var(--space-2);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.olist-recovery-link {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
}
.olist-recovery-result {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}
.olist-dialog {
  max-block-size: calc(100dvh - 2rem);
  overflow-y: auto;
}
.olist-dialog form {
  display: grid;
  gap: var(--space-4);
  margin-block-start: var(--space-4);
}
.olist-dialog-field {
  display: grid;
  gap: var(--space-2);
  min-inline-size: 0;
}
.olist-dialog-field label {
  margin: 0;
}
.olist-dialog-field input,
.olist-dialog-field textarea {
  inline-size: 100%;
  min-inline-size: 0;
  box-sizing: border-box;
}
.olist-dialog .field-help,
.olist-dialog .inline-error {
  margin: 0;
}
.olist-dialog .inline-error {
  color: var(--status-error-text);
  overflow-wrap: anywhere;
}
.olist-dialog-review {
  margin: 0;
  font-size: var(--text-base);
}
.olist-dialog-review:focus {
  outline: none;
}
.olist-dialog-review:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.olist-dialog dl {
  margin: 0;
}
.olist-dialog button {
  min-block-size: var(--target-min);
}
@media (width <= 30rem) {
  .olist-dialog .op-dialog-actions {
    display: grid;
  }
  .olist-recovery-item button {
    inline-size: 100%;
  }
}
</style>
