import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureOlistExistingBuyer,
  resolveOlistExistingBuyer,
  verifyOlistExistingBuyer,
  assertOlistExistingBuyerSource,
  olistBuyerRegistrationEmpty,
} from '../modules/olist/src/existing-buyer.js';

const config = {
  accountKey: 'synthetic-account',
  hmacKey: Buffer.alloc(32, 84),
};
const buyer = {
  name: ' Loja Sintética ',
  phone: '(11) 99999-0000',
  registration: null,
};
const contact = {
  id: 901,
  nome: 'Razão Social Sintética',
  fantasia: 'LOJA SINTÉTICA',
  celular: '5511999990000',
  situacao: 'B',
  cpfCnpj: '52998224725',
  endereco: { endereco: 'Not copied' },
};
const error = (/** @type {string} */ code) => (/** @type {any} */ e) =>
  e.code === code;

test('existing ERP buyer captures only name/phone plus account-bound private hashes', async () => {
  const result = await resolveOlistExistingBuyer({
    config,
    buyer,
    client: {
      findCustomerByIdentity: async (/** @type {any} */ identity) => {
        assert.deepEqual(identity, {
          name: 'loja sintética',
          phone: '5511999990000',
        });
        return contact;
      },
    },
  });
  assert.deepEqual(result.customer, {
    nome: 'loja sintética',
    celular: '5511999990000',
  });
  assert.equal(result.buyerSource.mode, 'erp-existing-v1');
  assert.equal(result.buyerSource.remoteId, '901');
  assert.equal(result.buyerSource.documentHash?.length, 64);
  assert.ok(!JSON.stringify(result).includes(contact.cpfCnpj));
  assert.ok(!JSON.stringify(result).includes('Not copied'));
  let reads = 0;
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      await verifyOlistExistingBuyer({
        config,
        ...result,
        client: {
          contact: async (/** @type {number} */ id) => {
            reads++;
            assert.equal(id, 901);
            return contact;
          },
        },
      }),
      { remoteId: '901' },
    );
  assert.equal(reads, 2);
});
test('only entirely empty CRM registration can trigger lookup; partial values never merge', async () => {
  for (const registration of [
    null,
    undefined,
    {},
    { personType: null, legalName: ' ' },
  ])
    assert.equal(olistBuyerRegistrationEmpty(registration), true);
  for (const registration of [
    { personType: 'company' },
    { instagram: 'synthetic' },
    [],
    '',
  ]) {
    assert.equal(olistBuyerRegistrationEmpty(registration), false);
    await assert.rejects(
      resolveOlistExistingBuyer({
        config,
        buyer: { ...buyer, registration },
        client: { findCustomerByIdentity: () => assert.fail('lookup') },
      }),
      error('OLIST_CUSTOMER_DIVERGENT'),
    );
  }
});
test('ERP reuse accepts documented active states only and exact normalized name and phone', () => {
  for (const situacao of ['A', 'B'])
    assert.equal(
      captureOlistExistingBuyer({
        config,
        buyer,
        contact: { ...contact, situacao },
      }).buyerSource.remoteId,
      '901',
    );
  for (const change of [
    { situacao: 'I' },
    { situacao: 'E' },
    { fantasia: 'Loja Sintetica' },
    { celular: '5511999990001' },
    { id: 0 },
  ])
    assert.throws(
      () =>
        captureOlistExistingBuyer({
          config,
          buyer,
          contact: { ...contact, ...change },
        }),
      error('OLIST_CUSTOMER_DIVERGENT'),
    );
});
test('known-ID revalidation rejects source tampering, cross-account identity and changed document', async () => {
  const result = captureOlistExistingBuyer({ config, buyer, contact });
  for (const buyerSource of [
    { ...result.buyerSource, remoteId: '902' },
    {
      ...result.buyerSource,
      identity: { ...result.buyerSource.identity, phone: '5511999990001' },
    },
    { ...result.buyerSource, documentHash: null },
  ])
    assert.throws(
      () =>
        assertOlistExistingBuyerSource({
          config,
          customer: result.customer,
          buyerSource,
        }),
      error('OLIST_CUSTOMER_DIVERGENT'),
    );
  assert.throws(
    () =>
      assertOlistExistingBuyerSource({
        config: { ...config, accountKey: 'other' },
        ...result,
      }),
    error('OLIST_CUSTOMER_DIVERGENT'),
  );
  for (const changed of [
    { ...contact, id: 902 },
    { ...contact, cpfCnpj: '11144477735' },
    { ...contact, cpfCnpj: '' },
    { ...contact, situacao: 'I' },
  ])
    await assert.rejects(
      verifyOlistExistingBuyer({
        config,
        ...result,
        client: { contact: async () => changed },
      }),
      error('OLIST_CUSTOMER_DIVERGENT'),
    );
});
test('absent ERP document stays unclaimed; a later addition does not fabricate original proof', async () => {
  const result = captureOlistExistingBuyer({
    config,
    buyer,
    contact: { ...contact, cpfCnpj: '' },
  });
  assert.equal(result.buyerSource.documentHash, null);
  await verifyOlistExistingBuyer({
    config,
    ...result,
    client: { contact: async () => contact },
  });
});
test('zero existing matches fails closed without a customer creator', async () => {
  await assert.rejects(
    resolveOlistExistingBuyer({
      config,
      buyer,
      client: { findCustomerByIdentity: async () => null },
    }),
    error('OLIST_CUSTOMER_NOT_FOUND'),
  );
});
