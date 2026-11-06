import { createHash } from 'node:crypto';
import { OrderForbiddenError, OrderNotFoundError } from '../domain/errors.js';
import { storeProduct } from '../domain/store-catalog.js';
import { StoreOrderError } from '../domain/store-order.js';
import { requireActiveOrder } from '../domain/order.js';

/** @param {{repository: any, clock?: () => Date}} options */
export function createStoreOrderCorrectionService({
  repository,
  clock = () => new Date(),
}) {
  return {
    /** @param {{actor: any, orderId: string, expectedVersion: number, expectedQuantity: number, expectedAmountCents: number, quantity: number, reason: string, correlationId: string, idempotencyKey: string}} input */
    async correct(input) {
      if (
        input.actor?.kind !== 'human' ||
        !input.actor?.capabilities?.includes('COMMERCIAL_ADMIN')
      )
        throw new OrderForbiddenError();
      if (input.reason !== 'USER_CONFIRMED_QUANTITY')
        throw new StoreOrderError(400, 'INVALID_CORRECTION_REASON');
      for (const value of [
        input.expectedVersion,
        input.expectedQuantity,
        input.expectedAmountCents,
        input.quantity,
      ]) {
        if (!Number.isSafeInteger(value) || value < 1)
          throw new StoreOrderError(400, 'INVALID_REQUEST');
      }
      const current = await repository.findById(input.orderId);
      if (!current) throw new OrderNotFoundError();
      requireActiveOrder(current);
      const product = storeProduct(current.ficha.loja?.produto.slug);
      const grade = current.ficha.items[0]?.grade;
      if (
        current.origin !== 'loja' ||
        current.status !== 'confirmado' ||
        current.isTest ||
        !product?.quantidadeMaxima ||
        product.pecasPorKit !== 1 ||
        current.ficha.items.length !== 1 ||
        grade?.length !== 1 ||
        grade[0].quantidade !== current.totalPieces ||
        input.quantity > product.quantidadeMaxima ||
        input.quantity === input.expectedQuantity
      )
        throw new StoreOrderError(409, 'STORE_ORDER_CONFLICT');
      const amountCents = product.precoCentavos * input.quantity;
      if (
        current.gatewayPayment?.source !== 'infinitepay' ||
        current.paymentCondition !== 'pix' ||
        !Number.isSafeInteger(current.gatewayPayment?.paidAmountCents) ||
        current.gatewayPayment.paidAmountCents < amountCents
      )
        throw new StoreOrderError(422, 'AMOUNT_BELOW_PRICE');
      const marker = createHash('sha256')
        .update(
          JSON.stringify([
            input.actor.id,
            input.idempotencyKey,
            input.orderId,
            input.expectedVersion,
            input.expectedQuantity,
            input.expectedAmountCents,
            input.quantity,
            input.reason,
          ]),
        )
        .digest('hex');
      return repository.correctStoreOrder({
        ...input,
        amountCents,
        marker,
        now: clock(),
      });
    },
  };
}
