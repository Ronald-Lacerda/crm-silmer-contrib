import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureOlistLegacyBuyerProof,
  assertOlistLegacyBuyerProof,
} from '../modules/olist/src/legacy-buyer-proof.js';
const config = {
  accountKey: 'synthetic-account',
  hmacKey: Buffer.alloc(32, 86),
};
const buyer = {
  name: 'Loja Sintética',
  phone: '5511999990000',
  registration: null,
};
const contact = {
  id: 901,
  nome: 'LOJA SINTÉTICA',
  situacao: 'B',
  celular: '5511999990001',
  cpfCnpj: '',
};
test('historical buyer proof binds account, sale, derived contact and both telephone evidences', () => {
  const captured = captureOlistLegacyBuyerProof({
    config,
    buyer,
    contact,
    saleId: '902',
  });
  const input = {
    config,
    customer: captured.customer,
    proof: captured.legacyBuyerProof,
    saleId: '902',
    customerId: '901',
  };
  assertOlistLegacyBuyerProof(input);
  for (const changed of [
    { ...input, config: { ...config, accountKey: 'other-account' } },
    { ...input, saleId: '903' },
    { ...input, customerId: '904' },
    { ...input, customer: { ...input.customer, celular: '5511999990005' } },
    { ...input, proof: { ...input.proof, erpPhonesHash: '0'.repeat(64) } },
    { ...input, proof: { ...input.proof, reusable: true } },
    { ...input, proof: { ...input.proof, phoneMismatch: false } },
  ])
    assert.throws(() => assertOlistLegacyBuyerProof(changed), {
      code: 'OLIST_CUSTOMER_DIVERGENT',
    });
});
test('historical exception refuses missing/equal phones, partial CRM registration, inactive contact and a different name', () => {
  for (const patch of [
    { buyer: { ...buyer, registration: { personType: 'company' } } },
    { contact: { ...contact, situacao: 'I' } },
    { contact: { ...contact, situacao: 'E' } },
    { contact: { ...contact, nome: 'Outra loja' } },
    { contact: { ...contact, celular: '' } },
    { contact: { ...contact, celular: buyer.phone } },
    { buyer: { ...buyer, phone: '' } },
  ])
    assert.throws(
      () =>
        captureOlistLegacyBuyerProof({
          config,
          buyer,
          contact,
          saleId: '902',
          ...patch,
        }),
      { code: 'OLIST_CUSTOMER_DIVERGENT' },
    );
});
