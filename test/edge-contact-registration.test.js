import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAZILIAN_STATES,
  formatDocument,
  formatPostalCode,
  isRegistrationComplete,
  isValidCnpj,
  isValidCpf,
  missingRegistrationFields,
  normalizeContactRegistration,
  normalizeEmail,
  normalizePhone,
} from '../apps/edge-web/src/lib/contact-registration.js';

// Synthetic, publicly documented check-digit vectors only (no real people).
const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';
// Example published by the Receita Federal for the alphanumeric CNPJ.
const VALID_ALPHA_CNPJ = '12ABC34501DE35';

const complete = Object.freeze({
  personType: 'individual',
  document: '529.982.247-25',
  legalName: '  Maria   da Silva ',
  instagram: '@Maria.Silva',
  stateRegistration: null,
  postalCode: '01310-100',
  city: 'São Paulo',
  state: 'sp',
  street: 'Avenida Paulista',
  district: 'Bela Vista',
  number: '1000',
  complement: '',
});

test('CP-25 CPF is checked by both check digits and rejects repeated digits', () => {
  assert.equal(isValidCpf(VALID_CPF), true);
  assert.equal(isValidCpf('11144477735'), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(isValidCpf('52998224715'), false);
  assert.equal(isValidCpf('11111111111'), false);
  assert.equal(isValidCpf('5299822472'), false);
  assert.equal(isValidCpf('529.982.247-25'), false, 'expects compact input');
});

test('CP-25 CNPJ accepts numeric and alphanumeric bases with numeric check digits', () => {
  assert.equal(isValidCnpj(VALID_CNPJ), true);
  assert.equal(isValidCnpj(VALID_ALPHA_CNPJ), true);
  assert.equal(isValidCnpj('11222333000180'), false);
  assert.equal(isValidCnpj('12ABC34501DE36'), false);
  assert.equal(isValidCnpj('12ABC34501DEA5'), false, 'check digits are digits');
  assert.equal(isValidCnpj('00000000000000'), false);
  assert.equal(isValidCnpj('AAAAAAAAAAAAAA'), false);
  assert.equal(isValidCnpj('12abc34501de35'), false, 'expects upper case');
});

test('CP-25 normalizes a complete individual registration', () => {
  const result = normalizeContactRegistration(complete);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    personType: 'individual',
    document: VALID_CPF,
    legalName: 'Maria da Silva',
    instagram: 'maria.silva',
    stateRegistration: null,
    postalCode: '01310100',
    city: 'São Paulo',
    state: 'SP',
    street: 'Avenida Paulista',
    district: 'Bela Vista',
    number: '1000',
    complement: null,
  });
  assert.equal(result.fieldsComplete, true);
});

test('CP-25 company document is cleaned and upper-cased; ISENTO and S/N are canonical', () => {
  const result = normalizeContactRegistration({
    ...complete,
    personType: 'company',
    document: '12.abc.345/01de-35',
    stateRegistration: ' isento ',
    number: 's/n',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.document, VALID_ALPHA_CNPJ);
  assert.equal(result.value.stateRegistration, 'ISENTO');
  assert.equal(result.value.number, 'S/N');
  assert.equal(result.fieldsComplete, true);
  for (const value of ['SN', 'sn', 's/N']) {
    const other = normalizeContactRegistration({ number: value });
    assert.equal(other.ok && other.value.number, 'S/N', value);
  }
  // Only S/N and SN are the "no number" marker, as in the domain.
  const spaced = normalizeContactRegistration({ number: 'S / N' });
  assert.equal(spaced.ok && spaced.value.number, 'S / N');
});

test('CP-26 a company needs a state registration or ISENTO to be complete', () => {
  const result = normalizeContactRegistration({
    ...complete,
    personType: 'company',
    document: VALID_CNPJ,
    stateRegistration: null,
  });
  assert.equal(result.ok && result.fieldsComplete, false);
  const withIe = normalizeContactRegistration({
    ...complete,
    personType: 'company',
    document: VALID_CNPJ,
    stateRegistration: '110.042.490.114',
  });
  assert.equal(withIe.ok && withIe.value.stateRegistration, '110042490114');
  assert.equal(withIe.ok && withIe.fieldsComplete, true);
});

test('CP-25 every field reports its own code', () => {
  const result = normalizeContactRegistration({
    personType: 'other',
    legalName: 'A',
    instagram: '.loja',
    stateRegistration: 'X',
    postalCode: '00000-000',
    city: 'c'.repeat(81),
    state: 'XX',
    street: 's'.repeat(151),
    district: 'd'.repeat(81),
    number: '12345678901',
    complement: 'c'.repeat(81),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, {
    personType: 'INVALID_PERSON_TYPE',
    legalName: 'INVALID_LEGAL_NAME',
    instagram: 'INVALID_INSTAGRAM',
    stateRegistration: 'INVALID_STATE_REGISTRATION',
    postalCode: 'INVALID_POSTAL_CODE',
    city: 'INVALID_CITY',
    state: 'INVALID_STATE',
    street: 'INVALID_STREET',
    district: 'INVALID_DISTRICT',
    number: 'INVALID_ADDRESS_NUMBER',
    complement: 'INVALID_COMPLEMENT',
  });
});

test('CP-25 a document without person type asks for the type', () => {
  const result = normalizeContactRegistration({ document: VALID_CPF });
  assert.deepEqual(result, {
    ok: false,
    errors: { personType: 'INVALID_PERSON_TYPE' },
  });
  const wrongType = normalizeContactRegistration({
    personType: 'company',
    document: VALID_CPF,
  });
  assert.deepEqual(wrongType, {
    ok: false,
    errors: { document: 'INVALID_DOCUMENT' },
  });
});

test('CP-25 Instagram accepts @, bare handles and profile URLs', () => {
  for (const [input, expected] of [
    ['@Loja_Silmer', 'loja_silmer'],
    ['loja.silmer', 'loja.silmer'],
    ['https://www.instagram.com/Loja.Silmer/', 'loja.silmer'],
    ['instagram.com/loja?igsh=abc', 'loja'],
  ]) {
    const result = normalizeContactRegistration({ instagram: input });
    assert.equal(result.ok && result.value.instagram, expected, input);
  }
  for (const input of [
    'loja.',
    'lo..ja',
    'loja silmer',
    'a'.repeat(31),
    '@',
    'loja!',
  ]) {
    const result = normalizeContactRegistration({ instagram: input });
    assert.equal(result.ok, false, input);
  }
});

test('CP-25 every one of the 27 UFs is accepted, case-insensitively', () => {
  assert.equal(BRAZILIAN_STATES.length, 27);
  assert.equal(new Set(BRAZILIAN_STATES).size, 27);
  for (const state of BRAZILIAN_STATES) {
    const result = normalizeContactRegistration({
      state: state.toLowerCase(),
    });
    assert.equal(result.ok && result.value.state, state);
  }
});

test('CP-25 empty values become null and keep the registration optional', () => {
  const result = normalizeContactRegistration({
    personType: '',
    document: '   ',
    legalName: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(Object.values(result.value).every((value) => value === null));
  assert.equal(result.fieldsComplete, false);
});

test('CP-26 completeness also needs phone and e-mail; the missing list names them', () => {
  const result = normalizeContactRegistration(complete);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    isRegistrationComplete(result.value, {
      phone: '5511999990000',
      email: null,
    }),
    false,
  );
  assert.deepEqual(
    missingRegistrationFields(result.value, { phone: '5511999990000' }),
    ['E-mail'],
  );
  assert.equal(
    isRegistrationComplete(result.value, {
      phone: '5511999990000',
      email: 'cliente@example.com',
    }),
    true,
  );
  assert.deepEqual(missingRegistrationFields(null), [
    'Tipo de pessoa',
    'CPF ou CNPJ',
    'Nome ou razão social',
    'CEP',
    'Cidade',
    'UF',
    'Endereço',
    'Bairro',
    'Número',
    'Celular',
    'E-mail',
  ]);
  assert.deepEqual(
    missingRegistrationFields(
      { personType: 'company' },
      { phone: '1', email: 'x@y.z' },
    ).slice(0, 3),
    ['CNPJ', 'Razão social', 'Inscrição estadual'],
  );
});

test('CP-25 documents and CEP are displayed with their masks', () => {
  assert.equal(formatDocument('individual', VALID_CPF), '529.982.247-25');
  assert.equal(formatDocument('company', VALID_CNPJ), '11.222.333/0001-81');
  assert.equal(
    formatDocument('company', VALID_ALPHA_CNPJ),
    '12.ABC.345/01DE-35',
  );
  assert.equal(formatDocument('individual', '5299'), '5299');
  assert.equal(formatPostalCode('01310100'), '01310-100');
  assert.equal(formatPostalCode('0131'), '0131');
});

test('phone and e-mail mirror the contact-details rules', () => {
  assert.equal(normalizePhone('(11) 99999-0000'), '5511999990000');
  assert.equal(normalizePhone('+55 11 99999-0000'), '5511999990000');
  assert.equal(normalizePhone('11111111111'), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizeEmail(' Cliente@Example.com '), 'cliente@example.com');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail('cliente@'), undefined);
});

test('CP-25 text fields refuse control characters like the domain', () => {
  for (const [field, code] of [
    ['legalName', 'INVALID_LEGAL_NAME'],
    ['city', 'INVALID_CITY'],
    ['street', 'INVALID_STREET'],
    ['district', 'INVALID_DISTRICT'],
    ['number', 'INVALID_ADDRESS_NUMBER'],
    ['complement', 'INVALID_COMPLEMENT'],
  ]) {
    for (const bad of [
      'Rua\u0000A',
      'Rua\tA',
      'Rua\nA',
      'Rua\u007fA',
      'Rua\u0085A',
      'Rua\u009fA',
    ]) {
      const result = normalizeContactRegistration({ [field]: bad });
      assert.deepEqual(
        result,
        { ok: false, errors: { [field]: code } },
        `${field} ${JSON.stringify(bad)}`,
      );
    }
  }
  // Blanks around the value are trimmed first; inner spaces collapse.
  const padded = normalizeContactRegistration({ city: '\t São  Paulo \n' });
  assert.equal(padded.ok && padded.value.city, 'São Paulo');
  const noBreak = normalizeContactRegistration({ city: 'São Paulo' });
  assert.equal(noBreak.ok && noBreak.value.city, 'São Paulo');
});

test('CP-25 lengths are counted in code points, after NFC', () => {
  const emoji = '\u{1F600}';
  assert.equal(emoji.length, 2);
  const atLimit = normalizeContactRegistration({ city: emoji.repeat(80) });
  assert.equal(atLimit.ok, true, '80 code points fit in 160 UTF-16 units');
  assert.deepEqual(normalizeContactRegistration({ city: emoji.repeat(81) }), {
    ok: false,
    errors: { city: 'INVALID_CITY' },
  });
  const decomposed = normalizeContactRegistration({
    district: 'São'.repeat(20),
  });
  assert.equal(decomposed.ok && decomposed.value.district, 'São'.repeat(20));
  assert.equal(normalizeContactRegistration({ legalName: emoji }).ok, false);
  assert.equal(
    normalizeContactRegistration({ legalName: emoji + emoji }).ok,
    true,
  );
});

test('CP-25 a non-object registration is a bad request', () => {
  for (const input of [null, undefined, 'x', []]) {
    assert.deepEqual(normalizeContactRegistration(input), {
      ok: false,
      errors: { registration: 'INVALID_REQUEST' },
    });
  }
});
