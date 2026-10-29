import { ShippingValidationError } from './errors.js';
import {
  deepFreeze,
  isFilledString,
  isNonNegativeInteger,
  isPositiveInteger,
  onlyDigits,
} from './guards.js';
import { normalizePostalCode } from './postal-code.js';

// Bodies for the Melhor Envio API v2 (RFC 038 section 9). The API takes
// centimetres as integers, kilograms as decimals and money as decimal reais;
// the domain keeps grams and cents and converts only here.

/**
 * @typedef {{lengthCm: number, widthCm: number, heightCm: number,
 *   weightGrams: number}} Volume
 * @typedef {{
 *   name?: string, document?: string, companyDocument?: string,
 *   stateRegister?: string, email?: string, phone?: string,
 *   address?: string, complement?: string, number?: string | number,
 *   district?: string, city?: string, stateAbbr?: string,
 *   postalCode?: string,
 * }} Party
 */

const CPF_DIGITS = 11;
const CNPJ_DIGITS = 14;
const INVOICE_KEY_DIGITS = 44;
const VOLUME_FIELDS = ['lengthCm', 'widthCm', 'heightCm', 'weightGrams'];

/**
 * RFC 038 section 9: PAC insures up to R$ 3.000,00. A documented default
 * only: the real cap comes per service from /me/shipment/services and is
 * passed as `maxInsuranceCents`; nothing here applies it implicitly.
 */
export const PAC_MAX_INSURANCE_CENTS = 300000;

/**
 * Mod-11 check digit over the first `length` characters; weights count down
 * from `firstWeight` to 2 and wrap to `maxWeight` (CPF never wraps, CNPJ
 * does). Each character is worth its char code minus 48, so digits keep their
 * value and the alphanumeric CNPJ letters (from July 2026) count A = 17.
 *
 * @param {string} characters
 * @param {number} length
 * @param {number} firstWeight
 * @param {number} maxWeight
 */
function mod11Weighted(characters, length, firstWeight, maxWeight) {
  let sum = 0;
  let weight = firstWeight;
  for (let index = 0; index < length; index += 1) {
    sum += (characters.charCodeAt(index) - 48) * weight;
    weight = weight === 2 ? maxWeight : weight - 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * The CNPJ may be alphanumeric since July 2026: keep letters and digits,
 * uppercase, and drop the mask.
 *
 * @param {unknown} value
 */
function cnpjCharacters(value) {
  return typeof value === 'string'
    ? value.toUpperCase().replace(/[^0-9A-Z]/gu, '')
    : onlyDigits(value);
}

/** @param {string} digits only digits */
function isValidCpf(digits) {
  if (digits.length !== CPF_DIGITS || /^(\d)\1+$/u.test(digits)) return false;
  return (
    mod11Weighted(digits, 9, 10, 10) === Number(digits[9]) &&
    mod11Weighted(digits, 10, 11, 11) === Number(digits[10])
  );
}

/** @param {string} characters from `cnpjCharacters` */
function isValidCnpj(characters) {
  if (
    characters.length !== CNPJ_DIGITS ||
    !/^[0-9A-Z]{12}\d{2}$/u.test(characters) ||
    /^(.)\1+$/u.test(characters)
  ) {
    return false;
  }
  return (
    mod11Weighted(characters, 12, 5, 9) === Number(characters[12]) &&
    mod11Weighted(characters, 13, 6, 9) === Number(characters[13])
  );
}

/** @param {number} cents */
const reais = (cents) => cents / 100;

/** @param {number} grams */
const kilograms = (grams) => grams / 1000;

/** @param {unknown} value */
function isValidPostalCode(value) {
  try {
    normalizePostalCode(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} volume
 * @param {string} prefix
 * @returns {string[]}
 */
function invalidVolumeFields(volume, prefix) {
  const source = /** @type {Record<string, unknown>} */ (volume ?? {});
  return VOLUME_FIELDS.filter((field) => !isPositiveInteger(source[field])).map(
    (field) => `${prefix}${field}`,
  );
}

/** @param {Volume} volume */
function toApiVolume(volume) {
  return {
    height: volume.heightCm,
    width: volume.widthCm,
    length: volume.lengthCm,
    weight: kilograms(volume.weightGrams),
  };
}

/**
 * MEV-02: body for POST /api/v2/me/shipment/calculate.
 *
 * @param {{
 *   fromPostalCode: string,
 *   toPostalCode: string,
 *   packages: readonly (Volume & {insuranceCents: number})[],
 *   serviceIds?: readonly number[],
 *   maxInsuranceCents?: number,
 * }} input `maxInsuranceCents` is the service's cap, checked per package
 *   since each package becomes its own label.
 */
export function buildQuoteRequest({
  fromPostalCode,
  toPostalCode,
  packages,
  serviceIds,
  maxInsuranceCents,
}) {
  const badPostalCodes = [];
  if (!isValidPostalCode(fromPostalCode)) badPostalCodes.push('fromPostalCode');
  if (!isValidPostalCode(toPostalCode)) badPostalCodes.push('toPostalCode');
  if (badPostalCodes.length > 0) {
    throw new ShippingValidationError(
      'Informe um CEP com 8 dígitos.',
      'INVALID_POSTAL_CODE',
      badPostalCodes,
    );
  }
  const list = Array.isArray(packages) ? packages : [];
  const fields = list.length === 0 ? ['packages'] : [];
  list.forEach((pkg, index) => {
    fields.push(...invalidVolumeFields(pkg, `packages[${index}].`));
    if (!isNonNegativeInteger(pkg?.insuranceCents)) {
      fields.push(`packages[${index}].insuranceCents`);
    }
  });
  if (!isValidInsuranceCap(maxInsuranceCents)) {
    fields.push('maxInsuranceCents');
  }
  if (fields.length > 0) {
    throw new ShippingValidationError(
      'Confira medidas, peso e valor segurado das embalagens.',
      'INVALID_QUOTE_PACKAGES',
      fields,
    );
  }
  if (
    serviceIds !== undefined &&
    (!Array.isArray(serviceIds) || !serviceIds.every(isPositiveInteger))
  ) {
    throw new ShippingValidationError(
      'Serviços de transporte inválidos.',
      'INVALID_SERVICE_IDS',
      ['serviceIds'],
    );
  }
  // TODO(ME-0 sandbox): confirm whether calculate caps the summed value too.
  const aboveCap = list
    .map((pkg, index) =>
      exceedsInsuranceCap(pkg.insuranceCents, maxInsuranceCents)
        ? `packages[${index}].insuranceCents`
        : null,
    )
    .filter((field) => field !== null);
  if (aboveCap.length > 0) throw insuranceAboveLimit(aboveCap);
  const insuranceCents = list.reduce((sum, pkg) => sum + pkg.insuranceCents, 0);
  return deepFreeze({
    from: { postal_code: normalizePostalCode(fromPostalCode) },
    to: { postal_code: normalizePostalCode(toPostalCode) },
    volumes: list.map(toApiVolume),
    options: {
      insurance_value: reais(insuranceCents),
      receipt: false,
      own_hand: false,
    },
    ...(serviceIds?.length ? { services: serviceIds.join(',') } : {}),
  });
}

/** @param {unknown} value */
function isValidInsuranceCap(value) {
  return value === undefined || isNonNegativeInteger(value);
}

/** @param {number} cents @param {number|undefined} cap */
function exceedsInsuranceCap(cents, cap) {
  return cap !== undefined && cents > cap;
}

/** @param {readonly string[]} fields */
function insuranceAboveLimit(fields) {
  return new ShippingValidationError(
    'O valor segurado passa do limite do serviço de transporte.',
    'INSURANCE_ABOVE_LIMIT',
    fields,
  );
}

/**
 * MEV-08: what is missing or invalid for a label, shown as "Etiqueta
 * pendente". Exactly one of `document` (CPF) or `companyDocument` (CNPJ) is
 * required; with both, a wrong length or wrong check digits, the offending
 * field(s) are listed.
 *
 * @param {Party | null | undefined} party
 * @returns {readonly string[]}
 */
export function missingRecipientFields(party) {
  const source = party ?? {};
  const missing = [];
  if (!isFilledString(source.name)) missing.push('name');
  const cpf = onlyDigits(source.document);
  const cnpj = cnpjCharacters(source.companyDocument);
  if (cpf && cnpj) missing.push('document', 'companyDocument');
  else if (cnpj) {
    if (!isValidCnpj(cnpj)) missing.push('companyDocument');
  } else if (!isValidCpf(cpf)) missing.push('document');
  if (!isFilledString(source.address)) missing.push('address');
  const number =
    typeof source.number === 'number' ? String(source.number) : source.number;
  if (!isFilledString(number)) missing.push('number');
  if (!isFilledString(source.district)) missing.push('district');
  if (!isFilledString(source.city)) missing.push('city');
  if (
    typeof source.stateAbbr !== 'string' ||
    !/^[A-Za-z]{2}$/u.test(source.stateAbbr.trim())
  ) {
    missing.push('stateAbbr');
  }
  if (!isValidPostalCode(source.postalCode)) missing.push('postalCode');
  if (onlyDigits(source.phone).length < 10) missing.push('phone');
  return Object.freeze(missing);
}

/**
 * The sender is the Silmer registration in the Melhor Envio menu. A
 * commercial shipment (with NF-e) also needs the state registration (IE).
 *
 * @param {Party | null | undefined} party
 * @param {{commercial?: boolean}} [options]
 * @returns {readonly string[]}
 */
export function missingSenderFields(party, { commercial = false } = {}) {
  const missing = [...missingRecipientFields(party)];
  if (commercial && !isFilledString(party?.stateRegister)) {
    missing.push('stateRegister');
  }
  return Object.freeze(missing);
}

/** @param {Party} party */
function toApiParty(party) {
  const cnpj = cnpjCharacters(party.companyDocument);
  const optional = {
    email: party.email?.trim(),
    complement: party.complement?.trim(),
    state_register: cnpj ? party.stateRegister?.trim() : undefined,
  };
  return {
    name: /** @type {string} */ (party.name).trim(),
    phone: onlyDigits(party.phone),
    ...(cnpj
      ? { company_document: cnpj }
      : { document: onlyDigits(party.document) }),
    address: /** @type {string} */ (party.address).trim(),
    number: String(party.number).trim(),
    district: /** @type {string} */ (party.district).trim(),
    city: /** @type {string} */ (party.city).trim(),
    state_abbr: /** @type {string} */ (party.stateAbbr).trim().toUpperCase(),
    country_id: 'BR',
    postal_code: normalizePostalCode(party.postalCode),
    ...Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value),
    ),
  };
}

/**
 * MEV-07/08/09/14: body for POST /api/v2/me/cart, one per package because
 * Correios, J&T and Loggi take a single volume per cart item. Without an
 * NF-e key the shipment is non-commercial and Melhor Envio issues the DC-e.
 * `packageIndex` is zero-based; the reminder prints it one-based.
 *
 * The products must add up to the package insurance to the cent (build them
 * with splitPackageValue); the same name may repeat with different unit
 * values. `maxInsuranceCents` is the service's cap, when known.
 *
 * @param {{
 *   serviceId: number,
 *   sender: Party,
 *   recipient: Party,
 *   pkg: Volume,
 *   products: readonly {name: string, quantity: number,
 *     unitValueCents: number}[],
 *   insuranceCents: number,
 *   invoiceKey?: string | null,
 *   orderId: string,
 *   orderNumber: string,
 *   packageIndex: number,
 *   packageCount: number,
 *   maxInsuranceCents?: number,
 * }} input
 */
export function buildCartItem({
  serviceId,
  sender,
  recipient,
  pkg,
  products,
  insuranceCents,
  invoiceKey,
  orderId,
  orderNumber,
  packageIndex,
  packageCount,
  maxInsuranceCents,
}) {
  const key = invoiceKey ? onlyDigits(invoiceKey) : '';
  const senderMissing = missingSenderFields(sender, { commercial: !!key });
  if (senderMissing.length > 0) {
    throw new ShippingValidationError(
      'Complete o remetente no menu Melhor Envio.',
      'SENDER_INCOMPLETE',
      senderMissing,
    );
  }
  const recipientMissing = missingRecipientFields(recipient);
  if (recipientMissing.length > 0) {
    throw new ShippingValidationError(
      'Faltam dados do destinatário para a etiqueta.',
      'RECIPIENT_INCOMPLETE',
      recipientMissing,
    );
  }
  if (invoiceKey && key.length !== INVOICE_KEY_DIGITS) {
    throw new ShippingValidationError(
      'A chave da NF-e tem 44 dígitos.',
      'INVALID_INVOICE_KEY',
      ['invoiceKey'],
    );
  }

  const fields = [];
  if (!isPositiveInteger(serviceId)) fields.push('serviceId');
  fields.push(...invalidVolumeFields(pkg, 'pkg.'));
  const productList = Array.isArray(products) ? products : [];
  if (productList.length === 0) fields.push('products');
  productList.forEach((product, index) => {
    if (!isFilledString(product?.name)) fields.push(`products[${index}].name`);
    if (!isPositiveInteger(product?.quantity)) {
      fields.push(`products[${index}].quantity`);
    }
    if (!isNonNegativeInteger(product?.unitValueCents)) {
      fields.push(`products[${index}].unitValueCents`);
    }
  });
  if (!isNonNegativeInteger(insuranceCents)) fields.push('insuranceCents');
  if (!isFilledString(orderId)) fields.push('orderId');
  if (!isFilledString(orderNumber)) fields.push('orderNumber');
  if (!isPositiveInteger(packageCount)) fields.push('packageCount');
  if (
    !isNonNegativeInteger(packageIndex) ||
    (isPositiveInteger(packageCount) && packageIndex >= packageCount)
  ) {
    fields.push('packageIndex');
  }
  if (!isValidInsuranceCap(maxInsuranceCents)) {
    fields.push('maxInsuranceCents');
  }
  if (fields.length > 0) {
    throw new ShippingValidationError(
      'Dados da embalagem incompletos para comprar a etiqueta.',
      'INVALID_CART_ITEM',
      fields,
    );
  }
  const productsCents = productList.reduce(
    (sum, product) => sum + product.quantity * product.unitValueCents,
    0,
  );
  if (productsCents !== insuranceCents) {
    throw new ShippingValidationError(
      'O valor das peças não fecha com o valor segurado da embalagem.',
      'DECLARED_VALUE_MISMATCH',
      ['products', 'insuranceCents'],
    );
  }
  if (exceedsInsuranceCap(insuranceCents, maxInsuranceCents)) {
    throw insuranceAboveLimit(['insuranceCents']);
  }

  const position = `${packageIndex + 1}/${packageCount}`;
  return deepFreeze({
    service: serviceId,
    from: toApiParty(sender),
    to: toApiParty(recipient),
    products: productList.map((product) => ({
      name: product.name.trim(),
      quantity: String(product.quantity),
      unitary_value: reais(product.unitValueCents).toFixed(2),
    })),
    volumes: [toApiVolume(pkg)],
    options: {
      insurance_value: reais(insuranceCents),
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: !key,
      ...(key ? { invoice: { key } } : {}),
      reminder: `Pedido ${orderNumber.trim()} · Embalagem ${position}`,
      tags: [{ tag: orderId, url: null }],
    },
  });
}

/**
 * MEV-07: the idempotency key of one label purchase. A new packing version
 * buys new labels; a retry of the same version never buys twice.
 *
 * @param {{orderId: string, packingVersion: number, packageIndex: number}}
 *   input
 * @returns {string}
 */
export function labelPurchaseKey({ orderId, packingVersion, packageIndex }) {
  const fields = [];
  if (!isFilledString(orderId) || orderId.includes(':')) fields.push('orderId');
  if (!isPositiveInteger(packingVersion)) fields.push('packingVersion');
  if (!isNonNegativeInteger(packageIndex)) fields.push('packageIndex');
  if (fields.length > 0) {
    throw new ShippingValidationError(
      'Chave de compra da etiqueta inválida.',
      'INVALID_PURCHASE_KEY',
      fields,
    );
  }
  return `me:label:${orderId}:v${packingVersion}:${packageIndex}`;
}
