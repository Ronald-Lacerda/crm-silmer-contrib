import {
  normalizeContactRegistration,
  normalizeContactEmail,
  normalizeContactPhone,
} from '@crm-silmer/contacts';
import { OlistError, integer, text } from './errors.js';

const ATTRIBUTES = [
  'garment',
  'color',
  'fabric',
  'application',
  'collar',
  'audience',
];
const CUSTOMER_FIELDS = [
  'tipoPessoa',
  'cpfCnpj',
  'nome',
  'celular',
  'email',
  'inscricaoEstadual',
  'endereco',
  'situacao',
];
const ADDRESS_FIELDS = [
  'cep',
  'municipio',
  'uf',
  'endereco',
  'bairro',
  'numero',
  'complemento',
];
/** @param {unknown} value @param {string[]} allowed @param {string[]} required */
function record(value, allowed, required = allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new OlistError('INVALID_REQUEST', 400);
  const entry = /** @type {Record<string,any>} */ (value);
  if (
    Object.keys(entry).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(entry, key))
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return entry;
}
/** @param {unknown} value */
function reference(value) {
  const result = text(value, 100);
  if (!/^CRM-[A-Za-z0-9-]+$/u.test(result))
    throw new OlistError('INVALID_REQUEST', 400);
  return result;
}
/** @param {unknown} value */
function sku(value) {
  return reference(value);
}
/** @param {unknown} value */
function size(value) {
  return text(value, 200).normalize('NFC');
}
/** Canonical description shared with read-only verification; no free-form notes.
 * @param {unknown} attributes */
export function productDescription(attributes) {
  const value = record(attributes, ATTRIBUTES);
  return ATTRIBUTES.map((field) =>
    field === 'audience' && value[field] === ''
      ? ''
      : text(value[field], field === 'fabric' ? 12000 : 200).normalize('NFC'),
  )
    .filter((value) => value !== '')
    .join(' | ');
}
/** @param {unknown} fiscal */
function fiscalFields(fiscal) {
  const value = record(fiscal, ['ncm', 'origin', 'unit']);
  const ncm = text(value.ncm, 12).replace(/[.\s]/gu, '');
  if (
    !/^\d{8}$/u.test(ncm) ||
    !Number.isSafeInteger(value.origin) ||
    value.origin < 0 ||
    value.origin > 8
  )
    throw new OlistError('OLIST_PRODUCT_FISCAL_REQUIRED', 409);
  return {
    ncm,
    origem: integer(value.origin, true),
    unidade: text(value.unit, 20).normalize('NFC'),
  };
}
/** Official customer allowlist; a buyer never receives ERP system access.
 * @param {unknown} customer */
function customerPayload(customer) {
  const value = record(customer, CUSTOMER_FIELDS, [
    'tipoPessoa',
    'cpfCnpj',
    'nome',
    'celular',
    'endereco',
    'situacao',
  ]);
  if (!['F', 'J'].includes(value.tipoPessoa) || value.situacao !== 'B')
    throw new OlistError('INVALID_REQUEST', 400);
  const address = record(
    value.endereco,
    ADDRESS_FIELDS,
    ADDRESS_FIELDS.filter((key) => key !== 'complemento'),
  );
  const registration = normalizeContactRegistration({
    personType: value.tipoPessoa === 'F' ? 'individual' : 'company',
    document: value.cpfCnpj,
    legalName: value.nome,
    stateRegistration: value.inscricaoEstadual,
    postalCode: address.cep,
    city: address.municipio,
    state: address.uf,
    street: address.endereco,
    district: address.bairro,
    number: address.numero,
    complement: address.complemento,
  });
  if (!registration.ok || !registration.fieldsComplete)
    throw new OlistError('OLIST_CUSTOMER_INVALID', 409);
  const phone = normalizeContactPhone(value.celular);
  const email = normalizeContactEmail(value.email);
  if (!phone || email === undefined)
    throw new OlistError('OLIST_CUSTOMER_INVALID', 409);
  const normalized = registration.value;
  return {
    tipoPessoa: value.tipoPessoa,
    cpfCnpj: normalized.document,
    nome: normalized.legalName,
    celular: phone,
    ...(email ? { email } : {}),
    ...(normalized.stateRegistration
      ? { inscricaoEstadual: normalized.stateRegistration }
      : {}),
    endereco: {
      cep: normalized.postalCode,
      municipio: normalized.city,
      uf: normalized.state,
      endereco: normalized.street,
      bairro: normalized.district,
      numero: normalized.number,
      ...(normalized.complement ? { complemento: normalized.complement } : {}),
    },
    situacao: 'B',
  };
}
/** Stable reference stays local: phase-one proof did not accept customer codigo.
 * @param {unknown} customer @param {string} stableReference */
export function buildCustomerPayload(customer, stableReference) {
  reference(stableReference);
  return customerPayload(customer);
}
/** @param {{size:string,sku:string,fiscal?:unknown}} input */
export function buildVariationPayload(input) {
  const value = record(input, ['size', 'sku', 'fiscal'], ['size', 'sku']);
  if (value.fiscal !== undefined) fiscalFields(value.fiscal); // Validate explicit policy; official variation inherits parent fiscal fields.
  return {
    sku: sku(value.sku),
    grade: [{ chave: 'Tamanho', valor: size(value.size) }],
  };
}
/** A parent V must be created with the complete initial variation batch.
 * No price, stock, tax default or silent extra fields are synthesized.
 * @param {{attributes:unknown,sku:string,fiscal:unknown,variations:{size:string,sku:string}[]}} input */
export function buildProductPayload(input) {
  const value = record(input, ['attributes', 'sku', 'fiscal', 'variations']);
  if (
    !Array.isArray(value.variations) ||
    value.variations.length < 1 ||
    value.variations.length > 250 ||
    Object.keys(value.variations).length !== value.variations.length
  )
    throw new OlistError('INVALID_REQUEST', 400);
  const variations = value.variations.map((/** @type {any} */ variation) =>
    buildVariationPayload(variation),
  );
  const sizes = variations.map((variation) =>
    variation.grade[0].valor.toLocaleLowerCase('pt-BR'),
  );
  if (
    new Set(variations.map((variation) => variation.sku)).size !==
      variations.length ||
    new Set(sizes).size !== sizes.length
  )
    throw new OlistError('INVALID_REQUEST', 400);
  return {
    sku: sku(value.sku),
    tipo: 'V',
    descricao: productDescription(value.attributes),
    ...fiscalFields(value.fiscal),
    grade: ['Tamanho'],
    variacoes: variations,
  };
}
/** Strict official shape validation at the writer boundary. Inputs are copied,
 * stripped of prototype tricks, validated and later frozen before reservation.
 * @param {string} kind @param {unknown} raw @returns {any} */
export function validateResourcePayload(kind, raw) {
  if (kind === 'customer') {
    const value = record(raw, CUSTOMER_FIELDS, [
      'tipoPessoa',
      'cpfCnpj',
      'nome',
      'celular',
      'endereco',
      'situacao',
    ]);
    return customerPayload(value);
  }
  if (kind === 'variation') {
    const value = record(raw, ['sku', 'grade']);
    if (!Array.isArray(value.grade) || value.grade.length !== 1)
      throw new OlistError('INVALID_REQUEST', 400);
    const grade = record(value.grade[0], ['chave', 'valor']);
    if (grade.chave !== 'Tamanho') throw new OlistError('INVALID_REQUEST', 400);
    return buildVariationPayload({ sku: value.sku, size: grade.valor });
  }
  if (kind === 'product') {
    const value = record(raw, [
      'sku',
      'tipo',
      'descricao',
      'ncm',
      'origem',
      'unidade',
      'grade',
      'variacoes',
    ]);
    if (
      value.tipo !== 'V' ||
      !Array.isArray(value.grade) ||
      value.grade.length !== 1 ||
      value.grade[0] !== 'Tamanho' ||
      !Array.isArray(value.variacoes) ||
      value.variacoes.length < 1 ||
      value.variacoes.length > 250 ||
      Object.keys(value.variacoes).length !== value.variacoes.length
    )
      throw new OlistError('INVALID_REQUEST', 400);
    const variations = value.variacoes.map(
      (/** @type {unknown} */ variation) =>
        /** @type {{sku:string,grade:{chave:string,valor:string}[]}} */ (
          validateResourcePayload('variation', variation)
        ),
    );
    if (
      new Set(variations.map((variation) => variation.sku)).size !==
        variations.length ||
      new Set(
        variations.map((variation) =>
          variation.grade[0].valor.toLocaleLowerCase('pt-BR'),
        ),
      ).size !== variations.length
    )
      throw new OlistError('INVALID_REQUEST', 400);
    return {
      sku: sku(value.sku),
      tipo: 'V',
      descricao: text(value.descricao, 14000).normalize('NFC'),
      ...fiscalFields({
        ncm: value.ncm,
        origin: value.origem,
        unit: value.unidade,
      }),
      grade: ['Tamanho'],
      variacoes: variations,
    };
  }
  throw new OlistError('INVALID_REQUEST', 400);
}
