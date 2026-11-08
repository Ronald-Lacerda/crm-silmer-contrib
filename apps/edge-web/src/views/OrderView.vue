<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import OrderOlistPanel from '../components/order/OrderOlistPanel.vue';
import OrderPriceBreakdown from '../components/order/OrderPriceBreakdown.vue';
import OrderClosingSection from '../components/order/OrderClosingSection.vue';
import OrderBillingSection from '../components/order/OrderBillingSection.vue';
import OrderArtworkSection from '../components/order/OrderArtworkSection.vue';
import OrderIcon from '../components/order/OrderIcon.vue';
import OrderInfoStrips from '../components/order/OrderInfoStrips.vue';
import OrderItemsSection from '../components/order/OrderItemsSection.vue';
import OrderMilestonesSection from '../components/order/OrderMilestonesSection.vue';
import OrderObservationsSection from '../components/order/OrderObservationsSection.vue';
import OrderProgress from '../components/order/OrderProgress.vue';
import OrderStoreDetails from '../components/order/OrderStoreDetails.vue';
import OrderStoreCorrection from '../components/order/OrderStoreCorrection.vue';
import OrderSummarySection from '../components/order/OrderSummarySection.vue';
import OrderShippingEstimate from '../components/order/OrderShippingEstimate.vue';
import { commandKey, request } from '../lib/api-client.js';
import { usePhone } from '../lib/media-query.js';
import {
  canSharePdf,
  downloadPdf,
  getOrderPdf,
  pdfFile,
  sharePdf,
} from '../lib/order-pdf.js';
import {
  fabLabel,
  isStoreOrder,
  nextOrderStep,
  ORDER_REVIEW_SECTION,
  orderStatusLabel,
  orderSteps,
  PRINT_LOCKED_REASON,
  STORE_ORIGIN_LABEL,
  storeFichaPending,
  storeProductLabel,
} from '../lib/order-format.js';

/**
 * PFI-18 (RFC 024): the sections of the phone accordion, in page order, and
 * the hash that opens each one again (`/pedidos/<id>#itens`).
 */
const SECTION_HASHES = Object.freeze({
  summary: 'resumo',
  milestones: 'datas',
  items: 'itens',
  artwork: 'arte',
  observations: 'observacoes',
  service: 'atendimento',
  billing: 'cobrancas',
});

const LIVE_REFRESH_DELAY_MS = 250;

const props = defineProps({
  fromConversationId: { type: String, default: '' },
  orderId: { type: String, required: true },
});

const liveEvent = inject('liveEvent', ref(null));
const sessionUser = inject('sessionUser', ref({}));
const heading = ref(null);
const order = ref(null);
const billingState = ref({ ready: false, managed: false, available: false });
provide('orderBillingState', billingState);
const loading = ref(true);
const notFound = ref(false);
const error = ref('');
const pdfError = ref('');
const pdfBusy = ref(false);
const shareAvailable = canSharePdf();
// PFI-06: one section in edit at a time, decided here so two open forms can
// never disagree about the version they are saving over.
const editingSection = ref('');
const editingVersion = ref(null);
const olistOperation = ref(null);
// ADR 016: "Gerar pedido" sends the seller to the section that fills a
// missing point; the section opens its own editor when it can.
/** @type {import('vue').Ref<{section: string, at: number}|null>} */
const editRequest = ref(null);
const closingSection = ref(null);
/** @type {import('vue').Ref<HTMLElement|null>} */
const footerStep = ref(null);
const route = useRoute();
const router = useRouter();
// PFI-18: up to 768 px the sections form an accordion, one open at a time.
const isPhone = usePhone();
const openSection = ref('');
let sectionChosen = false;
let revealOnLoad = false;
let controller;
let refreshTimer = 0;
let readyPdf = null;
let readyPdfVersion = null;
let pendingLiveRefresh = false;
let headingAnnounced = false;

const isPending = computed(() => order.value?.status === 'pendente');
// ADR 027: a site shop order is born confirmed and locked; the page shows it
// read only, with its simplified ficha to download.
const isStore = computed(() => isStoreOrder(order.value));
const isAdmin = computed(() =>
  (sessionUser.value?.capabilities ?? []).includes('COMMERCIAL_ADMIN'),
);
/**
 * PAU-01: editing follows the conversation owner (D08). A reader who is
 * neither the owner nor an administrator sees the whole page, and no button
 * that the API would refuse with 403.
 */
const commercialAccess = computed(
  () =>
    Boolean(order.value) &&
    (isAdmin.value || order.value.seller?.id === sessionUser.value?.id),
);
const olistLocked = computed(() =>
  Boolean(
    order.value?.olistLocked ||
    olistOperation.value?.unavailable ||
    (olistOperation.value &&
      !['invalidated', 'rejected'].includes(olistOperation.value.state)),
  ),
);
const canEdit = computed(
  () =>
    commercialAccess.value && !order.value?.cancelledAt && !olistLocked.value,
);
const canEditMilestones = computed(
  () => commercialAccess.value && !order.value?.cancelledAt,
);
const canConfirm = computed(
  () =>
    commercialAccess.value &&
    !order.value?.cancelledAt &&
    (!olistLocked.value || order.value?.olistConfirmationAllowed === true),
);
const olistEnabled = computed(() => sessionUser.value?.olistEnabled === true);
const customerName = computed(
  () => order.value?.ficha?.summary?.cliente || 'Cliente não informado',
);
const orderContext = computed(() => {
  if (isStore.value) {
    const product = storeProductLabel(order.value);
    return product ? `${STORE_ORIGIN_LABEL} · ${product}` : STORE_ORIGIN_LABEL;
  }
  const event = order.value?.ficha?.summary?.nome || 'Sem evento';
  const seller = order.value?.seller?.name;
  return seller ? `${event} · com ${seller}` : event;
});
// PFI-15 (RFC 024): the real steps to generate, for whoever may generate.
const steps = computed(() => orderSteps(order.value));
const nextStep = computed(() => nextOrderStep(order.value));
const nextStepNumber = computed(
  () => steps.value.findIndex((step) => step.key === nextStep.value?.key) + 1,
);
const showProgress = computed(
  () =>
    isPending.value &&
    canEdit.value &&
    !isStore.value &&
    steps.value.length > 0,
);
/**
 * Mobile first (PO, 15/10/2026): on a phone the page's main action stays in
 * a fixed footer — the next step while one is missing and "Gerar pedido" once
 * none is (PFI-16), for whoever may confirm a pending order, and "Gerar PDF"
 * once it is confirmed. It steps aside while a section is being
 * edited, so the editor's own Salvar and Cancelar stay in reach.
 */
const mobileAction = computed(() => {
  if (!order.value || editingSection.value !== '' || order.value.cancelledAt)
    return '';
  if (
    isPhone.value &&
    openSection.value === 'billing' &&
    billingState.value.available
  )
    return '';
  if (!isPending.value) return 'pdf';
  if (!canConfirm.value || isStore.value) return '';
  return nextStep.value ? 'step' : 'generate';
});
const itemCount = computed(() => order.value?.ficha?.items?.length ?? 0);
/** The conversation this order came from, opened directly in the Inbox. */
const conversationLink = computed(() => {
  const id = order.value?.conversationId || props.fromConversationId;
  return id ? `/inbox/${encodeURIComponent(id)}` : '';
});
const deliveryLabel = computed(() => {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(
    String(order.value?.ficha?.summary?.data_entrega_confirmada ?? ''),
  );
  return match ? `entrega ${match[2]}/${match[1]}` : 'sem entrega prometida';
});

/**
 * What a failed write means to the seller. The message is chosen here, next
 * to the version the page is holding, so every section says the same thing
 * about the same code.
 *
 * @param {any} cause
 */
function describeWriteError(cause) {
  const status = Number(cause?.status);
  const code = String(cause?.code ?? '');
  if (status === 409)
    return 'Este pedido mudou. Cancele a edição para ver a versão atual.';
  if (status === 403) return 'Este pedido é de outro vendedor.';
  if (code === 'INVALID_AMOUNT') return 'Use o formato 4.820,00.';
  if (code === 'INVALID_DATE') return 'Use uma data até hoje.';
  if (status >= 500) return 'Serviço indisponível no momento.';
  return 'Não foi possível salvar esta seção.';
}

/**
 * PFI-06: a section is written whole, over the version the page is showing.
 * The answer carries the new order, so the page never guesses what the server
 * derived (totals, what is missing) from the change.
 *
 * @param {string} section @param {unknown} value
 */
async function saveSection(section, value) {
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.orderId)}/sections/${section}`,
      {
        body: {
          expectedVersion: editingVersion.value ?? order.value.version,
          value,
        },
        idempotencyKey: commandKey(),
        method: 'PATCH',
      },
    );
    order.value = response.data.order;
    return { ok: true };
  } catch (cause) {
    if (Number(cause?.status) === 409) pendingLiveRefresh = true;
    return {
      code: String(/** @type {any} */ (cause)?.code ?? ''),
      fields: /** @type {any} */ (cause)?.problem?.fields ?? [],
      index: /** @type {any} */ (cause)?.problem?.index,
      message: describeWriteError(cause),
      ok: false,
    };
  }
}

/**
 * PCL-04/PCL-07: the only two transitions of the order, both human. They ride
 * the version the page is showing, so a confirmation typed over a stale screen
 * loses to a 409 instead of overwriting the winner (PCL-09).
 *
 * @param {'confirm'|'reopen'} action @param {Record<string, unknown>} body
 */
async function runCommand(action, body) {
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.orderId)}/${action}`,
      {
        body: {
          ...body,
          expectedVersion: body.expectedVersion ?? order.value.version,
        },
        idempotencyKey: commandKey(),
        method: 'POST',
      },
    );
    order.value = response.data.order;
    return { ok: true };
  } catch (cause) {
    if (Number(cause?.status) === 409) scheduleLiveRefresh();
    return {
      code: String(/** @type {any} */ (cause)?.code ?? ''),
      fields: /** @type {any} */ (cause)?.problem?.fields ?? [],
      message: describeWriteError(cause),
      ok: false,
      // 0 when the request never reached the server (connection lost).
      status: Number(/** @type {any} */ (cause)?.status) || 0,
    };
  }
}

/**
 * PFI-19: the server refused "Gerar o pedido" for a blocker outside the
 * dialog. The order is read again so the progress counts what the server
 * counts, and the focus goes to the button of the next step — the progress's
 * on a wide screen, the fixed footer's on a phone. Without a step to show,
 * the closing panel names the blockers ("Revisar pendências").
 */
async function revisitNextStep() {
  await load(true);
  await nextTick();
  const doc = globalThis.document;
  const target = nextStep.value
    ? [footerStep.value, doc?.querySelector('.op-progress-go')].find(
        (button) => button && button.getClientRects().length > 0,
      )
    : null;
  if (!target) {
    goToSection(ORDER_REVIEW_SECTION);
    return;
  }
  target.scrollIntoView?.({ block: 'center' });
  target.focus({ preventScroll: true });
}

/**
 * PLA-04 (ADR 008): paid and delivered travel together over the version the
 * page is showing, pending or confirmed.
 *
 * @param {{paidOn: string|null, deliveredOn?: string|null, paymentReviewed?: boolean}} value
 */
async function saveMilestones(value) {
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.orderId)}/milestones`,
      {
        body: {
          ...value,
          expectedVersion: editingVersion.value ?? order.value.version,
        },
        idempotencyKey: commandKey(),
        method: 'PATCH',
      },
    );
    order.value = response.data.order;
    return { ok: true };
  } catch (cause) {
    if (Number(cause?.status) === 409) scheduleLiveRefresh();
    return {
      code: String(/** @type {any} */ (cause)?.code ?? ''),
      fields: /** @type {any} */ (cause)?.problem?.fields ?? [],
      message: describeWriteError(cause),
      ok: false,
    };
  }
}

/** PIM-13: download the approved ficha as a PDF, or offer the mobile share sheet. */
async function generatePdf(share = false) {
  if (pdfBusy.value || isPending.value || !order.value) return;
  pdfBusy.value = true;
  pdfError.value = '';
  const firstStorePdf = storeFichaPending(order.value);
  try {
    const fromCache =
      share && readyPdf && readyPdfVersion === order.value.version;
    const file = fromCache
      ? readyPdf
      : pdfFile(await getOrderPdf(props.orderId), order.value.number);
    if (!fromCache) {
      readyPdf = file;
      readyPdfVersion = order.value.version;
      if (firstStorePdf && editingSection.value === '') await load(true);
    }
    if (share) {
      // Rendering may outlast the browser's gesture; a second tap shares the prepared file.
      if (
        !fromCache &&
        globalThis.navigator.userActivation?.isActive === false
      ) {
        pdfError.value =
          'PDF pronto. Toque em Compartilhar PDF novamente para escolher o WhatsApp.';
        return;
      }
      try {
        await sharePdf(file, order.value.number);
      } catch (cause) {
        if (cause?.name === 'AbortError') return;
        if (cause?.name === 'NotAllowedError' && !fromCache) {
          pdfError.value =
            'PDF pronto. Toque em Compartilhar PDF novamente para escolher o WhatsApp.';
          return;
        }
        downloadPdf(file);
        pdfError.value =
          'O compartilhamento não abriu. O PDF foi baixado para você encaminhar pelo WhatsApp.';
      }
    } else downloadPdf(file);
  } catch (cause) {
    pdfError.value =
      Number(cause?.status) === 409
        ? 'Este pedido foi reaberto. Atualize a página antes de gerar o PDF.'
        : 'Não foi possível gerar o PDF. Tente novamente.';
  } finally {
    pdfBusy.value = false;
  }
}

/**
 * PFI-15/PFI-16: the button of the next step opens the section that fills
 * it. Each section answers editRequest itself: it opens its own editor, or
 * only comes into view when it cannot open (PFI-06).
 *
 * "Revisar pendências" (a blocker this screen does not know) has no section
 * to open: it leads to the closing panel, whose "Falta para gerar" names it.
 * The focus moves to the panel's title unless it is already in the panel.
 *
 * @param {string} section
 */
function goToSection(section) {
  const gaps = order.value?.missingFields ?? [];
  if (
    section === 'items' &&
    !order.value?.ficha?.sizePricing &&
    order.value?.confirmedAt &&
    gaps.some((field) =>
      /^(?:sizePricing|priceBreakdown)(?:\.|$)/u.test(field),
    ) &&
    !gaps.some((field) => /^items(?:\[|$)/u.test(field))
  ) {
    const target = globalThis.document?.querySelector('.order-source h2');
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus();
    return;
  }
  if (section !== ORDER_REVIEW_SECTION) {
    editRequest.value = { at: Date.now(), section };
    return;
  }
  const doc = globalThis.document;
  const title = doc?.getElementById('order-closing-title');
  const panel = title?.closest('section');
  (doc?.getElementById('closing-readiness') ?? panel)?.scrollIntoView?.({
    block: 'center',
  });
  if (title && !panel?.contains(doc.activeElement)) {
    title.focus({ preventScroll: true });
  }
}

/** @param {string} section */
function isAccordionSection(section) {
  return Object.hasOwn(SECTION_HASHES, section);
}

/**
 * PFI-18: the open section is kept in the URL's hash, so a reload or the way
 * back resumes it, with no state of its own anywhere else. The hash is
 * written to the router's history directly: the shell keys each view by its
 * full path, hash included, so a router navigation would mount the page
 * again and drop the focus and any draft.
 *
 * @param {string} section
 */
function rememberSection(section) {
  if (!isPhone.value) return;
  const hash = isAccordionSection(section) ? `#${SECTION_HASHES[section]}` : '';
  const path = route.fullPath.replace(/#.*$/su, '');
  router.options.history.replace(`${path}${hash}`);
}

/**
 * PFI-18: the router has no scroll behaviour, so a section opened by the
 * hash, by the next step or by "Gerar pedido" is brought into view by its
 * head.
 *
 * @param {string} section
 */
function scrollToSection(section) {
  if (!isPhone.value) return;
  globalThis.document
    ?.getElementById(`order-${section}-title`)
    ?.closest('section')
    ?.scrollIntoView?.({ block: 'start' });
}

/**
 * PFI-18: the section the page opens with — the one named by the hash, else
 * the first step still missing (PFI-15), else the summary.
 */
function initialSection() {
  const hash = String(route.hash ?? '').replace(/^#/u, '');
  const named = Object.keys(SECTION_HASHES).find(
    (section) =>
      SECTION_HASHES[/** @type {keyof typeof SECTION_HASHES} */ (section)] ===
      hash,
  );
  if (named) return { reveal: true, section: named };
  const step = nextOrderStep(order.value);
  if (step && isAccordionSection(step.section)) {
    return { reveal: false, section: step.section };
  }
  return { reveal: false, section: 'summary' };
}

/**
 * PFI-18: opens one section and closes the other; the section in edit stays
 * open (isSectionOpen) until Salvar or Cancelar.
 *
 * @param {string} section
 */
async function revealSection(section) {
  if (!isAccordionSection(section)) return;
  if (openSection.value !== section) {
    openSection.value = section;
    rememberSection(section);
  }
  await nextTick();
  scrollToSection(section);
}

/**
 * PFI-18: a head opens its section or closes it. While a section is in edit
 * every head waits (PFI-06), so a draft is never hidden from its owner.
 *
 * @param {string} section
 */
function toggleSection(section) {
  if (!isPhone.value || editingSection.value !== '') return;
  if (!isAccordionSection(section)) return;
  openSection.value = openSection.value === section ? '' : section;
  rememberSection(openSection.value);
}

/**
 * PFI-18: every section is open on a wide screen; on a phone only the chosen
 * one and the one in edit.
 *
 * @param {string} section
 */
function isSectionOpen(section) {
  return (
    !isPhone.value ||
    openSection.value === section ||
    editingSection.value === section
  );
}

// The next step, "Gerar pedido" and the progress open the section they ask
// for before the section answers the request itself.
watch(editRequest, (next) => {
  if (next) void revealSection(next.section);
});

provide('orderEditing', {
  canEdit,
  canConfirm,
  canEditMilestones,
  command: runCommand,
  editingSection,
  editRequest,
  goToSection,
  isPhone,
  isSectionOpen,
  openSection,
  print: () => generatePdf(),
  /** @param {string} section */
  request(section) {
    editRequest.value = { at: Date.now(), section };
  },
  revisitNextStep,
  save: saveSection,
  saveMilestones,
  /** @param {string} section */
  start(section) {
    if (refreshTimer) {
      globalThis.clearTimeout(refreshTimer);
      refreshTimer = 0;
      pendingLiveRefresh = true;
    }
    editingVersion.value = order.value?.version ?? null;
    editingSection.value = section;
    if (isAccordionSection(section) && openSection.value !== section) {
      openSection.value = section;
      rememberSection(section);
    }
  },
  stop() {
    editingSection.value = '';
    editingVersion.value = null;
    if (pendingLiveRefresh) {
      pendingLiveRefresh = false;
      scheduleLiveRefresh();
    }
  },
  toggleSection,
});

/** @param {boolean} [silent] */
async function load(silent = false) {
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const response = await request(
      `/api/v1/orders/${encodeURIComponent(props.orderId)}`,
      { signal: currentController.signal },
    );
    order.value = response.data.order;
    notFound.value = false;
    error.value = '';
    // PFI-18: chosen once, with the first order read; a live refresh never
    // moves the seller to another section.
    if (!sectionChosen) {
      const initial = initialSection();
      openSection.value = initial.section;
      revealOnLoad = initial.reveal;
      sectionChosen = true;
    }
  } catch (cause) {
    if (cause?.name === 'AbortError') return;
    if (Number(cause?.status) === 404) {
      notFound.value = true;
      order.value = null;
      return;
    }
    error.value = order.value
      ? 'Não foi possível atualizar o pedido. Os dados exibidos podem estar desatualizados.'
      : 'Não foi possível carregar o pedido.';
  } finally {
    if (controller === currentController) {
      loading.value = false;
      // The heading exists once the order or an error is known.
      if (!headingAnnounced) {
        await nextTick();
        heading.value?.focus();
        headingAnnounced = Boolean(heading.value);
      }
      // PFI-18: a section named by the hash comes into view once the page
      // has announced itself.
      if (revealOnLoad && order.value) {
        revealOnLoad = false;
        await nextTick();
        scrollToSection(openSection.value);
      }
    }
  }
}

function retryInitialLoad() {
  headingAnnounced = false;
  void load();
}

/** Collapses bursts of live events into one silent refresh. */
function scheduleLiveRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    if (editingSection.value !== '') {
      pendingLiveRefresh = true;
      return;
    }
    void load(true);
  }, LIVE_REFRESH_DELAY_MS);
}

// A section under edit is not overwritten from under the seller: the refresh
// waits for Salvar or Cancelar.
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.conversation.changed',
      'inbox.contact.changed',
    ].includes(event?.type)
  ) {
    if (editingSection.value !== '') {
      pendingLiveRefresh = true;
      return;
    }
    scheduleLiveRefresh();
  }
});

onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  controller?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="page op-page" :data-mobile-action="mobileAction || undefined">
    <div v-if="loading" class="loading-state" role="status">
      Carregando pedido…
    </div>

    <section v-else-if="notFound" class="surface empty-list">
      <h1 ref="heading" tabindex="-1">Pedido não encontrado</h1>
      <p>Ele pode ter sido removido ou o endereço está errado.</p>
      <RouterLink class="button-link" to="/pedidos"
        >Voltar para Pedidos</RouterLink
      >
    </section>

    <section
      v-else-if="error && !order"
      class="surface empty-list"
      role="alert"
    >
      <h1 ref="heading" tabindex="-1">Pedido indisponível</h1>
      <p>{{ error }}</p>
      <button type="button" @click="retryInitialLoad">Tentar novamente</button>
    </section>

    <template v-else-if="order">
      <nav class="order-trail" aria-label="Rastro">
        <RouterLink to="/pedidos">← Pedidos</RouterLink>
        <span aria-hidden="true">/</span>
        <span>{{ order.number }}</span>
        <span v-if="fromConversationId" class="order-origin">
          aberto a partir da conversa de {{ customerName }}
        </span>
      </nav>

      <header class="op-head">
        <div class="op-head-text">
          <div class="op-head-title">
            <h1 ref="heading" tabindex="-1">Pedido {{ order.number }}</h1>
            <!-- LOJ-34: a site order is Confirmado, like any generated one. -->
            <span class="op-status" :data-status="order.status">
              <OrderIcon :name="isPending ? 'clock' : 'check'" />
              {{ orderStatusLabel(order.status) }}
            </span>
            <!-- ADR 028: the shop's number travels with the CRM number. -->
            <span v-if="isStore" class="badge" data-tone="info">{{
              order.storeNumber ? `Loja · ${order.storeNumber}` : 'Loja'
            }}</span>
            <span v-if="order.isTest" class="badge" data-tone="warning"
              >Teste</span
            >
            <span
              v-if="storeFichaPending(order)"
              class="badge"
              data-tone="warning"
              >Ficha ainda sem PDF</span
            >
          </div>
          <p v-if="isStore">{{ customerName }} — {{ orderContext }}</p>
          <p v-else>
            {{ customerName }} — {{ orderContext }} ·
            {{ fabLabel(order.fabCode) }}
          </p>
        </div>
        <div class="op-head-actions">
          <RouterLink
            v-if="conversationLink"
            class="button-link quiet-link"
            :to="conversationLink"
            >Abrir conversa</RouterLink
          >
          <button
            type="button"
            class="op-print"
            :disabled="isPending || pdfBusy"
            :aria-describedby="isPending ? 'order-print-reason' : undefined"
            @click="generatePdf()"
          >
            <OrderIcon name="download" />{{
              pdfBusy ? 'Gerando PDF…' : 'Gerar PDF'
            }}
          </button>
          <button
            v-if="shareAvailable && !isPending"
            type="button"
            class="op-print"
            :disabled="pdfBusy"
            @click="generatePdf(true)"
          >
            Compartilhar PDF
          </button>
        </div>
      </header>

      <p v-if="isPending" id="order-print-reason" class="op-print-reason">
        {{ PRINT_LOCKED_REASON }}
      </p>
      <p v-if="error" role="alert" class="op-alert">{{ error }}</p>
      <p v-if="pdfError" role="alert" class="op-alert">{{ pdfError }}</p>
      <button v-if="error" type="button" @click="load(true)">
        Tentar novamente
      </button>
      <p v-if="order.cancelledAt" class="op-readonly">
        Pedido cancelado. A edição e a geração estão bloqueadas.
      </p>
      <p v-else-if="olistLocked" class="op-readonly">
        Pedido protegido por uma operação Olist. A composição não pode ser
        editada ou reaberta.
      </p>
      <p v-else-if="isStore" class="op-readonly">
        <OrderIcon name="lock" />
        Pedido da loja do site: travado, sem edição.
      </p>
      <p v-else-if="!canEdit" class="op-readonly">
        <OrderIcon name="lock" />
        Somente {{ order.seller?.name || 'o dono da conversa' }} ou um
        administrador edita este pedido.
      </p>

      <!-- LOJ-34: the same two columns as any confirmed order. -->
      <div v-if="isStore" class="op-layout">
        <div class="op-main">
          <OrderStoreDetails :order="order" />
          <OrderStoreCorrection
            v-if="
              isAdmin &&
              canEdit &&
              !order.isTest &&
              [
                'bloquinho-22',
                'bloquinho-22-colorido',
                'bloquinho-22-completa',
              ].includes(order.ficha?.loja?.produto?.slug)
            "
            :order="order"
            @saved="order = $event"
          />
        </div>
        <aside class="op-rail" aria-label="Fechamento e pagamento">
          <OrderClosingSection ref="closingSection" :order="order" />
        </aside>
      </div>

      <div v-if="!isStore" class="op-layout">
        <!-- PFI-01: the order of the printed ficha, top to bottom, under the
             real progress to generate it (PFI-15). -->
        <div class="op-main">
          <OrderProgress v-if="showProgress" :order="order" />
          <OrderSummarySection :order="order" />
          <OrderMilestonesSection :order="order" />
          <OrderBillingSection
            :order="order"
            @state="billingState = $event"
            @changed="load(true)"
          />
          <OrderItemsSection :order="order" />
          <OrderArtworkSection :order="order" />
          <OrderObservationsSection :order="order" />
          <OrderShippingEstimate
            :order-id="order.id"
            :revision="order.version"
          />
          <OrderInfoStrips :order="order" />
        </div>
        <aside class="op-rail" aria-label="Gerar pedido">
          <OrderClosingSection ref="closingSection" :order="order" />
          <p class="op-total">
            <span class="op-total-label">
              Total de peças
              <span class="op-num"
                >{{ itemCount }} {{ itemCount === 1 ? 'item' : 'itens' }} ·
                {{ deliveryLabel }}</span
              >
            </span>
            <strong class="op-num">{{ order.totalPieces }}</strong>
          </p>
        </aside>
      </div>

      <OrderPriceBreakdown
        v-if="!order.ficha?.sizePricing && (isStore || order.confirmedAt)"
        :order="order"
        :can-edit="canEdit && (!isStore || isAdmin)"
        @changed="load(true)"
      />
      <OrderOlistPanel
        v-if="olistEnabled || isAdmin"
        :order-id="order.id"
        :revision="order.version"
        :disabled="editingSection !== ''"
        @operation="olistOperation = $event"
      />

      <div
        v-if="mobileAction"
        class="op-mobile-action"
        :data-step="mobileAction === 'step' || undefined"
      >
        <!-- PFI-16: never "Gerar pedido" while a step is missing. -->
        <template v-if="mobileAction === 'step' && nextStep">
          <p id="order-next-step-caption" class="op-mobile-caption">
            Passo {{ nextStepNumber }} de {{ steps.length }} para gerar
          </p>
          <button
            ref="footerStep"
            type="button"
            class="primary"
            aria-describedby="order-next-step-caption"
            @click="goToSection(nextStep.section)"
          >
            {{ nextStep.action }}
          </button>
        </template>
        <!-- PFI-19: the same dialog as the rail's; the focus comes back here. -->
        <button
          v-else-if="mobileAction === 'generate'"
          type="button"
          class="primary op-generate"
          @click="closingSection?.generateFromFooter($event.currentTarget)"
        >
          <OrderIcon name="ficha" />Gerar pedido
        </button>
        <button
          v-else
          type="button"
          class="primary"
          :disabled="pdfBusy"
          @click="generatePdf()"
        >
          <OrderIcon name="download" />{{
            pdfBusy ? 'Gerando PDF…' : 'Gerar PDF'
          }}
        </button>
        <button
          v-if="mobileAction === 'pdf' && shareAvailable"
          type="button"
          :disabled="pdfBusy"
          aria-label="Compartilhar PDF"
          @click="generatePdf(true)"
        >
          Compartilhar
        </button>
      </div>
    </template>
  </div>
</template>
