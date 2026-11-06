import { createHmac } from 'node:crypto';
import { normalizeFicha } from '../domain/ficha.js';

/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** Prices belong to the commercial composition, not receipt/print/payment-day
 * metadata. A keyed digest never publishes a plain hash of buyer PII.
 * @param {import('../domain/order.js').Order} order @param {Buffer} key */
export function orderSourceFingerprint(order, key) {
  const ficha = normalizeFicha(order.ficha);
  const basis = {
    origin: order.origin,
    items: ficha.items,
    total: order.finalAmountCents,
    buyer:
      order.origin === 'loja'
        ? {
            name: ficha.summary.cliente,
            phone: ficha.loja?.telefone,
            product: ficha.loja?.produto,
          }
        : null,
  };
  const digestKey = createHmac('sha256', key)
    .update('order-olist-source:key:v1')
    .digest();
  return createHmac('sha256', digestKey)
    .update('order-olist-source:v1:' + order.id + ':')
    .update(JSON.stringify(canonical(basis)))
    .digest('hex');
}
