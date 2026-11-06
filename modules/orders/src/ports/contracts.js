import { OrderInputError } from '../domain/errors.js';
import { ORDER_STATUSES } from '../domain/order.js';
import { ORDER_ORIGINS } from '../domain/store-order.js';

/**
 * @typedef {import('../domain/order.js').Order} Order
 * @typedef {import('../domain/order.js').OrderStatus} OrderStatus
 * @typedef {import('../domain/ficha.js').Ficha} Ficha
 *
 * @typedef {{
 *   id: string, conversationId: string|null, contactId?: string|null,
 *   manualOwnerId?: string|null, manualCreateKey?: string|null,
 *   fabCode: string, ficha: Ficha,
 *   totalPieces: number, missingFields: string[],
 *   createdByKind: 'automation'|'user', createdBy: string|null,
 *   firstContactAt: string|null, correlationId: string, now: Date,
 *   actor?: {id: string, kind: string, capabilities?: readonly string[]},
 * }} CreatePendingOrderInput
 *
 * Human writes include `actor`; only technical briefing projection omits it.
 * @typedef {{expectedVersion: number, correlationId: string, paymentReviewed?:boolean, actor?: {id: string, kind: string, capabilities?: readonly string[]}, agentTarget?: {conversationId: string, orderId: string, subjectId: string, automationEpoch: number, sourceRevision: number, eventId: string, eventType: string, expectedSubjectVersion: number, expectedOrderVersion: number, recovery: boolean}}} OrderWriteOptions
 *
 * A search matches orders by exact number OR by conversation OR, for store
 * orders (ADRs 027 and 028), by the HMAC of the customer's phone or by the
 * shop's number (`LJ-…`); with none, every order matches. Customer and phone
 * search resolve outside this port, so no personal data is ever queried in
 * the clear. `origin` narrows the search. `owner` (Painel, "Meus pedidos")
 * narrows to one seller's orders, by the rule that names the seller: the
 * manual order they own, or an order of a conversation assigned to them.
 * `cancellation` selects active orders by default, cancelled history, or all;
 * adapters apply it before status counts, cursor comparison and pagination.
 * @typedef {{
 *   status?: OrderStatus, numberSequence?: number, conversationIds?: string[],
 *   contactIds?: string[],
 *   phoneDigests?: string[], storeNumber?: string,
 *   origin?: 'atendimento'|'loja', cursor?: string|null, limit: number,
 *   cancellation?: 'active'|'cancelled'|'all',
 *   owner?: {userId: string, conversationIds: string[]},
 * }} OrderListQuery
 *
 * ADR 028: the store order recorded by the n8n checkout workflow. The
 * receipt keeps the `pedido_id` (the natural key of a retry), the HMAC of
 * the phone (the list search) and the hash of the data a retry must repeat;
 * `audit` names who called, for the audit event of the same transaction.
 * @typedef {{actor: string, correlationId: string}} StoreAuditContext
 * @typedef {{
 *   order: ReturnType<typeof import('../domain/store-order.js').buildStoreOrder>,
 *   receipt: {requestId: string, phoneDigest: string, recordSha256: string},
 *   audit: StoreAuditContext, now: Date,
 * }} CreateStoreOrderInput
 * @typedef {{
 *   orderId: string, receiptUrl: string, audit: StoreAuditContext, now: Date,
 * }} AttachStoreReceiptInput
 * @typedef {{
 *   orderId: string, expectedVersion: number, expectedQuantity: number,
 *   expectedAmountCents: number, quantity: number, amountCents: number,
 *   marker: string,
 *   actor: {id: string, kind: string, capabilities?: readonly string[]},
 *   correlationId: string, now: Date,
 * }} CorrectStoreOrderInput
 * @typedef {{order: Order, recordSha256: string}} StoredStoreOrder
 *
 * - `findStoreOrder` reads the order of a `pedido_id`, with its hash.
 * - `createStoreOrder` writes the order, its receipt, an `order.created`
 *   event and the `store.order.create` audit in one transaction. The same
 *   `pedido_id` twice is `StoreOrderDuplicateError`; a `transaction_nsu`
 *   another order already holds is `409 STORE_ORDER_CONFLICT`.
 * - `attachStoreReceipt` stores the receipt link an order did not have,
 *   with an `order.receipt_attached` event and the
 *   `store.order.receipt_attached` audit; the same link again changes
 *   nothing, and another one is `409 STORE_ORDER_CONFLICT`.
 * @typedef {{
 *   findStoreOrder(requestId: string): Promise<StoredStoreOrder|null>,
 *   createStoreOrder(input: CreateStoreOrderInput): Promise<Order>,
 *   attachStoreReceipt(input: AttachStoreReceiptInput): Promise<{order: Order, attached: boolean}>,
 * }} StoreOrderRepository
 *
 * @typedef {{
 *   items: Order[], nextCursor: string|null,
 *   counts: {pendente: number, confirmado: number},
 * }} OrderPage
 *
 * ADR 031: the Dashboard figures. Sales and pieces count confirmed orders,
 * pending orders are counted apart, test and cancelled orders never count. `storeNewCount`
 * counts the store orders whose ficha was never printed and
 * `storeNewOldestPaidAt` is when InfinitePay confirmed the oldest of them
 * (null when there is none).
 * `period` (Painel) counts the confirmed orders whose order day falls in
 * `from`..`to` (São Paulo days, inclusive) and the amount they sold.
 * `daily` (PNL-05, "Vendido por dia") is the same universe grouped by order
 * day over `dailyFrom`..`dailyTo`, oldest first, with only the days that
 * sold: the service fills the empty ones.
 * @typedef {{day: string, confirmedCount: number, soldAmountCents: number}} OrdersSoldDay
 * @typedef {{
 *   confirmedCount: number, soldAmountCents: number,
 *   averageTicketCents: number, pendingCount: number,
 *   totalPiecesSold: number, storeNewCount: number,
 *   storeNewOldestPaidAt: string|null,
 *   period: {confirmedCount: number, soldAmountCents: number},
 *   daily: OrdersSoldDay[],
 * }} OrdersSummary
 *
 * @typedef {{from: string, to: string, dailyFrom: string, dailyTo: string}} OrdersSummaryQuery
 *
 * ADR 031: the first print of a store order's ficha, signed by a person.
 * @typedef {{
 *   orderId: string, actorId: string, correlationId: string, now: Date,
 * }} RecordFirstPrintInput
 *
 * Every write bumps `version` by one, refuses a stale `expectedVersion` with
 * VERSION_CONFLICT and appends an identifier-only `order.*` domain event in
 * the same unit of work. Only one active pending order may exist per conversation.
 *
 * - `saveSection`/`projectBriefing` write the ficha and its derived columns
 *   (`totalPieces`, `missingFields`, `updatedAt`) of a pending order only.
 *   For sizePricing compositions, also persist the calculated finalAmountCents
 *   (null while incomplete) and invalidate settlement on a changed known total.
 * - `saveStatus` writes the confirmation/reopen columns of the order and
 *   its ficha, so a generated order keeps the client it showed (ADR 018).
 * - `saveMilestones` writes the days of the trail (`paidOn`, `deliveredOn`,
 *   `updatedAt`). For manual orders the service preserves delivery while
 *   editing payment, and records delivery only after explicit confirmation.
 * - `recordFirstPrint` (ADR 031) records who printed a store order's ficha
 *   and when, only while nobody has: the first print bumps `version` and
 *   appends an `order.ficha_first_printed` event and the
 *   `order.ficha.first_print` audit; any later print, or an order that is
 *   not a store order, changes nothing and answers `recorded: false`.
 * - `openDeliveries` (Painel) reads, whole and unpaginated, the confirmed
 *   attendance orders nobody marked delivered (`deliveredOn` empty), test
 *   orders aside, so the promised day inside the ficha can be compared.
 *
 * @typedef {{
 *   orderId: string, expectedVersion: number, reason: string,
 *   actor: {id: string, kind: string, capabilities?: readonly string[]},
 *   correlationId: string, now: Date,
 * }} CancelOrderInput
 *
 * @typedef {{
 *   readFrozenOrderIds?(orders: Order[]): Promise<Set<string>>,
 *   readPriceBreakdowns?(orders: Order[]): Promise<Map<string, any>>,
 *   assertCancellationAccess?(input: CancelOrderInput, transaction?: any): Promise<Order>,
 *   cancelOrder?(input: CancelOrderInput, transaction?: any): Promise<Order>,
 *   assertPriceBreakdownAccess?(input: any): Promise<void>,
 *   savePriceBreakdown?(input: any, transaction?: any): Promise<any>,
 *   createPending(input: CreatePendingOrderInput): Promise<Order>,
 *   findById(orderId: string): Promise<Order|null>,
 *   findPendingByConversation(conversationId: string): Promise<Order|null>,
 *   listByConversation(conversationId: string): Promise<Order[]>,
 *   list(query: OrderListQuery): Promise<OrderPage>,
 *   summary(query: OrdersSummaryQuery): Promise<OrdersSummary>,
 *   openDeliveries(): Promise<Order[]>,
 *   recordFirstPrint(input: RecordFirstPrintInput): Promise<{recorded: boolean, order: Order}>,
 *   saveSection(order: Order, options: OrderWriteOptions): Promise<Order>,
 *   saveStatus(order: Order, options: OrderWriteOptions): Promise<Order>,
 *   saveMilestones(order: Order, options: OrderWriteOptions): Promise<Order>,
 *   projectBriefing(order: Order, options: OrderWriteOptions): Promise<Order>,
 * }} OrderRepository
 */

export const ORDER_REPOSITORY_METHODS = Object.freeze([
  'createPending',
  'findById',
  'findPendingByConversation',
  'listByConversation',
  'list',
  'summary',
  'openDeliveries',
  'saveSection',
  'saveStatus',
  'saveMilestones',
  'projectBriefing',
  'recordFirstPrint',
]);

export const MAX_ORDER_PAGE_SIZE = 100;
const STORE_NUMBER = /^LJ-[0-9A-F]{8}$/u;

/** @param {unknown} repository @returns {asserts repository is OrderRepository} */
export function assertOrderRepositoryContract(repository) {
  if (repository === null || typeof repository !== 'object') {
    throw new TypeError('order repository is required');
  }
  const candidate = /** @type {Record<string, unknown>} */ (repository);
  for (const method of ORDER_REPOSITORY_METHODS) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(`order repository must implement ${method}`);
    }
  }
}

/**
 * Validates the parts of a list query both adapters interpret identically.
 *
 * @param {OrderListQuery} query
 * @returns {{status: OrderStatus|undefined, numberSequence: number|undefined, conversationIds: string[]|undefined, contactIds: string[]|undefined, phoneDigests: string[]|undefined, storeNumber: string|undefined, origin: 'atendimento'|'loja'|undefined, owner: {userId: string, conversationIds: string[]}|undefined, cancellation: 'active'|'cancelled'|'all', after: {updatedAt: string, id: string}|null, limit: number}}
 */
export function readOrderListQuery(query) {
  const {
    cancellation = 'active',
    conversationIds,
    contactIds,
    cursor,
    limit,
    numberSequence,
    origin,
    owner,
    phoneDigests,
    status,
    storeNumber,
  } = query;
  if (!['active', 'cancelled', 'all'].includes(cancellation)) {
    throw new OrderInputError('cancellation is invalid', ['cancellation']);
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ORDER_PAGE_SIZE
  ) {
    throw new OrderInputError('limit is invalid', ['limit']);
  }
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    throw new OrderInputError('status is invalid', ['status']);
  }
  if (
    numberSequence !== undefined &&
    (!Number.isSafeInteger(numberSequence) || numberSequence <= 0)
  ) {
    throw new OrderInputError('number is invalid', ['q']);
  }
  if (
    conversationIds !== undefined &&
    (!Array.isArray(conversationIds) ||
      conversationIds.some((id) => typeof id !== 'string'))
  ) {
    throw new TypeError('conversationIds must be a list of ids');
  }
  if (
    contactIds !== undefined &&
    (!Array.isArray(contactIds) ||
      contactIds.some((id) => typeof id !== 'string'))
  ) {
    throw new TypeError('contactIds must be a list of ids');
  }
  if (
    phoneDigests !== undefined &&
    (!Array.isArray(phoneDigests) ||
      phoneDigests.some((digest) => typeof digest !== 'string'))
  ) {
    throw new TypeError('phoneDigests must be a list of digests');
  }
  if (storeNumber !== undefined && !STORE_NUMBER.test(storeNumber)) {
    throw new TypeError('storeNumber must be LJ- and eight hex digits');
  }
  if (origin !== undefined && !ORDER_ORIGINS.includes(origin)) {
    throw new OrderInputError('origin is invalid', ['origin']);
  }
  if (
    owner !== undefined &&
    (typeof owner?.userId !== 'string' ||
      owner.userId === '' ||
      !Array.isArray(owner.conversationIds) ||
      owner.conversationIds.some((id) => typeof id !== 'string'))
  ) {
    throw new TypeError('owner must name a user and their conversations');
  }
  return {
    cancellation,
    after:
      cursor === undefined || cursor === null ? null : decodeCursor(cursor),
    conversationIds,
    contactIds,
    limit,
    numberSequence,
    origin,
    owner,
    phoneDigests,
    status,
    storeNumber,
  };
}

/** @param {{updatedAt: string, id: string}} order */
export function encodeOrderCursor(order) {
  return Buffer.from(
    JSON.stringify([order.updatedAt, order.id]),
    'utf8',
  ).toString('base64url');
}

/** @param {unknown} cursor */
function decodeCursor(cursor) {
  try {
    if (typeof cursor !== 'string') throw new Error('cursor');
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[1] !== 'string' ||
      typeof decoded[0] !== 'string' ||
      Number.isNaN(Date.parse(decoded[0]))
    ) {
      throw new Error('cursor');
    }
    return { id: decoded[1], updatedAt: new Date(decoded[0]).toISOString() };
  } catch {
    throw new OrderInputError('cursor is invalid', ['cursor']);
  }
}

/** @param {OrderStatus} status */
export function statusEventType(status) {
  return status === 'confirmado' ? 'order.confirmed' : 'order.reopened';
}
