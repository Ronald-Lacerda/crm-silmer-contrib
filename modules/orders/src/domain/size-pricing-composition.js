import { OrderConflictError, OrderValidationError } from './errors.js';
import {
  calculateSizePricing,
  changeSizePricingQuantity,
  createSizePricing,
  duplicateSizePricingGroup,
  reviewSizePricingSubtotal,
} from './size-pricing.js';

/** @param {string} code @returns {never} */
function conflict(code) {
  throw new OrderConflictError('Revise a composição do pedido.', code);
}

/** @returns {never} */
function invalid() {
  throw new OrderValidationError(
    'Revise o comando de composição por tamanho.',
    'SIZE_PRICING_INVALID',
    ['sizePricing'],
  );
}

/** @param {import('./size-pricing.js').SizePriceGroup[]} groups */
function requirePersistableQuantity(groups) {
  const total = groups.reduce(
    (sum, group) =>
      sum +
      group.lines.reduce((pieces, line) => pieces + BigInt(line.quantity), 0n),
    0n,
  );
  if (total > 2147483647n) invalid();
}

/**
 * T20b: adopt only a never-confirmed draft. IDs and review are server state;
 * commands reference existing IDs rather than importing a replacement graph.
 * Positional alignment is changed only here, together with the encrypted ficha.
 * T21/T24/T26 will add confirmation, shop and historical enrichment adapters.
 * @param {import('./order.js').Order} order
 * @param {unknown} value
 * @returns {import('./ficha.js').Ficha}
 */
export function applySizePricingCommand(order, value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const command = /** @type {Record<string, unknown>} */ (value);
  const fields = {
    initialize: ['action'],
    review_subtotal: ['action', 'groupId', 'lineId', 'subtotalCents'],
    change_quantity: ['action', 'groupId', 'lineId', 'quantity'],
    reorder_groups: ['action', 'groupIds'],
    duplicate_group: ['action', 'groupId'],
  };
  const action = command.action;
  if (typeof action !== 'string' || !Object.hasOwn(fields, action)) invalid();
  const keys = fields[/** @type {keyof typeof fields} */ (action)];
  if (
    Object.keys(command).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(command, key))
  )
    invalid();
  if (order.origin === 'loja') conflict('ORDER_LOCKED');
  if (order.status !== 'pendente') conflict('ORDER_STATUS_CONFLICT');
  if (order.confirmedAt !== null)
    conflict('SIZE_PRICING_LEGACY_REQUIRES_ADAPTER');
  const ficha = structuredClone(order.ficha);
  if (action === 'initialize') {
    if (ficha.sizePricing !== undefined)
      conflict('SIZE_PRICING_ALREADY_INITIALIZED');
    ficha.sizePricing = createSizePricing(
      ficha.items.map((item) =>
        item.grade.map((line) => ({
          size: line.tamanho,
          quantity: line.quantidade,
        })),
      ),
    );
    requirePersistableQuantity(ficha.sizePricing);
    return ficha;
  }
  if (ficha.sizePricing === undefined) conflict('SIZE_PRICING_NOT_INITIALIZED');
  const groups = ficha.sizePricing;
  // Refuse malformed persisted state before any transition. No matching by
  // size across garments, by content, or by a browser-supplied ordinal.
  calculateSizePricing(groups);
  if (
    groups.length !== ficha.items.length ||
    groups.some((group, index) => {
      const grade = ficha.items[index].grade;
      return (
        group.lines.length !== grade.length ||
        group.lines.some(
          (line, i) =>
            line.size !== grade[i].tamanho ||
            line.quantity !== grade[i].quantidade,
        )
      );
    })
  )
    invalid();
  const groupIndex = groups.findIndex((group) => group.id === command.groupId);
  const group = groups[groupIndex];
  if (action === 'reorder_groups') {
    const ids = command.groupIds;
    if (
      !Array.isArray(ids) ||
      Object.keys(ids).length !== ids.length ||
      ids.length !== groups.length ||
      new Set(ids).size !== groups.length ||
      ids.some(
        (id) => typeof id !== 'string' || !groups.some((g) => g.id === id),
      )
    )
      invalid();
    const indices = ids.map((id) => groups.findIndex((g) => g.id === id));
    ficha.sizePricing = indices.map((index) => groups[index]);
    ficha.items = indices.map((index) => ficha.items[index]);
  } else {
    if (!group || typeof command.groupId !== 'string') invalid();
    if (action === 'duplicate_group') {
      ficha.sizePricing = duplicateSizePricingGroup(groups, command.groupId);
      ficha.items.push(structuredClone(ficha.items[groupIndex]));
    } else {
      if (typeof command.lineId !== 'string') invalid();
      const lineIndex = group.lines.findIndex(
        (line) => line.id === command.lineId,
      );
      if (lineIndex < 0) invalid();
      if (action === 'review_subtotal') {
        if (
          command.subtotalCents !== null &&
          typeof command.subtotalCents !== 'number'
        )
          invalid();
        ficha.sizePricing = reviewSizePricingSubtotal(
          groups,
          command.groupId,
          command.lineId,
          command.subtotalCents,
        );
      } else {
        if (typeof command.quantity !== 'number') invalid();
        ficha.sizePricing = changeSizePricingQuantity(
          groups,
          command.groupId,
          command.lineId,
          command.quantity,
        );
        ficha.items[groupIndex].grade[lineIndex].quantidade = command.quantity;
      }
    }
  }
  calculateSizePricing(ficha.sizePricing);
  requirePersistableQuantity(ficha.sizePricing);
  return ficha;
}
