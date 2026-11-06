import {
  applyStoreSourceCommand,
  projectStoreSource,
  storeSourceView,
} from './store-order-source.js';
import {
  OrderConflictError,
  OrderInputError,
  OrderValidationError,
} from './errors.js';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from './size-pricing.js';
import { sizePricingSummary } from './size-pricing-composition.js';

/**
 * OLIST-T26: supplemental prices never replace the historical ficha or total.
 * Application/repository boundaries authorize the human, fence order/source
 * revisions and validate the source fingerprint before applying commands.
 * @typedef {import('./size-pricing.js').SizePriceGroup} SizePriceGroup
 * @typedef {{mode: 'legacy', groups: SizePriceGroup[]}} LegacySourceData
 * @typedef {LegacySourceData|import('./store-order-source.js').StoreSourceData} OrderSourceData
 * @typedef {{data: OrderSourceData, revision: number, sourceValid: boolean,
 *   orderVersion: number, updatedBy: string, updatedAt: string}} OrderSourceRecord
 * @typedef {{code: string, field: string}} OrderSourceIssue
 */

/** @param {string} [field] @returns {never} */
function invalid(field = 'priceBreakdown') {
  throw new OrderValidationError(
    'Revise a composição suplementar por tamanho.',
    'ORDER_SOURCE_INVALID',
    [field],
  );
}

/** @param {unknown} value @param {string[]} keys
 * @returns {Record<string, unknown>} */
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
function denseArray(value) {
  if (
    !Array.isArray(value) ||
    Object.keys(value).length !== value.length ||
    Object.keys(value).some((key, i) => key !== String(i))
  )
    invalid();
  return value;
}

/** @param {import('./order.js').Order} order */
function requireLegacy(order) {
  if (order.origin === 'loja')
    throw new OrderConflictError(
      'Pedido da loja permanece travado.',
      'ORDER_LOCKED',
    );
  if (order.ficha.sizePricing !== undefined)
    throw new OrderConflictError(
      'Pedido já usa subtotais por tamanho.',
      'SIZE_PRICING_ALREADY_INITIALIZED',
    );
  if (!order.confirmedAt || !['pendente', 'confirmado'].includes(order.status))
    throw new OrderConflictError(
      'Enriquecimento exige um pedido histórico.',
      'ORDER_STATUS_CONFLICT',
    );
  if (
    !Number.isSafeInteger(order.finalAmountCents) ||
    /** @type {number} */ (order.finalAmountCents) <= 0
  )
    invalid('finalAmount');
}

/** A temporary projection validates alignment; never write it to the order.
 * @param {import('./order.js').Order} order @param {LegacySourceData} data */
function legacySummary(order, data) {
  record(data, ['mode', 'groups']);
  if (data.mode !== 'legacy') invalid();
  const pricing = sizePricingSummary({
    ...order.ficha,
    sizePricing: data.groups,
  });
  if (pricing.complete && pricing.totalCents !== order.finalAmountCents) {
    throw new OrderValidationError(
      'A composição deve preservar o total histórico.',
      'SIZE_PRICING_AMOUNT_MISMATCH',
      ['priceBreakdown'],
    );
  }
  return pricing;
}

/**
 * Emit server identities once; the only later operation replaces human
 * subtotals in one complete identity-addressed batch. No grade/quantity,
 * review flag, total, snapshot or client-generated identity is imported.
 * @param {import('./order.js').Order} order
 * @param {OrderSourceData|null} currentData
 * @param {unknown} value @returns {OrderSourceData}
 */
export function applyOrderSourceCommand(order, currentData, value) {
  if (order.origin === 'loja')
    return applyStoreSourceCommand(
      order,
      /** @type {import('./store-order-source.js').StoreSourceData|null} */ (
        currentData
      ),
      value,
    );
  if (currentData !== null && currentData.mode !== 'legacy') invalid();
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
  if (
    !raw ||
    !['initialize', 'set_subtotals'].includes(
      /** @type {string} */ (raw.action),
    )
  )
    throw new OrderInputError('Comando de enriquecimento inválido.', [
      'action',
    ]);
  const command = record(
    value,
    raw.action === 'initialize' ? ['action'] : ['action', 'lines'],
  );
  requireLegacy(order);
  if (command.action === 'initialize') {
    if (currentData !== null)
      throw new OrderConflictError(
        'Composição suplementar já inicializada.',
        'SIZE_PRICING_ALREADY_INITIALIZED',
      );
    const data = {
      mode: /** @type {const} */ ('legacy'),
      groups: createSizePricing(
        order.ficha.items.map((item) =>
          item.grade.map((line) => ({
            size: line.tamanho,
            quantity: line.quantidade,
          })),
        ),
      ),
    };
    legacySummary(order, data);
    return data;
  }
  if (currentData === null)
    throw new OrderConflictError(
      'Inicialize a composição suplementar.',
      'SIZE_PRICING_NOT_INITIALIZED',
    );
  legacySummary(order, currentData);
  const lines = denseArray(command.lines);
  const expected = new Set(
    currentData.groups.flatMap((group) =>
      group.lines.map((line) => `${group.id}:${line.id}`),
    ),
  );
  if (lines.length !== expected.size) invalid('lines');
  const updates = lines.map((line) => {
    const entry = record(line, ['groupId', 'lineId', 'subtotalCents']);
    if (
      typeof entry.groupId !== 'string' ||
      typeof entry.lineId !== 'string' ||
      !expected.delete(`${entry.groupId}:${entry.lineId}`)
    )
      invalid('lines');
    if (
      entry.subtotalCents !== null &&
      (typeof entry.subtotalCents !== 'number' ||
        !Number.isSafeInteger(entry.subtotalCents) ||
        entry.subtotalCents <= 0)
    )
      invalid('lines');
    return {
      groupId: entry.groupId,
      lineId: entry.lineId,
      subtotalCents: /** @type {number|null} */ (entry.subtotalCents),
    };
  });
  if (expected.size !== 0) invalid('lines');
  let groups = structuredClone(currentData.groups);
  // Clear only our server-owned draft copy first. Applying a batch must not
  // overflow merely because a decreasing line appears after an increasing one.
  for (const group of groups)
    for (const line of group.lines) {
      line.subtotalCents = null;
      line.subtotalReviewed = false;
    }
  for (const update of updates)
    groups = reviewSizePricingSubtotal(
      groups,
      update.groupId,
      update.lineId,
      update.subtotalCents,
    );
  const data = { mode: /** @type {const} */ ('legacy'), groups };
  legacySummary(order, data);
  return data;
}

/**
 * Source validity means the record is anchored to the current commercial
 * snapshot, not that all prices are complete. Stale draft IDs may be shown,
 * but their prices are never advertised as a valid source.
 * @param {import('./order.js').Order} order
 * @param {OrderSourceRecord|null} source
 */
export function projectOrderSource(order, source) {
  if (order.origin === 'loja')
    return projectStoreSource(
      order,
      /** @type {import('./store-order-source.js').StoreSourceRecord|null} */ (
        source
      ),
    );
  const managed = order.ficha.sizePricing !== undefined;
  const groups = structuredClone(
    order.ficha.sizePricing ?? source?.data.groups ?? [],
  );
  const sourceValid = managed || source?.sourceValid === true;
  /** @type {ReturnType<typeof sizePricingSummary>|null} */
  let pricing = null;
  /** @type {OrderSourceIssue[]} */
  let issues = [];
  if (managed) pricing = sizePricingSummary(order.ficha);
  else if (!source)
    issues = [
      { code: 'LEGACY_PRICE_BREAKDOWN_REQUIRED', field: 'priceBreakdown' },
    ];
  else if (!source.sourceValid)
    issues = [{ code: 'ORDER_SOURCE_STALE', field: 'priceBreakdown' }];
  else {
    if (source.data.mode !== 'legacy') invalid();
    pricing = legacySummary(order, source.data);
  }
  if (pricing)
    issues = pricing.issues.map((issue) => ({
      code: issue.code,
      field: ['priceBreakdown', issue.groupId, issue.lineId]
        .filter(Boolean)
        .join('.'),
    }));
  return {
    mode: managed
      ? /** @type {const} */ ('managed')
      : /** @type {const} */ ('legacy'),
    orderId: order.id,
    orderVersion: order.version,
    revision: managed ? 0 : (source?.revision ?? 0),
    sourceValid,
    groups,
    pricing,
    issues,
    updatedBy: managed ? null : (source?.updatedBy ?? null),
    updatedAt: managed ? null : (source?.updatedAt ?? null),
  };
}

/** A temporary source view for T06, never a persistence command. Origin-specific
 * supplements are used only after freshness and local completeness checks.
 * Account/customer schema/configuration and precision gates still belong to T06.
 * @param {import('./order.js').Order} order @param {OrderSourceRecord|null} source */
export function orderSourceView(order, source) {
  const projection = projectOrderSource(order, source);
  if (
    !projection.sourceValid ||
    !projection.pricing?.complete ||
    projection.issues.length
  ) {
    return {
      order: null,
      sourceRevision: projection.revision,
      issues: projection.issues,
    };
  }
  const view =
    order.origin === 'loja'
      ? storeSourceView(
          order,
          /** @type {import('./store-order-source.js').StoreSourceData} */ (
            source?.data
          ),
        )
      : {
          ...structuredClone(order),
          ficha: {
            ...structuredClone(order.ficha),
            sizePricing: structuredClone(projection.groups),
          },
        };
  return { order: view, sourceRevision: projection.revision, issues: [] };
}
