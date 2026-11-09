<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { commandKey, request } from '../../lib/api-client.js';
import { openDialog } from '../../lib/ui.js';
import { amountLabel, dayLabel } from '../../lib/order-format.js';
import { normalizeReasonText } from '../../lib/order-cancel.js';
import {
  olistOperationReason,
  olistRecoveryFailure,
} from '../../lib/olist-feedback.js';
import {
  OLIST_RECONCILE_FOLLOW_MS,
  canOfferInvalidate,
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
const lkMode = ref('canonical');
const lkDueOn = ref('');
const lkDueField = ref(null);
const lkFiscal = ref({ ncm: '', origin: '', unit: '' });
const lkNcmField = ref(null);
const lkOriginField = ref(null);
const lkUnitField = ref(null);
const lkFiscalInvalid = ref('');
const lkConfirmed = ref(false);
const lkConfirmationField = ref(null);
const lkGroups = ref([]);
let lkKey = '';
let lkSettled = false;
let lkKeyReason = '';

// Invalidar esta geração (ADR 069): comando local e idempotente.
const ivOpen = ref(false);
const ivDialog = ref(null);
const ivTarget = ref(
  /** @type {{operationId: string, expectedVersion: number}|null} */ (null),
);
const ivReason = ref('');
const ivError = ref('');
const ivAlert = ref(null);
const ivReasonField = ref(null);
let ivKey = '';
let ivSettled = false;
let ivKeyToken = '';

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
const legacyContext = computed(() => data.value?.legacyLinkContext ?? null);
const legacyOffered = computed(
  () =>
    linkOffered.value &&
    Array.isArray(legacyContext.value?.groups) &&
    legacyContext.value.groups.length > 0,
);
const dueRequired = computed(
  () =>
    lkMode.value !== 'legacy' &&
    (data.value?.paymentDuePolicy ?? legacyContext.value?.paymentDuePolicy) ===
      'per_order',
);
const fiscalRequired = computed(
  () => lkMode.value !== 'legacy' && data.value?.productFiscalRequired === true,
);
watch(
  () => [lkFiscal.value.ncm, lkFiscal.value.origin, lkFiscal.value.unit],
  () => {
    if (lkFiscalInvalid.value) {
      lkFiscalInvalid.value = '';
      lkError.value = '';
    }
    if (!lkPreview.value || lkMode.value === 'legacy') return;
    lkPreview.value = null;
    lkStep.value = 'sale';
    lkKey = '';
    lkReason.value = '';
  },
);
/** @param {Record<string, any>} attributes */
function groupAttributes(attributes = {}) {
  let fabric = attributes.fabric ?? '';
  try {
    const fabrics = JSON.parse(fabric);
    if (
      Array.isArray(fabrics) &&
      fabrics.every((value) => typeof value === 'string')
    )
      fabric = fabrics.join(', ');
  } catch {
    // Older read models may already expose the display label.
  }
  return [
    attributes.garment,
    attributes.color,
    fabric,
    attributes.application,
    attributes.collar,
    attributes.audience,
  ].filter(Boolean);
}
const invalidateOffered = computed(
  () =>
    Boolean(data.value) &&
    canOfferInvalidate({
      operation: operation.value,
      attempts: data.value?.attempts,
      resources: data.value?.resources,
      cancelled: props.cancelled,
    }),
);
const operationHeadline = computed(() =>
  operation.value ? olistOperationHeadline(operation.value) : '',
);

function loseAccess(cause) {
  accessMessage.value = olistRecoveryFailure(cause, 'load');
  data.value = null;
  rcOpen.value = false;
  lkOpen.value = false;
  ivOpen.value = false;
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
    if (ivOpen.value) await closeInvalidate();
  },
);

/* Conferir no Olist ------------------------------------------------------ */
let rcTrigger = null;
async function openReconcile(target, event) {
  if (
    busy.value ||
    props.disabled ||
    rcOpen.value ||
    lkOpen.value ||
    ivOpen.value
  )
    return;
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
async function openLink(event, mode = 'canonical') {
  if (
    busy.value ||
    (mode === 'legacy' && !legacyOffered.value) ||
    props.disabled ||
    rcOpen.value ||
    lkOpen.value ||
    ivOpen.value
  )
    return;
  lkTrigger = event.currentTarget;
  const trigger = lkTrigger;
  lkStep.value = 'sale';
  lkMode.value = mode;
  lkDueOn.value = '';
  lkFiscal.value = { ncm: '', origin: '', unit: '' };
  lkFiscalInvalid.value = '';
  lkConfirmed.value = false;
  lkGroups.value =
    mode === 'legacy'
      ? (legacyContext.value?.groups ?? []).map((group) => ({
          ...group,
          parentProductId: '',
          lines: group.lines.map((line) => ({
            ...line,
            childProductId: '',
            itemIndex: '',
          })),
        }))
      : [];
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
  lkFiscalInvalid.value = '';
  lkKey = '';
  await focusElement(lkSaleField);
}
/** Primeiro gesto: conferir a venda. Não cria nada nem vincula. */
async function previewLink() {
  if (busy.value) return;
  lkFiscalInvalid.value = '';
  const saleId = lkSaleId.value.trim();
  if (!/^[1-9][0-9]{0,15}$/u.test(saleId)) {
    lkError.value =
      'Informe o ID da venda no Olist: somente números e sem zeros à esquerda.';
    await focusElement(lkSaleField);
    return;
  }
  if (dueRequired.value && !/^\d{4}-\d{2}-\d{2}$/u.test(lkDueOn.value)) {
    lkError.value = 'Informe o vencimento desta venda.';
    await focusElement(lkDueField);
    return;
  }
  let productFiscal;
  if (fiscalRequired.value) {
    const ncm = lkFiscal.value.ncm.trim(),
      origin = lkFiscal.value.origin.trim(),
      unit = lkFiscal.value.unit.trim().toUpperCase();
    if (!/^\d{8}$/u.test(ncm)) {
      lkFiscalInvalid.value = 'ncm';
      lkError.value = 'Informe o NCM com oito dígitos.';
      await focusElement(lkNcmField);
      return;
    }
    if (!/^[0-8]$/u.test(origin)) {
      lkFiscalInvalid.value = 'origin';
      lkError.value = 'Informe a origem fiscal de 0 a 8.';
      await focusElement(lkOriginField);
      return;
    }
    if (!/^[A-Z0-9]{1,6}$/u.test(unit)) {
      lkFiscalInvalid.value = 'unit';
      lkError.value =
        'Informe a unidade fiscal com até seis letras ou números.';
      await focusElement(lkUnitField);
      return;
    }
    productFiscal = { ncm, origin: Number(origin), unit };
  }
  let mapping;
  if (lkMode.value === 'legacy') {
    const indexes = new Set();
    if (
      !lkGroups.value.length ||
      lkGroups.value.some(
        (group) =>
          !/^[1-9][0-9]{0,15}$/u.test(group.parentProductId) ||
          !group.lines.length ||
          group.lines.some((line) => {
            const invalid =
              !/^[1-9][0-9]{0,15}$/u.test(line.childProductId) ||
              !/^(0|[1-9][0-9]*)$/u.test(line.itemIndex) ||
              !Number.isSafeInteger(Number(line.itemIndex)) ||
              indexes.has(line.itemIndex);
            indexes.add(line.itemIndex);
            return invalid;
          }),
      )
    ) {
      lkError.value =
        'Informe os IDs de produto pai e de cada variação e a posição de cada item. Não repita posições.';
      await focusElement(lkAlert);
      return;
    }
    mapping = {
      groups: lkGroups.value.map((group) => ({
        groupId: group.groupId,
        parentProductId: group.parentProductId,
        lines: group.lines.map((line) => ({
          lineId: line.lineId,
          childProductId: line.childProductId,
          itemIndex: Number(line.itemIndex),
        })),
      })),
    };
  }
  const id = props.orderId;
  busy.value = true;
  lkError.value = '';
  try {
    const response = await request(
      `${base.value}/existing/${lkMode.value === 'legacy' ? 'legacy/' : ''}previews`,
      {
        method: 'POST',
        body: {
          saleId,
          ...(lkDueOn.value ? { paymentDueOn: lkDueOn.value } : {}),
          ...(mapping ? { mapping } : {}),
          ...(productFiscal ? { productFiscal } : {}),
        },
        idempotencyKey: commandKey(),
      },
    );
    if (disposed || props.orderId !== id) return;
    const result = response.data;
    const historical = result?.historicalMetadata;
    const validHistorical =
      historical &&
      historical.reusable === false &&
      historical.fiscalVerified === false &&
      typeof historical.productFiscalMissing === 'boolean' &&
      (historical.originId === null ||
        (Number.isSafeInteger(historical.originId) &&
          historical.originId >= 0)) &&
      (historical.purchaseOrder === null ||
        (typeof historical.purchaseOrder === 'string' &&
          historical.purchaseOrder.length <= 120)) &&
      typeof historical.paymentDueOn === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(historical.paymentDueOn);
    if (
      result?.eligible !== true ||
      typeof result.previewToken !== 'string' ||
      !result.previewToken ||
      String(result.sale?.id) !== saleId ||
      typeof result.sale?.number !== 'string' ||
      !Number.isFinite(Date.parse(result.expiresAt ?? '')) ||
      (lkMode.value === 'legacy' &&
        (result.mode !== 'legacy-sale-only-v1' || !validHistorical)) ||
      (fiscalRequired.value &&
        (!result.productFiscal ||
          result.productFiscal.ncm !== productFiscal?.ncm ||
          result.productFiscal.origin !== productFiscal?.origin ||
          result.productFiscal.unit !== productFiscal?.unit))
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
      paymentDueOn: result.commercial?.paymentDueOn ?? lkDueOn.value,
      productFiscal:
        lkMode.value !== 'legacy' && result.productFiscal
          ? {
              ncm: result.productFiscal.ncm,
              origin: result.productFiscal.origin,
              unit: result.productFiscal.unit,
            }
          : null,
      historicalMetadata:
        lkMode.value === 'legacy'
          ? {
              originId: historical.originId,
              purchaseOrder: historical.purchaseOrder,
              paymentDueOn: historical.paymentDueOn,
              productFiscalMissing: historical.productFiscalMissing,
            }
          : null,
    };
    lkReason.value = '';
    lkConfirmed.value = false;
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
  if (lkMode.value === 'legacy' && !lkConfirmed.value) {
    lkError.value =
      'Confirme a correspondência dos atributos de cada produto e tamanho.';
    await focusElement(lkConfirmationField);
    return;
  }
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
    const response = await request(
      `${base.value}/${lkMode.value === 'legacy' ? 'existing/legacy/links' : 'links'}`,
      {
        method: 'POST',
        body: {
          previewToken: preview.token,
          reason,
          ...(lkMode.value === 'legacy' ? { confirmed: true } : {}),
        },
        idempotencyKey: lkKey,
      },
    );
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

/* Invalidar esta geração -------------------------------------------------- */
let ivTrigger = null;
async function openInvalidate(event) {
  if (
    busy.value ||
    props.disabled ||
    props.cancelled ||
    rcOpen.value ||
    lkOpen.value ||
    ivOpen.value ||
    !invalidateOffered.value
  )
    return;
  ivTrigger = event.currentTarget;
  const trigger = ivTrigger;
  // O que a pessoa viu ao abrir é o que o comando confirma: se o estado mudar
  // antes do envio, o servidor recusa pela versão.
  ivTarget.value = {
    operationId: operation.value.id,
    expectedVersion: Number(operation.value.version),
  };
  ivReason.value = '';
  ivError.value = '';
  ivKey = commandKey();
  ivKeyToken = '';
  ivSettled = false;
  ivOpen.value = true;
  await nextTick();
  if (disposed || !ivDialog.value) return;
  openDialog(ivDialog.value, trigger);
  ivReasonField.value?.focus();
}
async function closeInvalidate() {
  await closeDialogElement(ivDialog.value);
  ivOpen.value = false;
  await restoreFocus(ivTrigger);
}
async function cancelInvalidate() {
  if (busy.value) return;
  await closeInvalidate();
}
/** A geração alvo deixou de estar ativa: foi invalidada aqui, em outra aba ou
 * por um reenvio que o servidor já tinha gravado.
 * @param {{operationId: string}} target */
function targetNoLongerActive(target) {
  if (!data.value) return false;
  const current = data.value.operation;
  return (
    !current ||
    current.id !== target.operationId ||
    current.state === 'invalidated'
  );
}
/** Encerra o diálogo depois de a invalidação constar no servidor. */
async function finishInvalidate(message, reload) {
  resultMessage.value = message;
  ivSettled = true;
  busy.value = false;
  await closeInvalidate();
  if (reload) await loadAdministration();
  // O acionador saiu da tela: o painel leva o foco a "Conferir prévia Olist"
  // (ou ao progresso) depois de reler a projeção.
  emit('refresh', { focus: true });
}
async function submitInvalidate() {
  if (busy.value || ivSettled || !ivOpen.value || !ivTarget.value) return;
  if (props.cancelled) {
    ivError.value = olistRecoveryFailure(
      { code: 'ORDER_CANCELLED' },
      'invalidate',
    );
    await focusElement(ivAlert);
    return;
  }
  // Mesma regra de conferir e vincular: quebras e tabs viram um espaço.
  const reason = normalizeReasonText(ivReason.value);
  if (!reason || reason.length > 1000) {
    ivError.value = reason
      ? 'O motivo pode ter no máximo 1000 caracteres.'
      : 'Informe o motivo da invalidação.';
    await focusElement(ivReasonField);
    return;
  }
  const target = ivTarget.value;
  // Um reenvio idêntico (mesmo alvo, versão e motivo) usa a mesma chave; mudar
  // o motivo ou o alvo é outro comando e recebe outra chave.
  const token = `${target.operationId}:${target.expectedVersion}:${reason}`;
  if (ivKeyToken !== token) {
    ivKey = commandKey();
    ivKeyToken = token;
  }
  const id = props.orderId;
  busy.value = true;
  ivError.value = '';
  try {
    const response = await request(`${base.value}/invalidate`, {
      method: 'POST',
      body: {
        operationId: target.operationId,
        expectedVersion: target.expectedVersion,
        reason,
      },
      idempotencyKey: ivKey,
    });
    if (disposed || props.orderId !== id) return;
    const receipt = response.data;
    if (
      receipt?.state !== 'invalidated' ||
      receipt?.operationId !== target.operationId
    ) {
      // A resposta não prova o resultado: lê o diagnóstico antes de afirmar.
      await loadAdministration();
      if (disposed || props.orderId !== id) return;
      if (targetNoLongerActive(target)) {
        await finishInvalidate(
          'A invalidação consta no diagnóstico, apesar de a resposta não ter confirmado. Gere uma nova prévia.',
          false,
        );
        return;
      }
      emit('refresh', { focus: false });
      ivError.value =
        'A resposta não confirmou a invalidação. O diagnóstico foi atualizado; confira antes de tentar de novo.';
      await focusElement(ivAlert);
      return;
    }
    await finishInvalidate(
      receipt.replayed === true
        ? 'Esta geração já estava invalidada. Nada mudou; gere uma nova prévia.'
        : 'Geração invalidada antes de qualquer venda. Cadastros já criados no Olist foram preservados. Gere uma nova prévia.',
      true,
    );
  } catch (cause) {
    if (disposed || props.orderId !== id) return;
    if ([401, 403].includes(Number(cause?.status))) {
      await closeDialogElement(ivDialog.value);
      loseAccess(cause);
      return;
    }
    ivError.value = olistRecoveryFailure(cause, 'invalidate');
    if (cause?.code === 'VERSION_CONFLICT') {
      await loadAdministration();
      if (disposed || props.orderId !== id) return;
      if (invalidateOffered.value && operation.value) {
        // Segue com o estado atual: a versão nova gera outra chave.
        ivTarget.value = {
          operationId: operation.value.id,
          expectedVersion: Number(operation.value.version),
        };
      } else if (data.value) {
        ivError.value = olistRecoveryFailure(
          { status: 409, code: 'OLIST_INVALIDATION_BLOCKED' },
          'invalidate',
        );
      }
    } else if (uncertainFailure(cause)) {
      // Sem resposta ou 5xx: a invalidação pode ter sido gravada. Relê o
      // diagnóstico e a projeção; se ela consta, o diálogo se encerra. Senão,
      // o reenvio usa a mesma chave (comando local e idempotente).
      await loadAdministration();
      if (disposed || props.orderId !== id) return;
      if (targetNoLongerActive(target)) {
        await finishInvalidate(
          'A invalidação foi registrada, apesar da falha na resposta. Gere uma nova prévia.',
          false,
        );
        return;
      }
      emit('refresh', { focus: false });
    } else if (cause?.status === 409) void loadAdministration();
    await focusElement(ivAlert);
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
      geração. Invalidar descarta uma geração que ainda não chegou à venda.
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
        <div v-if="legacyOffered" class="olist-recovery-link">
          <button
            type="button"
            :disabled="busy || disabled"
            @click="openLink($event, 'legacy')"
          >
            Vincular venda histórica por linha
          </button>
          <p class="field-help">
            Para uma venda antiga cujos produtos não têm a identificação
            padronizada do CRM. Exige conferir os atributos de cada produto e
            informar a correspondência de cada linha. Os cadastros ficam
            restritos ao histórico desta venda.
          </p>
        </div>
        <div v-if="invalidateOffered" class="olist-recovery-link">
          <button
            type="button"
            :disabled="busy || disabled"
            @click="openInvalidate"
          >
            Invalidar esta geração
          </button>
          <p class="field-help">
            Descarta a geração atual, que ainda não chegou à venda, para
            preparar uma nova. Cadastros já criados no Olist são preservados;
            nada é apagado nem cancelado no Olist.
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
      v-if="ivOpen"
      ref="ivDialog"
      class="op-dialog olist-dialog"
      aria-modal="true"
      :aria-labelledby="`olist-iv-title-${orderId}`"
      :aria-describedby="`olist-iv-desc-${orderId}`"
      @cancel.prevent="cancelInvalidate"
    >
      <h2 :id="`olist-iv-title-${orderId}`">Invalidar esta geração?</h2>
      <p :id="`olist-iv-desc-${orderId}`">
        A geração atual é descartada antes de qualquer venda. Os cadastros já
        criados no Olist são preservados e nada é apagado nem cancelado no
        Olist. Depois será preciso gerar uma nova prévia.
      </p>
      <form novalidate @submit.prevent="submitInvalidate">
        <div class="olist-dialog-field">
          <label :for="`olist-iv-reason-${orderId}`"
            >Motivo da invalidação (obrigatório)</label
          >
          <textarea
            :id="`olist-iv-reason-${orderId}`"
            ref="ivReasonField"
            v-model="ivReason"
            rows="3"
            maxlength="1000"
            required
            :aria-invalid="ivError ? 'true' : undefined"
            :aria-describedby="`olist-iv-help-${orderId}`"
          ></textarea>
          <p :id="`olist-iv-help-${orderId}`" class="field-help">
            Fica cifrado na auditoria. Não inclua dados pessoais do cliente.
            Quebras de linha viram espaço.
          </p>
        </div>
        <p
          v-if="ivError"
          ref="ivAlert"
          role="alert"
          class="inline-error"
          tabindex="-1"
        >
          {{ ivError }}
        </p>
        <div class="op-dialog-actions">
          <button type="button" :disabled="busy" @click="cancelInvalidate">
            Voltar
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="busy"
            :aria-busy="busy || undefined"
          >
            {{ busy ? 'Invalidando…' : 'Invalidar geração' }}
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
      <h2 :id="`olist-lk-title-${orderId}`">
        {{
          lkMode === 'legacy'
            ? 'Vincular venda histórica por linha'
            : 'Vincular venda existente'
        }}
      </h2>
      <p :id="`olist-lk-desc-${orderId}`">
        Nenhuma venda será criada no Olist. Primeiro o CRM confere a venda
        informada; depois você confirma o vínculo com um motivo.
      </p>
      <p v-if="lkMode === 'legacy'" class="field-help">
        Confira no Olist a peça, cor, tecido, aplicação, gola, público e
        tamanho. Essa correspondência depende da sua conferência: descrições
        livres e SKUs vazios não comprovam esses atributos. O vínculo não
        disponibiliza esses produtos para gerar novos pedidos. O vencimento, a
        origem e a ordem de compra serão conferidos na própria venda histórica
        do Olist.
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
        <div v-if="dueRequired" class="olist-dialog-field">
          <label :for="`olist-lk-due-${orderId}`">Vencimento desta venda</label>
          <input
            :id="`olist-lk-due-${orderId}`"
            ref="lkDueField"
            v-model="lkDueOn"
            type="date"
            required
            :disabled="busy"
          />
          <p class="field-help">
            Informe a data registrada nesta venda no Olist.
          </p>
        </div>
        <fieldset
          v-if="fiscalRequired"
          class="olist-legacy-group"
          :disabled="busy"
        >
          <legend>Cadastro fiscal para esta conferência</legend>
          <p class="field-help">
            Informe os dados fiscais que devem corresponder ao produto já
            lançado no Olist. Eles ficam congelados nesta prévia.
          </p>
          <div class="olist-dialog-field">
            <label :for="`olist-lk-ncm-${orderId}`">NCM do produto</label>
            <input
              :id="`olist-lk-ncm-${orderId}`"
              ref="lkNcmField"
              v-model="lkFiscal.ncm"
              inputmode="numeric"
              autocomplete="off"
              maxlength="8"
              required
              :aria-invalid="lkFiscalInvalid === 'ncm' ? 'true' : undefined"
              :aria-describedby="
                lkFiscalInvalid === 'ncm'
                  ? `olist-lk-error-${orderId}`
                  : undefined
              "
            />
          </div>
          <div class="olist-dialog-field">
            <label :for="`olist-lk-origin-${orderId}`"
              >Origem fiscal do produto</label
            >
            <input
              :id="`olist-lk-origin-${orderId}`"
              ref="lkOriginField"
              v-model="lkFiscal.origin"
              inputmode="numeric"
              autocomplete="off"
              maxlength="1"
              required
              :aria-invalid="lkFiscalInvalid === 'origin' ? 'true' : undefined"
              :aria-describedby="`olist-lk-origin-help-${orderId}${lkFiscalInvalid === 'origin' ? ` olist-lk-error-${orderId}` : ''}`"
            />
            <p :id="`olist-lk-origin-help-${orderId}`" class="field-help">
              Código fiscal de 0 a 8, conforme o cadastro do produto.
            </p>
          </div>
          <div class="olist-dialog-field">
            <label :for="`olist-lk-unit-${orderId}`"
              >Unidade fiscal do produto</label
            >
            <input
              :id="`olist-lk-unit-${orderId}`"
              ref="lkUnitField"
              v-model="lkFiscal.unit"
              type="text"
              autocomplete="off"
              maxlength="6"
              autocapitalize="characters"
              required
              :aria-invalid="lkFiscalInvalid === 'unit' ? 'true' : undefined"
              :aria-describedby="
                lkFiscalInvalid === 'unit'
                  ? `olist-lk-error-${orderId}`
                  : undefined
              "
            />
          </div>
        </fieldset>
        <template v-if="lkMode === 'legacy'">
          <fieldset
            v-for="(group, groupIndex) in lkGroups"
            :key="group.groupId"
            class="olist-legacy-group"
            :disabled="busy"
          >
            <legend>Grupo {{ groupIndex + 1 }}</legend>
            <p>
              {{ groupAttributes(group.attributes).join(' · ') }}
            </p>
            <div class="olist-dialog-field">
              <label :for="`olist-legacy-parent-${orderId}-${groupIndex}`"
                >ID do produto pai no Olist — grupo {{ groupIndex + 1 }}</label
              >
              <input
                :id="`olist-legacy-parent-${orderId}-${groupIndex}`"
                v-model="group.parentProductId"
                inputmode="numeric"
                autocomplete="off"
                maxlength="16"
                required
              />
            </div>
            <fieldset
              v-for="(line, lineIndex) in group.lines"
              :key="line.lineId"
              class="olist-legacy-line"
            >
              <legend>Tamanho {{ line.size }}</legend>
              <p>
                {{ line.quantity }} peças ·
                {{ amountLabel(line.subtotalCents) }}
              </p>
              <div class="olist-dialog-field">
                <label
                  :for="`olist-legacy-child-${orderId}-${groupIndex}-${lineIndex}`"
                  >ID da variação no Olist — grupo {{ groupIndex + 1 }},
                  {{ line.size }}</label
                >
                <input
                  :id="`olist-legacy-child-${orderId}-${groupIndex}-${lineIndex}`"
                  v-model="line.childProductId"
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength="16"
                  required
                />
              </div>
              <div class="olist-dialog-field">
                <label
                  :for="`olist-legacy-item-${orderId}-${groupIndex}-${lineIndex}`"
                  >Posição do item na venda Olist — grupo {{ groupIndex + 1 }},
                  {{ line.size }}</label
                >
                <input
                  :id="`olist-legacy-item-${orderId}-${groupIndex}-${lineIndex}`"
                  v-model="line.itemIndex"
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength="6"
                  required
                  :aria-describedby="`olist-legacy-item-help-${orderId}`"
                />
              </div>
            </fieldset>
          </fieldset>
          <p :id="`olist-legacy-item-help-${orderId}`" class="field-help">
            A posição começa em 0: primeiro item = 0, segundo = 1. Cada item
            deve aparecer uma única vez.
          </p>
        </template>
        <p
          v-if="lkError"
          :id="`olist-lk-error-${orderId}`"
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
          <div v-if="lkMode !== 'legacy' && lkPreview?.paymentDueOn">
            <dt>Vencimento</dt>
            <dd>{{ dayLabel(lkPreview.paymentDueOn) }}</dd>
          </div>
          <div v-if="lkMode !== 'legacy' && lkPreview?.productFiscal">
            <dt>Cadastro fiscal conferido</dt>
            <dd>
              NCM {{ lkPreview.productFiscal.ncm }} · origem
              {{ lkPreview.productFiscal.origin }} ·
              {{ lkPreview.productFiscal.unit }}
            </dd>
          </div>
        </dl>
        <section
          v-if="lkMode === 'legacy' && lkPreview?.historicalMetadata"
          aria-label="Dados históricos da venda"
        >
          <h4>Dados históricos no Olist</h4>
          <dl>
            <div>
              <dt>Origem no Olist (ID)</dt>
              <dd>
                {{ lkPreview.historicalMetadata.originId ?? 'Não informada' }}
              </dd>
            </div>
            <div>
              <dt>Ordem de compra histórica</dt>
              <dd>
                {{
                  lkPreview.historicalMetadata.purchaseOrder || 'Não informada'
                }}
              </dd>
            </div>
            <div>
              <dt>Vencimento registrado no Olist</dt>
              <dd>{{ dayLabel(lkPreview.historicalMetadata.paymentDueOn) }}</dd>
            </div>
          </dl>
          <p
            v-if="lkPreview.historicalMetadata.productFiscalMissing"
            class="field-help"
          >
            Cadastro fiscal legado ausente; esses dados não serão reutilizados
            em novas vendas.
          </p>
          <p v-else class="field-help">
            Os dados fiscais permanecem apenas como evidência histórica; não
            serão reutilizados em novas vendas.
          </p>
        </section>
        <p class="field-help">
          O Olist confirmou comprador, itens, quantidades e total desta venda
          com o pedido. Vincular não altera a venda nem o pedido.
        </p>
        <section
          v-if="lkMode === 'legacy'"
          aria-label="Correspondência conferida"
        >
          <div
            v-for="(group, index) in lkGroups"
            :key="group.groupId"
            class="olist-legacy-group"
          >
            <h4>
              Grupo {{ index + 1 }} · produto pai {{ group.parentProductId }}
            </h4>
            <p>
              {{ groupAttributes(group.attributes).join(' · ') }}
            </p>
            <ul>
              <li v-for="line in group.lines" :key="line.lineId">
                {{ line.size }} · {{ line.quantity }} peças ·
                {{ amountLabel(line.subtotalCents) }} · variação
                {{ line.childProductId }} · posição {{ line.itemIndex }}
              </li>
            </ul>
          </div>
        </section>
        <div v-if="lkMode === 'legacy'" class="olist-dialog-field">
          <label
            :for="`olist-lk-confirmed-${orderId}`"
            class="olist-confirmation"
          >
            <input
              :id="`olist-lk-confirmed-${orderId}`"
              ref="lkConfirmationField"
              v-model="lkConfirmed"
              type="checkbox"
              required
            />
            Conferi no Olist os atributos de todos os produtos e tamanhos e
            confirmo a correspondência de cada linha deste pedido.
          </label>
          <p class="field-help">
            Somente o histórico da venda será vinculado. Nenhum cadastro será
            criado, alterado ou liberado para outros pedidos.
          </p>
        </div>
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
.olist-legacy-group,
.olist-legacy-line {
  display: grid;
  gap: var(--space-3);
  min-inline-size: 0;
  margin-block: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
}
.olist-legacy-group legend,
.olist-legacy-line legend {
  font-weight: 600;
}
.olist-legacy-group p,
.olist-legacy-group li {
  overflow-wrap: anywhere;
}
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
.olist-confirmation {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-block-size: var(--target-min);
}
.olist-dialog-field input[type='checkbox'] {
  flex: none;
  inline-size: auto;
  margin-block-start: var(--space-1);
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
