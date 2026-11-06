import { sizePricingSummary } from './size-pricing-composition.js';
import {
  OrderConflictError,
  OrderInputError,
  OrderValidationError,
} from './errors.js';
import { hasArtworkOrigin, ITEM_REQUIRED_FIELDS } from './ficha.js';

// ADR 006: an order is `pendente` (unofficial draft) or `confirmado`
// (official). The only way forward is a human confirmation and the only way
// back is a reopen; payment, production, time and the agent never move it.

export const ORDER_STATUSES = Object.freeze(
  /** @type {const} */ (['pendente', 'confirmado']),
);
export const PAYMENT_CONDITIONS = Object.freeze(
  /** @type {const} */ (['pix', 'cartao_credito', 'cartao_debito']),
);
// ADR 008: the two days of the order trail that only a person knows.
export const MILESTONE_FIELDS = Object.freeze(
  /** @type {const} */ (['paidOn', 'deliveredOn']),
);
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

// D00.6-05: the operation runs on São Paulo time; timestamps persist in UTC.
const OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';
const orderDateFormat = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: OPERATIONAL_TIME_ZONE,
  year: 'numeric',
});

/**
 * @typedef {typeof ORDER_STATUSES[number]} OrderStatus
 * @typedef {typeof PAYMENT_CONDITIONS[number]} PaymentCondition
 * @typedef {import('./ficha.js').Ficha} Ficha
 * ADRs 027 and 028: a store order (`origin` `loja`) has no conversation, may
 * be a test (`isTest`), carries the shop's number (`LJ-…`) and the lead time
 * of its colour, and keeps the payment InfinitePay confirmed. Every other
 * order has these empty. ADR 031: a store order also records the first
 * print of its ficha (when and by which user); absent or null means it was
 * never printed.
 *
 * @typedef {{
 *   id: string, number: string, numberSequence: number,
 *   conversationId: string|null, contactId?: string|null,
 *   manualOwnerId?: string|null, manualCreateKey?: string|null,
 *   status: OrderStatus, fabCode: string,
 *   cancelledAt?: string|null, cancelledBy?: string|null,
 *   cancellationReason?: string|null,
 *   origin: 'atendimento'|'loja', isTest: boolean,
 *   storeNumber: string|null, leadTimeBusinessDays: number|null,
 *   gatewayPayment: import('./store-order.js').GatewayPayment|null,
 *   fichaFirstPrintedAt?: string|null, fichaFirstPrintedBy?: string|null,
 *   legacySizePricing?: import('./size-pricing.js').SizePriceGroup[],
 *   ficha: Ficha, totalPieces: number, missingFields: string[],
 *   finalAmountCents: number|null, paymentCondition: PaymentCondition|null,
 *   orderDate: string|null, confirmedAt: string|null, confirmedBy: string|null,
 *   reopenedAt: string|null, reopenedBy: string|null,
 *   firstContactAt: string|null, paidOn: string|null, deliveredOn: string|null,
 *   paymentReviewRequired?: boolean,
 *   createdByKind: 'automation'|'user', createdBy: string|null,
 *   version: number, createdAt: string, updatedAt: string,
 * }} Order
 */

/**
 * The calendar day of an instant in São Paulo, as the trail stores it.
 *
 * @param {Date} instant
 */
export function operationalDay(instant) {
  return orderDateFormat.format(instant);
}

/**
 * The Painel's periods: today, the last seven days (today included) and the
 * month so far, all on São Paulo days.
 */
export const SUMMARY_PERIODS = Object.freeze(
  /** @type {const} */ (['hoje', '7dias', 'mes']),
);

/**
 * @param {string} day YYYY-MM-DD
 * @param {number} days
 */
export function shiftDay(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * The first and last day (inclusive) of a Painel period, read on the
 * operation's clock so "hoje" is the São Paulo day, not the UTC one.
 *
 * @param {typeof SUMMARY_PERIODS[number]} key
 * @param {Date} now
 */
export function summaryPeriod(key, now) {
  if (!SUMMARY_PERIODS.includes(key)) {
    throw new OrderInputError('period is invalid', ['period']);
  }
  const today = operationalDay(now);
  const from =
    key === 'hoje'
      ? today
      : key === '7dias'
        ? shiftDay(today, -6)
        : `${today.slice(0, 8)}01`;
  return Object.freeze({
    from,
    key,
    timeZone: OPERATIONAL_TIME_ZONE,
    to: today,
  });
}

/**
 * The day an order promised to deliver: the ficha's confirmed delivery. A
 * store order (ADR 028) carries only its colour's lead time, never a
 * promised day, so it has none.
 *
 * @param {Pick<Order, 'origin'|'ficha'>} order
 * @returns {string|null}
 */
export function promisedDeliveryOn(order) {
  if (order.origin === 'loja') return null;
  const day = order.ficha?.summary?.data_entrega_confirmada;
  return isCalendarDay(day) ? /** @type {string} */ (day) : null;
}

/** @param {number} sequence */
export function formatOrderNumber(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new TypeError('order number sequence must be a positive integer');
  }
  return `${String(sequence).padStart(2, '0')}-CRM`;
}

/** @param {unknown} now */
function requireClock(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

/** @param {{actorId: string, now: Date}} input */
function requireActorAndClock({ actorId, now }) {
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new TypeError('actorId is required');
  }
  requireClock(now);
}

/** @param {Order} order @param {OrderStatus} expected @param {string} command */
function requireStatus(order, expected, command) {
  requireActiveOrder(order);
  if (order.status !== expected) {
    throw new OrderConflictError(
      `Only ${expected} orders can be ${command}`,
      'ORDER_STATUS_CONFLICT',
    );
  }
}

/** A local cancellation is terminal without changing the commercial status.
 * @param {{cancelledAt?: string|null}} order */
export function requireActiveOrder(order) {
  if (order.cancelledAt) {
    throw new OrderConflictError(
      'Cancelled orders are terminal',
      'ORDER_CANCELLED',
    );
  }
}

/**
 * The principal points an item still lacks, as `items[N].<field>`. A size
 * line always carries a quantity above zero, so the grade stands for both the
 * sizes and the quantity.
 *
 * @param {Record<string, unknown>} item @param {number} index
 */
function itemGaps(item, index) {
  const principalGaps = ITEM_REQUIRED_FIELDS.filter((key) => {
    const value = item?.[key];
    if (key === 'grade') return !Array.isArray(value) || value.length === 0;
    if (key === 'malhas') {
      return (
        !Array.isArray(value) ||
        !value.some((entry) => typeof entry === 'string' && entry.trim() !== '')
      );
    }
    return typeof value !== 'string' || value.trim() === '';
  }).map((key) => `items[${index}].${key}`);
  return principalGaps;
}

/**
 * A real calendar day written the way the date picker stores it (ISO).
 *
 * @param {unknown} value
 */
function isCalendarDay(value) {
  const match = typeof value === 'string' ? ISO_DAY.exec(value) : null;
  if (!match) return false;
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return day.toISOString().slice(0, 10) === value;
}

/**
 * ADR 016/020 (replaces A01): generating the order needs at least one item,
 * the principal points of every item (technique included), who makes the
 * art, the promised delivery, the final amount and the payment method. The
 * other item fields, the rest of the summary and the other days of the trail
 * stay as the seller leaves them. Confirmation and settlement are separate;
 * the paid day never blocks confirmation. OLIST-T21 additionally requires
 * complete reviewed size subtotals; no caller-supplied total is authoritative.
 *
 * @param {{ficha: {items: readonly Record<string, any>[], summary: Record<string, unknown>, artwork?: Record<string, unknown>}}} order
 * @param {unknown} amountCents
 * @param {unknown} paymentCondition
 * @returns {string[]} `items`, `items[N].<field>`, `artwork`,
 *   `summary.data_entrega_confirmada`, `finalAmount` and `paymentCondition`,
 *   in that order
 */
function confirmationBlockers(order, amountCents, paymentCondition) {
  const { artwork, items, summary } = order.ficha;
  const blockers =
    items.length === 0
      ? ['items']
      : items.flatMap((item, index) => itemGaps(item, index));
  if (!hasArtworkOrigin(artwork)) blockers.push('artwork');
  if (!isCalendarDay(summary?.data_entrega_confirmada)) {
    blockers.push('summary.data_entrega_confirmada');
  }
  if (
    !Number.isSafeInteger(amountCents) ||
    /** @type {number} */ (amountCents) <= 0
  ) {
    blockers.push('finalAmount');
  }
  if (
    !PAYMENT_CONDITIONS.includes(
      /** @type {PaymentCondition} */ (paymentCondition),
    )
  ) {
    blockers.push('paymentCondition');
  }
  return blockers;
}

/**
 * PFI-09: what still keeps a pending order from being generated. A
 * confirmed order lacks nothing.
 *
 * @param {Pick<Order, 'status'|'ficha'|'finalAmountCents'|'paymentCondition'|'legacySizePricing'>} order
 * @returns {string[]}
 */
export function missingForConfirmation(order) {
  if (order.status === 'confirmado') return [];
  return pricingConfirmationBlockers(order, order.paymentCondition);
}

/** Server-only legacy composition, never merged into the persisted ficha.
 * @param {Pick<Order, 'ficha'|'legacySizePricing'>} order */
function pricingFicha(order) {
  return order.ficha.sizePricing === undefined && order.legacySizePricing
    ? { ...order.ficha, sizePricing: order.legacySizePricing }
    : order.ficha;
}

/** @param {Pick<Order, 'ficha'|'finalAmountCents'|'legacySizePricing'>} order @param {unknown} condition */
function pricingConfirmationBlockers(order, condition) {
  const ficha = pricingFicha(order);
  const pricing =
    ficha.sizePricing === undefined ? null : sizePricingSummary(ficha);
  if (
    order.ficha.sizePricing === undefined &&
    order.legacySizePricing &&
    pricing?.complete &&
    pricing.totalCents !== order.finalAmountCents
  ) {
    throw new OrderValidationError(
      'A composição deve preservar o total histórico.',
      'SIZE_PRICING_AMOUNT_MISMATCH',
      ['priceBreakdown'],
    );
  }
  const fields = confirmationBlockers(
    order,
    pricing?.totalCents ?? null,
    condition,
  );
  if (!pricing) fields.push('sizePricing');
  else
    fields.push(
      ...pricing.issues.map((issue) =>
        ['sizePricing', issue.groupId, issue.lineId].filter(Boolean).join('.'),
      ),
    );
  return [...new Set(fields)];
}

/**
 * @param {Order} order
 * @param {{amountCents?: number, paymentCondition: PaymentCondition, actorId: string, now: Date}} input
 * @returns {Order}
 */
export function confirmOrder(order, input) {
  requireActorAndClock(input);
  requireStatus(order, 'pendente', 'confirmed');
  const blockers = pricingConfirmationBlockers(order, input.paymentCondition);
  if (blockers.length > 0) {
    throw new OrderValidationError(
      'The order is not ready to be confirmed',
      'ORDER_NOT_CONFIRMABLE',
      blockers,
    );
  }
  const amountCents = /** @type {number} */ (
    sizePricingSummary(pricingFicha(order)).totalCents
  );
  if (input.amountCents !== undefined && input.amountCents !== amountCents) {
    throw new OrderValidationError(
      'O valor declarado difere da soma dos subtotais.',
      'SIZE_PRICING_AMOUNT_MISMATCH',
      ['finalAmount'],
    );
  }
  const confirmedAt = input.now.toISOString();
  return {
    ...structuredClone(order),
    confirmedAt,
    confirmedBy: input.actorId,
    finalAmountCents: amountCents,
    // FINQ-18: an earlier settlement never proves payment of a new price.
    paidOn:
      order.finalAmountCents !== null && order.finalAmountCents !== amountCents
        ? null
        : order.paidOn,
    ...(order.finalAmountCents !== null &&
    order.finalAmountCents !== amountCents
      ? { paymentReviewRequired: false }
      : {}),
    missingFields: [],
    orderDate: orderDateFormat.format(input.now),
    paymentCondition: input.paymentCondition,
    status: 'confirmado',
    updatedAt: confirmedAt,
  };
}

/**
 * @param {Order} order
 * @param {{actorId: string, now: Date}} input
 * @returns {Order}
 */
export function reopenOrder(order, input) {
  requireActorAndClock(input);
  requireStatus(order, 'confirmado', 'reopened');
  const reopenedAt = input.now.toISOString();
  const reopened = /** @type {Order} */ ({
    ...structuredClone(order),
    reopenedAt,
    reopenedBy: input.actorId,
    status: 'pendente',
    updatedAt: reopenedAt,
  });
  return { ...reopened, missingFields: missingForConfirmation(reopened) };
}

/**
 * A manual day of the trail is null while nobody has recorded it, or a
 * calendar day that has already come in São Paulo.
 *
 * @param {unknown} value @param {string} today
 */
function isMilestoneDay(value, today) {
  if (value === null) return true;
  return isCalendarDay(value) && /** @type {string} */ (value) <= today;
}

/**
 * ADR 008: when the customer paid and when the order reached them. A person
 * records both, pending or confirmed, without reopening: neither moves the
 * status nor blocks the confirmation (PCL-08), so a printed ficha stays valid.
 *
 * @param {Order} order
 * @param {{paidOn: unknown, deliveredOn: unknown, now: Date}} input
 * @returns {Order}
 */
export function recordMilestones(order, input) {
  requireActiveOrder(order);
  requireClock(input.now);
  const today = orderDateFormat.format(input.now);
  const invalid = MILESTONE_FIELDS.filter(
    (field) => !isMilestoneDay(input[field], today),
  );
  if (invalid.length > 0) {
    throw new OrderValidationError(
      'Use a calendar day that has already come',
      'INVALID_DATE',
      invalid,
    );
  }
  return {
    ...structuredClone(order),
    deliveredOn: /** @type {string|null} */ (input.deliveredOn),
    paidOn: /** @type {string|null} */ (input.paidOn),
    updatedAt: input.now.toISOString(),
  };
}
