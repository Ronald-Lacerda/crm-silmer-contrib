import { ShippingValidationError } from './errors.js';

// MEV-01: "Como o cliente recebe?" has exactly two answers and none is
// preselected, so `null` means the seller has not chosen yet.
export const DELIVERY_MODES = Object.freeze(['store_pickup', 'melhor_envio']);

/**
 * @typedef {'store_pickup' | 'melhor_envio'} DeliveryMode
 */

/**
 * @param {unknown} value
 * @returns {DeliveryMode | null}
 */
export function parseDeliveryMode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && DELIVERY_MODES.includes(value)) {
    return /** @type {DeliveryMode} */ (value);
  }
  throw new ShippingValidationError(
    'Escolha Retirada na loja ou Transportadora pelo Melhor Envio.',
    'INVALID_DELIVERY_MODE',
    ['deliveryMode'],
  );
}
