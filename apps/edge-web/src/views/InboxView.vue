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
import { brand } from '../brand/index.js';
import AppIcon from '../components/AppIcon.vue';
import AppHint from '../components/AppHint.vue';
import FilterChip from '../components/FilterChip.vue';
import FilterSheet from '../components/FilterSheet.vue';
import AnchoredPopover from '../components/AnchoredPopover.vue';
import AssistantTakeoverContext from '../components/inbox/AssistantTakeoverContext.vue';
import AudioRecorder from '../components/inbox/AudioRecorder.vue';
import ConversationHandoffSummary from '../components/inbox/ConversationHandoffSummary.vue';
import ConversationOrderAssistance from '../components/inbox/ConversationOrderAssistance.vue';
import ConversationOrderSummary from '../components/inbox/ConversationOrderSummary.vue';
import ConversationShippingQuote from '../components/inbox/ConversationShippingQuote.vue';
import MediaMessage from '../components/inbox/MediaMessage.vue';
import MessageDeliveryNotice from '../components/inbox/MessageDeliveryNotice.vue';
import MessageTranscript from '../components/inbox/MessageTranscript.vue';
import { commandKey, request } from '../lib/api-client.js';
import {
  preferredSellerFirstName,
  preferredSellerLabel,
} from '../lib/assistant-context.js';
import {
  CHANNEL_LABELS,
  conversationLabel,
  dateTimeBR,
  formatPhoneNumber,
  messageText,
} from '../lib/format.js';
import { elapsedSince, orderStatusLabel } from '../lib/order-format.js';
import {
  conversationHandoffTitle,
  conversationNextAction,
  conversationWaitingSince,
} from '../lib/inbox-priority.js';
import { openDialog } from '../lib/ui.js';

const ADMIN_CAPABILITY = 'COMMERCIAL_ADMIN';
const LIVE_REFRESH_DELAY_MS = 250;
/**
 * PCX-02 (D19): the Inbox is filtered by who has to act next, not by the
 * internal state of the conversation. A pending handoff is the whole of
 * "Aguardando vendedor", so the other two exclude it — an agent that stopped
 * and is waiting must never be counted as still working the conversation.
 *
 * PCX-14 (RFC 024): these are the "Situação" of the "Filtros" sheet; the
 * archived conversations (PCX-05) are its last option.
 */
const STATE_TABS = Object.freeze([
  Object.freeze({ label: 'Todas', params: {}, value: 'all' }),
  Object.freeze({
    label: 'Atender',
    params: { workQueue: 'attention' },
    value: 'attention',
  }),
  Object.freeze({
    label: 'Fechar pedidos',
    params: { workQueue: 'closing' },
    value: 'closing',
  }),
  Object.freeze({
    label: 'Aguardando vendedor',
    params: { pendingHandoff: 'true' },
    value: 'waiting',
  }),
  Object.freeze({
    label: `Com ${brand.assistant.reference}`,
    params: { automationState: 'assistant', pendingHandoff: 'false' },
    value: 'assistant',
  }),
  Object.freeze({
    label: 'Com vendedor',
    params: { automationState: 'human', pendingHandoff: 'false' },
    value: 'human',
  }),
  Object.freeze({
    archived: true,
    label: 'Arquivadas',
    params: {},
    value: 'archived',
  }),
]);
/** PCX-05: whose conversations are listed — "Responsável" in the sheet. */
const QUEUE_FILTERS = Object.freeze([
  { label: 'Todas', value: 'all' },
  { label: 'Minhas', value: 'mine' },
  { label: 'Sem responsável', value: 'unassignedHumanHandoff' },
]);
/**
 * PCX-14: the three questions of every day, one tap each, with their totals.
 * Each is a fixed pair of the two filters; any other pair is named in the
 * summary under the toolbar.
 */
const SHORTCUTS = Object.freeze([
  Object.freeze({
    label: 'Atender',
    queue: 'all',
    tab: 'attention',
    value: 'attention',
  }),
  Object.freeze({
    label: 'Fechar pedidos',
    queue: 'all',
    tab: 'closing',
    value: 'closing',
  }),
  Object.freeze({ label: 'Todas', queue: 'all', tab: 'all', value: 'all' }),
]);
const LIST_TIME = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});
const LIST_DAY = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
});
const LIST_DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
/** "ao Pedido 01-CRM e ao Assunto sem pedido". */
const LIST_FORMAT = new Intl.ListFormat('pt-BR', { type: 'conjunction' });
/** Pixels from the bottom that still count as reading the latest message. */
const STICKY_THREAD_GAP_PX = 64;

const props = defineProps({
  /** `/inbox/:conversationId`: the conversation the address opens. */
  conversationId: { type: String, default: '' },
});
const router = useRouter();
const liveEvent = inject('liveEvent', ref(null));
const liveConnection = inject('liveConnection', ref('indisponível'));
const sessionUser = inject(
  'sessionUser',
  computed(() => ({})),
);
const notify = inject('notify', () => {});

const heading = ref(null);
const searchInput = ref(null);
const conversationList = ref(null);
const listSummary = ref(null);
const moreConversationsButton = ref(null);
const replyInput = ref(null);
const shippingQuote = ref(null);
const takeoverButton = ref(null);
const nameInput = ref(null);
const archiveConfirmationDialog = ref(null);
const closeConfirmationDialog = ref(null);
const closureOutcome = ref('concluido');
const acknowledgePending = ref(false);
const orderLink = ref(null);
const orderCreating = ref(false);
const orderCreateTrigger = ref(null);
const orderConfirmationDialog = ref(null);
const manualOrderError = ref('');
const manualOrderErrorNotice = ref(null);
const manualOrderConfirmation = ref(null);
/** Bumped when the order changed, so Detalhes › Pedido reads it again. */
const orderRevision = ref(0);
const conversationHeading = ref(null);
const thread = ref(null);
const moreToggle = ref(null);
const moreMenu = ref(null);
const contextToggle = ref(null);
const transferSelect = ref(null);
const moreOpen = ref(false);
const contextOpen = ref(false);
const contextDialog = ref(null);
const assistanceDetailsTarget = ref(null);
const conversationExpanded = ref(false);
const expandToggle = ref(null);
const contactDialog = ref(null);
const contextTab = ref('orders');
const subjectActionsOpen = ref(false);
const contactLoading = ref(false);
const contactError = ref('');
const contactDetail = ref(null);
const closeError = ref('');
let contactController;
const query = ref('');
// Painel: each indicator opens the Inbox already filtered
// (`?fila=minhas|sem-responsavel`, `?situacao=aguardando|agente|vendedor`).
const route = useRoute();
const ROUTE_STATE_TAB = Object.freeze({
  atender: 'attention',
  fechar: 'closing',
  agente: 'assistant',
  aguardando: 'waiting',
  vendedor: 'human',
});
const ROUTE_QUEUE = Object.freeze({
  minhas: 'mine',
  'sem-responsavel': 'unassignedHumanHandoff',
});
const stateTab = ref(
  ROUTE_STATE_TAB[String(route.query.situacao ?? '')] ?? 'all',
);
const queueFilter = ref(ROUTE_QUEUE[String(route.query.fila ?? '')] ?? 'all');
const filtersButton = ref(null);
const filterSheet = ref(null);
const filtersOpen = ref(false);
const draftTab = ref('all');
const draftQueue = ref('all');
/**
 * Totals of the shortcuts, by shortcut value; a failed one is absent.
 *
 * @type {import('vue').Ref<Record<string, number>>}
 */
const counts = ref({});
const loading = ref(true);
const detailLoading = ref(false);
const busy = ref(false);
const mediaSending = ref(false);
const error = ref('');
const listError = ref('');
const actionMessage = ref('');
const deliveryCheckingId = ref('');
const deliveryCheckNotice = ref('');
const deliveryCheckError = ref('');
const deliveryCheckFailedId = ref('');
const conversations = ref([]);
const totalCount = ref(0);
const nextCursor = ref('');
const loadingMore = ref(false);
const moreError = ref('');
const moreNeedsRefresh = ref(false);
const activeId = ref('');
const detail = ref(null);
const subjectState = ref(emptySubjects());
const subjectError = ref('');
const subjectNotice = ref('');
const subjectBusy = ref(false);
const subjectHeading = ref(null);
const selectedSubjectOrderId = ref('');
const subjectOrderQuery = ref('');
const messageSubjectDrafts = ref({});
/**
 * CP-16/UXA-05: per message, the question opened to correct it, the
 * "Mais de um" choice, and the answer or error written in its own bubble.
 *
 * @type {import('vue').Ref<Record<string, boolean>>}
 */
const subjectCorrecting = ref({});
/** @type {import('vue').Ref<Record<string, boolean>>} */
const subjectManyOpen = ref({});
/** @type {import('vue').Ref<Record<string, string>>} */
const subjectAnswers = ref({});
/** @type {import('vue').Ref<Record<string, string>>} */
const subjectAnswerErrors = ref({});
// UX-FUNC-01 / PCX-13 / COB-REV-01: drafts belong to a conversation and the
// current shell session, including a round trip to its order. The shell clears
// them on session changes; no browser storage holds customer message content.
/** @type {import('vue').Ref<Map<string, string>>} */
const replyDrafts = inject('inboxReplyDrafts', () => ref(new Map()), true);
const reply = computed({
  get: () => replyDrafts.value.get(activeId.value) ?? '',
  set(value) {
    if (!activeId.value) return;
    if (value) replyDrafts.value.set(activeId.value, value);
    else replyDrafts.value.delete(activeId.value);
  },
});

/** T139: the seller reviews and sends; existing draft text is preserved. */
async function addShippingDraft(text) {
  if (!canReply.value) return;
  const next = reply.value.trim() ? `${reply.value}\n\n${text}` : text;
  if (next.length > 2000) {
    notify(
      'A resposta ultrapassa 2.000 caracteres. Reduza o rascunho antes de acrescentar o frete.',
    );
    return;
  }
  reply.value = next;
  await nextTick();
  replyInput.value?.focus();
}

/** @param {string} preview */
function messagePostalCodes(preview) {
  const found = new Set();
  const pattern =
    /(?<!\d)(?<!\d[./-])(\d{2})\.?(\d{3})-?(\d{3})(?!\d)(?![./-]\d)/gu;
  for (const match of String(preview ?? '').matchAll(pattern)) {
    const digits = `${match[1]}${match[2]}${match[3]}`;
    if (!/^0+$/u.test(digits)) found.add(digits);
  }
  return [...found].map((digits) => `${digits.slice(0, 5)}-${digits.slice(5)}`);
}
const renaming = ref(false);
const draftName = ref('');
const renameBase = ref(null);
const renameConflict = ref(false);
const renameCurrentKnown = ref(false);
const renameTrigger = ref(null);
const transferring = ref(false);
const transferTarget = ref('');
const assignableUsers = ref([]);
// A02: the clock is read again on every load, so "parado há" does not freeze
// at whatever the first render happened to compute.
const now = ref(new Date());
let listController;
let appendController;
let listEpoch = 0;
let countController;
let detailController;
let deliveryCheckController;
let subjectController;
const subjectCommandKeys = new Map();
/** "Separar como novo assunto" already created, while its link is retried. */
const separatedSubjects = new Map();
let refreshTimer = 0;
let waitingClockTimer;
let orderChangedLive = false;
let threadFollowsLatest = true;

const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase('pt-BR');
  const matching = needle
    ? conversations.value.filter((conversation) =>
        `${conversation.contact.label} ${conversation.channel === 'site_chat' ? (conversation.contact.phone ?? '') : conversation.contact.externalId} ${messageText(conversation.lastMessage)}`
          .toLocaleLowerCase('pt-BR')
          .includes(needle),
      )
    : conversations.value;
  if (!['waiting', 'attention', 'closing'].includes(stateTab.value))
    return matching;
  // PCX-04: whoever has waited longest is read first. The read model already
  // answers in this order, but the rule is kept where the waiting time is
  // rendered so a local search or a silent refresh cannot reshuffle the queue.
  return [...matching].sort((left, right) =>
    String(
      left.queuePosition ??
        conversationWaitingSince(left) ??
        left.updatedAt ??
        '',
    ).localeCompare(
      String(
        right.queuePosition ??
          conversationWaitingSince(right) ??
          right.updatedAt ??
          '',
      ),
    ),
  );
});
const visibleConversationLabel = computed(() => {
  const count = filtered.value.length;
  if (!query.value.trim() && totalCount.value > count)
    return `${count} de ${totalCount.value} conversas`;
  return `${count} ${count === 1 ? 'conversa' : 'conversas'}`;
});
const liveStatusMessage = computed(() => {
  if (liveConnection.value === 'conectado') return '';
  if (liveConnection.value === 'reconectando') {
    return 'Reconectando atualizações. Você pode consultar as conversas agora.';
  }
  if (liveConnection.value === 'conectando') {
    return 'Conectando atualizações automáticas.';
  }
  return 'Atualizações automáticas indisponíveis. Você pode consultar as conversas agora.';
});
const active = computed(() => detail.value?.conversation ?? null);
watch(active, (conversation) => {
  if (!conversation) conversationExpanded.value = false;
});
const isTerminal = computed(() =>
  ['convertida_em_lead', 'sem_lead', 'encerrada'].includes(active.value?.state),
);
const currentUserId = computed(() => sessionUser.value?.id ?? '');
const isAdmin = computed(() =>
  (sessionUser.value?.capabilities ?? []).includes(ADMIN_CAPABILITY),
);
const owner = computed(() => active.value?.assignedUser ?? null);
const ownedByMe = computed(
  () => !owner.value || owner.value.id === currentUserId.value,
);
/**
 * A conversation belongs to whoever took it over. Another seller sees it but
 * cannot act on it; only an administrator overrides that.
 */
const canAct = computed(
  () => !isTerminal.value && (ownedByMe.value || isAdmin.value),
);
const ownerLabel = computed(() => {
  if (!owner.value) return 'Sem responsável';
  if (owner.value.id === currentUserId.value) return 'Você';
  return (
    owner.value.name ??
    assignableUsers.value.find((user) => user.id === owner.value.id)?.name ??
    'Outro vendedor'
  );
});
const serviceLabel = computed(() => {
  if (!active.value) return '';
  if (isTerminal.value) return conversationLabel(active.value);
  if (pendingHandoff.value) return 'Aguardando vendedor';
  if (active.value.automationState === 'assistant')
    return `Com ${brand.assistant.reference}`;
  return owner.value
    ? `Em atendimento · ${ownerLabel.value}`
    : 'Sem responsável';
});
const transferOptions = computed(() =>
  assignableUsers.value.filter((user) => user.id !== currentUserId.value),
);
const canReply = computed(
  () =>
    canAct.value &&
    !pendingHandoff.value &&
    active.value?.automationState === 'human',
);
const canQuoteShipping = computed(
  () =>
    canReply.value &&
    sessionUser.value?.functionName === 'Vendedor' &&
    (owner.value?.id === currentUserId.value || isAdmin.value),
);
const pendingHandoff = computed(
  () => active.value?.handoff?.status === 'pending',
);
/**
 * PCX-13: until a person has the conversation, taking it is the one thing to
 * do, so "Assumir atendimento" sits where the reply would be. Whoever cannot
 * act keeps the disabled reply and the reason beside it.
 */
const needsTakeover = computed(
  () =>
    canAct.value &&
    (pendingHandoff.value || active.value?.automationState === 'assistant'),
);
/** PCX-03: why the conversation stopped, or who is still answering it. */
const takeoverReason = computed(() => {
  const conversation = active.value;
  if (!conversation) return { detail: '', title: '' };
  if (pendingHandoff.value) {
    const elapsed = elapsedSince(conversation.handoff.createdAt, now.value);
    // INBOX-HANDOFF-02: the seller the customer asked for, by first name;
    // any seller may still take it (the handoff has no owner).
    const asked = preferredSellerLabel(
      preferredSellerFirstName(conversation.handoff),
    );
    const waiting = `${
      elapsed
        ? `Esperando vendedor há ${elapsed}.`
        : 'Esperando um vendedor assumir.'
    }${asked ? ` ${asked}.` : ''}`;
    // UXA-03/CP-16: the agent's stop over which order a message is about
    // (`low_confidence` with a message to review) must not read as "Agente
    // sem confiança"; it says what the seller decides after taking. Any other
    // reason keeps its own words, even with a message still to review.
    if (
      conversation.handoff.reasonCode === 'low_confidence' &&
      subjectReviewIds.value.size
    ) {
      return {
        detail: `${waiting} Ao assumir, indique a qual pedido a mensagem se refere.`,
        title: 'O agente parou para não misturar pedidos.',
      };
    }
    return {
      detail:
        conversation.handoff.reasonCode === 'unsupported'
          ? `${waiting} A automação encaminhou esta conversa para atendimento humano. Consulte o registro no resumo da transferência.`
          : waiting,
      title: conversationHandoffTitle(conversation),
    };
  }
  const assistant = brand.assistant.reference;
  return {
    // ADR 015: once taken, the conversation never goes back to the bot.
    detail: `Ao assumir, a conversa fica com você e não volta para ${assistant}.`,
    title: `${assistant.charAt(0).toLocaleUpperCase('pt-BR')}${assistant.slice(1)} está atendendo.`,
  };
});
const canTransfer = computed(
  () =>
    canAct.value &&
    active.value?.automationState === 'human' &&
    Boolean(active.value?.assignedUser),
);
const canArchive = computed(
  () =>
    !isTerminal.value &&
    (isAdmin.value || owner.value?.id === currentUserId.value),
);
const canUnarchive = computed(
  () => canArchive.value && Boolean(active.value?.archivedAt),
);
const canClose = computed(
  () =>
    !isTerminal.value &&
    (isAdmin.value || owner.value?.id === currentUserId.value),
);
/** CP-10: includes pending orders linked only by a subject of this cycle. */
const hasPendingOrder = computed(
  () =>
    Boolean(active.value?.hasPendingOrder) ||
    active.value?.order?.status === 'pendente' ||
    subjectState.value.subjects.some(
      (subject) => subject.orderStatus === 'pendente',
    ),
);
const availableSubjectOrders = computed(() =>
  subjectState.value.orders.filter(
    (order) =>
      !subjectState.value.subjects.some(
        (subject) => subject.orderId === order.id,
      ),
  ),
);
/** CP-16: messages the agent stopped on, still without any order. */
const subjectReviewIds = computed(
  () => new Set(subjectState.value.needsSubjectMessageIds),
);
/**
 * CP-14/UXA-10: only whoever has the conversation says which order a message
 * is about, and only after taking it; an administrator also takes it first.
 * The API asks the same (a human seller, owner or COMMERCIAL_ADMIN), so the
 * question is never offered to someone it would refuse.
 */
const canAnswerSubjects = computed(
  () =>
    sessionUser.value?.functionName === 'Vendedor' &&
    canClose.value &&
    !needsTakeover.value,
);
/**
 * UXA-04: a general subject is not numbered by its place in the conversation;
 * "(2)" tells two of them apart only when there is more than one.
 */
const generalSubjectNumbers = computed(() => {
  const general = subjectState.value.subjects.filter(
    (subject) => !subject.orderId,
  );
  return new Map(
    general.length > 1
      ? general.map((subject, index) => [subject.id, index + 1])
      : [],
  );
});
/** PCX-08/PCL-10: creating the order follows the owner of the conversation. */
const canCreateOrder = computed(
  () => isAdmin.value || owner.value?.id === currentUserId.value,
);
/** IMG-06/08: only editable orders linked to this conversation are offered. */
const imageAttachmentOrders = computed(() => {
  if (!canCreateOrder.value || isTerminal.value) return [];
  const orders = new Map();
  if (active.value?.order?.status === 'pendente')
    orders.set(active.value.order.id, active.value.order);
  for (const subject of subjectState.value.subjects) {
    if (subject.orderId && subject.orderStatus === 'pendente') {
      orders.set(subject.orderId, {
        id: subject.orderId,
        number: subject.orderNumber,
      });
    }
  }
  return [...orders.values()];
});
/** PCX-10: the order the conversation has, as a link to its page. */
const headerOrder = computed(
  () => active.value?.reviewOrder ?? active.value?.order ?? null,
);
const orderPath = computed(() =>
  headerOrder.value
    ? `/pedidos/${encodeURIComponent(headerOrder.value.id)}?conversa=${encodeURIComponent(active.value.id)}`
    : '',
);
/**
 * Says where the link goes and keeps the visible words in order ("Pedido
 * 04-CRM", "Pendente"), so voice control finds it by what it shows.
 */
const orderLinkLabel = computed(() => {
  const order = headerOrder.value;
  if (!order) return undefined;
  const status = orderStatusLabel(order.status).toLocaleLowerCase('pt-BR');
  return `Abrir pedido ${order.number}, ${status}`;
});
/** PCL-11: never while the conversation already has a pending order. */
const canOfferOrder = computed(
  () => canCreateOrder.value && active.value?.order?.status !== 'pendente',
);
/**
 * PCX-11: "Criar pedido" sits in the header only for the seller who has the
 * conversation, once it is with a person and has no order. Whatever else the
 * API accepts (an administrator, the agent still answering, a confirmed order
 * already there) is offered from "Mais".
 */
const createOrderInHeader = computed(
  () =>
    canOfferOrder.value &&
    !active.value?.order &&
    !isTerminal.value &&
    !pendingHandoff.value &&
    active.value?.automationState === 'human' &&
    owner.value?.id === currentUserId.value,
);
const createOrderInMore = computed(
  () => canOfferOrder.value && !createOrderInHeader.value,
);
const showArchived = computed(() => stateTab.value === 'archived');
/** PCX-14: the shortcut the two filters add up to, if any. */
const activeShortcut = computed(
  () =>
    SHORTCUTS.find(
      (shortcut) =>
        shortcut.tab === stateTab.value && shortcut.queue === queueFilter.value,
    )?.value ?? '',
);
/**
 * PCX-14: a pair no shortcut covers is named, one removable filter per axis.
 * Empty while a shortcut is pressed: the shortcut already says it.
 */
const activeFilters = computed(() => {
  /** @type {Array<{key: 'queue'|'tab', label: string}>} */
  const filters = [];
  if (activeShortcut.value) return filters;
  const tab = STATE_TABS.find((item) => item.value === stateTab.value);
  if (tab && tab.value !== 'all')
    filters.push({ key: 'tab', label: tab.label });
  const queue = QUEUE_FILTERS.find((item) => item.value === queueFilter.value);
  if (queue && queue.value !== 'all') {
    filters.push({ key: 'queue', label: queue.label });
  }
  return filters;
});
const filteredByChoice = computed(
  () => stateTab.value !== 'all' || queueFilter.value !== 'all',
);
const canArchiveActive = computed(
  () => canArchive.value && !active.value?.archivedAt,
);
/** "Mais" holds what the header does not show, and only when there is any. */
const hasMoreActions = computed(
  () =>
    createOrderInMore.value ||
    canClose.value ||
    canTransfer.value ||
    canArchiveActive.value ||
    canUnarchive.value,
);
const canSendReply = computed(
  () =>
    canReply.value &&
    !busy.value &&
    !mediaSending.value &&
    Boolean(reply.value.trim()),
);
/**
 * Mobile first (ADR 035): on a phone the header keeps the order link,
 * "Criar pedido" when it is due and "Mais"; everything else goes to the
 * "Mais" sheet. The one primary action sits in the composer (PCX-13).
 */
const phoneQuery = globalThis.matchMedia?.('(max-width: 768px)');
const isPhone = ref(phoneQuery?.matches ?? false);
watch(isPhone, async (phone) => {
  if (!phone) return;
  conversationExpanded.value = false;
  if (filtersOpen.value && props.conversationId) {
    /** @type {any} */ (filterSheet.value)?.close();
    await nextTick();
    conversationHeading.value?.focus();
  }
});
/** @param {MediaQueryListEvent} event */
function phoneChanged(event) {
  isPhone.value = event.matches;
  moreOpen.value = false;
}
/** A touch keyboard keeps Enter for a new line (see replyKeydown). */
const touchInput =
  globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
const workspaceView = computed(() =>
  props.conversationId ? 'conversation' : 'list',
);

/**
 * The list reads the time of today's conversations, the day of this year's
 * and the full date of older ones; the exact moment stays in the tooltip.
 *
 * @param {unknown} value
 */
function listWhen(value) {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '';
  const today = now.value;
  if (date.toDateString() === today.toDateString()) {
    return LIST_TIME.format(date);
  }
  return date.getFullYear() === today.getFullYear()
    ? LIST_DAY.format(date)
    : LIST_DATE.format(date);
}

/**
 * A message always shows its time; the day joins it once it is not today.
 *
 * @param {unknown} value
 */
function messageWhen(value) {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '';
  const time = LIST_TIME.format(date);
  return date.toDateString() === now.value.toDateString()
    ? time
    : `${listWhen(value)}, ${time}`;
}

/** @param {string} value a shortcut value */
function shortcutCount(value) {
  const count = counts.value[value];
  return Number.isFinite(count) ? count : null;
}

/**
 * @param {{tab?: string, queue?: string}} [filter] the situation and the
 *   owner; the ones on screen by default
 * @param {number} [limit] 1 when only the total is wanted
 * @param {string} [cursor] opaque cursor returned by the same official scope
 */
function listUrl(
  { tab: tabValue = stateTab.value, queue = queueFilter.value } = {},
  limit = 100,
  cursor = '',
) {
  const tab =
    STATE_TABS.find((item) => item.value === tabValue) ?? STATE_TABS[0];
  const params = new URLSearchParams({
    archived: String(tab.archived === true),
    limit: String(limit),
  });
  // PCX-17: Todas keeps the official urgency order, including owner filters.
  if (tab.value === 'all') params.set('sort', 'urgency');
  if (cursor) params.set('cursor', cursor);
  for (const [name, value] of Object.entries(tab.params)) {
    params.set(name, value);
  }
  if (queue === 'mine' && currentUserId.value) {
    params.set('assignedUserId', currentUserId.value);
  }
  if (queue === 'unassignedHumanHandoff') {
    params.set('unassignedHumanHandoff', 'true');
  }
  return `/api/v1/inbox/conversations?${params.toString()}`;
}

/**
 * PCX-14: a shortcut sets both filters at once, so the list is read once.
 *
 * @param {(typeof SHORTCUTS)[number]} shortcut
 */
function selectShortcut(shortcut) {
  stateTab.value = shortcut.tab;
  queueFilter.value = shortcut.queue;
}

/** PCX-18: filters are a draft until the sheet's explicit apply action. @param {Event} event */
function openFilters(event) {
  draftTab.value = stateTab.value;
  draftQueue.value = queueFilter.value;
  filtersOpen.value = true;
  /** @type {any} */ (filterSheet.value)?.open(
    /** @type {HTMLElement} */ (event.currentTarget),
  );
}

function applySheetFilters() {
  stateTab.value = draftTab.value;
  queueFilter.value = draftQueue.value;
}

function clearSheetDraft() {
  draftTab.value = 'all';
  draftQueue.value = 'all';
}

async function toggleConversationWidth() {
  conversationExpanded.value = !conversationExpanded.value;
  await anchorThread();
}

/**
 * PCX-14: removes one filter of the summary. The focus stays in the summary
 * while it has a filter left, and goes to "Filtros" once it is gone.
 *
 * @param {'queue'|'tab'} key
 */
async function removeFilter(key) {
  if (key === 'tab') stateTab.value = 'all';
  else queueFilter.value = 'all';
  await nextTick();
  focusAfterFilterChange();
}

/** Back to every conversation; the focus lands on "Filtros". */
async function clearFilters() {
  stateTab.value = 'all';
  queueFilter.value = 'all';
  await nextTick();
  focusAfterFilterChange();
}

function focusAfterFilterChange() {
  const next = /** @type {HTMLElement|null} */ (
    globalThis.document.querySelector('.inbox-active-filter button')
  );
  (next ?? /** @type {HTMLElement|null} */ (filtersButton.value))?.focus();
}

/** INBOX-UX-02: one operational label, never a stack of technical badges. @param {Record<string, any>} conversation */
function nextAction(conversation) {
  const name = assignableUsers.value.find(
    (user) => user.id === conversation.assignedUser?.id,
  )?.name;
  return conversationNextAction(conversation, currentUserId.value, name);
}

/** PCX-15: official human wait; automatic messages do not reset its clock. @param {Record<string, any>} conversation */
function waitingFor(conversation) {
  const since = conversationWaitingSince(conversation);
  return since ? elapsedSince(since, now.value) : '';
}

/** Phones show one pane at a time: the list or the open conversation. */
function isSinglePane() {
  return globalThis.matchMedia?.('(max-width: 768px)').matches ?? false;
}

/** @param {boolean} [open] */
async function toggleContext(open = !contextOpen.value) {
  contextOpen.value = open;
  await nextTick();
  const dialog = contextDialog.value;
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (open && !dialog.open)
    openDialog(dialog, contextToggle.value ?? moreToggle.value);
  else if (!open) dialog.close();
}

/** Contact data is fetched only on deliberate opening and never persisted. */
async function loadContactDetails() {
  const id = active.value?.contact.id;
  if (!id) return;
  contactController?.abort();
  const controller = new AbortController();
  contactController = controller;
  contactLoading.value = true;
  contactError.value = '';
  try {
    const response = await request(
      `/api/v1/contacts/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    );
    if (controller === contactController && active.value?.contact.id === id)
      contactDetail.value = response.data.contact;
  } catch (cause) {
    if (controller === contactController && cause?.name !== 'AbortError')
      contactError.value =
        'Não foi possível carregar os dados completos do contato.';
  } finally {
    if (controller === contactController) contactLoading.value = false;
  }
}

/** @param {MouseEvent} event */
function openContact(event) {
  if (!contactDialog.value || !(event.currentTarget instanceof HTMLElement))
    return;
  contactDetail.value = null;
  openDialog(contactDialog.value, event.currentTarget);
  void loadContactDetails();
}

/** @param {MouseEvent} event */
function closeDrawerOnBackdrop(event) {
  const dialog = event.currentTarget;
  if (!(dialog instanceof HTMLDialogElement) || event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    dialog.close();
}

/** @param {string} id */
async function openConversation(id) {
  if (!id) return;
  if (id === props.conversationId) {
    if (isSinglePane()) conversationHeading.value?.focus();
    return;
  }
  await router.push(`/inbox/${encodeURIComponent(id)}`);
}

async function toggleMore() {
  moreOpen.value = !moreOpen.value;
  if (!moreOpen.value) return;
  await nextTick();
  /** @type {HTMLElement|null} */ (
    moreMenu.value?.querySelector('button:not(:disabled)')
  )?.focus();
}

/** @param {boolean} [restoreFocus] */
function closeMore(restoreFocus = false) {
  if (!moreOpen.value) return;
  moreOpen.value = false;
  if (restoreFocus) moreToggle.value?.focus();
}

/**
 * Enter sends and Shift+Enter breaks the line, as in the chat apps the team
 * already uses. On a touch keyboard Enter keeps writing a new line, and an
 * IME composition is never cut short.
 *
 * @param {KeyboardEvent} event
 */
function replyKeydown(event) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.altKey ||
    event.isComposing ||
    touchInput
  ) {
    return;
  }
  event.preventDefault();
  if (canSendReply.value) void sendReply();
}

function threadScrolled() {
  const element = thread.value;
  if (!(element instanceof HTMLElement)) return;
  threadFollowsLatest =
    element.scrollHeight - element.scrollTop - element.clientHeight <
    STICKY_THREAD_GAP_PX;
}

/**
 * The history opens on the latest message and follows new ones, unless the
 * reader scrolled up to read something older.
 */
async function anchorThread() {
  if (!threadFollowsLatest) return;
  await nextTick();
  const element = thread.value;
  if (element instanceof HTMLElement) element.scrollTop = element.scrollHeight;
}

async function archiveConversation() {
  const conversationId = active.value?.id;
  const archived = await runCommand(
    'archive',
    {
      expectedVersion: active.value.version,
      reason: 'Conversa arquivada na Caixa de Entrada',
    },
    'Conversa arquivada. Uma nova mensagem do cliente a exibirá novamente.',
  );
  // The archived conversation leaves the list; the next one takes its place.
  if (archived && props.conversationId === conversationId) {
    await router.replace('/inbox');
  }
}

async function unarchiveConversation() {
  const restored = await runCommand(
    'unarchive',
    {
      expectedVersion: active.value.version,
      reason: 'Conversa desarquivada na Caixa de Entrada',
    },
    'Conversa desarquivada e restaurada à Caixa de Entrada.',
  );
  if (restored && showArchived.value) stateTab.value = 'all';
}

/**
 * PCL-10/PCX-11: the pending order is created from the pré-ficha the
 * conversation already holds. It rides the conversation version on screen,
 * so a create typed over a stale view loses to a 409 instead of racing the
 * winner. On success the header shows the order link and focus moves to it.
 *
 * @param {boolean} [fromMore] asked from "Mais", which takes focus back on failure
 */
async function orderSuggestedCreated(order) {
  if (!order?.id) return;
  orderRevision.value += 1;
  notify(`Pedido ${order.number} criado.`);
}

async function revealOrderEvidence(messageId) {
  if (contextOpen.value) await toggleContext(false);
  const message = Array.from(
    thread.value?.querySelectorAll('[data-message-id]') ?? [],
  ).find((element) => element.getAttribute('data-message-id') === messageId);
  if (!message) return;
  message.scrollIntoView({ block: 'center', behavior: 'auto' });
  message.focus({ preventScroll: true });
}

async function createOrder(fromMore = false) {
  const conversation = active.value;
  if (
    !conversation ||
    orderCreating.value ||
    busy.value ||
    isTerminal.value ||
    !canOfferOrder.value
  )
    return;
  const dialog = orderConfirmationDialog.value;
  const trigger = fromMore ? moreToggle.value : orderCreateTrigger.value;
  closeMore();
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !(trigger instanceof HTMLElement)
  )
    return;
  manualOrderError.value = '';
  manualOrderConfirmation.value = {
    conversationId: conversation.id,
    expectedVersion: conversation.version,
    idempotencyKey: commandKey(),
    fromMore,
  };
  openDialog(dialog, trigger);
}

async function confirmManualOrder() {
  const confirmation = manualOrderConfirmation.value;
  if (
    !confirmation ||
    confirmation.conversationId !== active.value?.id ||
    orderCreating.value ||
    busy.value
  )
    return;
  const conversationId = confirmation.conversationId;
  orderCreating.value = true;
  manualOrderError.value = '';
  actionMessage.value = '';
  let created = null;
  try {
    const response = await request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/orders`,
      {
        body: { expectedVersion: confirmation.expectedVersion },
        idempotencyKey: confirmation.idempotencyKey,
        method: 'POST',
      },
    );
    created = response.data.order ?? null;
  } catch (cause) {
    manualOrderError.value =
      /** @type {any} */ (cause)?.status === 409
        ? 'A conversa mudou. Cancele esta confirmação, confira a intenção do cliente e abra a criação novamente.'
        : describeError(cause);
    if (/** @type {any} */ (cause)?.status === 409) await refreshInbox(true);
    await nextTick();
    manualOrderErrorNotice.value?.focus();
  } finally {
    orderCreating.value = false;
  }
  if (created) {
    orderConfirmationDialog.value?.close();
    if (activeId.value === conversationId && detail.value) {
      // The link appears at once; the refresh below confirms it.
      detail.value.conversation.order = {
        id: created.id,
        number: created.number,
        status: created.status,
      };
    }
    notify(`Pedido ${created.number} criado.`);
    orderRevision.value += 1;
    await refreshInbox(true);
  }
  if (!created || activeId.value !== conversationId) return;
  await nextTick();
  const link = /** @type {any} */ (orderLink.value)?.$el;
  if (created && link instanceof HTMLElement) {
    link.focus();
  } else if (confirmation.fromMore) {
    moreToggle.value?.focus();
  } else if (!globalThis.document.activeElement?.closest('.conv-actions')) {
    conversationHeading.value?.focus();
  }
}

/** Asked from "Mais", so the dialog hands focus back to that button. */
function requestArchiveConfirmation() {
  const dialog = archiveConfirmationDialog.value;
  const trigger = moreToggle.value;
  closeMore();
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !(trigger instanceof HTMLElement)
  ) {
    return;
  }
  openDialog(dialog, trigger);
}

async function confirmArchive() {
  archiveConfirmationDialog.value?.close();
  await archiveConversation();
}

/** PCX-13: "Encerrar conversa" lives in "Mais" at every width; focus returns to it. */
function requestCloseFromMore() {
  closeMore();
  openCloseConfirmation(moreToggle.value);
}

/** @param {EventTarget|null|undefined} trigger */
function openCloseConfirmation(trigger) {
  const dialog = closeConfirmationDialog.value;
  if (
    !(dialog instanceof HTMLDialogElement) ||
    !(trigger instanceof HTMLElement)
  )
    return;
  closureOutcome.value = 'concluido';
  acknowledgePending.value = false;
  closeError.value = '';
  openDialog(dialog, trigger);
}

async function confirmClose() {
  if (hasPendingOrder.value && !acknowledgePending.value) return;
  const closed = await runCommand(
    'close',
    {
      acknowledgePending: acknowledgePending.value,
      expectedVersion: active.value.version,
      outcome: closureOutcome.value,
    },
    'Conversa encerrada. Uma nova mensagem iniciará outro atendimento.',
  );
  if (closed) {
    closeConfirmationDialog.value?.close();
    await nextTick();
    heading.value?.focus();
  } else {
    closeError.value = error.value;
    acknowledgePending.value = false;
  }
}

/** @param {{authorKind?: unknown, direction?: unknown}} message */
function messageFrom(message) {
  if (message.authorKind === 'contact') return 'cliente';
  if (message.authorKind === 'assistant') return 'agente';
  if (message.authorKind === 'human') return 'humano';
  return message.direction === 'inbound' ? 'cliente' : 'agente';
}

/** @param {{authorKind?: unknown, direction?: unknown}} message */
function messageAuthorLabel(message) {
  const from = messageFrom(message);
  if (from === 'cliente') return active.value?.contact.label ?? 'Cliente';
  if (from === 'humano') return 'Vendedor';
  return brand.assistant.name;
}

/**
 * Glossário (achado 5): one name for the assistant, from the brand, and the
 * role only where the author's name does not already say it.
 *
 * @param {{authorKind?: unknown, direction?: unknown}} message
 */
function messageRoleLabel(message) {
  return messageFrom(message) === 'agente' ? 'IA' : '';
}

/** @param {{authorKind?: unknown, direction?: unknown}} message */
function messageInitials(message) {
  return String(messageAuthorLabel(message))
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toLocaleUpperCase('pt-BR');
}

/** Hide transport labels while retaining genuine captions on media. @param {Record<string, any>} message */
function messageCaption(message) {
  const caption = String(message.preview ?? '');
  return (message.media ||
    ['audio', 'image', 'video'].includes(message.type)) &&
    /^(áudio|audio|imagem|foto|vídeo|video)(?:\s+(?:recebid[oa]|enviad[oa]))?\.?$/iu.test(
      caption.trim(),
    )
    ? ''
    : caption;
}

/** INBOX-DELIVERY-01: consult the existing attempt; never create another send.
 * @param {string} messageId
 */
async function checkMessageDelivery(messageId) {
  if (deliveryCheckingId.value || !activeId.value || !detail.value) return;
  detailController?.abort();
  detailController = undefined;
  const id = activeId.value;
  const controller = new AbortController();
  deliveryCheckController = controller;
  const trigger = globalThis.document.activeElement;
  deliveryCheckingId.value = messageId;
  deliveryCheckNotice.value = '';
  deliveryCheckError.value = '';
  deliveryCheckFailedId.value = '';
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    );
    if (controller.signal.aborted || activeId.value !== id) return;
    const updated = response.data.messages?.find(
      (message) => message.id === messageId,
    );
    const current = detail.value?.messages.find(
      (message) => message.id === messageId,
    );
    if (!updated || !current) throw new Error('Message status unavailable');
    // Only delivery fields change; drafts, subjects and the thread stay intact.
    current.deliveryStatus = updated.deliveryStatus;
    current.deliveryErrorCode = updated.deliveryErrorCode;
    current.status = updated.status;
    const notices = {
      sent: 'Envio confirmado pelo serviço de mensagens.',
      delivered: 'Mensagem entregue.',
      read: 'Mensagem lida.',
      failed:
        'O envio continua com problema. Consulte os detalhes para suporte.',
    };
    deliveryCheckNotice.value =
      notices[updated.deliveryStatus] ??
      'Ainda não há confirmação do envio. Não repita a mensagem enquanto o resultado estiver incerto.';
    await nextTick();
    if (
      activeId.value === id &&
      !trigger?.isConnected &&
      globalThis.document.activeElement === globalThis.document.body
    ) {
      thread.value?.focus();
    }
  } catch {
    if (controller.signal.aborted || activeId.value !== id) return;
    deliveryCheckFailedId.value = messageId;
    deliveryCheckError.value =
      'Não foi possível verificar o envio agora. Tente novamente. O histórico foi preservado.';
  } finally {
    if (deliveryCheckController === controller) deliveryCheckingId.value = '';
  }
}

/** @param {unknown} cause */
function describeError(cause) {
  const status = Number(/** @type {any} */ (cause)?.status);
  const requestId = /** @type {any} */ (cause)?.problem?.request_id;
  const suffix = requestId ? ` (id ${requestId})` : '';
  if (/** @type {any} */ (cause)?.code === 'NON_PRODUCTION_CONVERSATION')
    return 'Esta conversa é de teste e não envia mensagens pelo WhatsApp.';
  if (status === 403) {
    return `Sem permissão para esta ação. A conversa pode estar com outro vendedor.${suffix}`;
  }
  if (status === 409) {
    return `A conversa mudou enquanto você trabalhava. Os dados foram recarregados.${suffix}`;
  }
  if (status === 429) {
    return `Muitas ações seguidas. Aguarde um instante.${suffix}`;
  }
  if (status >= 500) return `Serviço indisponível no momento.${suffix}`;
  return `Não foi possível concluir a ação.${suffix}`;
}

/** @param {boolean} [silent] */
async function loadInbox(silent = false) {
  const restoreAppendFocus =
    document.activeElement === moreConversationsButton.value;
  listEpoch += 1;
  appendController?.abort();
  appendController = undefined;
  loadingMore.value = false;
  nextCursor.value = '';
  moreError.value = '';
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  if (!silent) loading.value = true;
  try {
    const response = await request(listUrl(), {
      signal: controller.signal,
    });
    if (controller !== listController) return;
    moreNeedsRefresh.value = false;
    conversations.value = response.data.items;
    totalCount.value = response.data.totalCount;
    nextCursor.value = response.data.nextCursor ?? '';
    if (
      activeShortcut.value &&
      (queueFilter.value !== 'mine' || currentUserId.value)
    ) {
      counts.value = {
        ...counts.value,
        [activeShortcut.value]: Number(response.data.totalCount),
      };
    }
    now.value = new Date();
    listError.value = '';
    void loadCounts();
    await selectVisibleConversation();
  } catch (cause) {
    if (
      controller === listController &&
      /** @type {any} */ (cause)?.name !== 'AbortError'
    ) {
      listError.value =
        'Não foi possível atualizar a Caixa de Entrada. Os resultados exibidos podem estar desatualizados.';
    }
  } finally {
    if (controller === listController) {
      loading.value = false;
      if (restoreAppendFocus && document.activeElement === document.body) {
        await nextTick();
        listSummary.value?.focus({ preventScroll: true });
      }
    }
  }
}

/** PCX-17: append the official next page without disturbing the open conversation.
 * @param {MouseEvent} event
 */
async function loadMoreConversations(event) {
  if (loading.value || loadingMore.value) return;
  if (moreNeedsRefresh.value) {
    await loadInbox();
    return;
  }
  if (!nextCursor.value) return;
  const cursor = nextCursor.value;
  const scope = listUrl();
  const epoch = listEpoch;
  const actor = currentUserId.value;
  const trigger = event.currentTarget;
  const controller = new AbortController();
  appendController?.abort();
  appendController = controller;
  loadingMore.value = true;
  moreError.value = '';
  const isCurrent = () =>
    controller === appendController &&
    !controller.signal.aborted &&
    epoch === listEpoch &&
    actor === currentUserId.value &&
    scope === listUrl();
  try {
    const response = await request(listUrl({}, 100, cursor), {
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    const returnedCursor = response.data.nextCursor ?? '';
    if (returnedCursor === cursor) throw new Error('CURSOR_DID_NOT_ADVANCE');
    const known = new Set(conversations.value.map((item) => item.id));
    const additions = response.data.items.filter((item) => {
      if (known.has(item.id)) return false;
      known.add(item.id);
      return true;
    });
    const restoreFocus = document.activeElement === trigger;
    const scrollTop = conversationList.value?.scrollTop ?? 0;
    conversations.value = [...conversations.value, ...additions];
    nextCursor.value = returnedCursor;
    totalCount.value = response.data.totalCount;
    if (
      activeShortcut.value &&
      (queueFilter.value !== 'mine' || currentUserId.value)
    )
      counts.value = {
        ...counts.value,
        [activeShortcut.value]: Number(response.data.totalCount),
      };
    await nextTick();
    if (!isCurrent()) return;
    if (conversationList.value) conversationList.value.scrollTop = scrollTop;
    if (restoreFocus && !nextCursor.value) {
      const firstNew = Array.from(
        conversationList.value?.querySelectorAll('.conversation-row') ?? [],
      ).find((element) =>
        additions.some(
          (item) => item.id === element.getAttribute('data-conversation-id'),
        ),
      );
      (firstNew ?? listSummary.value)?.focus({ preventScroll: true });
    }
  } catch (cause) {
    if (isCurrent() && /** @type {any} */ (cause)?.name !== 'AbortError') {
      moreNeedsRefresh.value =
        cause?.code === 'INVALID_CURSOR' ||
        cause?.message === 'CURSOR_DID_NOT_ADVANCE';
      moreError.value = moreNeedsRefresh.value
        ? 'A lista mudou. Atualize a lista para continuar; as conversas já carregadas foram preservadas.'
        : 'Não foi possível carregar mais conversas. Tente novamente; as conversas já carregadas foram preservadas.';
    }
  } finally {
    if (controller === appendController) loadingMore.value = false;
  }
}

/**
 * The other shortcuts only need their totals: one `limit=1` read each, in
 * parallel. A failed total hides its number rather than keeping a stale one,
 * and "Minhas" has none until the session says who is reading.
 */
async function loadCounts() {
  countController?.abort();
  const controller = new AbortController();
  countController = controller;
  const others = SHORTCUTS.filter(
    (shortcut) => shortcut.value !== activeShortcut.value,
  );
  const results = await Promise.allSettled(
    others.map((shortcut) =>
      shortcut.queue === 'mine' && !currentUserId.value
        ? Promise.reject(new Error('Sessão sem usuário'))
        : request(listUrl(shortcut, 1), { signal: controller.signal }),
    ),
  );
  if (controller !== countController) return;
  const next = { ...counts.value };
  results.forEach((result, index) => {
    const value = others[index].value;
    const total = Number(
      result.status === 'fulfilled' ? result.value.data.totalCount : NaN,
    );
    if (Number.isFinite(total)) next[value] = total;
    else delete next[value];
  });
  counts.value = next;
}

/** @param {boolean} [silent] */
async function refreshInbox(silent = false) {
  await loadInbox(silent);
}

/**
 * Keeps the detail pane on a conversation the list actually shows. Without
 * this, searching leaves the reader looking at a conversation that has been
 * filtered out of the list beside it.
 *
 * @param {boolean} [refreshActive] refetch even when the selection is unchanged
 */
async function selectVisibleConversation(refreshActive = true) {
  // A conversation opened by its address stays open whatever the list shows:
  // it may be archived, filtered out or beyond the 100 loaded.
  if (props.conversationId) {
    const same =
      activeId.value === props.conversationId && Boolean(detail.value);
    if (refreshActive || !same) {
      await selectConversation(props.conversationId, same);
    }
    return;
  }
  const visible = filtered.value;
  const stillVisible = visible.some((item) => item.id === activeId.value);
  const nextId = stillVisible ? activeId.value : (visible[0]?.id ?? '');
  if (!nextId) {
    activeId.value = '';
    detail.value = null;
    subjectController?.abort();
    subjectState.value = emptySubjects();
    return;
  }
  // Typing in the search box must not refetch the open conversation on every
  // keystroke; only a data refresh or a changed selection needs the request.
  if (stillVisible && !refreshActive && detail.value) return;
  await selectConversation(nextId, stillVisible);
}

/** @param {string} id @param {boolean} [silent] */
async function selectConversation(id, silent = false) {
  if (!id) return;
  deliveryCheckController?.abort();
  deliveryCheckingId.value = '';
  detailController?.abort();
  subjectController?.abort();
  const controller = new AbortController();
  detailController = controller;
  if (activeId.value !== id) {
    error.value = '';
    actionMessage.value = '';
    orderConfirmationDialog.value?.close();
    contextDialog.value?.close();
    contactDialog.value?.close();
    contextOpen.value = false;
    contextTab.value = 'orders';
    subjectActionsOpen.value = false;
    contactController?.abort();
    contactDetail.value = null;
    deliveryCheckNotice.value = '';
    deliveryCheckError.value = '';
    deliveryCheckFailedId.value = '';
    detail.value = null;
    threadFollowsLatest = true;
    moreOpen.value = false;
    subjectOrderQuery.value = '';
    selectedSubjectOrderId.value = '';
    renaming.value = false;
    renameBase.value = null;
    renameConflict.value = false;
    transferring.value = false;
    subjectState.value = emptySubjects();
    subjectError.value = '';
    subjectNotice.value = '';
    subjectCorrecting.value = {};
    subjectManyOpen.value = {};
    messageSubjectDrafts.value = {};
    subjectAnswers.value = {};
    subjectAnswerErrors.value = {};
  }
  activeId.value = id;
  if (!silent) detailLoading.value = true;
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    );
    if (controller !== detailController || activeId.value !== id) return;
    detail.value = response.data;
    void loadSubjects(id);
  } catch (cause) {
    if (
      controller === detailController &&
      activeId.value === id &&
      /** @type {any} */ (cause)?.name !== 'AbortError'
    ) {
      error.value = 'Não foi possível carregar a conversa selecionada.';
      if (!silent || !renaming.value) detail.value = null;
    }
  } finally {
    if (controller === detailController && activeId.value === id)
      detailLoading.value = false;
  }
}

/** @returns {Record<string, any>} what a conversation without subjects reads. */
function emptySubjects() {
  return {
    currentSubjectId: null,
    links: [],
    needsSubjectMessageIds: [],
    orders: [],
    ordersHasMore: false,
    subjects: [],
  };
}

/** @param {string} conversationId */
async function loadSubjects(conversationId) {
  subjectController?.abort();
  const controller = new AbortController();
  subjectController = controller;
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}/subjects?order=${encodeURIComponent(subjectOrderQuery.value.trim())}`,
      { signal: controller.signal },
    );
    if (controller !== subjectController || activeId.value !== conversationId)
      return;
    const subjects = response.data;
    if (
      !Array.isArray(subjects?.subjects) ||
      !Array.isArray(subjects.links) ||
      !Array.isArray(subjects.orders)
    ) {
      throw new Error('Invalid conversation subjects response');
    }
    // CP-16: an API that does not flag messages yet asks nothing.
    subjectState.value = {
      ...subjects,
      needsSubjectMessageIds: Array.isArray(subjects.needsSubjectMessageIds)
        ? subjects.needsSubjectMessageIds
        : [],
    };
    // A question open under "Mais de um" or "Corrigir" keeps the boxes the
    // seller is checking through a silent live refresh; every other message
    // reads its links again. Only a change of conversation drops them all.
    const known = new Set(subjects.subjects.map((subject) => subject.id));
    const drafts = messageSubjectDrafts.value;
    messageSubjectDrafts.value = Object.fromEntries(
      (detail.value?.messages ?? []).map((message) => [
        message.id,
        (subjectManyOpen.value[message.id] ||
          subjectCorrecting.value[message.id]) &&
        Array.isArray(drafts[message.id])
          ? drafts[message.id].filter((/** @type {string} */ id) =>
              known.has(id),
            )
          : subjects.links
              .filter((link) => link.messageId === message.id)
              .map((link) => link.subjectId),
      ]),
    );
    subjectError.value = '';
  } catch (cause) {
    if (controller === subjectController && cause?.name !== 'AbortError') {
      subjectError.value =
        'Não foi possível consultar os assuntos desta conversa.';
    }
  }
}

/**
 * A command retried after a timeout or a lost answer keeps its idempotency
 * key, so the API replays it instead of acting twice; success or a conflict
 * ends that key.
 *
 * @param {unknown[]} parts what makes two attempts the same command
 * @param {(idempotencyKey: string) => Promise<any>} send
 */
async function keyedSubjectCommand(parts, send) {
  const signature = JSON.stringify(parts);
  const idempotencyKey = subjectCommandKeys.get(signature) ?? commandKey();
  subjectCommandKeys.set(signature, idempotencyKey);
  try {
    const response = await send(idempotencyKey);
    subjectCommandKeys.delete(signature);
    return response;
  } catch (cause) {
    if (/** @type {any} */ (cause)?.status === 409)
      subjectCommandKeys.delete(signature);
    throw cause;
  }
}

/** @param {'create'|'select'} kind @param {string|null} [target] */
async function subjectCommand(kind, target = null) {
  if (!active.value || subjectBusy.value) return;
  subjectBusy.value = true;
  subjectError.value = '';
  subjectNotice.value = '';
  const conversationId = active.value.id;
  const base = `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}`;
  try {
    await keyedSubjectCommand([conversationId, kind, target, []], (key) =>
      kind === 'create'
        ? request(`${base}/subjects`, {
            body: { orderId: target },
            idempotencyKey: key,
            method: 'POST',
          })
        : request(
            `${base}/subjects/${encodeURIComponent(String(target))}/select`,
            { body: {}, idempotencyKey: key, method: 'POST' },
          ),
    );
    if (kind === 'create') selectedSubjectOrderId.value = '';
    await loadSubjects(conversationId);
    if (activeId.value !== conversationId) return;
    if (!subjectError.value) {
      subjectNotice.value =
        kind === 'select'
          ? 'Pronto. O agente passa a usar este.'
          : 'Assunto criado. O agente passa a usar este.';
    }
    await nextTick();
    subjectHeading.value?.focus();
  } catch (cause) {
    if (activeId.value !== conversationId) return;
    subjectError.value = describeError(cause);
    if (/** @type {any} */ (cause)?.status === 409)
      await loadSubjects(conversationId);
  } finally {
    subjectBusy.value = false;
  }
}

/**
 * CP-14/CP-16: the seller's answer is a human link that also resolves the
 * agent's review; "Nenhum pedido" sends `[]`. "Separar como novo assunto"
 * first creates a general subject, kept while its link is retried, and
 * "Ligar aos marcados" sends the boxes checked under "Mais de um".
 * UXA-05: the outcome is written in the message itself and takes the focus,
 * never the Detalhes panel that is hidden below 1440 px.
 *
 * @param {string} messageId
 * @param {string[]|'separate'|'marked'} choice
 */
async function answerMessageSubject(messageId, choice) {
  if (!active.value || subjectBusy.value) return;
  if (choice === 'marked' && !messageSubjectDrafts.value[messageId]?.length) {
    subjectAnswerErrors.value = {
      ...subjectAnswerErrors.value,
      [messageId]: 'Marque pelo menos um pedido ou escolha “Nenhum pedido”.',
    };
    return;
  }
  subjectBusy.value = true;
  subjectAnswerErrors.value = { ...subjectAnswerErrors.value, [messageId]: '' };
  const conversationId = active.value.id;
  const base = `/api/v1/inbox/conversations/${encodeURIComponent(conversationId)}`;
  const separatedKey = JSON.stringify([conversationId, messageId]);
  try {
    let subjectIds;
    if (choice === 'separate') {
      let subjectId = separatedSubjects.get(separatedKey);
      if (!subjectId) {
        const created = await keyedSubjectCommand(
          [conversationId, 'separate', messageId],
          (key) =>
            // CP-30: separating one message does not change which subject
            // the agent uses; only "Usar este" does.
            request(`${base}/subjects`, {
              body: { orderId: null, select: false },
              idempotencyKey: key,
              method: 'POST',
            }),
        );
        subjectId = created?.data?.subject?.id;
        if (!subjectId) throw new Error('Invalid created subject response');
        separatedSubjects.set(separatedKey, subjectId);
      }
      subjectIds = [subjectId];
    } else {
      subjectIds = [
        ...(choice === 'marked'
          ? messageSubjectDrafts.value[messageId]
          : choice),
      ].sort();
    }
    await keyedSubjectCommand(
      [conversationId, 'tag', messageId, subjectIds],
      (key) =>
        request(`${base}/messages/${encodeURIComponent(messageId)}/subjects`, {
          body: { subjectIds },
          idempotencyKey: key,
          method: 'PUT',
        }),
    );
    separatedSubjects.delete(separatedKey);
    // The saved answer is what the message holds now, whatever the reload.
    messageSubjectDrafts.value[messageId] = [...subjectIds];
    await loadSubjects(conversationId);
    if (activeId.value !== conversationId) return;
    closeSubjectQuestion(messageId);
    // A reload that failed (or raced) must not leave the question beside the
    // success text: the message is answered, so it no longer asks.
    subjectState.value = {
      ...subjectState.value,
      needsSubjectMessageIds: subjectState.value.needsSubjectMessageIds.filter(
        (/** @type {string} */ id) => id !== messageId,
      ),
    };
    subjectAnswers.value = {
      ...subjectAnswers.value,
      [messageId]: answerText(subjectIds),
    };
    await nextTick();
    globalThis.document.getElementById(`subject-answer-${messageId}`)?.focus();
  } catch (cause) {
    if (activeId.value !== conversationId) return;
    const status = /** @type {any} */ (cause)?.status;
    subjectAnswerErrors.value = {
      ...subjectAnswerErrors.value,
      // A 409 is a closed conversation, a subject of another contact or a
      // reused key; it reads as the conversation having changed, and reloads.
      [messageId]:
        status === 409 || status === 403
          ? describeError(cause)
          : 'Não deu para salvar. A pergunta continua aqui; tente de novo.',
    };
    if (status === 409) await loadSubjects(conversationId);
  } finally {
    subjectBusy.value = false;
  }
}

/** @param {string[]} subjectIds */
function answerText(subjectIds) {
  if (!subjectIds.length) return 'Marcada sem pedido.';
  const labels = subjectIds.map((id) => {
    const subject = subjectState.value.subjects.find((item) => item.id === id);
    return `ao ${subject ? subjectLabel(subject) : 'novo assunto sem pedido'}`;
  });
  return `Ligada ${LIST_FORMAT.format(labels)} por você.`;
}

/** @param {string} messageId */
function closeSubjectQuestion(messageId) {
  const { [messageId]: _correcting, ...correcting } = subjectCorrecting.value;
  const { [messageId]: _many, ...many } = subjectManyOpen.value;
  const { [messageId]: _error, ...errors } = subjectAnswerErrors.value;
  subjectCorrecting.value = correcting;
  subjectManyOpen.value = many;
  subjectAnswerErrors.value = errors;
}

/** @param {string} messageId */
function toggleSubjectMany(messageId) {
  if (!Array.isArray(messageSubjectDrafts.value[messageId]))
    messageSubjectDrafts.value[messageId] = [];
  subjectManyOpen.value = {
    ...subjectManyOpen.value,
    [messageId]: !subjectManyOpen.value[messageId],
  };
}

/**
 * UXA-09: "Corrigir" opens the same question with the message's current
 * orders already checked, and moves the focus to its first option.
 *
 * @param {string} messageId
 */
async function correctMessageSubject(messageId) {
  const { [messageId]: _previous, ...answers } = subjectAnswers.value;
  subjectAnswers.value = answers;
  messageSubjectDrafts.value[messageId] = subjectState.value.links
    .filter((/** @type {any} */ link) => link.messageId === messageId)
    .map((/** @type {any} */ link) => link.subjectId);
  subjectCorrecting.value = { ...subjectCorrecting.value, [messageId]: true };
  if (!subjectManyOpen.value[messageId]) toggleSubjectMany(messageId);
  await nextTick();
  globalThis.document
    .getElementById(`subject-question-${messageId}`)
    ?.querySelector('button')
    ?.focus();
}

/** @param {string} messageId */
async function cancelSubjectCorrection(messageId) {
  closeSubjectQuestion(messageId);
  messageSubjectDrafts.value[messageId] = subjectState.value.links
    .filter((link) => link.messageId === messageId)
    .map((link) => link.subjectId);
  await nextTick();
  globalThis.document.getElementById(`subject-correct-${messageId}`)?.focus();
}

/**
 * CP-16/UXA-01: a message asks only where the agent stopped on it, or while
 * the seller corrects it; everywhere else it carries no control.
 *
 * @param {{id: string}} message
 */
function showsSubjectQuestion(message) {
  return (
    canAnswerSubjects.value &&
    (subjectReviewIds.value.has(message.id) ||
      Boolean(subjectCorrecting.value[message.id]))
  );
}

/**
 * UXA-01/UXA-09: with two or more subjects, a customer message says quietly
 * which order it went to and who linked it; with one there is nothing to tell.
 *
 * @param {{id: string, direction?: string}} message
 */
function messageSubjectChip(message) {
  if (subjectState.value.subjects.length < 2 || message.direction !== 'inbound')
    return '';
  const links = subjectState.value.links.filter(
    (link) => link.messageId === message.id,
  );
  const labels = links
    .map((link) =>
      subjectState.value.subjects.find(
        (subject) => subject.id === link.subjectId,
      ),
    )
    .filter(Boolean)
    .map(subjectLabel);
  if (!labels.length) return '';
  // CP-14: a person's answer replaces the agent's links, so it names them.
  const kinds = new Set(links.map((link) => link.assignedByKind));
  const by = kinds.has('human')
    ? ' · pelo vendedor'
    : kinds.has('agent')
      ? ' · pelo agente'
      : '';
  return `${labels.join(', ')}${by}`;
}

/** @param {Record<string, any>} subject */
function subjectLabel(subject) {
  if (subject.orderId) return `Pedido ${subject.orderNumber ?? ''}`.trim();
  const number = generalSubjectNumbers.value.get(subject.id);
  return number ? `Assunto sem pedido (${number})` : 'Assunto sem pedido';
}

/** @param {string} path @param {Record<string, unknown>} body @param {string} successMessage */
async function runCommand(path, body, successMessage) {
  if (!active.value || busy.value || mediaSending.value) return;
  const conversationId = active.value.id;
  busy.value = true;
  error.value = '';
  actionMessage.value = '';
  try {
    await request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/${path}`,
      {
        body,
        idempotencyKey: commandKey(),
        method: 'POST',
      },
    );
    if (activeId.value === conversationId) actionMessage.value = successMessage;
    await loadInbox(true);
    return true;
  } catch (cause) {
    if (activeId.value === conversationId) error.value = describeError(cause);
    if (/** @type {any} */ (cause)?.status === 409) await loadInbox(true);
    return false;
  } finally {
    busy.value = false;
  }
}

/**
 * The only automation change a person makes is taking the conversation from
 * the bot; ADR 015 removed handing it back.
 *
 * @param {string} path @param {string} successMessage
 */
async function changeAutomation(path, successMessage) {
  await runCommand(
    path,
    {
      expectedVersion: active.value.version,
      reason: 'Ação manual na Caixa de Entrada',
    },
    successMessage,
  );
}

async function sendReply() {
  if (!canReply.value || !active.value || busy.value || mediaSending.value)
    return;
  const conversationId = active.value.id;
  const draftScope = replyDrafts.value;
  const draft = reply.value;
  const text = draft.trim();
  if (!text) return;
  const sent = await runCommand(
    'messages',
    {
      content: { text },
      expectedVersion: active.value.version,
      messageType: 'text',
      reason: 'Resposta humana na Caixa de Entrada',
    },
    'Mensagem aceita para envio.',
  );
  if (sent) {
    if (replyDrafts.value !== draftScope) return;
    // A reply to A may finish while B is open. Clear only A's submitted draft,
    // and never erase a newer edit or move the keyboard out of B's context.
    if (replyDrafts.value.get(conversationId) === draft)
      replyDrafts.value.delete(conversationId);
    if (activeId.value !== conversationId) return;
    await nextTick();
    replyInput.value?.focus();
  }
}

async function mediaSent() {
  actionMessage.value = 'Mensagem aceita para envio.';
  await loadInbox(true);
}

async function loadAssignableUsers() {
  if (assignableUsers.value.length) return;
  try {
    const response = await request('/api/v1/users/assignable');
    assignableUsers.value = response.data.users ?? [];
  } catch {
    assignableUsers.value = [];
  }
}

async function openTransfer() {
  if (!canTransfer.value) return;
  closeMore();
  await loadAssignableUsers();
  transferTarget.value = transferOptions.value[0]?.id ?? '';
  transferring.value = true;
  await nextTick();
  transferSelect.value?.focus();
}

function cancelTransfer() {
  transferring.value = false;
  moreToggle.value?.focus();
}

async function confirmTransfer() {
  if (!transferTarget.value) return;
  const targetName =
    transferOptions.value.find((user) => user.id === transferTarget.value)
      ?.name ?? 'outro vendedor';
  await runCommand(
    'transfer',
    {
      expectedVersion: active.value.version,
      reason: 'Repasse de atendimento na Caixa de Entrada',
      targetUserId: transferTarget.value,
    },
    `Atendimento transferido para ${targetName}.`,
  );
  if (!error.value) transferring.value = false;
}

async function claimHandoff() {
  const conversation = active.value;
  const handoff = conversation?.handoff;
  if (!conversation || handoff?.status !== 'pending' || busy.value) return;
  busy.value = true;
  error.value = '';
  actionMessage.value = '';
  try {
    await request(`/api/v1/handoffs/${encodeURIComponent(handoff.id)}/claim`, {
      body: {
        expectedConversationVersion: conversation.version,
        expectedHandoffVersion: handoff.version,
        reasonCode: 'handoff_claimed',
      },
      idempotencyKey: commandKey(),
      method: 'POST',
    });
    actionMessage.value = `Atendimento de ${conversation.contact.label} assumido.`;
    await loadInbox(true);
    await selectConversation(conversation.id);
  } catch (cause) {
    if (/** @type {any} */ (cause)?.status === 409) {
      error.value =
        'Este handoff já foi assumido ou mudou. A Caixa de Entrada foi atualizada.';
      await refreshInbox(true);
    } else {
      error.value = describeError(cause);
    }
  } finally {
    busy.value = false;
  }
}

/**
 * PCX-13: the one way to take a conversation, whichever state it is in:
 * claiming the pending handoff (atomic on the server, ADR 009) or taking it
 * from the agent. Once it is yours the reply field appears and takes the
 * focus; the outcome is announced in the status above the conversation.
 */
async function takeOver() {
  const conversation = active.value;
  if (!conversation || !needsTakeover.value || busy.value) return;
  if (pendingHandoff.value) {
    await claimHandoff();
  } else {
    await changeAutomation(
      'takeover',
      `Atendimento de ${conversation.contact.label} assumido.`,
    );
  }
  if (activeId.value !== conversation.id) return;
  await nextTick();
  const field = /** @type {HTMLTextAreaElement|null} */ (replyInput.value);
  if (canReply.value && field && !field.disabled) {
    field.focus();
  } else if (!takeoverButton.value?.isConnected) {
    // The bar left without handing over the reply (someone else took it):
    // the reader lands on the conversation instead of the page body.
    conversationHeading.value?.focus();
  }
}

async function openRename() {
  if (!active.value) return;
  draftName.value = active.value?.contact.displayName ?? '';
  renameBase.value = {
    contactId: active.value.contact.id,
    conversationId: active.value.id,
    expectedVersion: active.value.contact.version,
  };
  renameConflict.value = false;
  renameCurrentKnown.value = false;
  error.value = '';
  renaming.value = true;
  await nextTick();
  nameInput.value?.focus();
}

async function refreshConflictName() {
  const base = renameBase.value;
  if (!base) return;
  try {
    const response = await request(
      `/api/v1/inbox/conversations/${encodeURIComponent(base.conversationId)}`,
    );
    if (
      renameBase.value !== base ||
      activeId.value !== base.conversationId ||
      response.data.conversation?.contact?.id !== base.contactId
    )
      return;
    detail.value = response.data;
    renameCurrentKnown.value = true;
  } catch {
    renameCurrentKnown.value = false;
  }
}

async function cancelRename() {
  const base = renameBase.value;
  const hadConflict = renameConflict.value;
  renaming.value = false;
  renameBase.value = null;
  renameConflict.value = false;
  renameCurrentKnown.value = false;
  if (hadConflict && base && activeId.value === base.conversationId) {
    await selectConversation(base.conversationId, true);
  }
  await nextTick();
  renameTrigger.value?.focus();
}

async function saveName() {
  const base = renameBase.value;
  if (
    !base ||
    active.value?.id !== base.conversationId ||
    busy.value ||
    renameConflict.value
  )
    return;
  busy.value = true;
  error.value = '';
  actionMessage.value = '';
  try {
    await request(
      `/api/v1/contacts/${encodeURIComponent(base.contactId)}/name`,
      {
        body: {
          displayName: draftName.value.trim(),
          expectedVersion: base.expectedVersion,
          reason: 'Nome do contato ajustado na Caixa de Entrada',
        },
        method: 'POST',
      },
    );
    actionMessage.value = 'Nome do contato atualizado.';
    renaming.value = false;
    renameBase.value = null;
    await loadInbox(true);
    await nextTick();
    renameTrigger.value?.focus();
  } catch (cause) {
    if (Number(cause?.status) === 409) {
      renameConflict.value = true;
      await refreshConflictName();
      await nextTick();
      nameInput.value?.focus();
    } else {
      error.value = describeError(cause);
    }
  } finally {
    busy.value = false;
  }
}

function clearSearch() {
  query.value = '';
  void nextTick(() => searchInput.value?.focus());
}

/**
 * Live events arrive in bursts (a takeover bumps the conversation and queues a
 * message). Collapse them into a single silent refresh so the panel never
 * flickers or stampedes the read model.
 */
function scheduleLiveRefresh() {
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  refreshTimer = globalThis.setTimeout(async () => {
    refreshTimer = 0;
    const orderChanged = orderChangedLive;
    orderChangedLive = false;
    await refreshInbox(true);
    // Together with the refreshed header, so the summary reads once.
    if (orderChanged) orderRevision.value += 1;
  }, LIVE_REFRESH_DELAY_MS);
}

watch(query, () => void selectVisibleConversation(false));
// A shortcut or the sheet may change both filters at once: one read.
watch([stateTab, queueFilter], () => void refreshInbox());
watch(
  () => props.conversationId,
  async (id, previous) => {
    if (id) {
      await selectConversation(
        id,
        id === activeId.value && Boolean(detail.value),
      );
      // On a phone the list gives way to the conversation; focus follows it.
      if (isSinglePane()) {
        await nextTick();
        conversationHeading.value?.focus();
      }
      return;
    }
    await selectVisibleConversation(false);
    if (isSinglePane() && previous) {
      await nextTick();
      /** @type {HTMLElement|null} */ (
        globalThis.document.querySelector(
          `.conversation-row[data-conversation-id="${CSS.escape(previous)}"]`,
        )
      )?.focus();
    }
  },
);
watch(
  () => [
    activeId.value,
    detail.value?.messages?.length,
    detailLoading.value,
    subjectState.value.subjects.length,
    subjectState.value.links.length,
  ],
  () => void anchorThread(),
  { flush: 'post' },
);
watch(liveEvent, (event) => {
  if (!event) return;
  // PLI-08: an order changed elsewhere; Detalhes › Pedido reads it again.
  if (event.reset || event.type === 'inbox.order.changed') {
    orderChangedLive = true;
  }
  scheduleLiveRefresh();
});
watch(liveConnection, (state, previous) => {
  if (state === 'conectado' && previous !== 'conectado') {
    void refreshInbox(true);
  }
});
onMounted(() => {
  phoneQuery?.addEventListener('change', phoneChanged);
  heading.value?.focus();
  void refreshInbox();
  void loadAssignableUsers();
  waitingClockTimer = globalThis.setInterval(() => {
    now.value = new Date();
  }, 30_000);
});
onBeforeUnmount(() => {
  /** @type {any} */ (filterSheet.value)?.close();
  contextDialog.value?.close();
  contactDialog.value?.close();
  contactController?.abort();
  phoneQuery?.removeEventListener('change', phoneChanged);
  listController?.abort();
  listEpoch += 1;
  appendController?.abort();
  appendController = undefined;
  countController?.abort();
  detailController?.abort();
  deliveryCheckController?.abort();
  subjectController?.abort();
  if (refreshTimer) globalThis.clearTimeout(refreshTimer);
  globalThis.clearInterval(waitingClockTimer);
});
</script>

<template>
  <div
    class="page inbox-page"
    :data-view="workspaceView"
    :data-expanded="conversationExpanded || undefined"
  >
    <h1 ref="heading" class="inbox-title" tabindex="-1">Caixa de Entrada</h1>
    <div class="inbox-toolbar">
      <!-- PCX-18: horizontal shortcuts; official queues and urgency are preserved. -->
      <div class="inbox-tabs" role="group" aria-label="Atalhos da Caixa">
        <button
          v-for="shortcut in SHORTCUTS"
          :key="shortcut.value"
          type="button"
          class="inbox-tab"
          :aria-pressed="activeShortcut === shortcut.value"
          @click="selectShortcut(shortcut)"
        >
          <span class="inbox-tab-label">{{ shortcut.label }}</span>
          <span
            v-if="shortcutCount(shortcut.value) !== null"
            class="inbox-tab-count"
            :data-tone="
              shortcut.value === 'waiting' && shortcutCount(shortcut.value) > 0
                ? 'attention'
                : undefined
            "
            >{{ shortcutCount(shortcut.value) }}</span
          >
        </button>
      </div>

      <button
        ref="filtersButton"
        type="button"
        class="soft inbox-filters-button"
        aria-haspopup="dialog"
        aria-label="Filtros"
        title="Filtrar conversas"
        :aria-expanded="filtersOpen"
        :data-active="activeFilters.length ? 'true' : undefined"
        @click="openFilters"
      >
        Filtros
        <span v-if="activeFilters.length" class="inbox-tab-count"
          >{{ activeFilters.length
          }}<span class="sr-only">
            {{ activeFilters.length === 1 ? 'ativo' : 'ativos' }}</span
          ></span
        >
      </button>

      <div
        v-if="activeFilters.length"
        class="inbox-active-filter"
        role="group"
        aria-labelledby="inbox-active-filter-label"
      >
        <span id="inbox-active-filter-label">Filtro:</span>
        <FilterChip
          v-for="filter in activeFilters"
          :key="filter.key"
          :label="filter.label"
          :remove-label="`Remover filtro ${filter.label}`"
          @remove="removeFilter(filter.key)"
        />
        <button
          v-if="activeFilters.length > 1"
          type="button"
          class="quiet"
          @click="clearFilters"
        >
          Limpar filtros
        </button>
      </div>
    </div>
    <Teleport to="#inbox-view-tools" defer>
      <button
        v-if="active && !isPhone"
        ref="expandToggle"
        type="button"
        class="quiet inbox-expand-toggle"
        :aria-label="
          conversationExpanded
            ? 'Mostrar lista de conversas'
            : 'Ampliar conversa'
        "
        :title="
          conversationExpanded
            ? 'Mostrar lista de conversas'
            : 'Ampliar conversa'
        "
        :aria-pressed="conversationExpanded"
        @click="toggleConversationWidth"
      >
        <AppIcon :name="conversationExpanded ? 'minimize' : 'maximize'" />
      </button>
    </Teleport>
    <FilterSheet
      ref="filterSheet"
      title="Filtrar conversas"
      @apply="applySheetFilters"
      @clear="clearSheetDraft"
      @close="filtersOpen = false"
    >
      <fieldset class="filter-sheet-group">
        <legend>Situação</legend>
        <label
          v-for="tab in STATE_TABS"
          :key="tab.value"
          class="filter-sheet-option"
        >
          <input
            v-model="draftTab"
            type="radio"
            name="inbox-situacao"
            :value="tab.value"
          />
          {{ tab.label }}
        </label>
      </fieldset>
      <fieldset class="filter-sheet-group">
        <legend>Responsável</legend>
        <label
          v-for="queue in QUEUE_FILTERS"
          :key="queue.value"
          class="filter-sheet-option"
        >
          <input
            v-model="draftQueue"
            type="radio"
            name="inbox-responsavel"
            :value="queue.value"
          />
          {{ queue.label }}
        </label>
      </fieldset>
    </FilterSheet>

    <div v-if="liveStatusMessage" class="inbox-notice inbox-live-notice">
      <p role="status">{{ liveStatusMessage }}</p>
      <button
        v-if="
          liveConnection === 'indisponível' || liveConnection === 'reconectando'
        "
        type="button"
        class="quiet"
        aria-label="Atualizar conversas"
        :disabled="loading"
        @click="refreshInbox()"
      >
        Atualizar
      </button>
    </div>
    <p v-if="listError" role="alert" class="inbox-notice" data-tone="error">
      {{ listError }}
    </p>

    <div
      class="inbox-workspace"
      :data-context="active && contextOpen ? 'open' : 'closed'"
    >
      <div class="inbox-list-pane">
        <div class="inbox-search" role="search">
          <label for="inbox-search" class="sr-only"
            >Buscar nas conversas exibidas</label
          >
          <div class="search-field">
            <AppIcon class="inbox-search-icon" name="search" />
            <input
              id="inbox-search"
              ref="searchInput"
              v-model="query"
              type="search"
              placeholder="Buscar contato, telefone ou mensagem"
              aria-describedby="inbox-search-help"
            />
            <button
              v-if="query"
              type="button"
              class="quiet"
              aria-label="Limpar busca"
              @click="clearSearch"
            >
              Limpar
            </button>
          </div>

          <AppHint id="inbox-search-help" class="inbox-search-hint"
            >Busca apenas nas conversas carregadas, por contato, telefone ou
            última mensagem.</AppHint
          >
        </div>

        <p
          ref="listSummary"
          class="inbox-list-summary"
          role="status"
          tabindex="-1"
        >
          {{ loading ? 'Carregando conversas…' : visibleConversationLabel }}
          <span v-if="!loading && stateTab === 'all'">
            · Mais urgentes primeiro</span
          >
          <span
            v-else-if="
              !loading && ['attention', 'closing', 'waiting'].includes(stateTab)
            "
          >
            · Maior espera primeiro</span
          >
        </p>
        <ul
          ref="conversationList"
          class="inbox-list"
          aria-label="Conversas"
          :aria-busy="loading || loadingMore"
        >
          <li v-for="conversation in filtered" :key="conversation.id">
            <button
              type="button"
              class="conversation-row"
              :data-conversation-id="conversation.id"
              :aria-current="activeId === conversation.id ? 'true' : undefined"
              @click="openConversation(conversation.id)"
            >
              <span class="conv-top">
                <span class="conv-name" :title="conversation.contact.label">{{
                  conversation.contact.label
                }}</span>
                <span
                  v-if="conversation.state === 'nova' && !conversation.handoff"
                  class="conv-new"
                  >Nova</span
                >
                <span
                  v-if="waitingFor(conversation)"
                  class="conv-waiting"
                  :title="`Aguardando desde ${dateTimeBR(conversationWaitingSince(conversation))}`"
                  ><span class="sr-only">Espera: </span
                  >{{ waitingFor(conversation) }}</span
                >
              </span>
              <span
                class="conv-next-action"
                :data-tone="nextAction(conversation).tone || undefined"
                ><AppIcon
                  v-if="nextAction(conversation).tone === 'error'"
                  name="alert"
                /><AppIcon
                  v-else-if="nextAction(conversation).tone === 'warning'"
                  name="alert"
                />{{ nextAction(conversation).label }}</span
              >
            </button>
          </li>
          <li v-if="nextCursor || moreNeedsRefresh" class="empty-list">
            <p v-if="moreError" role="alert">{{ moreError }}</p>
            <button
              ref="moreConversationsButton"
              type="button"
              class="quiet"
              :aria-disabled="loading || loadingMore ? 'true' : undefined"
              @click="loadMoreConversations"
            >
              {{
                moreNeedsRefresh
                  ? 'Atualizar lista'
                  : loadingMore
                    ? 'Carregando mais conversas…'
                    : 'Ver mais conversas'
              }}
            </button>
          </li>
          <li v-if="!loading && !filtered.length" class="empty-list">
            <template v-if="query">
              <h2>Nenhuma conversa encontrada</h2>
              <p>Revise a busca informada.</p>
            </template>
            <!-- PCX-14: nothing matches the filter, which is not an empty Inbox. -->
            <template v-else-if="filteredByChoice">
              <h2>Nenhuma conversa com esse filtro</h2>
              <p>Volte para todas as conversas ou escolha outro filtro.</p>
              <button type="button" @click="clearFilters">
                Limpar filtros
              </button>
            </template>
            <template v-else>
              <h2>Nenhuma conversa por enquanto</h2>
              <p>Quando um cliente escrever, a conversa aparece aqui.</p>
            </template>
          </li>
        </ul>
      </div>

      <section
        class="inbox-conversation"
        :aria-labelledby="active ? `conversation-${active.id}` : undefined"
        :aria-label="active ? undefined : 'Conversa selecionada'"
      >
        <div v-if="error || actionMessage" class="inbox-pane-notices">
          <p v-if="error" role="alert" class="inbox-notice" data-tone="error">
            {{ error }}
          </p>
          <p v-if="actionMessage" role="status" class="inbox-notice">
            {{ actionMessage }}
          </p>
        </div>

        <template v-if="active">
          <header class="conv-head">
            <RouterLink class="conv-back" to="/inbox" title="Conversas">
              <AppIcon name="back" /><span class="sr-only">Conversas</span>
            </RouterLink>
            <div class="conv-title">
              <div class="conv-title-row">
                <h2
                  :id="`conversation-${active.id}`"
                  :aria-label="active.contact.label"
                  ref="conversationHeading"
                  tabindex="-1"
                >
                  <button
                    type="button"
                    class="conv-contact-name"
                    :aria-label="`Dados de ${active.contact.label}`"
                    @click="openContact"
                  >
                    <span>{{ active.contact.label }}</span
                    ><AppIcon name="chevron-down" />
                  </button>
                </h2>
                <!-- PCX-10: the order is a place to go, not a status dressed
                     as a button. The status reads as text in its badge; with
                     no order nothing shows here (Detalhes › Pedido says so). -->
                <RouterLink
                  v-if="headerOrder"
                  ref="orderLink"
                  class="conv-order-link"
                  :to="orderPath"
                  :aria-label="orderLinkLabel"
                >
                  <span class="conv-order-number"
                    >Pedido {{ headerOrder.number }}</span
                  >
                  <span
                    class="badge"
                    :data-tone="
                      headerOrder.status === 'confirmado'
                        ? 'success'
                        : 'warning'
                    "
                    >{{ orderStatusLabel(headerOrder.status) }}</span
                  >
                </RouterLink>
              </div>
              <p class="conv-identity">
                {{ CHANNEL_LABELS[active.channel] }} ·
                {{ serviceLabel }}
              </p>
            </div>
            <!-- No primary here: the conversation's one primary action sits
                 in the composer, "Assumir atendimento" or "Enviar resposta"
                 (PCX-13). Two visible at most, the rest under "Mais"
                 (pesquisa UX, achado 1). ADR 015: once a person has the
                 conversation it never goes back to the bot, so there is no
                 hand-back action here. -->
            <div class="conv-actions">
              <button
                v-if="needsTakeover"
                ref="takeoverButton"
                type="button"
                class="primary"
                aria-describedby="takeover-reason"
                :aria-disabled="busy ? 'true' : undefined"
                :aria-busy="busy ? 'true' : undefined"
                @click="takeOver"
              >
                Assumir atendimento
              </button>
              <button
                v-if="createOrderInHeader"
                ref="orderCreateTrigger"
                type="button"
                :aria-disabled="orderCreating || busy ? 'true' : undefined"
                :aria-busy="orderCreating ? 'true' : undefined"
                @click="createOrder()"
              >
                Criar pedido
              </button>
              <div
                v-if="hasMoreActions"
                class="conv-more"
                @keydown.esc.stop="closeMore(true)"
              >
                <button
                  ref="moreToggle"
                  type="button"
                  aria-label="Mais ações"
                  title="Mais ações"
                  aria-controls="conv-more-menu"
                  :aria-expanded="moreOpen"
                  @click="toggleMore"
                >
                  <AppIcon name="more" />
                </button>
                <AnchoredPopover
                  v-model:open="moreOpen"
                  :anchor="moreToggle"
                  label="Mais ações"
                  role="group"
                  id="conv-more-menu"
                  class="conv-more-panel"
                >
                  <div ref="moreMenu" class="conv-more-items">
                    <p class="conv-more-label">Atendimento</p>
                    <button
                      v-if="createOrderInMore"
                      type="button"
                      :aria-disabled="
                        orderCreating || busy ? 'true' : undefined
                      "
                      @click="createOrder(true)"
                    >
                      Criar pedido
                    </button>
                    <button
                      v-if="canTransfer"
                      type="button"
                      :disabled="busy"
                      @click="openTransfer"
                    >
                      <AppIcon name="transfer" />Transferir atendimento
                    </button>
                    <button
                      v-if="canArchiveActive"
                      type="button"
                      :disabled="busy"
                      @click="requestArchiveConfirmation"
                    >
                      <AppIcon name="archive" />Arquivar conversa
                    </button>
                    <button
                      v-if="canUnarchive"
                      type="button"
                      :disabled="busy"
                      @click="
                        closeMore(true);
                        unarchiveConversation();
                      "
                    >
                      <AppIcon name="archive" />Desarquivar conversa
                    </button>
                    <button
                      v-if="canClose"
                      type="button"
                      class="conv-more-danger"
                      :disabled="busy"
                      @click="requestCloseFromMore"
                    >
                      <AppIcon name="close-circle" />Encerrar conversa
                    </button>
                  </div>
                </AnchoredPopover>
              </div>
              <button
                ref="contextToggle"
                type="button"
                class="quiet conv-context-toggle"
                title="Detalhes do atendimento"
                aria-label="Detalhes do atendimento"
                aria-controls="inbox-context"
                :aria-expanded="contextOpen"
                @click="toggleContext()"
              >
                <AppIcon name="panel" />
                <span class="sr-only">Detalhes</span>
              </button>
            </div>
          </header>

          <div
            v-if="needsTakeover || pendingHandoff"
            class="inbox-takeover handoff-reason"
          >
            <div id="takeover-reason" class="inbox-takeover-reason">
              <strong>{{ takeoverReason.title }}</strong>
              <span>{{ takeoverReason.detail }}</span>
              <AssistantTakeoverContext
                v-if="!pendingHandoff && active.automationState === 'assistant'"
                :conversation-id="active.id"
                :revision="active.updatedAt ?? ''"
              />
            </div>
          </div>

          <p v-if="!canAct && !isTerminal" class="inbox-notice">
            Esta conversa está sob responsabilidade de outro vendedor. Só quem
            atende ou um administrador pode agir.
          </p>
          <p v-if="active.archivedAt" class="inbox-notice">
            Conversa arquivada. Uma nova mensagem do cliente a devolve à Caixa
            de Entrada.
          </p>

          <form
            v-if="transferring"
            class="transfer-form"
            @submit.prevent="confirmTransfer"
          >
            <label :for="`transfer-${active.id}`"
              >Transferir atendimento para</label
            >
            <select
              :id="`transfer-${active.id}`"
              ref="transferSelect"
              v-model="transferTarget"
            >
              <option
                v-for="user in transferOptions"
                :key="user.id"
                :value="user.id"
              >
                {{ user.name }}
              </option>
            </select>
            <div class="inline-actions">
              <button
                type="submit"
                class="primary"
                :disabled="busy || !transferTarget"
              >
                Confirmar transferência
              </button>
              <button type="button" :disabled="busy" @click="cancelTransfer">
                Cancelar
              </button>
            </div>
            <p v-if="!transferOptions.length">
              Nenhum outro vendedor disponível para receber o atendimento.
            </p>
          </form>

          <ConversationHandoffSummary
            :conversation-id="active.id"
            :handoff="active.handoff ?? null"
          />

          <p v-if="deliveryCheckNotice" role="status" class="inbox-notice">
            {{ deliveryCheckNotice }}
          </p>
          <p
            v-if="deliveryCheckError"
            role="alert"
            class="inbox-notice"
            data-tone="error"
          >
            {{ deliveryCheckError }}
          </p>

          <div v-if="detailLoading" class="loading-state thread" role="status">
            Carregando histórico…
          </div>
          <!-- A scrollable history must be reachable by keyboard (WCAG 2.1.1). -->
          <ol
            v-else
            ref="thread"
            class="thread"
            aria-label="Histórico da conversa"
            tabindex="0"
            @scroll.passive="threadScrolled"
            @load.capture="anchorThread"
          >
            <li
              v-for="message in detail.messages"
              :key="message.id"
              class="message"
              :data-message-id="message.id"
              tabindex="-1"
              :data-from="messageFrom(message)"
              :data-side="message.direction === 'outbound' ? 'out' : 'in'"
            >
              <div class="msg-head">
                <span class="msg-sender">
                  <span class="message-avatar" aria-hidden="true">{{
                    messageInitials(message)
                  }}</span>
                  <strong class="msg-author">{{
                    messageAuthorLabel(message)
                  }}</strong>
                  <span v-if="messageRoleLabel(message)" class="msg-role">{{
                    messageRoleLabel(message)
                  }}</span>
                </span>
                <time
                  class="msg-time"
                  :datetime="message.occurredAt"
                  :title="dateTimeBR(message.occurredAt)"
                  >{{ messageWhen(message.occurredAt) }}</time
                >
              </div>
              <p
                v-if="
                  !message.media &&
                  !['audio', 'image', 'video'].includes(message.type) &&
                  messageCaption(message)
                "
              >
                {{ messageCaption(message) }}
              </p>
              <div
                v-if="canQuoteShipping && message.direction === 'inbound'"
                class="inline-actions"
              >
                <button
                  v-for="postalCode in messagePostalCodes(message.preview)"
                  :key="postalCode"
                  type="button"
                  @click="shippingQuote?.open($event.currentTarget, postalCode)"
                >
                  Cotar para CEP {{ postalCode }}
                </button>
              </div>
              <MediaMessage
                v-if="
                  message.media ||
                  (message.direction === 'inbound' && message.type === 'image')
                "
                :media="
                  message.media ?? {
                    mediaId: message.id,
                    kind: 'image',
                    state: 'missing',
                    contentUrl: null,
                  }
                "
                :orders="
                  message.direction === 'inbound' ? imageAttachmentOrders : []
                "
              />
              <p
                v-if="
                  (message.media ||
                    ['audio', 'image', 'video'].includes(message.type)) &&
                  messageCaption(message)
                "
                class="message-media-caption"
              >
                {{ messageCaption(message) }}
              </p>
              <small v-if="message.deliveryMode === 'dev'"
                >DEV: envio simulado</small
              >
              <MessageDeliveryNotice
                :message="message"
                :checking="Boolean(deliveryCheckingId)"
                :check-failed="deliveryCheckFailedId === message.id"
                @check="checkMessageDelivery(message.id)"
              />
              <!-- CP-16/UXA-01: no control on every message. The question
                   sits only on the message the agent stopped on, for whoever
                   has the conversation; the others read why it waits. -->
              <fieldset
                v-if="showsSubjectQuestion(message)"
                :id="`subject-question-${message.id}`"
                class="subject-question"
              >
                <legend>A qual pedido esta mensagem se refere?</legend>
                <div class="subject-question-options">
                  <button
                    v-for="subject in subjectState.subjects"
                    :key="subject.id"
                    type="button"
                    :aria-disabled="subjectBusy ? 'true' : undefined"
                    @click="answerMessageSubject(message.id, [subject.id])"
                  >
                    {{ subjectLabel(subject) }}
                  </button>
                  <button
                    v-if="subjectState.subjects.length > 1"
                    type="button"
                    :aria-expanded="Boolean(subjectManyOpen[message.id])"
                    :aria-controls="`subject-many-${message.id}`"
                    @click="toggleSubjectMany(message.id)"
                  >
                    Mais de um
                  </button>
                  <button
                    type="button"
                    :aria-disabled="subjectBusy ? 'true' : undefined"
                    @click="answerMessageSubject(message.id, 'separate')"
                  >
                    Separar como novo assunto
                  </button>
                  <button
                    type="button"
                    :aria-disabled="subjectBusy ? 'true' : undefined"
                    @click="answerMessageSubject(message.id, [])"
                  >
                    Nenhum pedido
                  </button>
                  <button
                    v-if="subjectCorrecting[message.id]"
                    type="button"
                    class="quiet"
                    @click="cancelSubjectCorrection(message.id)"
                  >
                    Cancelar
                  </button>
                </div>
                <div
                  v-if="subjectManyOpen[message.id]"
                  :id="`subject-many-${message.id}`"
                  class="subject-question-many"
                >
                  <label
                    v-for="subject in subjectState.subjects"
                    :key="subject.id"
                  >
                    <input
                      v-model="messageSubjectDrafts[message.id]"
                      type="checkbox"
                      :value="subject.id"
                    />
                    {{ subjectLabel(subject) }}
                  </label>
                  <button
                    type="button"
                    :aria-disabled="subjectBusy ? 'true' : undefined"
                    @click="answerMessageSubject(message.id, 'marked')"
                  >
                    Ligar aos marcados
                  </button>
                </div>
                <p
                  v-if="subjectAnswerErrors[message.id]"
                  class="subject-question-error"
                  role="alert"
                >
                  {{ subjectAnswerErrors[message.id] }}
                </p>
              </fieldset>
              <p
                v-else-if="subjectReviewIds.has(message.id) && !isTerminal"
                class="subject-question-hint"
              >
                O agente não soube a qual pedido esta mensagem se refere.
                {{
                  needsTakeover
                    ? 'Assuma o atendimento para indicar.'
                    : 'Aguardando o vendedor indicar o pedido.'
                }}
              </p>
              <p v-if="messageSubjectChip(message)" class="subject-chip">
                <span :id="`subject-chip-${message.id}`">{{
                  messageSubjectChip(message)
                }}</span>
                <button
                  v-if="canAnswerSubjects && !subjectCorrecting[message.id]"
                  :id="`subject-correct-${message.id}`"
                  type="button"
                  class="link-button"
                  :aria-describedby="`subject-chip-${message.id}`"
                  @click="correctMessageSubject(message.id)"
                >
                  Corrigir
                </button>
              </p>
              <!-- UXA-05: the answer is confirmed where it was given. -->
              <p
                v-if="subjectAnswers[message.id]"
                :id="`subject-answer-${message.id}`"
                class="subject-answer"
                role="status"
                tabindex="-1"
              >
                {{ subjectAnswers[message.id] }}
              </p>
            </li>
            <li v-if="!detail.messages.length" class="empty-list">
              Sem mensagens persistidas.
            </li>
          </ol>

          <ConversationOrderAssistance
            :key="active.id"
            :details-target="assistanceDetailsTarget"
            :details-open="contextOpen && contextTab === 'orders'"
            :conversation-id="active.id"
            :can-manage="canCreateOrder"
            :messages="detail?.messages ?? []"
            :refresh-key="`${active.version}:${liveEvent?.receivedAt ?? ''}:${detail?.messages?.length ?? 0}`"
            @created="orderSuggestedCreated"
            @changed="refreshInbox(true)"
            @evidence="revealOrderEvidence"
            @review="
              contextTab = 'orders';
              toggleContext(true);
            "
          />

          <div v-if="!needsTakeover" class="inbox-composer">
            <!-- PCX-13: until a person has the conversation, taking it is the
                 one action where the reply would be, with why it stopped and
                 for how long (PCX-03). -->
            <AudioRecorder
              v-if="!needsTakeover"
              :key="active.id"
              :conversation-id="active.id"
              :expected-version="active.version"
              :disabled="busy || !canReply || active.channel === 'site_chat'"
              @sending-change="mediaSending = $event"
              @sent="mediaSent"
            >
              <template #tools="{ disabled: quoteDisabled }">
                <ConversationShippingQuote
                  v-if="canQuoteShipping"
                  ref="shippingQuote"
                  :key="`shipping-${active.id}`"
                  :conversation-id="active.id"
                  :subjects="subjectState.subjects"
                  :disabled="quoteDisabled || busy || mediaSending || !canReply"
                  :has-draft="Boolean(reply.trim())"
                  :revision="orderRevision"
                  @draft="addShippingDraft"
                />
              </template>
              <template #message="{ recordingActive }">
                <form
                  id="inbox-reply-form"
                  class="composer"
                  @submit.prevent="sendReply"
                >
                  <label for="reply" class="sr-only">Responder</label>

                  <textarea
                    id="reply"
                    ref="replyInput"
                    v-model="reply"
                    rows="1"
                    placeholder="Escreva uma mensagem…"
                    maxlength="2000"
                    :disabled="
                      busy || mediaSending || recordingActive || !canReply
                    "
                    aria-describedby="reply-help"
                    @keydown="replyKeydown"
                  ></textarea>
                  <p
                    id="reply-help"
                    class="composer-help"
                    :class="{ 'sr-only': canReply }"
                  >
                    <template v-if="isTerminal"
                      >A conversa está encerrada.</template
                    >
                    <template v-else-if="!canAct"
                      >Somente o vendedor responsável pode responder.</template
                    >
                    <template v-else-if="!canReply"
                      >Assuma o atendimento antes de responder.</template
                    >
                    <template v-else-if="touchInput"
                      >Toque em Enviar resposta para enviar.</template
                    >
                    <template v-else
                      >Enter envia · Shift+Enter quebra a linha.</template
                    >
                  </p>
                </form>
              </template>
              <template #send="{ recordingActive }">
                <button
                  type="submit"
                  form="inbox-reply-form"
                  class="primary"
                  aria-label="Enviar resposta"
                  :title="
                    touchInput
                      ? 'Enviar resposta'
                      : 'Enviar resposta · Enter envia; Shift+Enter quebra a linha'
                  "
                  :disabled="
                    busy ||
                    mediaSending ||
                    recordingActive ||
                    !canReply ||
                    !reply.trim()
                  "
                >
                  <AppIcon name="send" />
                  <span class="sr-only">Enviar resposta</span>
                </button>
              </template>
            </AudioRecorder>
          </div>
        </template>
        <div v-else-if="detailLoading" class="loading-state" role="status">
          Carregando conversa…
        </div>
        <div v-else class="empty-list inbox-empty" aria-live="polite">
          <h2 id="inbox-empty-title">Selecione uma conversa</h2>
          <p>O histórico, a resposta e as ações aparecerão aqui.</p>
        </div>
      </section>

      <dialog
        v-if="active"
        ref="contextDialog"
        id="inbox-context"
        class="inbox-context"
        aria-labelledby="inbox-context-title"
        @close="contextOpen = false"
        @click="closeDrawerOnBackdrop"
      >
        <div class="inbox-context-head">
          <h2 id="inbox-context-title" tabindex="-1">Atendimento</h2>
          <button
            type="button"
            class="quiet"
            aria-label="Recolher detalhes"
            @click="toggleContext(false)"
          >
            <AppIcon name="close" />
          </button>
        </div>

        <div
          class="context-tabs"
          role="group"
          aria-label="Seções do atendimento"
        >
          <button
            type="button"
            :aria-pressed="contextTab === 'orders'"
            @click="contextTab = 'orders'"
          >
            Pedidos e assuntos
          </button>
          <button
            type="button"
            :aria-pressed="contextTab === 'summary'"
            @click="contextTab = 'summary'"
          >
            Resumo
          </button>
        </div>
        <div v-show="contextTab === 'orders'">
          <div ref="assistanceDetailsTarget" class="context-assistance" />
          <ConversationOrderSummary
            :conversation-id="active.id"
            :order="headerOrder"
            :read-by-id="
              Boolean(headerOrder && headerOrder.id !== active.order?.id)
            "
            :open="contextOpen"
            :revision="orderRevision"
          />

          <section class="subject-panel" aria-labelledby="subject-panel-title">
            <!-- UXA-04: the seller's words, and what each action changes. -->
            <h3 id="subject-panel-title" ref="subjectHeading" tabindex="-1">
              Assuntos do atendimento
            </h3>
            <p v-if="subjectError" role="alert">{{ subjectError }}</p>
            <p v-if="subjectNotice" role="status">{{ subjectNotice }}</p>
            <p v-if="!subjectState.subjects.length" class="op-hint">
              Ainda não há assunto classificado. As mensagens permanecem no
              histórico.
            </p>
            <ul v-else class="subject-list">
              <li v-for="subject in subjectState.subjects" :key="subject.id">
                <span>{{ subjectLabel(subject) }}</span>
                <strong v-if="subject.isCurrent" class="badge" data-tone="info"
                  >Em foco</strong
                >
                <button
                  v-else-if="canClose"
                  type="button"
                  :aria-label="`Usar este: fazer o agente usar ${subjectLabel(subject)}`"
                  :disabled="subjectBusy"
                  @click="subjectCommand('select', subject.id)"
                >
                  Usar este
                </button>
              </li>
            </ul>
            <button
              v-if="canClose"
              type="button"
              class="subject-add-toggle"
              :aria-expanded="subjectActionsOpen"
              aria-controls="subject-add-actions"
              @click="subjectActionsOpen = !subjectActionsOpen"
            >
              Adicionar assunto
            </button>
            <div
              v-if="canClose"
              v-show="subjectActionsOpen"
              id="subject-add-actions"
              class="subject-actions"
            >
              <button
                type="button"
                :disabled="subjectBusy"
                @click="subjectCommand('create')"
              >
                Novo assunto sem pedido
              </button>
              <form
                class="subject-order-search"
                @submit.prevent="loadSubjects(active.id)"
              >
                <label :for="`subject-order-query-${active.id}`">
                  Buscar pedido pelo número
                </label>
                <input
                  :id="`subject-order-query-${active.id}`"
                  v-model="subjectOrderQuery"
                  type="search"
                  maxlength="40"
                  autocomplete="off"
                />
                <button type="submit" :disabled="subjectBusy">Buscar</button>
              </form>
              <label :for="`subject-order-${active.id}`">Vincular pedido</label>
              <select
                :id="`subject-order-${active.id}`"
                v-model="selectedSubjectOrderId"
              >
                <option value="">Selecione um pedido</option>
                <option
                  v-for="order in availableSubjectOrders"
                  :key="order.id"
                  :value="order.id"
                >
                  {{ order.number }} · {{ orderStatusLabel(order.status) }}
                </option>
              </select>
              <button
                type="button"
                :disabled="subjectBusy || !selectedSubjectOrderId"
                @click="subjectCommand('create', selectedSubjectOrderId)"
              >
                Criar assunto do pedido
              </button>
            </div>
            <p v-if="subjectState.ordersHasMore" class="op-hint">
              Há mais pedidos deste cliente. Busque pelo número para localizar o
              pedido desejado.
            </p>
          </section>
        </div>
        <section
          v-show="contextTab === 'summary'"
          class="context-section"
          aria-label="Resumo do atendimento"
        >
          <dl class="context-facts">
            <div>
              <dt>Responsável</dt>
              <dd>{{ ownerLabel }}</dd>
            </div>
            <div>
              <dt>Canal</dt>
              <dd>{{ CHANNEL_LABELS[active.channel] }}</dd>
            </div>
            <div>
              <dt>Atendimento</dt>
              <dd>{{ serviceLabel }}</dd>
            </div>
            <div v-if="active.closureOutcome">
              <dt>Encerramento</dt>
              <dd>
                {{
                  active.closureOutcome === 'concluido'
                    ? 'Atendimento concluído'
                    : 'Sem pedido neste atendimento'
                }}
                · {{ dateTimeBR(active.terminalAt) }}
              </dd>
            </div>
          </dl>
          <details
            v-if="detail?.messages?.some((message) => message.transcript)"
            class="context-transcripts"
          >
            <summary>Transcrições automáticas</summary>
            <div
              v-for="message in detail.messages.filter(
                (entry) => entry.transcript,
              )"
              :key="message.id"
              :data-message-id="message.id"
              class="context-transcript-entry"
            >
              <time :datetime="message.occurredAt">{{
                dateTimeBR(message.occurredAt)
              }}</time>
              <MessageTranscript
                :message-id="message.id"
                :transcript="message.transcript"
              />
            </div>
          </details>
        </section>
      </dialog>
      <dialog
        v-if="active"
        ref="contactDialog"
        class="inbox-context inbox-contact"
        aria-labelledby="contact-drawer-title"
        @close="
          contactController?.abort();
          contactDetail = null;
          renaming = false;
        "
        @click="closeDrawerOnBackdrop"
      >
        <div class="inbox-context-head">
          <h2 id="contact-drawer-title">Cadastro</h2>
          <button
            type="button"
            class="quiet"
            aria-label="Fechar cadastro"
            @click="contactDialog?.close()"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <section class="context-section" aria-labelledby="context-client-title">
          <h3 id="context-client-title" class="sr-only">Dados do contato</h3>
          <p v-if="contactLoading" role="status">Carregando cadastro…</p>
          <div v-if="contactError" role="alert">
            <p>{{ contactError }}</p>
            <button type="button" @click="loadContactDetails">
              Tentar novamente
            </button>
          </div>
          <form v-if="renaming" class="rename-form" @submit.prevent="saveName">
            <label :for="`name-${active.id}`">Nome do contato</label>
            <input
              :id="`name-${active.id}`"
              ref="nameInput"
              v-model="draftName"
              type="text"
              maxlength="120"
              placeholder="Sem nome definido"
            />
            <div v-if="renameConflict" class="inbox-notice" role="alert">
              <p>O nome mudou enquanto você editava. Seu texto foi mantido.</p>
              <p v-if="renameCurrentKnown">
                Nome atual: {{ active.contact.label }}. Cancele e abra a edição
                novamente para revisar antes de salvar.
              </p>
              <p v-else>
                Não foi possível consultar o nome atual. Consulte novamente ou
                cancele para atualizar.
              </p>
              <button type="button" @click="refreshConflictName">
                Consultar nome atual
              </button>
            </div>
            <div class="inline-actions">
              <button
                type="submit"
                class="primary"
                :disabled="busy || renameConflict"
              >
                Salvar nome
              </button>
              <button type="button" :disabled="busy" @click="cancelRename">
                Cancelar
              </button>
            </div>
          </form>
          <dl v-else class="context-facts">
            <div>
              <dt>Nome</dt>
              <dd>{{ active.contact.label }}</dd>
            </div>
            <div>
              <dt>Telefone</dt>
              <dd>
                {{
                  formatPhoneNumber(
                    contactDetail?.phone ??
                      active.contact.phone ??
                      (active.channel === 'site_chat'
                        ? null
                        : active.contact.externalId),
                  )
                }}
                <small v-if="active.channel === 'site_chat'"
                  >telefone informado no site</small
                >
              </dd>
            </div>
            <div>
              <dt>E-mail</dt>
              <dd>{{ contactDetail?.email || 'Não informado' }}</dd>
            </div>
            <div v-if="contactDetail?.registration?.city">
              <dt>Cidade</dt>
              <dd>
                {{ contactDetail.registration.city }} ·
                {{ contactDetail.registration.state }}
              </dd>
            </div>
          </dl>
          <div v-if="!renaming" class="inline-actions">
            <button ref="renameTrigger" type="button" @click="openRename">
              Editar nome
            </button>
            <RouterLink
              class="button-link"
              :to="`/clientes/${encodeURIComponent(active.contact.id)}`"
            >
              Ver contato
            </RouterLink>
          </div>
        </section>
      </dialog>
    </div>
    <dialog
      ref="orderConfirmationDialog"
      class="command-dialog"
      aria-labelledby="order-confirmation-title"
      aria-describedby="order-confirmation-description"
      @cancel="orderCreating && $event.preventDefault()"
      @close="manualOrderConfirmation = null"
    >
      <form @submit.prevent="confirmManualOrder">
        <h2 id="order-confirmation-title">O cliente confirmou a compra?</h2>
        <p id="order-confirmation-description">
          Crie o pedido somente quando o cliente já tiver confirmado que quer
          fechar esta compra. Pedir orçamento ou informações não é uma
          confirmação. Os dados coletados serão aproveitados no pedido pendente.
        </p>
        <p
          v-if="manualOrderError"
          ref="manualOrderErrorNotice"
          role="alert"
          tabindex="-1"
        >
          {{ manualOrderError }}
        </p>
        <div class="inline-actions">
          <button
            type="button"
            :disabled="orderCreating"
            @click="orderConfirmationDialog?.close()"
          >
            Cancelar
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="orderCreating"
            :aria-busy="orderCreating ? 'true' : undefined"
          >
            {{
              orderCreating
                ? 'Criando pedido…'
                : 'Cliente confirmou, criar pedido'
            }}
          </button>
        </div>
      </form>
    </dialog>
    <dialog
      ref="closeConfirmationDialog"
      class="command-dialog"
      aria-labelledby="close-confirmation-title"
      aria-describedby="close-confirmation-description"
    >
      <form @submit.prevent="confirmClose">
        <h2 id="close-confirmation-title">Encerrar conversa?</h2>
        <p id="close-confirmation-description">
          Este atendimento será encerrado. Uma nova mensagem do cliente abrirá
          outra conversa, preservando o histórico e os pedidos.
        </p>
        <fieldset>
          <legend>Motivo do encerramento</legend>
          <label>
            <input v-model="closureOutcome" type="radio" value="concluido" />
            Atendimento concluído
          </label>
          <label>
            <input v-model="closureOutcome" type="radio" value="sem_pedido" />
            Sem pedido neste atendimento
          </label>
        </fieldset>
        <p v-if="closeError" role="alert">{{ closeError }}</p>
        <label v-if="hasPendingOrder">
          <input v-model="acknowledgePending" type="checkbox" required />
          Há um pedido pendente. Confirmo que desejo encerrar esta conversa sem
          alterar o pedido.
        </label>
        <div class="inline-actions">
          <button type="button" @click="closeConfirmationDialog?.close()">
            Cancelar
          </button>
          <button type="submit" class="primary" :disabled="busy">
            Encerrar conversa
          </button>
        </div>
      </form>
    </dialog>
    <dialog
      ref="archiveConfirmationDialog"
      class="command-dialog"
      aria-labelledby="archive-confirmation-title"
      aria-describedby="archive-confirmation-description"
    >
      <form @submit.prevent="confirmArchive">
        <h2 id="archive-confirmation-title">Arquivar conversa?</h2>
        <p id="archive-confirmation-description">
          A conversa sairá da Caixa de Entrada, mas não será apagada. Se o
          cliente enviar uma nova mensagem, ela voltará a aparecer.
        </p>
        <div class="inline-actions">
          <button type="button" @click="archiveConfirmationDialog?.close()">
            Cancelar
          </button>
          <button type="submit" class="primary" :disabled="busy">
            Arquivar conversa
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
