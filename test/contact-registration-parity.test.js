import assert from 'node:assert/strict';
import test from 'node:test';

import * as edge from '../apps/edge-web/src/lib/contact-registration.js';
import * as domain from '../modules/contacts/src/domain/contact-registration.js';

// edge-web mirrors the contact domain rules on purpose (CP-25). A drift lets
// the form accept a registration the API rejects, or block a valid one.
// Synthetic, publicly documented check-digit vectors only.
const VALID = Object.freeze({
  personType: 'company',
  document: '12.ABC.345/01DE-35',
  legalName: '  Silmer   Uniformes Ltda ',
  instagram: 'https://www.instagram.com/Silmer.Uniformes/',
  stateRegistration: 'isento',
  postalCode: '01310-100',
  city: 'São Paulo',
  state: 'sp',
  street: 'Avenida Paulista',
  district: 'Bela Vista',
  number: 's/n',
  complement: 'Sala 4',
});

const CASES = [
  VALID,
  {},
  { personType: 'individual', document: '529.982.247-25' },
  { personType: 'individual', document: '52998224724' },
  { personType: 'individual', document: '11111111111' },
  { personType: 'company', document: '11.222.333/0001-81' },
  { personType: 'company', document: '11222333000182' },
  { personType: 'company', document: '00000000000000' },
  { personType: 'company', document: '529.982.247-25' },
  { document: '52998224725' },
  { personType: 'person' },
  { legalName: 'A' },
  { legalName: 'x'.repeat(151) },
  { instagram: '@a..b' },
  { instagram: '.silmer' },
  { instagram: 'silmer.' },
  { instagram: '@SILMER_01' },
  { stateRegistration: '110.042.490.114' },
  { stateRegistration: 'I' },
  { postalCode: '00000000' },
  { postalCode: '1310100' },
  { state: 'XX' },
  { city: 'c'.repeat(81) },
  { street: 's'.repeat(151) },
  { district: 'd'.repeat(81) },
  { number: 'SN' },
  { number: '12345678901' },
  { complement: '  ' },
  { ...VALID, personType: 'individual', document: '52998224725' },
  { ...VALID, stateRegistration: null },
  { ...VALID, number: null },
];

test('edge-web and the contact domain agree on every registration vector', () => {
  for (const input of CASES) {
    const fromEdge = edge.normalizeContactRegistration(input);
    const fromDomain = domain.normalizeContactRegistration(input);
    assert.equal(fromEdge.ok, fromDomain.ok, JSON.stringify(input));
    if (fromDomain.ok && fromEdge.ok) {
      assert.deepEqual(fromEdge.value, fromDomain.value, JSON.stringify(input));
      assert.equal(
        fromEdge.fieldsComplete,
        fromDomain.fieldsComplete,
        JSON.stringify(input),
      );
    } else if (!fromDomain.ok && !fromEdge.ok) {
      assert.deepEqual(
        Object.keys(fromEdge.errors).sort(),
        Object.keys(fromDomain.errors).sort(),
        JSON.stringify(input),
      );
    }
  }
});

test('edge-web and the contact domain agree on documents and states', () => {
  assert.deepEqual([...edge.BRAZILIAN_STATES], [...domain.BRAZILIAN_STATES]);
  for (const value of [
    '52998224725',
    '52998224724',
    '11222333000181',
    '12ABC34501DE35',
    'A1B2C3D4E5F668',
    '12ABC34501DE36',
  ]) {
    assert.equal(edge.isValidCpf(value), domain.isValidCpf(value), value);
    assert.equal(edge.isValidCnpj(value), domain.isValidCnpj(value), value);
  }
});
