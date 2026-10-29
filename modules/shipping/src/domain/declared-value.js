import { ShippingValidationError } from './errors.js';
import { isNonNegativeInteger, isPositiveInteger } from './guards.js';

/**
 * MEV-06/09: the pieces value split across packages by piece count. Each
 * package gets the floor of its share and the leftover cents go, one each, to
 * the largest remainders (ties to the first package), so the sum is exact.
 *
 * @param {{piecesValueCents: number, packagePieces: readonly number[]}} input
 * @returns {readonly number[]} integer cents per package
 */
export function allocateDeclaredValue({ piecesValueCents, packagePieces }) {
  if (!isNonNegativeInteger(piecesValueCents)) {
    throw new ShippingValidationError(
      'O valor das peças precisa estar em centavos inteiros.',
      'INVALID_PIECES_VALUE',
      ['piecesValueCents'],
    );
  }
  if (
    !Array.isArray(packagePieces) ||
    packagePieces.length === 0 ||
    !packagePieces.every(isPositiveInteger)
  ) {
    throw new ShippingValidationError(
      'Cada embalagem precisa ter ao menos uma peça.',
      'NO_PIECES',
      ['packagePieces'],
    );
  }
  const totalPieces = packagePieces.reduce((sum, pieces) => sum + pieces, 0);
  if (!Number.isSafeInteger(piecesValueCents * totalPieces)) {
    throw new ShippingValidationError(
      'Valor ou quantidade grande demais para ratear.',
      'INVALID_PIECES_VALUE',
      ['piecesValueCents'],
    );
  }
  const shares = packagePieces.map((pieces, index) => {
    const exact = piecesValueCents * pieces;
    return {
      index,
      cents: Math.floor(exact / totalPieces),
      remainder: exact % totalPieces,
    };
  });
  let leftover =
    piecesValueCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (const share of byRemainder) {
    if (leftover === 0) break;
    share.cents += 1;
    leftover -= 1;
  }
  return Object.freeze(shares.map((share) => share.cents));
}

/**
 * MEV-09: the product lines of one package, whose sum is exactly the
 * package's allocated cents (its insurance). `quantity - r` units carry
 * floor(value / quantity) and the remaining `r` units carry one cent more;
 * empty lines are left out.
 *
 * @param {{valueCents: number, quantity: number}} input
 * @returns {readonly Readonly<{quantity: number, unitValueCents: number}>[]}
 */
export function splitPackageValue({ valueCents, quantity }) {
  if (!isNonNegativeInteger(valueCents)) {
    throw new ShippingValidationError(
      'O valor da embalagem precisa estar em centavos inteiros.',
      'INVALID_PIECES_VALUE',
      ['valueCents'],
    );
  }
  if (!isPositiveInteger(quantity)) {
    throw new ShippingValidationError(
      'Cada embalagem precisa ter ao menos uma peça.',
      'NO_PIECES',
      ['quantity'],
    );
  }
  const base = Math.floor(valueCents / quantity);
  const remainder = valueCents - base * quantity;
  return Object.freeze(
    [
      { quantity: quantity - remainder, unitValueCents: base },
      { quantity: remainder, unitValueCents: base + 1 },
    ]
      .filter((line) => line.quantity > 0)
      .map((line) => Object.freeze(line)),
  );
}

/**
 * MEV-06/09: the average unit value, rounded half up, for display only (the
 * screen and the reminder). Never use it for the cart products: quantity
 * times this value does not add up to the insurance; use splitPackageValue.
 *
 * @param {number} piecesValueCents
 * @param {number} totalPieces
 * @returns {number} integer cents
 */
export function unitValueCents(piecesValueCents, totalPieces) {
  if (!isNonNegativeInteger(piecesValueCents)) {
    throw new ShippingValidationError(
      'O valor das peças precisa estar em centavos inteiros.',
      'INVALID_PIECES_VALUE',
      ['piecesValueCents'],
    );
  }
  if (!isPositiveInteger(totalPieces)) {
    throw new ShippingValidationError(
      'Informe ao menos uma peça.',
      'NO_PIECES',
      ['totalPieces'],
    );
  }
  return Math.floor((2 * piecesValueCents + totalPieces) / (2 * totalPieces));
}
