import { ShippingValidationError } from './errors.js';
import { deepFreeze, isPositiveInteger } from './guards.js';
import {
  CORREIOS_LIMITS,
  checkCarrierLimits,
  createPackageType,
} from './package-type.js';

/**
 * @typedef {{size: string, quantity: number}} GradeLine
 * @typedef {{index: number, grade: readonly GradeLine[]}} PackingItem
 * @typedef {{itemIndex: number, size: string, quantity: number}} PackageContent
 * @typedef {{packageTypeId: string, weightGrams: number,
 *   contents: readonly PackageContent[]}} PackingPackage
 * @typedef {{code: string, field: string, reasons?: readonly string[]}}
 *   PackingProblem
 */

/**
 * MEV-06: the packages a shipping clerk filled, checked against the order's
 * grade. Every problem is collected first, then one error lists them all so
 * the page can mark each field at once. When the problems share a code the
 * error keeps it, otherwise it is `PACKING_INVALID`; `problems` has the detail.
 *
 * @param {{
 *   items: readonly PackingItem[],
 *   packages: readonly PackingPackage[],
 *   packageTypes: readonly import('./package-type.js').PackageType[],
 *   limits?: import('./package-type.js').CarrierLimits,
 * }} input
 */
export function validatePacking({
  items,
  packages,
  packageTypes,
  limits = CORREIOS_LIMITS,
}) {
  const types = new Map(
    (packageTypes ?? []).map((type) => {
      const valid = createPackageType(type);
      return [valid.id, valid];
    }),
  );
  /** @type {PackingProblem[]} */
  const problems = [];
  if (!Array.isArray(packages) || packages.length === 0) {
    problems.push({ code: 'NO_PACKAGES', field: 'packages' });
  }

  /** @type {Map<string, {itemIndex: number, size: string, expected: number, packed: number}>} */
  const lines = new Map();
  /** @param {number} itemIndex @param {string} size */
  const lineFor = (itemIndex, size) => {
    const key = JSON.stringify([itemIndex, size]);
    const line = lines.get(key) ?? { itemIndex, size, expected: 0, packed: 0 };
    lines.set(key, line);
    return line;
  };
  for (const item of items ?? []) {
    for (const { size, quantity } of item.grade ?? []) {
      lineFor(item.index, size).expected += quantity;
    }
  }

  const checked = (Array.isArray(packages) ? packages : []).map((pkg, i) => {
    const at = `packages[${i}]`;
    const type = types.get(pkg?.packageTypeId);
    if (!type) {
      problems.push({
        code: 'UNKNOWN_PACKAGE_TYPE',
        field: `${at}.packageTypeId`,
      });
    }
    const weightValid = isPositiveInteger(pkg?.weightGrams);
    if (!weightValid) {
      problems.push({ code: 'INVALID_WEIGHT', field: `${at}.weightGrams` });
    }
    /** @type {readonly PackageContent[]} */
    const contents = Array.isArray(pkg?.contents) ? pkg.contents : [];
    let pieces = 0;
    contents.forEach((content, j) => {
      if (!isPositiveInteger(content?.quantity)) {
        problems.push({
          code: 'INVALID_QUANTITY',
          field: `${at}.contents[${j}].quantity`,
        });
        return;
      }
      pieces += content.quantity;
      lineFor(content.itemIndex, content.size).packed += content.quantity;
    });
    if (pieces === 0) {
      problems.push({ code: 'EMPTY_PACKAGE', field: `${at}.contents` });
    }
    if (type && weightValid) {
      if (pkg.weightGrams > type.maxLoadGrams + type.tareGrams) {
        problems.push({
          code: 'PACKAGE_OVER_LOAD',
          field: `${at}.weightGrams`,
        });
      }
      const carrier = checkCarrierLimits(
        {
          lengthCm: type.lengthCm,
          widthCm: type.widthCm,
          heightCm: type.heightCm,
          weightGrams: pkg.weightGrams,
        },
        limits,
      );
      if (!carrier.fits) {
        problems.push({
          code: 'CARRIER_LIMIT',
          field: at,
          reasons: carrier.reasons,
        });
      }
    }
    return {
      packageTypeId: pkg?.packageTypeId,
      weightGrams: pkg?.weightGrams,
      contents: contents.map((content) => ({ ...content })),
      pieces,
    };
  });

  for (const line of lines.values()) {
    if (line.expected !== line.packed) {
      problems.push({
        code: 'PACKING_MISMATCH',
        field: `items[${line.itemIndex}].grade.${line.size}`,
      });
    }
  }

  if (problems.length > 0) throw packingError(problems);
  return deepFreeze({
    totalPieces: checked.reduce((sum, pkg) => sum + pkg.pieces, 0),
    packages: checked,
  });
}

/** @param {readonly PackingProblem[]} problems */
function packingError(problems) {
  const codes = new Set(problems.map((problem) => problem.code));
  const code = codes.size === 1 ? problems[0].code : 'PACKING_INVALID';
  const error = new ShippingValidationError(
    'Confira as embalagens: o conteúdo, o peso ou as medidas não fecham.',
    code,
    [...new Set(problems.map((problem) => problem.field))],
  );
  return Object.assign(error, { problems: deepFreeze([...problems]) });
}
