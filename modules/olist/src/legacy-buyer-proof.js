import { normalizeContactPhone } from '@crm-silmer/contacts';
import { identityHash } from './crypto.js';
import { OlistError } from './errors.js';
import {
  olistBuyerRegistrationEmpty,
  olistExistingBuyerName,
  olistExistingBuyerDocumentHash,
} from './existing-buyer.js';

const MODE = 'legacy-sale-buyer-review-v1';
/** @returns {never} */
function refuse() {
  throw new OlistError('OLIST_CUSTOMER_DIVERGENT');
}
/** @param {unknown} value */
function id(value) {
  const raw = String(value);
  if (!/^[1-9][0-9]{0,15}$/u.test(raw) || !Number.isSafeInteger(Number(raw)))
    refuse();
  return raw;
}
/** @param {any} config @param {string} purpose @param {unknown} value */
function hash(config, purpose, value) {
  return identityHash(config.hmacKey, 'legacy-buyer-' + purpose, [
    config.accountKey,
    value,
  ]);
}
/** @param {any} config @param {any} proof */
function digest(config, proof) {
  return hash(config, 'proof-v1', [
    proof.mode,
    proof.saleId,
    proof.customerId,
    proof.nameHash,
    proof.crmPhoneHash,
    proof.erpPhonesHash,
    proof.documentHash,
    proof.phoneMismatch,
    proof.reusable,
  ]);
}
/** A historical, sale-local human review. It cannot identify a buyer for any
 * creator or establish a reusable customer resource.
 * @param {{config:any,buyer:any,contact:any,saleId:string|number}} input */
export function captureOlistLegacyBuyerProof({
  config,
  buyer,
  contact,
  saleId,
}) {
  const name = olistExistingBuyerName(buyer?.name),
    phone = normalizeContactPhone(buyer?.phone);
  if (
    !olistBuyerRegistrationEmpty(buyer?.registration) ||
    !phone ||
    !['A', 'B'].includes(contact?.situacao) ||
    ![contact?.nome, contact?.fantasia].some(
      (entry) =>
        typeof entry === 'string' &&
        entry.trim() &&
        olistExistingBuyerName(entry) === name,
    )
  )
    refuse();
  const phones = [
    ...new Set(
      [contact.celular, contact.telefone]
        .map(normalizeContactPhone)
        .filter((entry) => entry !== null),
    ),
  ].sort();
  if (!phones.length || phones.includes(phone)) refuse();
  const proof = {
    mode: MODE,
    saleId: id(saleId),
    customerId: id(contact.id),
    nameHash: hash(config, 'name-v1', name),
    crmPhoneHash: hash(config, 'crm-phone-v1', phone),
    erpPhonesHash: hash(config, 'erp-phones-v1', phones),
    documentHash: olistExistingBuyerDocumentHash(config, contact.cpfCnpj),
    phoneMismatch: true,
    reusable: false,
  };
  return {
    customer: { nome: name, celular: phone },
    legacyBuyerProof: { ...proof, digest: digest(config, proof) },
  };
}
/** Local authenticity and scope check; the inspector additionally reproduces
 * the proof from fresh GET sale/contact evidence.
 * @param {{config:any,customer:any,proof:any,saleId:string|number,customerId:string|number}} input */
export function assertOlistLegacyBuyerProof({
  config,
  customer,
  proof,
  saleId,
  customerId,
}) {
  if (
    !proof ||
    proof.mode !== MODE ||
    proof.saleId !== id(saleId) ||
    proof.customerId !== id(customerId) ||
    proof.phoneMismatch !== true ||
    proof.reusable !== false ||
    !['nameHash', 'crmPhoneHash', 'erpPhonesHash', 'digest'].every(
      (key) =>
        typeof proof[key] === 'string' && /^[a-f0-9]{64}$/u.test(proof[key]),
    ) ||
    (proof.documentHash !== null &&
      !/^[a-f0-9]{64}$/u.test(proof.documentHash)) ||
    proof.nameHash !==
      hash(config, 'name-v1', olistExistingBuyerName(customer?.nome)) ||
    !normalizeContactPhone(customer?.celular) ||
    proof.crmPhoneHash !==
      hash(config, 'crm-phone-v1', normalizeContactPhone(customer.celular)) ||
    proof.digest !== digest(config, proof)
  )
    refuse();
}
