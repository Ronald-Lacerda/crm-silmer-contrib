import {
  CONTACT_REGISTRATION_FIELDS,
  normalizeContactRegistration,
} from '@crm-silmer/contacts';
import {
  OrderConflictError,
  OrderInputError,
  OrderValidationError,
} from './errors.js';
import { hasArtworkOrigin } from './ficha.js';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from './size-pricing.js';
import { sizePricingSummary } from './size-pricing-composition.js';

/**
 * OLIST-T24: an additive source for the store snapshot. None of these pure
 * functions authorizes a human or writes checkout, gateway, catalog or ficha.
 * @typedef {import('./size-pricing.js').SizePriceGroup} SizePriceGroup
 * @typedef {import('../../../contacts/src/domain/contact-registration.js').ContactRegistration} ContactRegistration
 * @typedef {{deliveryOn: string|null,
 *   applications: {groupId: string, application: string|null}[],
 *   registration: ContactRegistration|null}} StoreSourceDetails
 * @typedef {{mode: 'store', groups: SizePriceGroup[], details: StoreSourceDetails}} StoreSourceData
 * @typedef {{data: StoreSourceData, revision: number, sourceValid: boolean,
 *   orderVersion: number, updatedBy: string, updatedAt: string}} StoreSourceRecord
 * @typedef {{code: string, field: string}} StoreSourceIssue
 */
const REGISTRATION_KEYS = new Set(CONTACT_REGISTRATION_FIELDS);
const REQUIRED_REGISTRATION = /** @type {const} */ ([
  'personType',
  'document',
  'legalName',
  'postalCode',
  'city',
  'state',
  'street',
  'district',
  'number',
]);
const PHONE = /^55[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/u;
const GATEWAY_ID = /^[\x21-\x7e]{1,128}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

/** @param {string[]} [fields] @returns {never} */
function invalid(fields = ['priceBreakdown']) {
  throw new OrderValidationError(
    'Revise os dados complementares do pedido da loja.',
    'ORDER_SOURCE_INVALID',
    fields,
  );
}

/** @param {unknown} value @param {string[]} keys @returns {Record<string, unknown>} */
function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const input = /** @type {Record<string, unknown>} */ (value);
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    invalid();
  return input;
}

/** @param {unknown} value @returns {unknown[]} */
function dense(value) {
  if (
    !Array.isArray(value) ||
    Object.keys(value).length !== value.length ||
    Object.keys(value).some((key, i) => key !== String(i))
  )
    invalid();
  return value;
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** @param {unknown} value */
function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const instant = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

/** Store origin alone is not evidence of a valid paid checkout snapshot.
 * @param {import('./order.js').Order} order */
function requireStore(order) {
  if (order.origin !== 'loja')
    throw new OrderConflictError(
      'Este adaptador exige pedido da loja.',
      'ORDER_LOCKED',
    );
  if (order.status !== 'confirmado')
    throw new OrderConflictError(
      'Pedido da loja deve estar confirmado.',
      'ORDER_STATUS_CONFLICT',
    );
  const { ficha, gatewayPayment: payment, finalAmountCents: total } = order;
  if (!ficha || typeof ficha !== 'object' || !ficha.summary)
    invalid(['storeSnapshot']);
  const items = dense(ficha.items);
  if (items.length !== 1 || !items[0] || typeof items[0] !== 'object')
    invalid(['items']);
  const item = ficha.items[0];
  const grade = dense(item.grade);
  if (grade.length !== 1 || !grade[0] || typeof grade[0] !== 'object')
    invalid(['items.grade']);
  const line = item.grade[0];
  if (
    ficha.sizePricing !== undefined ||
    order.conversationId !== null ||
    (order.contactId ?? null) !== null ||
    (order.manualOwnerId ?? null) !== null ||
    !Number.isSafeInteger(order.totalPieces) ||
    order.totalPieces <= 0 ||
    line.quantidade !== order.totalPieces ||
    !text(line.tamanho, 200) ||
    !Number.isSafeInteger(total) ||
    /** @type {number} */ (total) <= 0 ||
    order.paymentCondition !== 'pix' ||
    payment?.source !== 'infinitepay' ||
    !Number.isSafeInteger(payment.paidAmountCents) ||
    payment.paidAmountCents < /** @type {number} */ (total) ||
    typeof payment.transactionNsu !== 'string' ||
    !GATEWAY_ID.test(payment.transactionNsu) ||
    typeof payment.invoiceSlug !== 'string' ||
    !GATEWAY_ID.test(payment.invoiceSlug) ||
    !UTC_INSTANT.test(payment.confirmedAt) ||
    !Number.isFinite(Date.parse(payment.confirmedAt)) ||
    new Date(payment.confirmedAt).toISOString().slice(0, 19) !==
      payment.confirmedAt.slice(0, 19) ||
    !text(ficha.summary.cliente, 150) ||
    typeof ficha.loja?.telefone !== 'string' ||
    !PHONE.test(ficha.loja.telefone) ||
    !text(ficha.loja?.produto?.slug, 128) ||
    !text(ficha.loja?.produto?.nome, 200)
  )
    invalid(['storeSnapshot']);
  return item;
}

/** The original field may be absent, but malformed snapshot text must never
 * become a ready application or be silently replaced by a supplement.
 * @param {import('./order.js').Order} order @param {number} index
 * @returns {string|null} */
function originalApplication(order, index) {
  const value = order.ficha.items[index].tipo_servico;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalid([`items.${index}.tipo_servico`]);
  if (value.trim() === '') {
    if (value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))
      invalid([`items.${index}.tipo_servico`]);
    return null;
  }
  if (!text(value, 200)) invalid([`items.${index}.tipo_servico`]);
  return value.trim();
}

/** @param {unknown} value @returns {ContactRegistration|null} */
function registration(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !REGISTRATION_KEYS.has(key))
  )
    invalid(['registration']);
  const normalized = normalizeContactRegistration(value);
  if (!normalized.ok)
    invalid(Object.keys(normalized.errors).map((key) => 'registration.' + key));
  return structuredClone(normalized.value);
}

/** @param {import('./order.js').Order} order @param {SizePriceGroup[]} groups
 * @param {unknown} value @returns {StoreSourceDetails} */
function details(order, groups, value) {
  const input = record(value, ['deliveryOn', 'applications', 'registration']);
  if (input.deliveryOn !== null && !calendarDay(input.deliveryOn))
    invalid(['deliveryOn']);
  const originalDelivery = order.ficha.summary.data_entrega_confirmada;
  if (
    originalDelivery !== null &&
    originalDelivery !== undefined &&
    !calendarDay(originalDelivery)
  )
    invalid(['deliveryOn']);
  if (
    originalDelivery &&
    input.deliveryOn !== null &&
    input.deliveryOn !== originalDelivery
  )
    invalid(['deliveryOn']);
  const remaining = new Set(groups.map((group) => group.id));
  const entries = dense(input.applications);
  if (entries.length !== remaining.size) invalid(['applications']);
  const applications = entries.map((entry) => {
    const input = record(entry, ['groupId', 'application']);
    if (typeof input.groupId !== 'string' || !remaining.delete(input.groupId))
      invalid(['applications']);
    if (input.application !== null && !text(input.application, 200))
      invalid(['applications']);
    const application =
      input.application === null
        ? null
        : /** @type {string} */ (input.application).trim();
    const original = originalApplication(
      order,
      groups.findIndex((group) => group.id === input.groupId),
    );
    if (original && application !== null && application !== original)
      invalid(['applications']);
    return { groupId: input.groupId, application };
  });
  return {
    deliveryOn: /** @type {string|null} */ (input.deliveryOn),
    applications,
    registration: registration(input.registration),
  };
}

/** @param {import('./order.js').Order} order @param {StoreSourceData} data */
function validateData(order, data) {
  requireStore(order);
  record(data, ['mode', 'groups', 'details']);
  if (data.mode !== 'store') invalid();
  const pricing = sizePricingSummary({
    ...order.ficha,
    sizePricing: data.groups,
  });
  if (!pricing.complete || pricing.totalCents !== order.finalAmountCents)
    invalid(['priceBreakdown']);
  const normalizedDetails = details(order, data.groups, data.details);
  return { pricing, details: normalizedDetails };
}

/** @param {import('./order.js').Order} order @param {StoreSourceData|null} currentData
 * @param {unknown} value @returns {StoreSourceData} */
export function applyStoreSourceCommand(order, currentData, value) {
  requireStore(order);
  const action =
    value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value).action
      : null;
  if (action !== 'initialize' && action !== 'set_store_details')
    throw new OrderInputError('Comando de complemento inválido.', ['action']);
  const input = record(
    value,
    action === 'initialize'
      ? ['action']
      : ['action', 'deliveryOn', 'applications', 'registration'],
  );
  if (action === 'initialize') {
    if (currentData !== null)
      throw new OrderConflictError(
        'Complemento já inicializado.',
        'SIZE_PRICING_ALREADY_INITIALIZED',
      );
    const line = order.ficha.items[0].grade[0];
    let groups = createSizePricing([
      [{ size: line.tamanho, quantity: line.quantidade }],
    ]);
    groups = reviewSizePricingSubtotal(
      groups,
      groups[0].id,
      groups[0].lines[0].id,
      /** @type {number} */ (order.finalAmountCents),
    );
    const data = {
      mode: /** @type {const} */ ('store'),
      groups,
      details: {
        deliveryOn: null,
        applications: [{ groupId: groups[0].id, application: null }],
        registration: null,
      },
    };
    validateData(order, data);
    return data;
  }
  if (currentData === null)
    throw new OrderConflictError(
      'Inicialize o complemento.',
      'SIZE_PRICING_NOT_INITIALIZED',
    );
  validateData(order, currentData);
  const next = {
    mode: /** @type {const} */ ('store'),
    groups: structuredClone(currentData.groups),
    details: details(order, currentData.groups, {
      deliveryOn: input.deliveryOn,
      applications: input.applications,
      registration: input.registration,
    }),
  };
  validateData(order, next);
  return next;
}

/** @param {import('./order.js').Order} order @param {StoreSourceDetails|null} value
 * @returns {StoreSourceIssue[]} */
function completeness(order, value) {
  /** @type {StoreSourceIssue[]} */
  const issues = [];
  if (
    !value?.deliveryOn &&
    !calendarDay(order.ficha.summary.data_entrega_confirmada)
  )
    issues.push({ code: 'STORE_DELIVERY_REQUIRED', field: 'deliveryOn' });
  for (const [index, item] of order.ficha.items.entries()) {
    if (
      !originalApplication(order, index) &&
      !value?.applications[index]?.application
    )
      issues.push({
        code: 'STORE_APPLICATION_REQUIRED',
        field: 'applications.' + (value?.applications[index]?.groupId ?? index),
      });
    for (const field of ['tipo', 'cor', 'gola'])
      if (!text(item[/** @type {'tipo'|'cor'|'gola'} */ (field)], 200))
        issues.push({
          code: 'STORE_ITEM_FIELD_REQUIRED',
          field: `items.${index}.${field}`,
        });
    if (
      !Array.isArray(item.malhas) ||
      item.malhas.length === 0 ||
      Object.keys(item.malhas).length !== item.malhas.length ||
      Object.keys(item.malhas).some((key, i) => key !== String(i)) ||
      !item.malhas.every((fabric) => text(fabric, 200))
    )
      issues.push({
        code: 'STORE_ITEM_FIELD_REQUIRED',
        field: `items.${index}.malhas`,
      });
  }
  if (!hasArtworkOrigin(order.ficha.artwork))
    issues.push({ code: 'STORE_ARTWORK_REQUIRED', field: 'artwork' });
  for (const field of REQUIRED_REGISTRATION)
    if (!value?.registration?.[field])
      issues.push({
        code: 'STORE_BUYER_FIELD_REQUIRED',
        field: 'registration.' + field,
      });
  if (
    value?.registration?.personType === 'company' &&
    !value.registration.stateRegistration
  )
    issues.push({
      code: 'STORE_BUYER_FIELD_REQUIRED',
      field: 'registration.stateRegistration',
    });
  return issues;
}

/** A transient view for T06. Never persist this augmented ficha as the order.
 * @param {import('./order.js').Order} order @param {StoreSourceData} data */
export function storeSourceView(order, data) {
  const checked = validateData(order, data);
  const view = structuredClone(order);
  view.ficha.sizePricing = structuredClone(data.groups);
  view.ficha.summary.data_entrega_confirmada =
    order.ficha.summary.data_entrega_confirmada ?? checked.details.deliveryOn;
  for (const [index, item] of view.ficha.items.entries()) {
    item.tipo_servico =
      originalApplication(order, index) ||
      checked.details.applications[index].application ||
      '';
  }
  return {
    ...view,
    buyer: {
      name: order.ficha.summary.cliente,
      phone: order.ficha.loja?.telefone,
      registration: structuredClone(checked.details.registration),
    },
  };
}

/** @param {import('./order.js').Order} order @param {StoreSourceRecord|null} source */
export function projectStoreSource(order, source) {
  requireStore(order);
  let pricing = /** @type {ReturnType<typeof sizePricingSummary>|null} */ (
    null
  );
  let checkedDetails = /** @type {StoreSourceDetails|null} */ (null);
  /** @type {StoreSourceIssue[]} */
  let issues;
  if (source?.sourceValid) {
    const checked = validateData(order, source.data);
    pricing = checked.pricing;
    checkedDetails = checked.details;
    issues = completeness(order, checkedDetails);
  } else {
    issues = [
      {
        code: source ? 'ORDER_SOURCE_STALE' : 'STORE_ORDER_COMPLEMENT_REQUIRED',
        field: 'priceBreakdown',
      },
      ...completeness(order, null),
    ];
  }
  return {
    mode: /** @type {const} */ ('store'),
    orderId: order.id,
    orderVersion: order.version,
    revision: source?.revision ?? 0,
    sourceValid: source?.sourceValid === true,
    groups: structuredClone(source?.data.groups ?? []),
    pricing,
    issues,
    updatedBy: source?.updatedBy ?? null,
    updatedAt: source?.updatedAt ?? null,
    details: structuredClone(checkedDetails ?? source?.data.details ?? null),
    buyer: source?.sourceValid
      ? {
          name: order.ficha.summary.cliente,
          phone: order.ficha.loja?.telefone,
          registration: structuredClone(checkedDetails?.registration ?? null),
        }
      : null,
  };
}
