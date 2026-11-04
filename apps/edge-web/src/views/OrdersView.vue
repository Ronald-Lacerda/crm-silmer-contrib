<script>
// RFC 024 (PLI-10): "Limpar filtro" drops a Painel filter from the address,
// which opens a new list (the app keys each view by its address). The search
// and the focus travel to that list once, so clearing is not starting over.
/** @type {{query: string}|null} */
let clearedFromRoute = null;
</script>

<script setup>
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import FilterSheet from '../components/FilterSheet.vue';
import FilterChip from '../components/FilterChip.vue';
import AppHint from '../components/AppHint.vue';
import { commandKey, request } from '../lib/api-client.js';
import { dateTimeBR, formatPhoneNumber } from '../lib/format.js';
import { openDialog } from '../lib/ui.js';
import { downloadPdf, getOrderPdf, pdfFile } from '../lib/order-pdf.js';
import {
  amountLabel,
  deliveryDue,
  elapsedSince,
  fichaPrintedLabel,
  isStoreOrder,
  missingHeadline,
  orderStatusLabel,
  STORE_ORIGIN_LABEL,
  storeConfirmationLabel,
  storeFichaPending,
  storeProductLabel,
} from '../lib/order-format.js';

const LIVE_REFRESH_DELAY_MS = 250;
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 25;

// ADRs 027 and 028: "Loja do site" narrows the list to the site shop's
// orders, all of them confirmed and paid through InfinitePay.
const STORE_FILTER = 'loja';
// Pesquisa UX 2026-10-15, achado 3: the production queue — confirmed orders
// (rule 10: only those print) not delivered yet and not tests, by the
// promised delivery. The API filters by status; the rest is read here.
const PRODUCTION_FILTER = 'producao';
// Painel ("Meus pedidos pendentes"): the session seller's pending orders.
const MINE_FILTER = 'meus';
/** @param {string} label @param {string} value */
const filterOption = (label, value) => Object.freeze({ label, value });
// RFC 024 (PLI-09): three chips answer the daily questions; the eight filters
// stay, grouped in the "Filtros" sheet. The choice is still a single one, and
// "Pendentes" and "Confirmados" no longer repeat the groups (PLI-03) up front.
const QUICK_FILTERS = Object.freeze([
  filterOption('Todos', ''),
  filterOption('Meus pendentes', MINE_FILTER),
  filterOption('Prontos para produção', PRODUCTION_FILTER),
]);
const FILTER_GROUPS = Object.freeze([
  Object.freeze({
    legend: 'Situação',
    options: Object.freeze([
      filterOption('Todos', ''),
      filterOption('Pendentes', 'pendente'),
      filterOption('Confirmados', 'confirmado'),
    ]),
  }),
  Object.freeze({
    legend: 'Responsável',
    options: Object.freeze([filterOption('Meus pendentes', MINE_FILTER)]),
  }),
  Object.freeze({
    legend: 'Origem',
    options: Object.freeze([filterOption(STORE_ORIGIN_LABEL, STORE_FILTER)]),
  }),
  Object.freeze({
    legend: 'Entrega',
    options: Object.freeze([
      filterOption('Entrega atrasada', 'atrasada'),
      filterOption('Próximas entregas', 'proxima'),
    ]),
  }),
  Object.freeze({
    legend: 'Produção',
    options: Object.freeze([
      filterOption('Prontos para produção', PRODUCTION_FILTER),
    ]),
  }),
]);
const FILTER_LABELS = new Map(
  FILTER_GROUPS.flatMap((group) =>
    group.options.map((option) => [option.value, option.label]),
  ),
);
const QUICK_VALUES = new Set(QUICK_FILTERS.map((option) => option.value));
// The Painel's links name their filter in the address (filterFromRoute).
const FILTER_QUERY_KEYS = Object.freeze([
  'entrega',
  'origem',
  'status',
  'vendedor',
]);
// Painel: confirmed orders whose promised day passed, or comes in the next
// seven days, read in promised order. The API answers one short list.
const DELIVERY_FILTERS = Object.freeze({
  atrasada: 'overdue',
  proxima: 'due_soon',
});

const liveEvent = inject('liveEvent', ref(null));
const router = useRouter();
const route = useRoute();
const heading = ref(null);
const newOrderDialog = ref(null);
const contactQuery = ref('');
const contactSearchInput = ref(null);
const contactOptions = ref([]);
const newPhoneMatches = ref([]);
const newPhoneSearching = ref(false);
const selectedContact = ref(null);
const newContactName = ref('');
const newContactPhone = ref('');
const newContactEmail = ref('');
const createErrorAlert = ref(null);
const unverifiedPhoneNotice = ref(null);
const contactSearching = ref(false);
const contactCreating = ref(false);
const orderCreating = ref(false);
const createError = ref('');
let contactController;
let contactSearchTimer = 0;
let newPhoneController;
let newPhoneSearchTimer = 0;
const checkedNewPhone = ref('');
let contactCreateKey = '';
let detailsUpdateKey = '';
let orderCreateKey = '';
// LOJ-31: the Dashboard notice opens `/pedidos?origem=loja`, the list already
// on "Loja do site"; the Dashboard indicators open `?status=` and `?entrega=`.
/** @returns {string} */
function filterFromRoute() {
  if (route.query.origem === STORE_FILTER) return STORE_FILTER;
  if (route.query.vendedor === 'eu') return MINE_FILTER;
  const delivery = String(route.query.entrega ?? '');
  if (Object.hasOwn(DELIVERY_FILTERS, delivery)) return delivery;
  const status = String(route.query.status ?? '');
  return ['confirmado', 'pendente'].includes(status) ? status : '';
}
const filter = ref(filterFromRoute());
const carried = clearedFromRoute;
clearedFromRoute = null;
const query = ref(carried?.query ?? '');
const filterSheet = ref(null);
const filtersButton = ref(null);
const orderSearch = ref(null);
// The sheet edits a draft; "Ver resultados" applies it, Esc discards it.
const draftFilter = ref('');
const searchNotice = ref('');
const items = ref([]);
const counts = ref({ confirmado: 0, pendente: 0 });
const nextCursor = ref(null);
const loading = ref(true);
const loadingMore = ref(false);
const refreshing = ref(false);
const hasLoaded = ref(false);
const error = ref('');
const pdfError = ref('');
const pdfBusyId = ref('');
const errorMode = ref('');
// The clock is refreshed on every load, so the inactivity signal does not freeze at the
// value the first render happened to compute.
const now = ref(new Date());
let controller;
let refreshTimer = 0;
let searchTimer = 0;
let clockTimer = 0;

const isProductionQueue = computed(() => filter.value === PRODUCTION_FILTER);
// Pesquisa UX 2026-10-15, achado 3: exceptions first, then the nearest
// promised delivery; the server's order breaks the ties.
const confirmedOrders = computed(() =>
  queueOrder(
    items.value.filter(
      (order) =>
        order.status === 'confirmado' &&
        (!isProductionQueue.value || (!order.isTest && !order.deliveredOn)),
    ),
  ),
);
const pendingOrders = computed(() =>
  queueOrder(items.value.filter((order) => order.status === 'pendente')),
);
const deliveryFilter = computed(
  () =>
    DELIVERY_FILTERS[
      /** @type {keyof typeof DELIVERY_FILTERS} */ (filter.value)
    ] ?? '',
);
const showConfirmed = computed(
  () =>
    ['', 'confirmado', PRODUCTION_FILTER, STORE_FILTER].includes(
      filter.value,
    ) || Boolean(deliveryFilter.value),
);
const confirmedTitle = computed(() =>
  isProductionQueue.value ? 'Prontos para produção' : 'Confirmados',
);
const confirmedCount = computed(() =>
  isProductionQueue.value
    ? `${confirmedOrders.value.length}${nextCursor.value ? '+' : ''}`
    : String(counts.value.confirmado),
);
const showPending = computed(() =>
  ['', 'pendente', MINE_FILTER].includes(filter.value),
);
// PLI-10: a filter only the sheet offers is named, with a way out.
const sheetFilterLabel = computed(() =>
  QUICK_VALUES.has(filter.value) ? '' : (FILTER_LABELS.get(filter.value) ?? ''),
);
// PLI-10: the result replaces the old "N confirmados · N pendentes" line; the
// group headings keep both counts (PLI-03). The API counts the search, the
// origin and the owner; the production queue is read here.
const resultLabel = computed(() => {
  const total = isProductionQueue.value
    ? confirmedCount.value
    : String(
        (showConfirmed.value ? counts.value.confirmado : 0) +
          (showPending.value ? counts.value.pendente : 0),
      );
  return `${total} ${total === '1' ? 'pedido' : 'pedidos'}`;
});
const isEmpty = computed(
  () =>
    !loading.value &&
    (showConfirmed.value ? confirmedOrders.value.length : 0) +
      (showPending.value ? pendingOrders.value.length : 0) ===
      0,
);
const canCreateOrder = computed(() =>
  Boolean(
    selectedContact.value
      ? selectedContact.value.phoneSource !== 'site_unverified' &&
          (selectedContact.value.phone ||
            newContactPhone.value.replace(/\D/gu, '').length >= 10)
      : newContactName.value.trim() &&
          newContactPhone.value.replace(/\D/gu, '').length >= 10,
  ),
);
const phoneSearchAmbiguous = computed(
  () =>
    contactQuery.value.replace(/\D/gu, '').length >= 10 &&
    contactOptions.value.length > 1,
);

/** @param {Record<string, any>} order */
function customerName(order) {
  return order.ficha?.summary?.cliente || 'Cliente não informado';
}

/** PLI-04: the event and the seller travel with the customer. */
/** @param {Record<string, any>} order */
function customerContext(order) {
  if (isStoreOrder(order)) {
    const product = storeProductLabel(order);
    return product ? `${STORE_ORIGIN_LABEL} · ${product}` : STORE_ORIGIN_LABEL;
  }
  const event = order.ficha?.summary?.nome || 'Sem evento';
  return `${event} · ${order.seller?.name || 'sem vendedor'}`;
}

/** PLI-05: what is missing and for how long, or who confirmed and when. */
/** @param {Record<string, any>} order */
function situation(order) {
  // LOJ-33: a site order reads like any confirmed order, confirmed by the site.
  if (isStoreOrder(order)) return storeConfirmationLabel(order);
  if (order.status === 'confirmado') {
    const who = order.confirmedBy?.name || 'vendedor';
    return `Confirmado por ${who} · ${dateTimeBR(order.confirmedAt)}`;
  }
  const still = elapsedSince(order.updatedAt, now.value);
  const headline = missingHeadline(order.missingFields);
  return still === ''
    ? headline
    : `${headline} · Pedido sem movimentação há ${still}`;
}

/** A confirmed send without a later reply is evidence of waiting. */
function clientWaiting(order) {
  if (order.status !== 'pendente') return '';
  const message = order.lastMessage;
  if (message?.direction !== 'outbound') return '';
  if (!['sent', 'delivered', 'read'].includes(message.deliveryStatus))
    return '';
  if (typeof message.sentAt !== 'string') return '';
  const lastAt = new Date(message.sentAt).getTime();
  if (!Number.isFinite(lastAt) || now.value.getTime() - lastAt < 48 * 3_600_000)
    return '';
  return `Cliente sem resposta há ${elapsedSince(message.sentAt, now.value)}`;
}

function priority(order) {
  if (order.status !== 'pendente') return '';
  if (clientWaiting(order)) return 'Retomar contato';
  const age = now.value.getTime() - new Date(order.updatedAt).getTime();
  return Number.isFinite(age) && age >= 72 * 3_600_000 ? 'Revisar pedido' : '';
}

/** @param {Record<string, any>} order */
function due(order) {
  return deliveryDue(order, now.value);
}

/**
 * What puts an order at the top of its group: a late promised delivery, a
 * pending order to resume or review, a site order nobody printed yet.
 *
 * @param {Record<string, any>} order
 */
function isException(order) {
  return (
    due(order).overdue ||
    Boolean(priority(order)) ||
    (order.status === 'confirmado' && storeFichaPending(order))
  );
}

/** @param {Record<string, any>[]} orders */
function queueOrder(orders) {
  const delivered = (/** @type {Record<string, any>} */ order) =>
    Boolean(order.deliveredOn);
  return orders
    .map((order, index) => ({ days: due(order).days, index, order }))
    .sort((a, b) => {
      const exception =
        Number(isException(b.order)) - Number(isException(a.order));
      if (exception !== 0) return exception;
      const done = Number(delivered(a.order)) - Number(delivered(b.order));
      if (done !== 0) return done;
      if (a.days !== b.days) {
        if (a.days === null) return 1;
        if (b.days === null) return -1;
        return a.days - b.days;
      }
      return a.index - b.index;
    })
    .map(({ order }) => order);
}

function openOrder(order, event) {
  if (event.target?.closest?.('a, button, input, select, textarea')) return;
  void router.push(`/pedidos/${order.id}`);
}

/** @param {Event} event */
function openNewOrder(event) {
  const dialog = newOrderDialog.value;
  if (!(dialog instanceof HTMLDialogElement)) return;
  contactController?.abort();
  newPhoneController?.abort();
  if (contactSearchTimer) globalThis.clearTimeout(contactSearchTimer);
  if (newPhoneSearchTimer) globalThis.clearTimeout(newPhoneSearchTimer);
  contactQuery.value = '';
  contactOptions.value = [];
  newPhoneMatches.value = [];
  newPhoneSearching.value = false;
  checkedNewPhone.value = '';
  selectedContact.value = null;
  newContactName.value = '';
  newContactPhone.value = '';
  newContactEmail.value = '';
  createError.value = '';
  contactCreateKey = '';
  detailsUpdateKey = '';
  orderCreateKey = '';
  openDialog(dialog, /** @type {HTMLElement} */ (event.currentTarget));
}

async function searchContacts() {
  contactController?.abort();
  const needle = contactQuery.value.trim();
  if (needle.length < 2 || selectedContact.value) {
    contactOptions.value = [];
    contactSearching.value = false;
    return;
  }
  const currentController = new AbortController();
  contactController = currentController;
  contactSearching.value = true;
  try {
    const response = await request('/api/v1/contacts/search', {
      body: { limit: 10, q: needle },
      method: 'POST',
      signal: currentController.signal,
    });
    contactOptions.value = response.data.items;
    createError.value = '';
  } catch (cause) {
    if (cause?.name !== 'AbortError') {
      createError.value = 'Não foi possível buscar clientes.';
    }
  } finally {
    if (contactController === currentController) contactSearching.value = false;
  }
}

/** @param {Record<string, any>} contact */
function selectContact(contact) {
  contactController?.abort();
  newPhoneController?.abort();
  if (contactSearchTimer) globalThis.clearTimeout(contactSearchTimer);
  if (newPhoneSearchTimer) globalThis.clearTimeout(newPhoneSearchTimer);
  selectedContact.value = contact;
  contactQuery.value = contact.label;
  contactOptions.value = [];
  newPhoneMatches.value = [];
  newPhoneSearching.value = false;
  createError.value = '';
  orderCreateKey = '';
  detailsUpdateKey = '';
  if (contact.phoneSource === 'site_unverified') {
    void nextTick(() => unverifiedPhoneNotice.value?.focus());
  }
}

async function changeSelectedContact() {
  selectedContact.value = null;
  contactQuery.value = '';
  newPhoneMatches.value = [];
  checkedNewPhone.value = '';
  newContactPhone.value = '';
  newContactEmail.value = '';
  detailsUpdateKey = '';
  await nextTick();
  contactSearchInput.value?.focus();
}

async function completeLegacyContact(contact) {
  detailsUpdateKey ||= commandKey();
  try {
    const response = await request(
      `/api/v1/contacts/${encodeURIComponent(contact.id)}/details`,
      {
        body: {
          expectedVersion: contact.version,
          phone: newContactPhone.value.trim(),
          ...(newContactEmail.value.trim()
            ? { email: newContactEmail.value.trim() }
            : {}),
        },
        idempotencyKey: detailsUpdateKey,
        method: 'POST',
      },
    );
    selectedContact.value = {
      ...contact,
      ...response.data.contact,
      label: response.data.contact.label || contact.label,
    };
    detailsUpdateKey = '';
    return selectedContact.value;
  } catch (cause) {
    createError.value =
      Number(cause?.status) === 409
        ? 'O cliente foi alterado ou esse telefone já está em outro cadastro. Busque pelo telefone e revise antes de continuar.'
        : Number(cause?.status) === 400
          ? 'Informe um telefone brasileiro válido com DDD.'
          : 'Não foi possível salvar o telefone. Tente novamente.';
    await nextTick();
    createErrorAlert.value?.focus();
    return null;
  }
}

async function createContact() {
  const displayName = newContactName.value.trim();
  const phone = newContactPhone.value.trim();
  const email = newContactEmail.value.trim();
  if (!displayName || !phone || contactCreating.value) return null;
  contactCreating.value = true;
  createError.value = '';
  contactCreateKey ||= commandKey();
  try {
    if (checkedNewPhone.value !== phone.replace(/\D/gu, '')) {
      const checked = await searchNewPhone();
      if (!checked) return null;
    }
    if (newPhoneMatches.value.length) {
      createError.value =
        'Esse telefone aparece em outros cadastros. Escolha um cliente da lista antes de criar o pedido.';
      await nextTick();
      createErrorAlert.value?.focus();
      return null;
    }
    const response = await request('/api/v1/contacts', {
      body: { displayName, phone, ...(email ? { email } : {}) },
      idempotencyKey: contactCreateKey,
      method: 'POST',
    });
    selectContact(response.data.contact);
    newContactName.value = '';
    newContactPhone.value = '';
    newContactEmail.value = '';
    contactCreateKey = '';
    return response.data.contact;
  } catch (cause) {
    createError.value =
      Number(cause?.status) === 400
        ? 'Confira o telefone e o e-mail informados.'
        : Number(cause?.status) === 409
          ? 'Já existe um cliente com esse telefone ou o cadastro mudou. Busque pelo telefone e selecione o cadastro existente.'
          : 'Não foi possível cadastrar o cliente. Tente novamente.';
    await nextTick();
    createErrorAlert.value?.focus();
    return null;
  } finally {
    contactCreating.value = false;
  }
}

async function searchNewPhone() {
  newPhoneController?.abort();
  const phone = newContactPhone.value.trim();
  const digits = phone.replace(/\D/gu, '');
  if (digits.length < 10 || selectedContact.value) {
    newPhoneMatches.value = [];
    checkedNewPhone.value = '';
    newPhoneSearching.value = false;
    return false;
  }
  const currentController = new AbortController();
  newPhoneController = currentController;
  newPhoneSearching.value = true;
  try {
    const response = await request('/api/v1/contacts/search', {
      body: { limit: 10, q: phone },
      method: 'POST',
      signal: currentController.signal,
    });
    if (newContactPhone.value.trim() !== phone) return false;
    newPhoneMatches.value = response.data.items;
    checkedNewPhone.value = digits;
    return true;
  } catch (cause) {
    if (
      newPhoneController === currentController &&
      cause?.name !== 'AbortError'
    ) {
      createError.value =
        'Não foi possível conferir esse telefone. Tente novamente.';
    }
    if (newPhoneController === currentController) checkedNewPhone.value = '';
    return false;
  } finally {
    if (newPhoneController === currentController)
      newPhoneSearching.value = false;
  }
}

async function createOrder() {
  if (!canCreateOrder.value || orderCreating.value) return;
  orderCreating.value = true;
  createError.value = '';
  try {
    let contact = selectedContact.value ?? (await createContact());
    if (!contact) return;
    if (!contact.phone) {
      contact = await completeLegacyContact(contact);
      if (!contact) return;
    }
    orderCreateKey ||= commandKey();
    const response = await request('/api/v1/orders', {
      body: { contactId: contact.id },
      idempotencyKey: orderCreateKey,
      method: 'POST',
    });
    newOrderDialog.value?.close();
    orderCreateKey = '';
    await router.push(`/pedidos/${response.data.order.id}`);
  } catch (cause) {
    createError.value =
      cause?.code === 'CONTACT_PHONE_REQUIRED'
        ? 'O telefone deste contato foi apenas informado no chat. Abra a conversa na Caixa de Entrada para criar o pedido deste atendimento.'
        : Number(cause?.status) === 403
          ? 'Você não tem permissão para criar pedidos.'
          : 'Não foi possível criar o pedido. Tente novamente.';
    await nextTick();
    createErrorAlert.value?.focus();
  } finally {
    orderCreating.value = false;
  }
}

watch(contactQuery, () => {
  if (selectedContact.value?.label !== contactQuery.value) {
    selectedContact.value = null;
    orderCreateKey = '';
  }
  if (contactSearchTimer) globalThis.clearTimeout(contactSearchTimer);
  contactSearchTimer = globalThis.setTimeout(() => {
    contactSearchTimer = 0;
    void searchContacts();
  }, 250);
});
watch(newContactName, () => {
  contactCreateKey = '';
});
watch([newContactPhone, newContactEmail], () => {
  contactCreateKey = '';
  detailsUpdateKey = '';
});
watch(newContactPhone, () => {
  newPhoneController?.abort();
  if (newPhoneSearchTimer) globalThis.clearTimeout(newPhoneSearchTimer);
  checkedNewPhone.value = '';
  newPhoneMatches.value = [];
  if (newContactPhone.value.replace(/\D/gu, '').length < 10) return;
  newPhoneSearchTimer = globalThis.setTimeout(() => {
    newPhoneSearchTimer = 0;
    void searchNewPhone();
  }, SEARCH_DELAY_MS);
});

/** @param {string|null} cursor */
function listRequest(cursor) {
  if (deliveryFilter.value) {
    return {
      url: `/api/v1/orders?delivery=${deliveryFilter.value}`,
      options: {},
    };
  }
  const params = new globalThis.URLSearchParams({ limit: String(PAGE_SIZE) });
  const status =
    filter.value === PRODUCTION_FILTER ? 'confirmado' : filter.value;
  if (filter.value === STORE_FILTER) params.set('origin', STORE_FILTER);
  else if (filter.value === MINE_FILTER) {
    params.set('status', 'pendente');
    params.set('owner', 'me');
  } else if (status) params.set('status', status);
  const needle = query.value.trim();
  if ((needle.match(/\d/gu) ?? []).length >= 8) {
    return {
      url: '/api/v1/orders/search',
      options: {
        method: 'POST',
        body: {
          limit: PAGE_SIZE,
          q: needle,
          ...(filter.value === STORE_FILTER
            ? { origin: STORE_FILTER }
            : filter.value === MINE_FILTER
              ? { owner: 'me', status: 'pendente' }
              : status
                ? { status }
                : {}),
          ...(cursor ? { cursor } : {}),
        },
      },
    };
  }
  if (needle) params.set('q', needle);
  if (cursor) params.set('cursor', cursor);
  return { url: `/api/v1/orders?${params}`, options: {} };
}

/** @param {boolean} [silent] */
async function load(silent = false) {
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  if (!silent) {
    loading.value = true;
    error.value = '';
  } else refreshing.value = true;
  try {
    const listing = listRequest(null);
    const response = await request(listing.url, {
      ...listing.options,
      signal: currentController.signal,
    });
    items.value = response.data.items;
    counts.value = response.data.counts;
    nextCursor.value = response.data.nextCursor;
    hasLoaded.value = true;
    now.value = new Date();
    error.value = '';
    errorMode.value = '';
  } catch (cause) {
    if (cause?.name !== 'AbortError') {
      error.value = hasLoaded.value
        ? 'Não foi possível atualizar os pedidos. Os dados exibidos podem estar desatualizados.'
        : 'Não foi possível carregar os pedidos.';
      errorMode.value = 'list';
    }
  } finally {
    if (controller === currentController) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

/** PLI-07: "Ver mais" appends the next page instead of replacing the list. */
async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const listing = listRequest(nextCursor.value);
    const response = await request(listing.url, listing.options);
    items.value = [...items.value, ...response.data.items];
    counts.value = response.data.counts;
    nextCursor.value = response.data.nextCursor;
    now.value = new Date();
    error.value = '';
    errorMode.value = '';
  } catch {
    error.value = 'Não foi possível carregar mais pedidos.';
    errorMode.value = 'more';
  } finally {
    loadingMore.value = false;
  }
}

function retryLoadedError() {
  if (errorMode.value === 'more') void loadMore();
  else void load(true);
}

async function retryInitialLoad() {
  await load();
  await nextTick();
  heading.value?.focus();
}

/** PIM-13: the same approved ficha, delivered as a PDF file. */
/** @param {Record<string, any>} order */
async function generatePdf(order) {
  if (pdfBusyId.value) return;
  pdfBusyId.value = order.id;
  pdfError.value = '';
  try {
    downloadPdf(pdfFile(await getOrderPdf(order.id), order.number));
    if (storeFichaPending(order)) void load(true);
  } catch (cause) {
    pdfError.value =
      Number(cause?.status) === 409
        ? 'Este pedido foi reaberto. Atualize a lista antes de gerar o PDF.'
        : 'Não foi possível gerar o PDF. Tente novamente.';
  } finally {
    pdfBusyId.value = '';
  }
}

/** @param {string} value */
function selectFilter(value) {
  if (filter.value === value) return;
  searchNotice.value = '';
  filter.value = value;
  void load();
}

/** PLI-09: the sheet opens on the filter in use. @param {Event} event */
function openFilters(event) {
  draftFilter.value = filter.value;
  /** @type {any} */ (filterSheet.value)?.open(
    /** @type {HTMLElement} */ (event.currentTarget),
  );
}

function applySheetFilter() {
  selectFilter(draftFilter.value);
}

async function clearSearch() {
  query.value = '';
  await nextTick();
  orderSearch.value?.focus();
}

/**
 * PLI-10: back to every order. A filter that came in the address leaves it
 * too; the focus lands on "Filtros", where another filter is chosen.
 */
async function clearFilter() {
  const rest = { ...route.query };
  const fromRoute = FILTER_QUERY_KEYS.filter((key) => key in rest);
  if (fromRoute.length) {
    for (const key of fromRoute) delete rest[key];
    clearedFromRoute = { query: query.value };
    const failure = await router.replace({ path: route.path, query: rest });
    if (failure) clearedFromRoute = null;
    return;
  }
  selectFilter('');
  await nextTick();
  /** @type {HTMLElement|null} */ (filtersButton.value)?.focus();
}

/** Collapses bursts of live events into one silent refresh. */
function scheduleLiveRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(() => {
    refreshTimer = 0;
    void load(true);
  }, LIVE_REFRESH_DELAY_MS);
}

watch(query, () => {
  // A delivery view is a short list in promised order; a search reads every
  // order again.
  if (deliveryFilter.value && query.value.trim()) {
    filter.value = '';
    searchNotice.value =
      'A busca está em todos os pedidos. A visualização por entrega foi removida.';
  }
  if (!query.value.trim()) searchNotice.value = '';
  if (searchTimer) globalThis.clearTimeout(searchTimer);
  searchTimer = globalThis.setTimeout(() => {
    searchTimer = 0;
    void load();
  }, SEARCH_DELAY_MS);
});

// PLI-08: order, conversation and contact changes may change the list's labels
// or the last message used to prioritize contact.
watch(liveEvent, (event) => {
  if (
    event?.reset ||
    [
      'inbox.order.changed',
      'inbox.conversation.changed',
      'inbox.contact.changed',
    ].includes(event?.type)
  ) {
    scheduleLiveRefresh();
  }
});

onMounted(() => {
  if (carried) /** @type {HTMLElement|null} */ (filtersButton.value)?.focus();
  else heading.value?.focus();
  void load();
  clockTimer = globalThis.setInterval(() => {
    now.value = new Date();
  }, 60_000);
});
onBeforeUnmount(() => {
  controller?.abort();
  contactController?.abort();
  newPhoneController?.abort();
  if (contactSearchTimer) globalThis.clearTimeout(contactSearchTimer);
  if (newPhoneSearchTimer) globalThis.clearTimeout(newPhoneSearchTimer);
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  if (searchTimer) globalThis.clearTimeout(searchTimer);
  if (clockTimer) globalThis.clearInterval(clockTimer);
});
</script>

<template>
  <div class="page">
    <!-- RFC 024: one line, so the first order shows on a phone. -->
    <header class="page-heading orders-heading">
      <h1 ref="heading" tabindex="-1">Pedidos</h1>
      <button type="button" class="primary" @click="openNewOrder">
        Novo pedido
      </button>
    </header>

    <dialog
      ref="newOrderDialog"
      class="op-dialog manual-order-dialog"
      aria-labelledby="new-order-title"
    >
      <h2 id="new-order-title">Novo pedido</h2>
      <p>
        Encontre o cliente pelo telefone ou nome, ou informe os dados abaixo
        para criar o pedido.
      </p>
      <div class="manual-order-field">
        <label for="new-order-contact"
          >Buscar cliente por telefone ou nome</label
        >
        <input
          id="new-order-contact"
          ref="contactSearchInput"
          v-model="contactQuery"
          type="search"
          autocomplete="off"
          aria-describedby="new-order-search-help"
        />
        <p id="new-order-search-help" class="op-hint">
          Informe o telefone completo ou ao menos duas letras do nome. Confira o
          telefone antes de selecionar um cliente com nome repetido.
        </p>
      </div>
      <p v-if="contactSearching" role="status">Buscando clientes…</p>
      <p v-if="phoneSearchAmbiguous" role="alert" class="op-alert">
        Há mais de um cadastro para esse telefone. Confira a ficha e o histórico
        de cada cliente antes de escolher.
      </p>
      <ul
        v-if="contactOptions.length"
        class="manual-contact-options"
        aria-label="Resultados da busca de clientes"
      >
        <li v-for="contact in contactOptions" :key="contact.id">
          <button type="button" @click="selectContact(contact)">
            Selecionar {{ contact.label }}
            <small v-if="contact.phone">
              {{ formatPhoneNumber(contact.phone) }} ·
              {{
                contact.phoneSource === 'site_unverified'
                  ? 'informado no site · não confirmado'
                  : 'telefone'
              }}
            </small>
            <small v-if="!contact.identities?.length"
              >Cadastro sem canal vinculado</small
            >
            <small
              v-if="
                contact.identities?.length &&
                contact.identities[0].channel !== 'site_chat'
              "
            >
              {{ contact.identities[0].channel }} · final
              {{ contact.identities[0].externalId?.slice(-4) }}
            </small>
          </button>
          <RouterLink
            :to="`/clientes/${contact.id}`"
            target="_blank"
            rel="noopener noreferrer"
          >
            Conferir ficha de {{ contact.label }} em outra aba
          </RouterLink>
        </li>
      </ul>
      <p
        v-else-if="
          contactQuery.trim().length >= 2 &&
          !contactSearching &&
          !selectedContact
        "
        role="status"
      >
        Nenhum cliente encontrado nesta busca.
      </p>
      <p v-if="selectedContact" role="status">
        Cliente selecionado: <strong>{{ selectedContact.label }}</strong>
        <button
          type="button"
          class="link-button"
          @click="changeSelectedContact"
        >
          Trocar cliente
        </button>
      </p>
      <p
        v-if="selectedContact?.phoneSource === 'site_unverified'"
        ref="unverifiedPhoneNotice"
        class="op-alert"
        role="status"
        tabindex="-1"
      >
        Este telefone foi informado no chat e ainda não foi confirmado. Abra a
        conversa pela
        <RouterLink :to="`/clientes/${selectedContact.id}`">
          ficha do contato</RouterLink
        >
        para criar o pedido deste atendimento.
      </p>
      <fieldset
        v-if="selectedContact && !selectedContact.phone"
        class="manual-contact-create"
      >
        <legend>Completar telefone deste cliente</legend>
        <p class="op-hint">
          Para criar um pedido novo, informe o telefone deste cadastro legado.
        </p>
        <label for="legacy-contact-phone">Telefone</label>
        <input
          id="legacy-contact-phone"
          v-model="newContactPhone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          required
        />
        <label for="legacy-contact-email"
          >E-mail <span class="op-hint">(opcional)</span></label
        >
        <input
          id="legacy-contact-email"
          v-model="newContactEmail"
          type="email"
          autocomplete="email"
          maxlength="254"
        />
      </fieldset>
      <fieldset v-if="!selectedContact" class="manual-contact-create">
        <legend>Cliente novo</legend>
        <p class="op-hint">
          O telefone é obrigatório. O nome identifica a pessoa no CRM; e-mail é
          opcional.
        </p>
        <label for="new-contact-name">Nome</label>
        <input
          id="new-contact-name"
          v-model="newContactName"
          type="text"
          maxlength="120"
          autocomplete="name"
          required
        />
        <label for="new-contact-phone">Telefone</label>
        <input
          id="new-contact-phone"
          v-model="newContactPhone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="(11) 99999-9999"
          required
        />
        <p v-if="newPhoneSearching" role="status">
          Conferindo cadastros com esse telefone…
        </p>
        <p v-else-if="checkedNewPhone" role="status" aria-live="polite">
          {{
            newPhoneMatches.length
              ? `${newPhoneMatches.length} cadastro${newPhoneMatches.length === 1 ? '' : 's'} encontrado${newPhoneMatches.length === 1 ? '' : 's'} para esse telefone. Escolha um cliente da lista antes de criar o pedido.`
              : 'Nenhum cadastro encontrado com esse telefone.'
          }}
        </p>
        <div
          v-if="newPhoneMatches.length"
          class="op-alert"
          role="group"
          aria-label="Cadastros com o telefone informado"
        >
          <p>
            Esse telefone já aparece no CRM. Confira e escolha o cadastro antes
            de criar o pedido.
          </p>
          <ul class="manual-contact-options">
            <li v-for="contact in newPhoneMatches" :key="contact.id">
              <button type="button" @click="selectContact(contact)">
                Selecionar {{ contact.label }} ·
                {{ formatPhoneNumber(contact.phone) }}
                <span v-if="contact.phoneSource === 'site_unverified'">
                  · informado no site · não confirmado
                </span>
              </button>
              <RouterLink
                :to="`/clientes/${contact.id}`"
                target="_blank"
                rel="noopener noreferrer"
              >
                Conferir ficha de {{ contact.label }} em outra aba
              </RouterLink>
            </li>
          </ul>
        </div>
        <label for="new-contact-email"
          >E-mail <span class="op-hint">(opcional)</span></label
        >
        <input
          id="new-contact-email"
          v-model="newContactEmail"
          type="email"
          autocomplete="email"
          maxlength="254"
        />
      </fieldset>
      <p
        v-if="createError"
        ref="createErrorAlert"
        tabindex="-1"
        role="alert"
        class="op-alert"
      >
        {{ createError }}
      </p>
      <div class="op-dialog-actions">
        <button
          type="button"
          :disabled="orderCreating || contactCreating"
          @click="newOrderDialog?.close()"
        >
          Cancelar
        </button>
        <button
          type="button"
          class="primary"
          :disabled="!canCreateOrder || orderCreating || contactCreating"
          @click="createOrder"
        >
          Criar pedido
        </button>
      </div>
    </dialog>

    <!-- RFC 024 (PLI-09): search, three chips and "Filtros" — five controls. -->
    <div class="filter-bar orders-filter-bar">
      <div class="search-control orders-search" role="search">
        <label for="order-search" class="sr-only"
          >Buscar número, cliente ou telefone</label
        >
        <div class="search-field">
          <AppIcon class="orders-search-icon" name="search" />
          <input
            id="order-search"
            ref="orderSearch"
            v-model="query"
            type="search"
            placeholder="Número, cliente ou telefone"
          />
        </div>
      </div>
      <div
        class="chip-row orders-chip-row"
        role="group"
        aria-label="Filtrar pedidos"
      >
        <button
          v-for="option in QUICK_FILTERS"
          :key="option.value"
          class="chip"
          type="button"
          :aria-pressed="filter === option.value"
          @click="selectFilter(option.value)"
        >
          {{ option.label }}
        </button>
        <button
          ref="filtersButton"
          type="button"
          class="soft orders-filters-button"
          aria-haspopup="dialog"
          :data-active="sheetFilterLabel ? 'true' : undefined"
          @click="openFilters"
        >
          Filtros
        </button>
      </div>
    </div>
    <div class="orders-result-line">
      <p v-if="sheetFilterLabel" class="orders-active-filter">
        <span class="sr-only">Filtro: </span>
        <FilterChip
          :label="sheetFilterLabel"
          :remove-label="`Limpar filtro ${sheetFilterLabel}`"
          @remove="clearFilter"
        />
      </p>
      <p class="filter-summary" role="status">
        {{ loading ? '' : resultLabel }}
      </p>
    </div>
    <AppHint
      v-if="searchNotice"
      tone="info"
      role="status"
      class="orders-search-notice"
      >{{ searchNotice }}</AppHint
    >
    <AppHint v-else-if="deliveryFilter" tone="info" class="orders-search-notice"
      >Buscar por nome, número ou telefone muda a visualização para todos os
      pedidos.</AppHint
    >

    <FilterSheet
      ref="filterSheet"
      title="Filtros"
      description="Escolha uma visualização por vez. Uma opção substitui a anterior."
      @apply="applySheetFilter"
      @clear="draftFilter = ''"
    >
      <fieldset
        v-for="group in FILTER_GROUPS"
        :key="group.legend"
        class="filter-sheet-group"
      >
        <legend>{{ group.legend }}</legend>
        <label
          v-for="option in group.options"
          :key="option.value"
          class="filter-sheet-option"
        >
          <input
            v-model="draftFilter"
            type="radio"
            name="orders-filter"
            :value="option.value"
          />
          {{ option.label }}
        </label>
      </fieldset>
    </FilterSheet>

    <p v-if="pdfError" role="alert" class="op-alert">{{ pdfError }}</p>
    <div v-if="error && hasLoaded" role="alert" class="audit-note">
      <p>{{ error }}</p>
      <button
        type="button"
        :disabled="refreshing || loadingMore"
        @click="retryLoadedError"
      >
        Tentar novamente
      </button>
    </div>
    <div v-if="loading" class="loading-state" role="status">
      Carregando pedidos…
    </div>
    <section
      v-else-if="error && !hasLoaded"
      class="surface empty-list"
      role="alert"
    >
      <h2>Pedidos indisponíveis</h2>
      <p>{{ error }}</p>
      <button type="button" @click="retryInitialLoad">Tentar novamente</button>
    </section>
    <section
      v-else-if="isEmpty && isProductionQueue && !query.trim()"
      class="surface empty-list"
      aria-live="polite"
    >
      <h2>Nenhum pedido na fila de produção</h2>
      <p>
        Pedidos confirmados aparecem aqui, pela entrega mais próxima, até serem
        marcados como entregues.
      </p>
      <button type="button" class="soft" @click="clearFilter">
        Limpar filtro
      </button>
    </section>
    <section v-else-if="isEmpty" class="surface empty-list" aria-live="polite">
      <template v-if="query.trim()">
        <h2>Nenhum pedido encontrado</h2>
        <p>A busca não encontrou pedidos nesta visualização.</p>
        <button type="button" class="soft" @click="clearSearch">
          Limpar busca
        </button>
      </template>
      <template v-else-if="filter">
        <h2>Nenhum pedido com esse filtro</h2>
        <p>Escolha outra visualização ou volte para todos os pedidos.</p>
        <button type="button" class="soft" @click="clearFilter">
          Limpar filtro
        </button>
      </template>
      <template v-else>
        <h2>Nenhum pedido por aqui</h2>
        <p>Crie um pedido quando o cliente confirmar que quer fechar.</p>
      </template>
    </section>
    <template v-else>
      <!-- Pesquisa UX 2026-10-15, achado 3: what still needs a person comes
           first; inside each group, exceptions and the nearest delivery. -->
      <section
        v-if="showPending && pendingOrders.length"
        class="surface section-gap"
        aria-labelledby="orders-pending-title"
      >
        <div class="panel-head">
          <h2 id="orders-pending-title">
            Pendentes
            <span class="badge" data-tone="warning">{{ counts.pendente }}</span>
          </h2>
          <p>o vendedor responsável ou administrador pode continuar</p>
        </div>
        <div
          class="table-wrap list-scroll order-list"
          role="region"
          tabindex="0"
          aria-label="Pedidos pendentes"
        >
          <table class="data-table order-table">
            <thead>
              <tr>
                <th scope="col">Pedido</th>
                <th scope="col">Cliente</th>
                <th scope="col">Entrega</th>
                <th scope="col" class="num">Peças</th>
                <th scope="col" class="num">Valor</th>
                <th scope="col">Situação</th>
                <th scope="col"><span class="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="order in pendingOrders"
                :key="order.id"
                class="clickable-row"
                :data-exception="isException(order) || undefined"
                @click="openOrder(order, $event)"
              >
                <td class="order-cell-number">
                  #{{ order.number }}
                  <span class="badge order-card-status" data-tone="warning">{{
                    orderStatusLabel(order.status)
                  }}</span>
                </td>
                <td class="order-cell-customer">
                  <strong>{{ customerName(order) }}</strong>
                  <small class="order-context">{{
                    customerContext(order)
                  }}</small>
                </td>
                <td class="order-cell-due" data-label="Entrega">
                  <span class="order-due-date num">{{ due(order).date }}</span>
                  <span
                    v-if="due(order).relative"
                    class="order-due"
                    :data-tone="due(order).tone || undefined"
                    >{{ due(order).relative }}</span
                  >
                </td>
                <td class="num" data-label="Peças">{{ order.totalPieces }}</td>
                <td class="num" data-label="Valor">
                  {{ amountLabel(order.finalAmountCents) }}
                </td>
                <td class="order-cell-situation">
                  <span
                    v-if="priority(order)"
                    class="badge"
                    :data-tone="clientWaiting(order) ? 'warning' : 'info'"
                    >{{ priority(order) }}</span
                  >
                  <small v-if="clientWaiting(order)" class="order-context">{{
                    clientWaiting(order)
                  }}</small>
                  <small class="order-context">{{ situation(order) }}</small>
                </td>
                <td class="order-cell-actions">
                  <div class="row-actions">
                    <RouterLink class="button-link" :to="`/pedidos/${order.id}`"
                      >Abrir pedido<span class="sr-only">
                        {{ order.number }}</span
                      ></RouterLink
                    >
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        v-if="showConfirmed && confirmedOrders.length"
        class="surface section-gap"
        aria-labelledby="orders-confirmed-title"
      >
        <div class="panel-head">
          <h2 id="orders-confirmed-title">
            {{ confirmedTitle }}
            <span class="badge" data-tone="success">{{ confirmedCount }}</span>
          </h2>
          <p v-if="isProductionQueue">
            confirmados e ainda não entregues, pela entrega mais próxima
          </p>
          <p v-else>valor e forma de pagamento registrados</p>
        </div>
        <div
          class="table-wrap list-scroll order-list"
          role="region"
          tabindex="0"
          :aria-label="
            isProductionQueue ? 'Fila de produção' : 'Pedidos confirmados'
          "
        >
          <table class="data-table order-table">
            <thead>
              <tr>
                <th scope="col">Pedido</th>
                <th scope="col">Cliente</th>
                <th scope="col">Entrega</th>
                <th scope="col" class="num">Peças</th>
                <th scope="col" class="num">Valor</th>
                <th scope="col">Situação</th>
                <th scope="col"><span class="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="order in confirmedOrders"
                :key="order.id"
                class="clickable-row"
                :data-exception="isException(order) || undefined"
                @click="openOrder(order, $event)"
              >
                <td class="order-cell-number">
                  #{{ order.number }}
                  <span
                    v-if="isStoreOrder(order) || order.isTest"
                    class="order-badges"
                  >
                    <!-- ADR 028: the shop's number next to the CRM's. -->
                    <span
                      v-if="isStoreOrder(order)"
                      class="badge"
                      data-tone="info"
                      >{{
                        order.storeNumber
                          ? `Loja · ${order.storeNumber}`
                          : 'Loja'
                      }}</span
                    >
                    <span v-if="order.isTest" class="badge" data-tone="warning"
                      >Teste</span
                    >
                    <!-- LOJ-33: a new site order until its first print. -->
                    <span
                      v-if="storeFichaPending(order)"
                      class="badge"
                      data-tone="warning"
                      >Ficha ainda sem PDF</span
                    >
                  </span>
                  <span class="badge order-card-status" data-tone="success">{{
                    orderStatusLabel(order.status)
                  }}</span>
                </td>
                <td class="order-cell-customer">
                  <strong>{{ customerName(order) }}</strong>
                  <small class="order-context">{{
                    customerContext(order)
                  }}</small>
                </td>
                <td class="order-cell-due" data-label="Entrega">
                  <span class="order-due-date num">{{ due(order).date }}</span>
                  <span
                    v-if="due(order).relative"
                    class="order-due"
                    :data-tone="due(order).tone || undefined"
                    >{{ due(order).relative }}</span
                  >
                </td>
                <td class="num" data-label="Peças">{{ order.totalPieces }}</td>
                <td class="num" data-label="Valor">
                  {{ amountLabel(order.finalAmountCents) }}
                </td>
                <td class="order-cell-situation">
                  {{ situation(order) }}
                  <small
                    v-if="fichaPrintedLabel(order)"
                    class="order-context"
                    >{{ fichaPrintedLabel(order) }}</small
                  >
                </td>
                <td class="order-cell-actions">
                  <div class="row-actions">
                    <button
                      type="button"
                      :disabled="Boolean(pdfBusyId)"
                      @click="generatePdf(order)"
                    >
                      {{ pdfBusyId === order.id ? 'Gerando PDF…' : 'Gerar PDF'
                      }}<span class="sr-only"> {{ order.number }}</span>
                    </button>
                    <RouterLink class="button-link" :to="`/pedidos/${order.id}`"
                      >Abrir pedido<span class="sr-only">
                        {{ order.number }}</span
                      ></RouterLink
                    >
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <button
      v-if="nextCursor && !loading && hasLoaded"
      class="load-more"
      type="button"
      :disabled="loadingMore"
      @click="loadMore"
    >
      {{ loadingMore ? 'Carregando…' : 'Ver mais' }}
    </button>
  </div>
</template>

<style scoped>
.clickable-row {
  cursor: pointer;
}
</style>
