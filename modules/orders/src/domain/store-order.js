import { createHash } from 'node:crypto';

import { OrderConflictError, OrderError } from './errors.js';
import { blankArtwork, blankItem } from './ficha.js';
import { operationalDay, requireActiveOrder } from './order.js';
import {
  STORE_ACTOR_ID,
  STORE_PAYMENT_GATEWAY,
  STORE_PAYMENT_METHOD,
  storeProduct,
} from './store-catalog.js';

// ADR 028: the paid order of the site shop, as the n8n checkout workflow
// records it once InfinitePay confirms the Pix (`payment_check`). This module
// reads that record, checks it against the CRM's own catalog and builds the
// order, which is born official and stays locked (ADR 027). It decides
// nothing about who may call it (the automation route does) or how a retry
// is answered (the service does).

export const ORDER_ORIGINS = Object.freeze(
  /** @type {const} */ (['atendimento', 'loja']),
);
export const STORE_SCHEMA_VERSION = '1.0';
// The gateway's instant: a little ahead of the CRM's clock is skew; a month
// back still lets someone re-run a failed execution of the workflow.
export const PAID_AT_MAX_AGE_MS = 30 * 24 * 3_600_000;
export const PAID_AT_MAX_SKEW_MS = 5 * 60_000;
/** The only hosts a receipt link may point to (a closed list). */
export const STORE_RECEIPT_HOSTS = Object.freeze([
  'infinitepay.io',
  'infinitepay.com.br',
]);

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// The site's rule (Anatel numbering): 55, an area code without zero, then a
// mobile of nine digits starting with 9 or a landline of eight starting with
// 2 to 5.
const BRAZILIAN_PHONE = /^55[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/u;
const BRAZILIAN_CEP = /^(?!00000-000$)\d{5}-\d{3}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const GATEWAY_ID = /^[\x21-\x7e]{1,128}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_TEXT = 64;
const MAX_CENTS = 10_000_000;
const MAX_RECEIPT_URL = 2048;

const SHAPE = Object.freeze({
  cliente: ['nome', 'telefone'],
  entrega: ['cep', 'tipo'],
  item: ['cor_id', 'prazo_dias', 'quantidade', 'tamanho_id'],
  pagamento: [
    'forma',
    'gateway',
    'invoice_slug',
    'pago_em',
    'receipt_url',
    'transaction_nsu',
    'valor_pago_centavos',
  ],
  produto: ['slug'],
});
const TOP_KEYS = Object.freeze([
  'cliente',
  'item',
  'numero_loja',
  'pagamento',
  'pedido_id',
  'produto',
  'schema_version',
  'teste',
  'valor_centavos',
]);

/**
 * A refused record, in the n8n problem vocabulary: `code` is the
 * `error.code` of the problem+json answer, `statusCode` its HTTP status.
 */
export class StoreOrderError extends OrderError {
  /** @param {number} statusCode @param {string} code @param {string} [message] */
  constructor(statusCode, code, message = code) {
    super(message, code, statusCode);
  }
}

/**
 * The repository found the `pedido_id` already recorded while creating it: a
 * concurrent retry won the race. The service reads that order and answers
 * the retry from it.
 */
export class StoreOrderDuplicateError extends Error {
  constructor() {
    super('The store order was already recorded');
    this.name = 'StoreOrderDuplicateError';
  }
}

/**
 * @typedef {{
 *   requestId: string, storeNumber: string, test: boolean,
 *   product: {slug: string},
 *   item: {colorId: string, sizeId: string, quantity: number,
 *     leadTimeDays: number},
 *   amountCents: number,
 *   customer: {name: string, phone: string},
 *   delivery: {type: 'envio', cep: string}|null,
 *   payment: {gateway: string, method: string, transactionNsu: string,
 *     invoiceSlug: string, paidAmountCents: number, paidAt: string,
 *     receiptUrl: string|null},
 * }} StoreOrderRecord
 * @typedef {{
 *   telefone: string, produto: {slug: string, nome: string},
 *   comprovanteUrl: string|null,
 * }} StoreFicha
 * @typedef {{
 *   source: 'infinitepay', confirmedAt: string, paidAmountCents: number,
 *   transactionNsu: string, invoiceSlug: string,
 * }} GatewayPayment
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * An unknown key is UNKNOWN_REQUEST_FIELD; a missing one, or a value that is
 * not an object, INVALID_REQUEST — the same split the other n8n routes use.
 *
 * @param {unknown} value @param {readonly string[]} keys
 * @param {readonly string[]} [optionalKeys]
 */
function requireShape(value, keys, optionalKeys = []) {
  if (!isPlainObject(value)) throw new StoreOrderError(400, 'INVALID_REQUEST');
  const known = new Set([...keys, ...optionalKeys]);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new StoreOrderError(400, 'UNKNOWN_REQUEST_FIELD');
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  return value;
}

/** @param {unknown} value */
function requireText(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > MAX_TEXT ||
    CONTROL.test(value)
  ) {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  return value;
}

/** @param {unknown} value @param {number} min @param {number} max */
function requireInteger(value, min, max) {
  if (
    !Number.isSafeInteger(value) ||
    /** @type {number} */ (value) < min ||
    /** @type {number} */ (value) > max
  ) {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function requireGatewayId(value) {
  if (typeof value !== 'string' || !GATEWAY_ID.test(value)) {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  return value;
}

/**
 * ISO 8601 in UTC that names a real instant: `2026-02-30` or `24:00` would
 * roll over, so the normalized instant must keep the date and time sent.
 *
 * @param {unknown} value
 */
function requirePaidAt(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    throw new StoreOrderError(400, 'INVALID_PAID_AT');
  }
  const instant = new Date(value);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new StoreOrderError(400, 'INVALID_PAID_AT');
  }
  return instant.toISOString();
}

/**
 * The receipt link the gateway gave: `null`, or an https URL on one of the
 * InfinitePay hosts, without credentials or a port.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function readReceiptUrl(value) {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > MAX_RECEIPT_URL ||
    !value.startsWith('https://') ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new StoreOrderError(400, 'INVALID_RECEIPT_URL');
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new StoreOrderError(400, 'INVALID_RECEIPT_URL');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !STORE_RECEIPT_HOSTS.some(
      (base) => host === base || host.endsWith(`.${base}`),
    )
  ) {
    throw new StoreOrderError(400, 'INVALID_RECEIPT_URL');
  }
  return value;
}

/**
 * ADR 028: the shop's number for an order is `LJ-` and the first eight hex
 * digits of its `pedido_id`, in upper case.
 *
 * @param {string} requestId
 */
export function storeNumberFor(requestId) {
  return `LJ-${requestId.slice(0, 8).toUpperCase()}`;
}

/**
 * LOJ-15/LOJ-20: the record n8n sends, exactly. A missing, extra or mistyped
 * key is malformed (400), and so are a store number, a receipt link, an
 * instant, a name or a phone the checkout could not have produced. Whether
 * the product, the price and the payment are acceptable is the catalog's
 * call (422), made only for an order the CRM does not know yet.
 *
 * @param {unknown} body
 * @returns {StoreOrderRecord}
 */
export function parseStoreOrderRecord(body) {
  const top = requireShape(body, TOP_KEYS, ['entrega']);
  if (top.schema_version !== STORE_SCHEMA_VERSION) {
    throw new StoreOrderError(400, 'UNSUPPORTED_SCHEMA_VERSION');
  }
  if (typeof top.pedido_id !== 'string' || !UUID_V4.test(top.pedido_id)) {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  const requestId = top.pedido_id.toLowerCase();
  const storeNumber = storeNumberFor(requestId);
  if (top.numero_loja !== storeNumber) {
    throw new StoreOrderError(400, 'INVALID_STORE_NUMBER');
  }
  if (typeof top.teste !== 'boolean') {
    throw new StoreOrderError(400, 'INVALID_REQUEST');
  }
  const produto = requireShape(top.produto, SHAPE.produto);
  const item = requireShape(top.item, SHAPE.item);
  const cliente = requireShape(top.cliente, SHAPE.cliente);
  const pagamento = requireShape(top.pagamento, SHAPE.pagamento);
  let delivery = null;
  if (Object.hasOwn(top, 'entrega')) {
    const entrega = requireShape(top.entrega, SHAPE.entrega);
    if (
      entrega.tipo !== 'envio' ||
      typeof entrega.cep !== 'string' ||
      !BRAZILIAN_CEP.test(entrega.cep)
    ) {
      throw new StoreOrderError(400, 'INVALID_REQUEST');
    }
    delivery = { type: /** @type {const} */ ('envio'), cep: entrega.cep };
  }
  const name =
    typeof cliente.nome === 'string'
      ? cliente.nome.replace(/\s+/gu, ' ').trim()
      : '';
  if (name.length < 2 || name.length > 80 || CONTROL.test(name)) {
    throw new StoreOrderError(400, 'INVALID_CUSTOMER');
  }
  if (
    typeof cliente.telefone !== 'string' ||
    !BRAZILIAN_PHONE.test(cliente.telefone)
  ) {
    throw new StoreOrderError(400, 'INVALID_CUSTOMER');
  }
  return {
    amountCents: requireInteger(top.valor_centavos, 1, MAX_CENTS),
    customer: { name, phone: cliente.telefone },
    delivery,
    item: {
      colorId: requireText(item.cor_id),
      leadTimeDays: requireInteger(item.prazo_dias, 0, 365),
      quantity: requireInteger(item.quantidade, 1, 10_000),
      sizeId: requireText(item.tamanho_id),
    },
    payment: {
      gateway: requireText(pagamento.gateway),
      invoiceSlug: requireGatewayId(pagamento.invoice_slug),
      method: requireText(pagamento.forma),
      paidAmountCents: requireInteger(
        pagamento.valor_pago_centavos,
        1,
        MAX_CENTS,
      ),
      paidAt: requirePaidAt(pagamento.pago_em),
      receiptUrl: readReceiptUrl(pagamento.receipt_url),
      transactionNsu: requireGatewayId(pagamento.transaction_nsu),
    },
    product: { slug: requireText(produto.slug) },
    requestId,
    storeNumber,
    test: top.teste,
  };
}

/**
 * LOJ-17: what a retry of the same order must repeat — everything but the
 * receipt link, which may arrive later. The hash is kept next to the order,
 * so a retry is compared without decrypting the ficha.
 *
 * @param {StoreOrderRecord} record
 */
export function storeRecordFingerprint(record) {
  const { customer, item, payment } = record;
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.requestId,
        record.storeNumber,
        record.test,
        record.product.slug,
        item.colorId,
        item.sizeId,
        item.quantity,
        item.leadTimeDays,
        record.amountCents,
        customer.name,
        customer.phone,
        payment.gateway,
        payment.method,
        payment.transactionNsu,
        payment.invoiceSlug,
        payment.paidAmountCents,
        payment.paidAt,
        ...(record.delivery ? [record.delivery.cep] : []),
      ]),
    )
    .digest('hex');
}

/**
 * LOJ-18/LOJ-19: a new order must be a test only where tests are accepted,
 * paid by Pix through InfinitePay, describe what the CRM sells at the CRM's
 * price and lead time, be paid in full, and carry an instant a retry can
 * explain.
 *
 * @param {StoreOrderRecord} record
 * @param {{acceptTest: boolean, now: Date}} options
 * @returns {{product: import('./store-catalog.js').StoreProduct, color: import('./store-catalog.js').StoreColor, size: string, priceCents: number}}
 */
export function matchStoreCatalog(record, { acceptTest, now }) {
  if (record.test && !acceptTest) {
    throw new StoreOrderError(422, 'TEST_REFUSED');
  }
  if (
    record.payment.gateway !== STORE_PAYMENT_GATEWAY ||
    record.payment.method !== STORE_PAYMENT_METHOD
  ) {
    throw new StoreOrderError(422, 'PAYMENT_METHOD_UNSUPPORTED');
  }
  const mismatch = () => new StoreOrderError(422, 'STORE_CATALOG_MISMATCH');
  const product = storeProduct(record.product.slug);
  if (!product) throw mismatch();
  const { item } = record;
  const color = Object.hasOwn(product.cores, item.colorId)
    ? product.cores[item.colorId]
    : null;
  const size = Object.hasOwn(product.tamanhos, item.sizeId)
    ? product.tamanhos[item.sizeId]
    : null;
  if (
    color === null ||
    size === null ||
    (product.quantidadeMaxima
      ? item.quantity < 1 || item.quantity > product.quantidadeMaxima
      : item.quantity !== product.pecasPorKit) ||
    item.leadTimeDays !== color.prazoDiasUteis
  ) {
    throw mismatch();
  }
  const catalogPrice =
    product.precoCentavos * (product.quantidadeMaxima ? item.quantity : 1);
  const prices = record.test
    ? [catalogPrice, product.precoTesteCentavos]
    : [catalogPrice];
  if (!prices.includes(record.amountCents)) throw mismatch();
  if (record.payment.paidAmountCents < record.amountCents) {
    throw new StoreOrderError(422, 'AMOUNT_BELOW_PRICE');
  }
  const paidAt = Date.parse(record.payment.paidAt);
  if (
    paidAt < now.getTime() - PAID_AT_MAX_AGE_MS ||
    paidAt > now.getTime() + PAID_AT_MAX_SKEW_MS
  ) {
    throw new StoreOrderError(400, 'INVALID_PAID_AT');
  }
  return { color, priceCents: record.amountCents, product, size };
}

/**
 * LOJ-21: the store order as it is born — confirmed on the gateway's word
 * at the catalog's price, paid by Pix on the day InfinitePay confirmed, with
 * no conversation. The name, phone, delivery CEP and receipt link live only
 * in the ficha, which the repository encrypts.
 *
 * @param {{
 *   record: StoreOrderRecord,
 *   match: ReturnType<typeof matchStoreCatalog>,
 *   id: string, fabCode: string, now: Date,
 * }} input
 */
export function buildStoreOrder({ fabCode, id, match, now, record }) {
  const { color, priceCents, product, size } = match;
  const paidAt = new Date(record.payment.paidAt);
  const item = {
    ...blankItem(),
    cor: color.nome,
    estampa: color.estampa ?? '',
    gola: product.gola,
    grade: [{ quantidade: record.item.quantity, tamanho: size }],
    malhas: [product.malha],
    publico: product.publico,
    tipo: product.tipo,
  };
  /** @type {StoreFicha} */
  const loja = {
    comprovanteUrl: record.payment.receiptUrl,
    produto: { nome: product.nome, slug: product.slug },
    telefone: record.customer.phone,
  };
  /** @type {GatewayPayment} */
  const gatewayPayment = {
    confirmedAt: record.payment.paidAt,
    invoiceSlug: record.payment.invoiceSlug,
    paidAmountCents: record.payment.paidAmountCents,
    source: STORE_PAYMENT_GATEWAY,
    transactionNsu: record.payment.transactionNsu,
  };
  return {
    confirmedAt: now.toISOString(),
    confirmedBy: STORE_ACTOR_ID,
    conversationId: null,
    createdBy: STORE_ACTOR_ID,
    createdByKind: /** @type {const} */ ('automation'),
    fabCode,
    ficha: {
      artwork: {
        ...blankArtwork(),
        [color.estampa ? 'feito_pela_silmer' : 'sem_estampa']: true,
      },
      items: [item],
      loja,
      observations: record.delivery
        ? [
            `Dados de envio — CEP: ${record.delivery.cep}. Entrar em contato para pegar as informações de entrega.`,
          ]
        : [],
      serviceData: {},
      summary: {
        cliente: record.customer.name,
        data_entrega_confirmada: null,
        nome: null,
      },
    },
    finalAmountCents: priceCents,
    firstContactAt: record.payment.paidAt,
    gatewayPayment,
    id,
    isTest: record.test,
    leadTimeBusinessDays: color.prazoDiasUteis,
    missingFields: [],
    orderDate: operationalDay(paidAt),
    origin: /** @type {const} */ ('loja'),
    paidOn: operationalDay(paidAt),
    paymentCondition: /** @type {const} */ ('pix'),
    status: /** @type {const} */ ('confirmado'),
    storeNumber: record.storeNumber,
    totalPieces: record.item.quantity,
  };
}

/**
 * LOJ-07: a store order takes no human write after it is born — no section,
 * no confirmation or reopening, no trail day, no art file.
 *
 * @param {{origin?: string, cancelledAt?: string|null}} order
 */
export function requireUnlocked(order) {
  requireActiveOrder(order);
  if (order.origin === 'loja') {
    throw new OrderConflictError('Store orders are locked', 'ORDER_LOCKED');
  }
}
