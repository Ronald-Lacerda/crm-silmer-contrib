import { blankItem, validateItems } from './ficha.js';
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

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string[]} expected @returns {number[]} */
function permutation(value, expected) {
  if (
    !Array.isArray(value) ||
    Object.keys(value).length !== value.length ||
    value.length !== expected.length ||
    new Set(value).size !== expected.length ||
    Object.keys(value).some((key, i) => key !== String(i)) ||
    value.some((id) => typeof id !== 'string' || !expected.includes(id))
  )
    invalid();
  return value.map((id) => expected.indexOf(id));
}

/** Validate prices against the same ficha that is persisted/confirmed.
 * @param {import('./ficha.js').Ficha} ficha */
export function sizePricingSummary(ficha) {
  if (ficha.sizePricing === undefined) conflict('SIZE_PRICING_NOT_INITIALIZED');
  const groups = ficha.sizePricing;
  const summary = calculateSizePricing(groups);
  requirePersistableQuantity(groups);
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
  return summary;
}

/**
 * OLIST-T20: server-issued IDs; explicit commands never import a replacement
 * pricing graph. Grade and prices move in the same encrypted write.
 * @param {import('./order.js').Order} order
 * @param {unknown} value
 * @returns {import('./ficha.js').Ficha}
 */
export function applySizePricingCommand(order, value) {
  const command = record(value);
  const fields = {
    initialize: ['action'],
    review_subtotal: ['action', 'groupId', 'lineId', 'subtotalCents'],
    change_quantity: ['action', 'groupId', 'lineId', 'quantity'],
    reorder_groups: ['action', 'groupIds'],
    duplicate_group: ['action', 'groupId'],
    add_group: ['action', 'item'],
    remove_group: ['action', 'groupId'],
    update_group: ['action', 'groupId', 'attributes'],
    add_line: ['action', 'groupId', 'size', 'quantity'],
    remove_line: ['action', 'groupId', 'lineId'],
    rename_line: ['action', 'groupId', 'lineId', 'size'],
    reorder_lines: ['action', 'groupId', 'lineIds'],
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
  const ficha = structuredClone(order.ficha);
  if (action === 'initialize') {
    if (ficha.sizePricing !== undefined)
      conflict('SIZE_PRICING_ALREADY_INITIALIZED');
    if (order.confirmedAt !== null)
      conflict('SIZE_PRICING_LEGACY_REQUIRES_ADAPTER');
    ficha.sizePricing = createSizePricing(
      ficha.items.map((item) =>
        item.grade.map((line) => ({
          size: line.tamanho,
          quantity: line.quantidade,
        })),
      ),
    );
    sizePricingSummary(ficha);
    return ficha;
  }
  sizePricingSummary(ficha);
  const groups = /** @type {import('./size-pricing.js').SizePriceGroup[]} */ (
    ficha.sizePricing
  );
  if (action === 'add_group') {
    const [item] = validateItems([command.item]);
    const [group] = createSizePricing([
      item.grade.map((line) => ({
        size: line.tamanho,
        quantity: line.quantidade,
      })),
    ]);
    groups.push(group);
    ficha.items.push(item);
  } else if (action === 'reorder_groups') {
    const indices = permutation(
      command.groupIds,
      groups.map((g) => g.id),
    );
    ficha.sizePricing = indices.map((i) => groups[i]);
    ficha.items = indices.map((i) => ficha.items[i]);
  } else {
    const groupIndex = groups.findIndex((g) => g.id === command.groupId);
    const group = groups[groupIndex];
    if (!group || typeof command.groupId !== 'string') invalid();
    const item = ficha.items[groupIndex];
    if (action === 'duplicate_group') {
      ficha.sizePricing = duplicateSizePricingGroup(groups, command.groupId);
      ficha.items.push(structuredClone(item));
    } else if (action === 'remove_group') {
      groups.splice(groupIndex, 1);
      ficha.items.splice(groupIndex, 1);
    } else if (action === 'update_group') {
      const attributes = record(command.attributes);
      if (
        Object.keys(attributes).some(
          (key) => key === 'grade' || !Object.hasOwn(blankItem(), key),
        )
      )
        invalid();
      const [updated] = validateItems([{ ...item, ...attributes }]);
      if (
        JSON.stringify(updated) !== JSON.stringify(validateItems([item])[0])
      ) {
        ficha.items[groupIndex] = updated;
        for (const line of group.lines) line.subtotalReviewed = false;
      }
    } else if (action === 'add_line') {
      const [seed] = createSizePricing([
        [
          {
            size: /** @type {string} */ (command.size),
            quantity: /** @type {number} */ (command.quantity),
          },
        ],
      ]);
      const [line] = seed.lines;
      group.lines.push(line);
      item.grade.push({ tamanho: line.size, quantidade: line.quantity });
    } else if (action === 'reorder_lines') {
      const indices = permutation(
        command.lineIds,
        group.lines.map((line) => line.id),
      );
      group.lines = indices.map((i) => group.lines[i]);
      item.grade = indices.map((i) => item.grade[i]);
    } else {
      if (typeof command.lineId !== 'string') invalid();
      const lineIndex = group.lines.findIndex(
        (line) => line.id === command.lineId,
      );
      if (lineIndex < 0) invalid();
      const line = group.lines[lineIndex];
      if (action === 'remove_line') {
        group.lines.splice(lineIndex, 1);
        item.grade.splice(lineIndex, 1);
      } else if (action === 'rename_line') {
        const [seed] = createSizePricing([
          [
            {
              size: /** @type {string} */ (command.size),
              quantity: line.quantity,
            },
          ],
        ]);
        if (line.size !== seed.lines[0].size) {
          line.size = seed.lines[0].size;
          line.subtotalReviewed = false;
          item.grade[lineIndex].tamanho = line.size;
        }
      } else if (action === 'review_subtotal') {
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
        item.grade[lineIndex].quantidade = command.quantity;
      }
    }
  }
  sizePricingSummary(ficha);
  return ficha;
}
