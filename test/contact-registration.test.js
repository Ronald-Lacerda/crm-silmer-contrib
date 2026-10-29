import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAZILIAN_STATES,
  PostalCodeLookupError,
  ViaCepPostalCodeClient,
  decryptContactRegistration,
  encryptContactDetails,
  encryptContactRegistration,
  isValidCnpj,
  isValidCpf,
  normalizeContactRegistration,
} from '../modules/contacts/src/index.js';

/** Builds a valid alphanumeric CNPJ from 12 base characters (Receita Federal rule). */
function alphanumericCnpj(/** @type {string} */ base) {
  const values = [...base].map((character) => character.charCodeAt(0) - 48);
  const check = (
    /** @type {number[]} */ digits,
    /** @type {number[]} */ weights,
  ) => {
    const rest =
      weights.reduce((sum, weight, index) => sum + digits[index] * weight, 0) %
      11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = check(values, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = check(
    [...values, first],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  return `${base}${first}${second}`;
}

const COMPLETE_INDIVIDUAL = Object.freeze({
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

test('CPF accepts valid check digits and rejects wrong digits and repeated sequences', () => {
  assert.equal(isValidCpf('52998224725'), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(isValidCpf('11111111111'), false);
  assert.equal(isValidCpf('5299822472'), false);
  assert.equal(isValidCpf('5299822472A'), false);
});

test('CNPJ accepts numeric and alphanumeric forms by check digit', () => {
  assert.equal(isValidCnpj('11222333000181'), true);
  assert.equal(isValidCnpj('11222333000182'), false);
  // Official alphanumeric example published by the Receita Federal.
  assert.equal(isValidCnpj('12ABC34501DE35'), true);
  const generated = alphanumericCnpj('A1B2C3D4E5F6');
  assert.equal(generated, 'A1B2C3D4E5F668');
  assert.equal(isValidCnpj(generated), true);
  assert.equal(isValidCnpj('A1B2C3D4E5F669'), false);
  // Check digits are always numeric; letters only in the 12 base positions.
  assert.equal(isValidCnpj('12ABC34501DEA5'), false);
  assert.equal(isValidCnpj('00000000000000'), false);
  assert.equal(isValidCnpj('12abc34501de35'), false);
});

test('a complete individual registration is normalized and counts as complete', () => {
  const result = normalizeContactRegistration(COMPLETE_INDIVIDUAL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    personType: 'individual',
    document: '52998224725',
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
  assert.ok(Object.isFrozen(result.value));
});

test('a company needs a state registration or ISENTO to be complete', () => {
  const company = {
    ...COMPLETE_INDIVIDUAL,
    personType: 'company',
    document: '12.ABC.345/01DE-35',
    legalName: 'Silmer Uniformes Ltda',
  };
  const missing = normalizeContactRegistration(company);
  assert.equal(missing.ok && missing.fieldsComplete, false);
  const exempt = normalizeContactRegistration({
    ...company,
    stateRegistration: ' isento ',
  });
  assert.equal(exempt.ok, true);
  if (!exempt.ok) return;
  assert.equal(exempt.value.document, '12ABC34501DE35');
  assert.equal(exempt.value.stateRegistration, 'ISENTO');
  assert.equal(exempt.fieldsComplete, true);
  const registered = normalizeContactRegistration({
    ...company,
    stateRegistration: '110.042.490.114',
  });
  assert.equal(
    registered.ok && registered.value.stateRegistration,
    '110042490114',
  );
});

test('instagram, address number, state and postal code accept the usual forms', () => {
  for (const [input, expected] of [
    ['https://www.instagram.com/Loja_Silmer/', 'loja_silmer'],
    ['http://instagram.com/loja.silmer?igsh=abc', 'loja.silmer'],
    ['@LOJA', 'loja'],
    ['loja', 'loja'],
  ]) {
    const result = normalizeContactRegistration({ instagram: input });
    assert.equal(result.ok && result.value.instagram, expected, input);
  }
  for (const value of [
    '.loja',
    'loja.',
    'lo..ja',
    'loja silmer',
    'a'.repeat(31),
  ]) {
    assert.deepEqual(normalizeContactRegistration({ instagram: value }), {
      ok: false,
      errors: { instagram: 'INVALID_INSTAGRAM' },
    });
  }
  for (const value of ['s/n', 'SN', 'sn', 'S/N']) {
    const result = normalizeContactRegistration({ number: value });
    assert.equal(result.ok && result.value.number, 'S/N');
  }
  assert.equal(BRAZILIAN_STATES.length, 27);
  assert.deepEqual(normalizeContactRegistration({ state: 'XX' }), {
    ok: false,
    errors: { state: 'INVALID_STATE' },
  });
  for (const postalCode of ['00000000', '1234567', '12345-6789', 'abcdefgh']) {
    assert.deepEqual(normalizeContactRegistration({ postalCode }), {
      ok: false,
      errors: { postalCode: 'INVALID_POSTAL_CODE' },
    });
  }
});

test('empty values clear a field and invalid values report every field in form order', () => {
  const empty = normalizeContactRegistration({
    personType: '',
    document: null,
    city: '   ',
  });
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.ok(Object.values(empty.value).every((value) => value === null));
    assert.equal(empty.fieldsComplete, false);
  }
  const invalid = normalizeContactRegistration({
    complement: 'x'.repeat(81),
    number: '12345678901',
    street: 'Rua\u0007',
    legalName: 'A',
    document: '52998224725',
    personType: 'other',
    stateRegistration: '1',
    city: 'c'.repeat(81),
    district: 42,
  });
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.deepEqual(Object.entries(invalid.errors), [
    ['personType', 'INVALID_PERSON_TYPE'],
    ['legalName', 'INVALID_LEGAL_NAME'],
    ['stateRegistration', 'INVALID_STATE_REGISTRATION'],
    ['city', 'INVALID_CITY'],
    ['street', 'INVALID_STREET'],
    ['district', 'INVALID_DISTRICT'],
    ['number', 'INVALID_ADDRESS_NUMBER'],
    ['complement', 'INVALID_COMPLEMENT'],
  ]);
});

test('a document needs its person type and must match it', () => {
  assert.deepEqual(normalizeContactRegistration({ document: '52998224725' }), {
    ok: false,
    errors: { personType: 'INVALID_PERSON_TYPE' },
  });
  assert.deepEqual(
    normalizeContactRegistration({
      personType: 'individual',
      document: '11222333000181',
    }),
    { ok: false, errors: { document: 'INVALID_DOCUMENT' } },
  );
  assert.deepEqual(
    normalizeContactRegistration({
      personType: 'company',
      document: '529.982.247-25',
    }),
    { ok: false, errors: { document: 'INVALID_DOCUMENT' } },
  );
});

test('registration envelope round trips without plaintext and rejects another AAD', () => {
  const key = Buffer.alloc(32, 9);
  const result = normalizeContactRegistration(COMPLETE_INDIVIDUAL);
  assert.ok(result.ok);
  if (!result.ok) return;
  const envelope = encryptContactRegistration(result.value, key);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(envelope.version, 1);
  assert.doesNotMatch(
    JSON.stringify(envelope),
    /52998224725|Maria|Paulista|01310100/u,
  );
  assert.deepEqual(decryptContactRegistration(envelope, key), result.value);
  assert.deepEqual(
    decryptContactRegistration(JSON.stringify(envelope), key),
    result.value,
  );
  assert.equal(decryptContactRegistration(null, key), null);
  assert.throws(() =>
    decryptContactRegistration(envelope, Buffer.alloc(32, 8)),
  );
  // A details envelope uses another AAD and cannot be read as a registration.
  const details = encryptContactDetails(
    { email: 'cliente@example.test', phone: '5511999999999' },
    key,
  );
  assert.throws(() => decryptContactRegistration(details, key));
});

/** @param {(url: URL, init: any) => Promise<any>} fetchImpl */
function viaCep(fetchImpl) {
  return new ViaCepPostalCodeClient({ fetchImpl });
}

test('ViaCEP client sends only the postal code and bounds the suggestion', async () => {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  const client = viaCep(async (url, init) => {
    calls.push({ url: url.href, init });
    return new globalThis.Response(
      JSON.stringify({
        bairro: 'Bela\u0000 Vista',
        cep: '01310-100',
        complemento: 'lado ímpar',
        localidade: 'São Paulo',
        logradouro: `Avenida ${'P'.repeat(200)}`,
        uf: 'sp',
      }),
      { status: 200 },
    );
  });
  const suggestion = await client.lookup('01310100');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://viacep.com.br/ws/01310100/json/');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(suggestion.postalCode, '01310100');
  assert.equal(suggestion.district, 'Bela Vista');
  assert.equal(suggestion.city, 'São Paulo');
  assert.equal(suggestion.state, 'SP');
  assert.equal([...(suggestion.street ?? '')].length, 150);

  const sparse = await viaCep(
    async () =>
      new globalThis.Response(
        JSON.stringify({
          bairro: '',
          localidade: 'Cidade',
          logradouro: '',
          uf: 'ZZ',
        }),
        { status: 200 },
      ),
  ).lookup('12345678');
  assert.deepEqual(sparse, {
    city: 'Cidade',
    district: null,
    postalCode: '12345678',
    state: null,
    street: null,
  });
});

test('ViaCEP client maps missing postal codes and every failure to bounded errors', async () => {
  await assert.rejects(
    viaCep(
      async () => new globalThis.Response('{"erro": true}', { status: 200 }),
    ).lookup('99999999'),
    (error) =>
      error instanceof PostalCodeLookupError &&
      error.statusCode === 404 &&
      error.code === 'POSTAL_CODE_NOT_FOUND' &&
      !error.message.includes('99999999'),
  );
  const failures = [
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      throw new globalThis.DOMException('timeout', 'TimeoutError');
    },
    async () => new globalThis.Response('{}', { status: 502 }),
    async () => new globalThis.Response('<html>', { status: 200 }),
    async () => new globalThis.Response('[]', { status: 200 }),
    async () => new globalThis.Response('{"cep":"00000-001"}', { status: 200 }),
  ];
  for (const failure of failures) {
    await assert.rejects(
      viaCep(failure).lookup('01310100'),
      (error) =>
        error instanceof PostalCodeLookupError &&
        error.statusCode === 503 &&
        error.code === 'POSTAL_CODE_UNAVAILABLE' &&
        !error.message.includes('01310100'),
    );
  }
  assert.throws(
    () => new ViaCepPostalCodeClient({ baseUrl: 'http://viacep.com.br/ws/' }),
    TypeError,
  );
});
