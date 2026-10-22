/**
 * Reading and writing an order in the browser (ADR 006). The amount rules
 * mirror `modules/orders/src/domain/money.js` on purpose: edge-web ships no
 * runtime dependencies, so the seller gets the error next to the field before
 * the request instead of a round trip. The server stays the authority — it
 * parses the text again and answers 422 INVALID_AMOUNT when the two disagree.
 */

// PFI-11: thousands in groups of three separated by dots, cents after a
// comma. "4,820.00" is a different number, so it is refused, never guessed.
const BRL_AMOUNT = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}|\d))?$/u;

const ORDER_STATUS_LABELS = Object.freeze({
  confirmado: 'Confirmado',
  pendente: 'Pendente',
});

export const PAYMENT_CONDITION_OPTIONS = Object.freeze([
  Object.freeze({ label: 'Pix', value: 'pix' }),
  Object.freeze({ label: 'Cartão de crédito', value: 'cartao_credito' }),
  Object.freeze({ label: 'Cartão de débito', value: 'cartao_debito' }),
]);

/** A03: every `reason_code` the CHECK of migrations 0013 and 0025 accepts. */
export const HANDOFF_REASON_LABELS = Object.freeze({
  briefing_complete: 'Pré-ficha completa',
  complaint: 'Reclamação',
  customer_requested_human: 'Pediu um vendedor',
  human_requested: 'Pediu um vendedor',
  iteration_limit: 'Limite de mensagens',
  low_confidence: 'Agente sem confiança',
  negotiation: 'Perguntou o valor',
  price_before_quote: 'Perguntou o valor',
  unresolved_blocker: 'Dado divergente',
  unsupported: 'Conteúdo não suportado',
  urgency: 'Urgência',
});

/**
 * The FAB as the ficha prints it. Codes arrive either bare ("01") or already
 * prefixed ("FAB 01"); both read "FAB 01".
 *
 * @param {unknown} code
 */
export function fabLabel(code) {
  const text = String(code ?? '').trim();
  if (text === '') return '—';
  return /^fab(?:\s|$)/iu.test(text) ? text.toUpperCase() : `FAB ${text}`;
}

/** PIM-01: why the button is locked, said in the place of the button. */
export const PRINT_LOCKED_REASON = 'Disponível depois de gerar o pedido';

// ADR 016/020: the seven points an item needs before the order is generated,
// named as the seller reads them ("cor do item 1"). The quantity is the sum
// of the sizes, so the sizes stand for it.
const ITEM_POINT_LABELS = Object.freeze({
  cor: 'cor',
  gola: 'gola',
  grade: 'tamanhos',
  // ADR 025 (D5): the fabric is "Modelo de malha" at Silmer.
  malhas: 'modelo de malha',
  tipo: 'tipo de roupa',
  tipo_servico: 'técnica',
});

// ADR 025 (D1): who an item is for, a closed list the API also enforces.
export const AUDIENCE_OPTIONS = Object.freeze([
  Object.freeze({ label: 'Masculino', value: 'masculino' }),
  Object.freeze({ label: 'Feminino', value: 'feminino' }),
  Object.freeze({ label: 'Infantil', value: 'infantil' }),
  Object.freeze({ label: 'Unissex', value: 'unissex' }),
]);

/** @param {unknown} value */
export function audienceLabel(value) {
  return AUDIENCE_OPTIONS.find((option) => option.value === value)?.label ?? '';
}

// What the bot records when the customer leaves a point to the seller.
const DEFERRED = 'definir com o vendedor';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** @param {unknown} status */
export function orderStatusLabel(status) {
  return (
    ORDER_STATUS_LABELS[
      /** @type {keyof typeof ORDER_STATUS_LABELS} */ (status)
    ] ?? 'Sem pedido'
  );
}

/** @param {unknown} condition */
export function paymentConditionLabel(condition) {
  return (
    PAYMENT_CONDITION_OPTIONS.find((option) => option.value === condition)
      ?.label ?? '—'
  );
}

/** @param {unknown} reasonCode */
export function handoffReasonLabel(reasonCode) {
  return (
    HANDOFF_REASON_LABELS[
      /** @type {keyof typeof HANDOFF_REASON_LABELS} */ (reasonCode)
    ] ?? 'Aguardando vendedor'
  );
}

/**
 * @param {unknown} text
 * @returns {number|null} integer cents > 0, or null when the text is not an
 *   amount this operation can charge.
 */
export function parseBrl(text) {
  if (typeof text !== 'string') return null;
  const match = BRL_AMOUNT.exec(text.trim());
  if (!match) return null;
  const reais = Number(match[1].replaceAll('.', ''));
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  const total = reais * 100 + cents;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** @param {unknown} cents @returns {string} e.g. `4.820,00`, or '' when unset */
export function formatBrl(cents) {
  if (!Number.isSafeInteger(cents) || Number(cents) <= 0) return '';
  const value = Number(cents);
  const reais = Math.trunc(value / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return `${reais},${String(value % 100).padStart(2, '0')}`;
}

/** PFI-11: the prefix is fixed; an order with no amount yet shows a dash. */
/** @param {unknown} cents */
export function amountLabel(cents) {
  const formatted = formatBrl(cents);
  return formatted === '' ? '—' : `R$ ${formatted}`;
}

/**
 * Parts of a sentence joined the Portuguese way: "a, b e c".
 *
 * @param {string[]} parts
 */
export function joinPt(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`;
}

/**
 * PIT-06: `missingFields` in plain words, in the order the server lists them.
 * An entry this screen does not know is shown as it is, so a new blocker
 * appears as a raw name instead of disappearing from the list.
 *
 * @param {unknown} missingFields
 * @returns {string[]}
 */
export function missingFieldLabels(missingFields) {
  if (!Array.isArray(missingFields)) return [];
  return missingFields.map((field) => missingFieldLabel(String(field)));
}

/** @param {string} field */
function missingFieldLabel(field) {
  if (field === 'items') return 'nenhum item';
  if (field === 'artwork') return 'quem faz a arte';
  if (field === 'summary.data_entrega_confirmada') return 'entrega prometida';
  if (field === 'finalAmount') return 'valor final';
  if (field === 'paymentCondition') return 'forma de pagamento';
  const item = /^items\[(\d+)\]\.(\w+)$/u.exec(field);
  if (item && Object.hasOwn(ITEM_POINT_LABELS, item[2])) {
    const label =
      ITEM_POINT_LABELS[
        /** @type {keyof typeof ITEM_POINT_LABELS} */ (item[2])
      ];
    return `${label} do item ${Number(item[1]) + 1}`;
  }
  return field;
}

/**
 * True for the entries that belong to the items, as opposed to the promised
 * delivery, the amount and the payment method.
 *
 * @param {string} field
 */
export function isItemGap(field) {
  return field === 'items' || field.startsWith('items[');
}

/**
 * True for what the seller fills elsewhere on the page — the items, who
 * makes the art and the promised delivery of the summary — as opposed to the
 * amount and the payment method entered in the "Gerar o pedido" dialog.
 *
 * @param {string} field
 */
export function isPageGap(field) {
  return field !== 'finalAmount' && field !== 'paymentCondition';
}

// PFI-15 (RFC 024): the steps to generate an order, in the order of the page.
// The amount and the payment method are typed when generating, not here.
const ORDER_STEPS = Object.freeze([
  {
    action: 'Informar entrega prometida',
    key: 'delivery',
    label: 'Entrega prometida',
    /** @param {string} field */
    owns: (field) => field === 'summary.data_entrega_confirmada',
    section: 'summary',
  },
  {
    action: 'Completar itens',
    key: 'items',
    label: 'Itens',
    owns: isItemGap,
    section: 'items',
  },
  {
    action: 'Marcar quem faz a arte',
    key: 'artwork',
    label: 'Arte do pedido',
    /** @param {string} field */
    owns: (field) => field === 'artwork',
    section: 'artwork',
  },
]);

/**
 * What a step still lacks, in the words of "Falta para gerar" (PIT-06).
 *
 * @param {string} key @param {string[]} gaps
 */
function stepGapText(key, gaps) {
  if (key === 'delivery') return 'a data combinada';
  if (key === 'artwork') return 'quem faz a arte';
  if (gaps.includes('items')) return 'ao menos um item';
  const labels = missingFieldLabels(gaps);
  if (labels.length <= 2) return joinPt(labels);
  const more = labels.length - 2;
  return `${labels[0]}, ${labels[1]} e mais ${more} ${more === 1 ? 'ponto' : 'pontos'}`;
}

/**
 * Where the step "Revisar pendências" leads: the closing panel, whose
 * "Falta para gerar" (#closing-readiness) names every blocker, known or not.
 * No section of the page fills a blocker this screen does not know.
 */
export const ORDER_REVIEW_SECTION = 'closing';

const REVIEW_STEP = Object.freeze({
  action: 'Revisar pendências',
  key: 'review',
  label: 'Outras pendências',
  section: ORDER_REVIEW_SECTION,
});

/** @param {string} field */
function isKnownStepGap(field) {
  return ORDER_STEPS.some((step) => step.owns(field));
}

/**
 * PFI-15: the three steps to generate an order, judged only by the server's
 * `missingFields` so the progress is never ahead of what the API accepts. A
 * blocker of the page that none of the three knows (a key newer than this
 * screen) becomes a fourth step, "Revisar pendências", never done while the
 * server lists it: otherwise the count would say "3 de 3" with "Gerar pedido"
 * still refused. The amount and the payment method are typed when generating
 * and never count. A store order (ADR 027) or an order without the list has
 * no steps.
 *
 * @param {Record<string, any>|null|undefined} order
 * @returns {{key: string, label: string, done: boolean, missing: string, section: string, action: string}[]}
 */
export function orderSteps(order) {
  if (!order || isStoreOrder(order) || !Array.isArray(order.missingFields)) {
    return [];
  }
  const missing = order.missingFields.map(String);
  const steps = ORDER_STEPS.map(({ owns, ...step }) => {
    const gaps = missing.filter(owns);
    return {
      ...step,
      done: gaps.length === 0,
      missing: gaps.length === 0 ? '' : `falta: ${stepGapText(step.key, gaps)}`,
    };
  });
  const unknown = missing.filter(
    (field) => isPageGap(field) && !isKnownStepGap(field),
  );
  if (unknown.length === 0) return steps;
  return [
    ...steps,
    {
      ...REVIEW_STEP,
      done: false,
      missing: `falta: ${stepGapText(REVIEW_STEP.key, unknown)}`,
    },
  ];
}

/**
 * PFI-15/PFI-16: the first step still missing, or null when all are done.
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function nextOrderStep(order) {
  return orderSteps(order).find((step) => !step.done) ?? null;
}

/**
 * PLI-05: one line for the Situação column and the drawer: the first two
 * points still missing, and how many more.
 *
 * @param {unknown} missingFields
 */
export function missingHeadline(missingFields) {
  const missing = Array.isArray(missingFields) ? missingFields.map(String) : [];
  if (missing.length === 0) return 'Pronto para confirmar';
  if (missing.includes('items')) return 'Nenhum item';
  const labels = missingFieldLabels(missing);
  if (labels.length <= 2) return `Falta ${joinPt(labels)}`;
  const more = labels.length - 2;
  return `Falta ${labels[0]}, ${labels[1]} e mais ${more} ${more === 1 ? 'ponto' : 'pontos'}`;
}

/** @param {Record<string, any>} item */
export function itemPieces(item) {
  return (Array.isArray(item?.grade) ? item.grade : []).reduce(
    /** @param {number} total @param {Record<string, any>} line */
    (total, line) =>
      total + (Number.parseInt(String(line.quantidade), 10) || 0),
    0,
  );
}

/**
 * PIT-01: "Item 1 · CAMISETA · 150 peças"; ADR 025 adds the audience when
 * there is one: "Item 2 · CAMISETA · Feminino · 10 peças".
 *
 * @param {Record<string, any>} item @param {number} index
 */
export function itemHeading(item, index) {
  const tipo = String(item?.tipo ?? '').trim() || '—';
  const audience = audienceLabel(item?.publico);
  return [`Item ${index + 1}`, tipo, audience, `${itemPieces(item)} peças`]
    .filter(Boolean)
    .join(' · ');
}

/**
 * ADR 025: the quantity the customer said for this item, when it holds one.
 *
 * @param {Record<string, any>} item
 * @returns {number|null}
 */
function itemInformed(item) {
  const value = Number(item?.quantidade_informada);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * ADR 025 (PIT-09 per item): the warning under an item whose sizes add up to
 * something other than what the customer said for it. It never blocks.
 *
 * @param {Record<string, any>} item
 */
export function itemQuantityWarning(item) {
  const informed = itemInformed(item);
  const pieces = itemPieces(item);
  if (informed === null || pieces <= 0 || informed === pieces) return '';
  return `A soma dos tamanhos (${pieces}) é diferente da quantidade informada (${informed})`;
}

/**
 * PIT-09: the quantity the customer told the bot, kept as service data. The
 * text is shown as it came; `count` is set only when it holds one whole
 * number, so "30 peças" compares and "entre 20 e 30" does not. A quantity
 * left to the seller is not one.
 *
 * @param {Record<string, any>} order
 * @returns {{text: string, count: number|null}|null}
 */
export function informedQuantity(order) {
  const value = order?.ficha?.serviceData?.quantity;
  let text = '';
  if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value.trim();
  if (text === '') return null;
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.!]+$/u, '');
  if (folded === DEFERRED) return null;
  const numbers = text.match(/\d+/gu) ?? [];
  const count = numbers.length === 1 ? Number(numbers[0]) : null;
  return {
    count:
      count !== null && Number.isSafeInteger(count) && count > 0 ? count : null,
    text,
  };
}

/**
 * PIT-09: the warning beside "Total de peças" when the sizes add up to
 * something other than what the customer said. It never blocks.
 *
 * @param {Record<string, any>} order
 */
export function quantityWarning(order) {
  const informed = informedQuantity(order);
  const total = Number(order?.totalPieces ?? 0);
  if (!informed || informed.count === null || total <= 0) return '';
  if (informed.count === total) return '';
  return `A soma dos tamanhos (${total}) é diferente da quantidade informada (${informed.count})`;
}

/**
 * PIT-09: an item's Quantidade — the sum of its sizes; with no sizes yet, the
 * quantity said for the item (ADR 025) or, on the first item (the one the bot
 * fills), the quantity said for the order.
 *
 * @param {Record<string, any>} item @param {number} index @param {Record<string, any>} order
 */
export function itemQuantityLabel(item, index, order) {
  const pieces = itemPieces(item);
  if (pieces > 0) return `${pieces} ${pieces === 1 ? 'peça' : 'peças'}`;
  const own = itemInformed(item);
  if (own !== null) return `— (cliente informou ${own})`;
  const informed = index === 0 ? informedQuantity(order) : null;
  return informed ? `— (cliente informou ${informed.text})` : '—';
}

/**
 * A02: how long the order has been still, counted from its last change. A
 * clock slightly ahead of the browser reads as "agora" rather than as a
 * negative age.
 *
 * @param {unknown} since @param {Date} [now]
 */
export function elapsedSince(since, now = new Date()) {
  if (typeof since !== 'string' || since === '') return '';
  const start = new Date(since);
  if (Number.isNaN(start.getTime())) return '';
  const elapsed = now.getTime() - start.getTime();
  if (elapsed < MINUTE_MS) return 'agora';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}min`;
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${String(minutes).padStart(2, '0')}min`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);
  return `${days}d ${String(hours).padStart(2, '0')}h`;
}

// D00.6-05: days are read on São Paulo time, whatever the browser's zone.
const OPERATIONAL_DAY = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
});
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * An ISO day (2026-10-24) the way the operation reads it (24/10/2026). Text
 * that is not an ISO day comes back as it was typed.
 *
 * @param {unknown} value
 */
export function dayLabel(value) {
  if (typeof value !== 'string') return '';
  const match = ISO_DAY.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value.trim();
}

/**
 * The São Paulo day of an instant, as an ISO day.
 *
 * @param {unknown} value
 */
export function operationalDay(value) {
  if (!(value instanceof Date) && typeof value !== 'string') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : OPERATIONAL_DAY.format(date);
}

/**
 * PLA-01..03, PLA-08 (ADR 008/017): the printed trail has three days.
 * Order date and promised delivery stay in the summary, so each of the five
 * business dates appears only once in the ficha.
 *
 * @param {Record<string, any>} order
 * @returns {{key: string, label: string, value: string, recorded: boolean, note: string}[]}
 */
export function orderMilestones(order) {
  const manual = order.origin === 'atendimento' && !order.conversationId;
  const steps = [
    {
      day: operationalDay(order.firstContactAt),
      emptyNote: 'sem registro',
      key: 'firstContact',
      label: 'Primeiro contato',
      recordedNote: manual ? 'criação do pedido' : 'vem da conversa',
    },
    {
      day: order.paidOn,
      emptyNote: 'a informar',
      key: 'paid',
      label: 'Pago em',
      recordedNote: 'informado',
    },
    {
      day: order.deliveredOn,
      emptyNote: manual ? 'a confirmar nos afazeres' : 'a informar',
      key: 'delivered',
      label: 'Entregue em',
      recordedNote: manual ? 'entrega confirmada' : 'informado',
    },
  ];
  return steps.map(({ day, emptyNote, key, label, recordedNote }) => {
    const value = dayLabel(day);
    return {
      key,
      label,
      note: value ? recordedNote : emptyNote,
      recorded: value !== '',
      value: value || '—',
    };
  });
}

// ADRs 027 and 028: an order from the site shop. It is born confirmed and
// locked; "Pago" is what InfinitePay confirmed through the n8n checkout.
export const STORE_ORIGIN_LABEL = 'Loja do site';

const SAO_PAULO_DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
});

/** @param {Record<string, any>|null|undefined} order */
export function isStoreOrder(order) {
  return order?.origin === 'loja';
}

/**
 * An instant as São Paulo reads it: "07/10/2026 às 23:15", or '' when there
 * is none.
 *
 * @param {unknown} value
 */
export function instantLabel(value) {
  if (typeof value !== 'string') return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const parts = Object.fromEntries(
    SAO_PAULO_DATE_TIME.formatToParts(instant).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}

/**
 * LOJ-22: "Pago — confirmado pela InfinitePay em 07/10/2026 às 23:15".
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function storePaymentLabel(order) {
  const at = instantLabel(order?.gatewayPayment?.confirmedAt);
  return at
    ? `Pago — confirmado pela InfinitePay em ${at}`
    : 'Pago — confirmado pela InfinitePay';
}

/**
 * LOJ-22: the kit's lead time — "Pronta entrega", "1 dia útil" or
 * "10 dias úteis"; '' when the order has none.
 *
 * @param {unknown} days
 */
export function leadTimeLabel(days) {
  if (!Number.isSafeInteger(days) || Number(days) < 0) return '';
  if (days === 0) return 'Pronta entrega';
  return days === 1 ? '1 dia útil' : `${days} dias úteis`;
}

/**
 * The receipt link of a store order, only when it is an https link (the API
 * accepted it from the InfinitePay hosts only).
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function storeReceiptUrl(order) {
  const url = order?.gatewayPayment?.receiptUrl;
  return typeof url === 'string' && url.startsWith('https://') ? url : '';
}

// ADR 031: how people read the site shop's product. The catalog name and slug
// stay as the order recorded them; the screen says "Camisa dry fit".
const STORE_PRODUCT_LABELS = Object.freeze({
  'camisa-masculina-lisa': 'Camisa dry fit',
});

/**
 * ADR 031 (LOJ-35): the product of a store order as the screen names it.
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function storeProductLabel(order) {
  const produto = order?.ficha?.loja?.produto;
  const slug = typeof produto?.slug === 'string' ? produto.slug : '';
  if (Object.hasOwn(STORE_PRODUCT_LABELS, slug)) {
    return STORE_PRODUCT_LABELS[
      /** @type {keyof typeof STORE_PRODUCT_LABELS} */ (slug)
    ];
  }
  return typeof produto?.nome === 'string' ? produto.nome.trim() : '';
}

/** @param {unknown} value */
function saoPauloParts(value) {
  if (typeof value !== 'string') return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return Object.fromEntries(
    SAO_PAULO_DATE_TIME.formatToParts(instant).map((part) => [
      part.type,
      part.value,
    ]),
  );
}

/**
 * ADR 031: "07/10/2026, 23:15" as São Paulo reads it; '' when there is none.
 *
 * @param {unknown} value
 */
export function dateTimeLabel(value) {
  const parts = saoPauloParts(value);
  return parts
    ? `${parts.day}/${parts.month}/${parts.year}, ${parts.hour}:${parts.minute}`
    : '';
}

/**
 * ADR 031: "07/10, 23:15", for the Dashboard notice.
 *
 * @param {unknown} value
 */
export function shortDateTimeLabel(value) {
  const parts = saoPauloParts(value);
  return parts
    ? `${parts.day}/${parts.month}, ${parts.hour}:${parts.minute}`
    : '';
}

/**
 * LOJ-33/LOJ-34: when the site confirmed the order — the instant InfinitePay
 * confirmed the Pix, else when the CRM recorded it.
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function storeConfirmationLabel(order) {
  const at = dateTimeLabel(
    order?.gatewayPayment?.confirmedAt ?? order?.confirmedAt,
  );
  return at
    ? `Confirmado pela loja do site · ${at}`
    : 'Confirmado pela loja do site';
}

/**
 * LOJ-26: a store order (not a test) whose ficha nobody printed yet.
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function storeFichaPending(order) {
  return isStoreOrder(order) && !order?.isTest && !order?.fichaFirstPrintedAt;
}

/**
 * LOJ-33/LOJ-34: "PDF gerado por Rose · 08/10/2026, 09:12", or '' while
 * nobody printed it.
 *
 * @param {Record<string, any>|null|undefined} order
 */
export function fichaPrintedLabel(order) {
  if (!order?.fichaFirstPrintedAt) return '';
  const who = order.fichaFirstPrintedBy?.name || 'equipe';
  const at = dateTimeLabel(order.fichaFirstPrintedAt);
  return at ? `PDF gerado por ${who} · ${at}` : `PDF gerado por ${who}`;
}

/**
 * LOJ-31: the Dashboard notice for N new site orders, the oldest paid at
 * `oldestPaidAt`; null when there is none.
 *
 * @param {unknown} count
 * @param {unknown} oldestPaidAt
 * @returns {{title: string, detail: string}|null}
 */
export function storeNoticeText(count, oldestPaidAt) {
  const total = Number(count);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const at = shortDateTimeLabel(oldestPaidAt);
  if (total === 1) {
    return {
      detail: at
        ? `Confirmado e pago por Pix em ${at}. Gere o PDF da ficha para começar a produção.`
        : 'Confirmado e pago por Pix. Gere o PDF da ficha para começar a produção.',
      title: '1 pedido novo do site',
    };
  }
  return {
    detail: at
      ? `Confirmados e pagos por Pix, o mais antigo em ${at}. Gere os PDFs das fichas para começar a produção.`
      : 'Confirmados e pagos por Pix. Gere os PDFs das fichas para começar a produção.',
    title: `${total} pedidos novos do site`,
  };
}

/**
 * Pesquisa UX 2026-10-15, achado 3: the promised delivery against today, on
 * São Paulo days. `date` is the short day ("24/10"), `relative` the distance
 * ("em 9 dias", "Amanhã", "Atrasada há 2 dias"), and `days` what the queue
 * sorts by — null when there is no ISO day to count from. A delivered order
 * stops counting: it reads "Entregue em 26/10" and is no longer late.
 *
 * @param {Record<string, any>|null|undefined} order @param {Date} [now]
 * @returns {{date: string, relative: string, tone: ''|'error'|'warning'|'info'|'success', days: number|null, overdue: boolean}}
 */
export function deliveryDue(order, now = new Date()) {
  const raw = order?.ficha?.summary?.data_entrega_confirmada;
  const delivered = ISO_DAY.exec(String(order?.deliveredOn ?? ''));
  const match = ISO_DAY.exec(typeof raw === 'string' ? raw : '');
  if (delivered) {
    return {
      date: match ? `${match[3]}/${match[2]}` : '—',
      days: null,
      overdue: false,
      relative: `Entregue em ${delivered[3]}/${delivered[2]}`,
      tone: 'success',
    };
  }
  if (!match) {
    const typed = typeof raw === 'string' ? raw.trim() : '';
    return {
      date: typed || 'Sem data',
      days: null,
      overdue: false,
      relative: '',
      tone: '',
    };
  }
  const today = ISO_DAY.exec(operationalDay(now));
  const days = today
    ? Math.round(
        (Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
          Date.UTC(Number(today[1]), Number(today[2]) - 1, Number(today[3]))) /
          DAY_MS,
      )
    : null;
  /** @type {''|'error'|'warning'|'info'} */
  let tone = '';
  let relative = '';
  if (days === null) relative = '';
  else if (days < 0) {
    relative = `Atrasada há ${-days} ${days === -1 ? 'dia' : 'dias'}`;
    tone = 'error';
  } else if (days === 0) {
    relative = 'Entrega hoje';
    tone = 'warning';
  } else if (days === 1) {
    relative = 'Amanhã';
    tone = 'warning';
  } else {
    relative = `em ${days} dias`;
    tone = days <= 7 ? 'info' : '';
  }
  return {
    date: `${match[3]}/${match[2]}`,
    days,
    overdue: days !== null && days < 0,
    relative,
    tone,
  };
}

// Pesquisa UX 2026-10-15, achado 4: the order the shop floor counts sizes in
// — babies by month, children by number, then the adult letters of the
// catalog and the plus sizes. A size outside this list keeps the place it
// was typed in, after the known ones.
const LETTER_SIZE_ORDER = Object.freeze([
  'PP',
  'P',
  'M',
  'G',
  'GG',
  'EG',
  'XG',
  'EGG',
  'XGG',
  'XX',
  'JEGAO',
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
]);

/** @param {unknown} size */
function sizeKey(size) {
  return String(size ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[‐-―]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** @param {unknown} size @returns {number} */
function sizeRank(size) {
  const key = sizeKey(size);
  const months = /^(\d{1,2}) ?- ?(\d{1,2}) ?MES(?:ES)?$/u.exec(key);
  if (months) return Number(months[1]) / 100;
  if (/^\d{1,2}$/u.test(key)) return 100 + Number(key);
  const letter = LETTER_SIZE_ORDER.indexOf(key);
  return letter === -1 ? Number.POSITIVE_INFINITY : 1000 + letter;
}

/**
 * The grade in canonical size order for reading, each line with the index
 * it has in the ficha. Editing keeps the typed order; only the screen sorts.
 *
 * @param {unknown} grade
 * @returns {{tamanho: string, quantidade: unknown, index: number}[]}
 */
export function sortedGrade(grade) {
  const lines = Array.isArray(grade) ? grade : [];
  return lines
    .map((line, index) => ({
      index,
      quantidade: line?.quantidade,
      rank: sizeRank(line?.tamanho),
      tamanho: String(line?.tamanho ?? ''),
    }))
    .sort((a, b) =>
      a.rank === b.rank ? a.index - b.index : a.rank < b.rank ? -1 : 1,
    )
    .map(({ index, quantidade, tamanho }) => ({ index, quantidade, tamanho }));
}

/**
 * The sizes written on more than one line of the same item ("M" and "m "
 * are the same size), in the order they first appear.
 *
 * @param {unknown} grade
 * @returns {string[]}
 */
export function duplicateSizes(grade) {
  const lines = Array.isArray(grade) ? grade : [];
  /** @type {Map<string, {label: string, count: number}>} */
  const seen = new Map();
  for (const line of lines) {
    const key = sizeKey(line?.tamanho);
    if (key === '') continue;
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { count: 1, label: String(line.tamanho).trim() });
  }
  return [...seen.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.label);
}

/**
 * The warning under an item whose grade repeats a size: the ficha would
 * print two lines for it and the floor could cut one of them twice.
 *
 * @param {unknown} grade
 */
export function duplicateSizeWarning(grade) {
  const repeated = duplicateSizes(grade);
  if (repeated.length === 0) return '';
  const named = joinPt(repeated);
  return repeated.length === 1
    ? `O tamanho ${named} aparece em mais de uma linha. Junte as quantidades numa linha só.`
    : `Os tamanhos ${named} aparecem em mais de uma linha. Junte as quantidades de cada um numa linha só.`;
}

/**
 * True when `size` is one of the sizes the grade repeats.
 *
 * @param {unknown} grade @param {unknown} size
 */
export function isDuplicateSize(grade, size) {
  const key = sizeKey(size);
  if (key === '' || !Array.isArray(grade)) return false;
  return grade.filter((line) => sizeKey(line?.tamanho) === key).length > 1;
}
