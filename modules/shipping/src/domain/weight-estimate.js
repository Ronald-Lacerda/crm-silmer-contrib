import { ShippingValidationError } from './errors.js';
import { isFilledString, isPositiveInteger } from './guards.js';
import { createPackageType } from './package-type.js';

/**
 * @typedef {{garmentType: string, pieces: number}} EstimateItem
 * @typedef {{packageTypeId: string, pieces: number, weightGrams: number}}
 *   EstimatedPackage
 * @typedef {{
 *   totalPieces: number,
 *   contentGrams: number,
 *   packageCount: number,
 *   packages: readonly Readonly<EstimatedPackage>[],
 *   totalGrams: number,
 * }} ShipmentEstimate
 */

/**
 * MEV-02/04: the weight a quote uses before anything is weighed. Pieces go
 * into the fewest packages of the standard type whose content stays within
 * `maxLoadGrams` (the tare is added on top), spread as evenly as possible.
 *
 * @param {{
 *   items: readonly EstimateItem[],
 *   weightTable: Readonly<Record<string, number>>,
 *   packageType: import('./package-type.js').PackageType,
 * }} input
 * @returns {Readonly<ShipmentEstimate>}
 */
export function estimateShipment({ items, weightTable, packageType }) {
  const type = createPackageType(packageType);
  const groups = gramsPerPieceGroups(items, weightTable ?? {});
  const totalPieces = groups.reduce((sum, group) => sum + group.count, 0);
  const contentGrams = groups.reduce(
    (sum, group) => sum + group.count * group.grams,
    0,
  );

  const tooHeavy = [
    ...new Set(
      groups
        .filter((group) => group.grams > type.maxLoadGrams)
        .flatMap((group) => group.garmentTypes),
    ),
  ];
  if (tooHeavy.length > 0) {
    throw new ShippingValidationError(
      'Uma peça sozinha passa da carga máxima da embalagem.',
      'PIECE_TOO_HEAVY',
      tooHeavy,
    );
  }

  let count = Math.max(1, Math.ceil(contentGrams / type.maxLoadGrams));
  let loads = distribute(groups, count);
  while (loads.some((load) => load.grams > type.maxLoadGrams)) {
    count += 1;
    loads = distribute(groups, count);
  }

  const packages = loads.map((load) =>
    Object.freeze({
      packageTypeId: type.id,
      pieces: load.pieces,
      weightGrams: load.grams + type.tareGrams,
    }),
  );
  return Object.freeze({
    totalPieces,
    contentGrams,
    packageCount: packages.length,
    packages: Object.freeze(packages),
    totalGrams: packages.reduce((sum, pkg) => sum + pkg.weightGrams, 0),
  });
}

/**
 * Pieces grouped by weight, heaviest first, so a round-robin deal keeps both
 * the piece counts and the weights close between packages.
 *
 * @param {readonly EstimateItem[]} items
 * @param {Readonly<Record<string, number>>} weightTable
 * @returns {{grams: number, count: number, garmentTypes: string[]}[]}
 */
function gramsPerPieceGroups(items, weightTable) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ShippingValidationError(
      'Informe ao menos uma peça para estimar o peso.',
      'NO_PIECES',
      ['items'],
    );
  }
  /** @type {string[]} */
  const invalid = [];
  const unknown = new Set();
  /** @type {Map<number, {grams: number, count: number, garmentTypes: string[]}>} */
  const byGrams = new Map();
  items.forEach((item, index) => {
    if (!isFilledString(item?.garmentType)) {
      invalid.push(`items[${index}].garmentType`);
    }
    if (!isPositiveInteger(item?.pieces))
      invalid.push(`items[${index}].pieces`);
    if (!isFilledString(item?.garmentType)) return;
    const grams = Object.hasOwn(weightTable, item.garmentType)
      ? weightTable[item.garmentType]
      : undefined;
    if (!isPositiveInteger(grams)) {
      unknown.add(item.garmentType);
      return;
    }
    if (!isPositiveInteger(item.pieces)) return;
    const group = byGrams.get(grams) ?? { grams, count: 0, garmentTypes: [] };
    group.count += item.pieces;
    if (!group.garmentTypes.includes(item.garmentType)) {
      group.garmentTypes.push(item.garmentType);
    }
    byGrams.set(grams, group);
  });
  if (invalid.length > 0) {
    throw new ShippingValidationError(
      'Cada linha precisa de tipo de peça e quantidade.',
      'INVALID_ESTIMATE_ITEMS',
      invalid,
    );
  }
  if (unknown.size > 0) {
    throw new ShippingValidationError(
      'Cadastre o peso por peça destes tipos no menu Melhor Envio.',
      'UNKNOWN_GARMENT_WEIGHT',
      [...unknown],
    );
  }
  return [...byGrams.values()].sort((a, b) => b.grams - a.grams);
}

/**
 * @param {readonly {grams: number, count: number}[]} groups
 * @param {number} count
 */
function distribute(groups, count) {
  const loads = Array.from({ length: count }, () => ({ pieces: 0, grams: 0 }));
  let next = 0;
  for (const group of groups) {
    for (let piece = 0; piece < group.count; piece += 1) {
      loads[next].pieces += 1;
      loads[next].grams += group.grams;
      next = (next + 1) % count;
    }
  }
  return loads;
}
