import { randomUUID } from 'node:crypto';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from '../../modules/orders/src/domain/size-pricing.js';

/** Synthetic negotiated prices for preexisting non-pricing regression scenarios.
 * The explicit test budget is NOT read from an order's historical amount.
 * Use differentiated prices (one cent per remaining line) so no unit-rate
 * assumption leaks into fixtures. Pricing-specific tests author each line.
 * @param {any} ficha @param {number} totalCents @returns {any} */
export function fixturePricing(ficha, totalCents) {
  const next = structuredClone(ficha);
  let groups = createSizePricing(
    next.items.map((/** @type {any} */ item) =>
      item.grade.map((/** @type {any} */ line) => ({
        size: line.tamanho,
        quantity: line.quantidade,
      })),
    ),
  );
  const count = groups.reduce((n, group) => n + group.lines.length, 0);
  let first = true;
  for (const group of groups)
    for (const line of group.lines) {
      groups = reviewSizePricingSubtotal(
        groups,
        group.id,
        line.id,
        first ? totalCents - count + 1 : 1,
      );
      first = false;
    }
  next.sizePricing = groups;
  return next;
}

/** Seed a valid persisted synthetic fixture for a scenario unrelated to pricing.
 * @param {any} repository @param {any} order @param {number} totalCents @param {any} actor */
export async function persistFixturePricing(
  repository,
  order,
  totalCents,
  actor,
) {
  return repository.saveSection(
    {
      ...order,
      ficha: fixturePricing(order.ficha, totalCents),
      finalAmountCents: totalCents,
    },
    {
      actor,
      expectedVersion: order.version,
      correlationId: 'synthetic-pricing-fixture',
    },
  );
}

/** Exercise the actual authorized command boundary when a fixture has no repository port.
 * @param {any} service @param {any} order @param {number} totalCents @param {any} actor */
export async function priceDraft(service, order, totalCents, actor) {
  const apply = (/** @type {unknown} */ value) =>
    service.patchSection({
      actor,
      correlationId: 'synthetic-pricing-fixture',
      idempotencyKey: randomUUID(),
      orderId: order.id,
      expectedVersion: order.version,
      section: 'size-pricing',
      value,
    });
  if (order.ficha.sizePricing === undefined)
    order = await apply({ action: 'initialize' });
  const count = order.ficha.sizePricing.reduce(
    (/** @type {number} */ n, /** @type {any} */ g) => n + g.lines.length,
    0,
  );
  let first = true;
  for (const group of order.ficha.sizePricing)
    for (const line of group.lines) {
      order = await apply({
        action: 'review_subtotal',
        groupId: group.id,
        lineId: line.id,
        subtotalCents: first ? totalCents - count + 1 : 1,
      });
      first = false;
    }
  return order;
}
