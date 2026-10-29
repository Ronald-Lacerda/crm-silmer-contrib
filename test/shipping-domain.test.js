import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateDeclaredValue,
  splitPackageValue,
  unitValueCents,
} from '../modules/shipping/src/domain/declared-value.js';
import {
  DELIVERY_MODES,
  parseDeliveryMode,
} from '../modules/shipping/src/domain/delivery-mode.js';
import { ShippingValidationError } from '../modules/shipping/src/domain/errors.js';
import { decideFreightDifference } from '../modules/shipping/src/domain/freight-difference.js';
import {
  PAC_MAX_INSURANCE_CENTS,
  buildCartItem,
  buildQuoteRequest,
  labelPurchaseKey,
  missingRecipientFields,
  missingSenderFields,
} from '../modules/shipping/src/domain/melhor-envio-payloads.js';
import {
  CORREIOS_LIMITS,
  checkCarrierLimits,
  createPackageType,
} from '../modules/shipping/src/domain/package-type.js';
import { validatePacking } from '../modules/shipping/src/domain/packing.js';
import {
  findPostalCodes,
  normalizePostalCode,
} from '../modules/shipping/src/domain/postal-code.js';
import { estimateShipment } from '../modules/shipping/src/domain/weight-estimate.js';

/**
 * @param {() => unknown} work
 * @param {string} code
 * @param {readonly string[]} [fields]
 * @returns {any} the error, for further checks
 */
function refuses(work, code, fields) {
  /** @type {any} */
  let caught;
  assert.throws(work, (error) => {
    caught = error;
    assert.ok(error instanceof ShippingValidationError);
    assert.equal(/** @type {any} */ (error).statusCode, 422);
    assert.equal(/** @type {any} */ (error).code, code);
    if (fields) assert.deepEqual(/** @type {any} */ (error).fields, fields);
    return true;
  });
  return caught;
}

const caixaM = Object.freeze({
  id: 'caixa-m',
  name: 'Caixa M',
  kind: /** @type {const} */ ('box'),
  lengthCm: 40,
  widthCm: 30,
  heightCm: 25,
  tareGrams: 450,
  maxLoadGrams: 20000,
});

const sacoP = Object.freeze({
  id: 'saco-p',
  name: 'Saco P',
  kind: /** @type {const} */ ('bag'),
  lengthCm: 30,
  widthCm: 20,
  heightCm: 4,
  tareGrams: 20,
  maxLoadGrams: 2000,
});

// Obviously fake parties: no real person, company or address. The documents
// are the usual synthetic examples with valid check digits.
const sender = Object.freeze({
  name: 'Remetente Teste Ltda',
  companyDocument: '11.222.333/0001-81',
  stateRegister: '000000000',
  phone: '(00) 0000-0000',
  email: 'expedicao@example.test',
  address: 'Rua Exemplo',
  number: '100',
  district: 'Bairro Teste',
  city: 'Cidade Teste',
  stateAbbr: 'rr',
  postalCode: '69301-000',
});

const recipient = Object.freeze({
  name: 'Cliente Teste',
  document: '111.444.777-35',
  phone: '(00) 90000-0000',
  address: 'Avenida Fictícia',
  number: 42,
  complement: 'Sala 1',
  district: 'Centro Teste',
  city: 'Outra Cidade',
  stateAbbr: 'AM',
  postalCode: '69.005-000',
});

/** @param {Record<string, unknown>} [overrides] */
function cartInput(overrides = {}) {
  return {
    serviceId: 1,
    sender,
    recipient,
    pkg: { lengthCm: 40, widthCm: 30, heightCm: 25, weightGrams: 13950 },
    // 175909 cents over 90 pieces: 41 x 19,54 + 49 x 19,55, exact to the cent.
    products: [
      { name: 'Camiseta', quantity: 41, unitValueCents: 1954 },
      { name: 'Camiseta', quantity: 49, unitValueCents: 1955 },
    ],
    insuranceCents: 175909,
    orderId: 'ord_123',
    orderNumber: '0123-CRM',
    packageIndex: 0,
    packageCount: 3,
    ...overrides,
  };
}

// MEV-01 -------------------------------------------------------------------

test('MEV-01: forma de entrega aceita as duas opções e nenhuma por padrão', () => {
  assert.deepEqual(DELIVERY_MODES, ['store_pickup', 'melhor_envio']);
  assert.ok(Object.isFrozen(DELIVERY_MODES));
  assert.equal(parseDeliveryMode('store_pickup'), 'store_pickup');
  assert.equal(parseDeliveryMode('melhor_envio'), 'melhor_envio');
  assert.equal(parseDeliveryMode(null), null);
  assert.equal(parseDeliveryMode(undefined), null);
});

test('MEV-01: forma de entrega desconhecida é recusada', () => {
  for (const value of ['', 'correios', 'STORE_PICKUP', 1, {}, false]) {
    refuses(() => parseDeliveryMode(value), 'INVALID_DELIVERY_MODE', [
      'deliveryMode',
    ]);
  }
});

// MEV-02: postal code --------------------------------------------------------

test('MEV-02: CEP é normalizado para 8 dígitos nos três formatos', () => {
  assert.equal(normalizePostalCode('69301-000'), '69301000');
  assert.equal(normalizePostalCode('69301000'), '69301000');
  assert.equal(normalizePostalCode('69.301-000'), '69301000');
  assert.equal(normalizePostalCode('  01310-100 '), '01310100');
});

test('MEV-02: CEP inválido é recusado', () => {
  for (const value of [
    '6930-1000',
    '6930100',
    '693010000',
    '69301-00a',
    '00000-000',
    69301000,
    null,
    undefined,
  ]) {
    refuses(() => normalizePostalCode(value), 'INVALID_POSTAL_CODE', [
      'postalCode',
    ]);
  }
});

test('MEV-02: CEPs são achados no texto livre, únicos e em ordem', () => {
  const found = findPostalCodes(
    'Meu CEP é 69301-000. O da loja é 69.005-000, ou 69301000 de novo; e 01310100!',
  );
  assert.deepEqual(found, ['69301000', '69005000', '01310100']);
  assert.ok(Object.isFrozen(found));
  assert.deepEqual(findPostalCodes('cep:69301-000'), ['69301000']);
  assert.deepEqual(findPostalCodes('(69301-000)'), ['69301000']);
});

test('MEV-02: telefone, CPF e números longos não viram CEP', () => {
  for (const text of [
    'meu zap 95991234567',
    'tel (95) 99123-4567',
    '+55 95 99123-4567',
    'CPF 123.456.789-09',
    'CPF 12345678909',
    'CNPJ 00.000.000/0001-91',
    'pedido 1234567890',
    'pedido 0123-CRM com 220 peças',
    'RG 12.345.678',
    'código 69301-0001',
    'código 169301-000',
    'valor 1.234.567,00',
    'cep 00000-000',
  ]) {
    assert.deepEqual(findPostalCodes(text), [], text);
  }
  assert.deepEqual(findPostalCodes(undefined), []);
  assert.deepEqual(findPostalCodes(''), []);
});

// MEV-06/13: package type and carrier limits --------------------------------

test('MEV-06: tipo de embalagem válido sai congelado e aparado', () => {
  const type = createPackageType({
    ...caixaM,
    id: ' caixa-m ',
    name: ' Caixa M ',
  });
  assert.deepEqual(type, caixaM);
  assert.ok(Object.isFrozen(type));
  assert.equal(createPackageType({ ...sacoP, tareGrams: 0 }).tareGrams, 0);
});

test('MEV-06: tipo de embalagem lista todos os campos inválidos', () => {
  refuses(
    () =>
      createPackageType({
        id: ' ',
        name: '',
        kind: 'envelope',
        lengthCm: 0,
        widthCm: 1.5,
        heightCm: -2,
        tareGrams: -1,
        maxLoadGrams: Number.NaN,
      }),
    'INVALID_PACKAGE_TYPE',
    [
      'id',
      'name',
      'kind',
      'lengthCm',
      'widthCm',
      'heightCm',
      'maxLoadGrams',
      'tareGrams',
    ],
  );
  refuses(
    () => createPackageType(/** @type {any} */ (null)),
    'INVALID_PACKAGE_TYPE',
  );
});

test('MEV-13: volume dentro dos limites dos Correios cabe', () => {
  const result = checkCarrierLimits({
    lengthCm: 105,
    widthCm: 60,
    heightCm: 35,
    weightGrams: 30000,
  });
  assert.deepEqual(result, { fits: true, reasons: [] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasons));
});

test('MEV-13: cada limite estourado vira um motivo', () => {
  assert.deepEqual(
    checkCarrierLimits(
      { lengthCm: 15, widthCm: 10, heightCm: 1, weightGrams: 30001 },
      CORREIOS_LIMITS,
    ).reasons,
    [
      'WEIGHT_ABOVE_MAX',
      'LENGTH_BELOW_MIN',
      'WIDTH_BELOW_MIN',
      'HEIGHT_BELOW_MIN',
    ],
  );
  assert.deepEqual(
    checkCarrierLimits({
      lengthCm: 106,
      widthCm: 106,
      heightCm: 106,
      weightGrams: 1,
    }),
    {
      fits: false,
      reasons: [
        'LENGTH_ABOVE_MAX',
        'WIDTH_ABOVE_MAX',
        'HEIGHT_ABOVE_MAX',
        'SUM_ABOVE_MAX',
      ],
    },
  );
  assert.deepEqual(
    checkCarrierLimits({
      lengthCm: 100,
      widthCm: 60,
      heightCm: 41,
      weightGrams: 1,
    }).reasons,
    ['SUM_ABOVE_MAX'],
  );
});

test('MEV-13: limites vêm de fora e limite ausente não é checado', () => {
  const volume = { lengthCm: 50, widthCm: 50, heightCm: 50, weightGrams: 9000 };
  assert.deepEqual(
    checkCarrierLimits(volume, { maxWeightGrams: 8000, maxSumCm: 140 }).reasons,
    ['WEIGHT_ABOVE_MAX', 'SUM_ABOVE_MAX'],
  );
  assert.equal(checkCarrierLimits(volume, {}).fits, true);
  refuses(
    () =>
      checkCarrierLimits({
        lengthCm: 10,
        widthCm: 0,
        heightCm: 2.5,
        weightGrams: 100,
      }),
    'INVALID_VOLUME',
    ['widthCm', 'heightCm'],
  );
});

// MEV-02/04: weight estimate -------------------------------------------------

test('MEV-04: 220 camisetas de 150 g cabem em 2 Caixas M de 110 peças', () => {
  const estimate = estimateShipment({
    items: [{ garmentType: 'camiseta', pieces: 220 }],
    weightTable: { camiseta: 150 },
    packageType: caixaM,
  });
  assert.deepEqual(estimate, {
    totalPieces: 220,
    contentGrams: 33000,
    packageCount: 2,
    packages: [
      { packageTypeId: 'caixa-m', pieces: 110, weightGrams: 16950 },
      { packageTypeId: 'caixa-m', pieces: 110, weightGrams: 16950 },
    ],
    totalGrams: 33900,
  });
  assert.ok(Object.isFrozen(estimate));
  assert.ok(Object.isFrozen(estimate.packages));
  assert.ok(Object.isFrozen(estimate.packages[0]));
});

test('MEV-04: peças de pesos diferentes se espalham por igual', () => {
  const estimate = estimateShipment({
    items: [
      { garmentType: 'camiseta', pieces: 60 },
      { garmentType: 'moletom', pieces: 50 },
      { garmentType: 'camiseta', pieces: 40 },
    ],
    weightTable: { camiseta: 150, moletom: 600 },
    packageType: caixaM,
  });
  assert.equal(estimate.totalPieces, 150);
  assert.equal(estimate.contentGrams, 45000);
  assert.equal(estimate.packageCount, 3);
  assert.deepEqual(
    estimate.packages.map((pkg) => [pkg.pieces, pkg.weightGrams]),
    [
      [50, 15600],
      [50, 15600],
      [50, 15150],
    ],
  );
  assert.equal(estimate.totalGrams, 46350);
});

test('MEV-04: a divisão sobe uma embalagem quando o resto não cabe', () => {
  // 5 pieces of 900 g (4500 g) need 3 bags of 2000 g: two hold 2 pieces
  // (1800 g) and one holds the last piece.
  const estimate = estimateShipment({
    items: [{ garmentType: 'jaqueta', pieces: 5 }],
    weightTable: { jaqueta: 900 },
    packageType: sacoP,
  });
  assert.deepEqual(
    estimate.packages.map((pkg) => pkg.pieces),
    [2, 2, 1],
  );
  assert.ok(estimate.packages.every((pkg) => pkg.weightGrams <= 2020));
});

test('MEV-04: uma peça cabe numa embalagem só', () => {
  const estimate = estimateShipment({
    items: [{ garmentType: 'camiseta', pieces: 1 }],
    weightTable: { camiseta: 150 },
    packageType: sacoP,
  });
  assert.equal(estimate.packageCount, 1);
  assert.equal(estimate.totalGrams, 170);
});

test('MEV-04: tipo de peça sem peso cadastrado lista os tipos', () => {
  refuses(
    () =>
      estimateShipment({
        items: [
          { garmentType: 'camiseta', pieces: 10 },
          { garmentType: 'bone', pieces: 2 },
          { garmentType: 'constructor', pieces: 1 },
          { garmentType: 'bone', pieces: 3 },
        ],
        weightTable: { camiseta: 150, regata: 0 },
        packageType: caixaM,
      }),
    'UNKNOWN_GARMENT_WEIGHT',
    ['bone', 'constructor'],
  );
});

test('MEV-04: peça mais pesada que a carga máxima é recusada', () => {
  refuses(
    () =>
      estimateShipment({
        items: [{ garmentType: 'casaco', pieces: 1 }],
        weightTable: { casaco: 2001 },
        packageType: sacoP,
      }),
    'PIECE_TOO_HEAVY',
    ['casaco'],
  );
});

test('MEV-04: linhas inválidas e lista vazia são recusadas', () => {
  refuses(
    () =>
      estimateShipment({
        items: [],
        weightTable: {},
        packageType: caixaM,
      }),
    'NO_PIECES',
  );
  refuses(
    () =>
      estimateShipment({
        items: [
          { garmentType: 'camiseta', pieces: 0 },
          { garmentType: '', pieces: 2 },
        ],
        weightTable: { camiseta: 150 },
        packageType: caixaM,
      }),
    'INVALID_ESTIMATE_ITEMS',
    ['items[0].pieces', 'items[1].garmentType'],
  );
  refuses(
    () =>
      estimateShipment({
        items: [{ garmentType: 'camiseta', pieces: 1 }],
        weightTable: { camiseta: 150 },
        packageType: { ...caixaM, maxLoadGrams: 0 },
      }),
    'INVALID_PACKAGE_TYPE',
    ['maxLoadGrams'],
  );
});

// MEV-06: packing -------------------------------------------------------------

const packingItems = [
  {
    index: 0,
    grade: [
      { size: 'P', quantity: 10 },
      { size: 'G', quantity: 5 },
    ],
  },
  { index: 1, grade: [{ size: 'M', quantity: 4 }] },
];

test('MEV-06: embalagens que batem com a grade são aceitas', () => {
  const packages = [
    {
      packageTypeId: 'caixa-m',
      weightGrams: 2500,
      contents: [
        { itemIndex: 0, size: 'P', quantity: 6 },
        { itemIndex: 0, size: 'G', quantity: 5 },
      ],
    },
    {
      packageTypeId: 'saco-p',
      weightGrams: 1200,
      contents: [
        { itemIndex: 0, size: 'P', quantity: 4 },
        { itemIndex: 1, size: 'M', quantity: 4 },
      ],
    },
  ];
  const result = validatePacking({
    items: packingItems,
    packages,
    packageTypes: [caixaM, sacoP],
  });
  assert.equal(result.totalPieces, 19);
  assert.deepEqual(
    result.packages.map((pkg) => [pkg.packageTypeId, pkg.pieces]),
    [
      ['caixa-m', 11],
      ['saco-p', 8],
    ],
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.packages[0].contents[0]));
  assert.ok(!Object.isFrozen(packages[0]), 'input is not frozen');
});

test('MEV-06: soma por item e tamanho diferente da grade aponta o campo', () => {
  const error = refuses(
    () =>
      validatePacking({
        items: packingItems,
        packages: [
          {
            packageTypeId: 'caixa-m',
            weightGrams: 3000,
            contents: [
              { itemIndex: 0, size: 'P', quantity: 10 },
              { itemIndex: 0, size: 'G', quantity: 4 },
              { itemIndex: 1, size: 'GG', quantity: 1 },
            ],
          },
        ],
        packageTypes: [caixaM],
      }),
    'PACKING_MISMATCH',
    ['items[0].grade.G', 'items[1].grade.M', 'items[1].grade.GG'],
  );
  assert.equal(error.problems.length, 3);
  assert.ok(Object.isFrozen(error.problems));
});

test('MEV-06: todos os problemas das embalagens vêm num erro só', () => {
  const error = refuses(
    () =>
      validatePacking({
        items: packingItems,
        packages: [
          {
            packageTypeId: 'caixa-x',
            weightGrams: 1000,
            contents: [{ itemIndex: 0, size: 'P', quantity: 10 }],
          },
          { packageTypeId: 'saco-p', weightGrams: 2021, contents: [] },
          {
            packageTypeId: 'caixa-m',
            weightGrams: 0,
            contents: [{ itemIndex: 0, size: 'G', quantity: 0 }],
          },
          {
            packageTypeId: 'caixa-m',
            weightGrams: 9000,
            contents: [
              { itemIndex: 0, size: 'G', quantity: 5 },
              { itemIndex: 1, size: 'M', quantity: 4 },
            ],
          },
        ],
        packageTypes: [caixaM, sacoP],
        limits: { ...CORREIOS_LIMITS, maxWeightGrams: 8000 },
      }),
    'PACKING_INVALID',
  );
  assert.deepEqual(
    error.problems.map((/** @type {any} */ problem) => [
      problem.code,
      problem.field,
    ]),
    [
      ['UNKNOWN_PACKAGE_TYPE', 'packages[0].packageTypeId'],
      ['EMPTY_PACKAGE', 'packages[1].contents'],
      ['PACKAGE_OVER_LOAD', 'packages[1].weightGrams'],
      ['INVALID_WEIGHT', 'packages[2].weightGrams'],
      ['INVALID_QUANTITY', 'packages[2].contents[0].quantity'],
      ['EMPTY_PACKAGE', 'packages[2].contents'],
      ['CARRIER_LIMIT', 'packages[3]'],
    ],
  );
  assert.deepEqual(error.problems[6].reasons, ['WEIGHT_ABOVE_MAX']);
  assert.deepEqual(error.fields, [
    'packages[0].packageTypeId',
    'packages[1].contents',
    'packages[1].weightGrams',
    'packages[2].weightGrams',
    'packages[2].contents[0].quantity',
    'packages[2].contents',
    'packages[3]',
  ]);
});

test('MEV-06: peso no limite da carga mais a tara passa', () => {
  const result = validatePacking({
    items: [{ index: 0, grade: [{ size: 'U', quantity: 1 }] }],
    packages: [
      {
        packageTypeId: 'saco-p',
        weightGrams: 2020,
        contents: [{ itemIndex: 0, size: 'U', quantity: 1 }],
      },
    ],
    packageTypes: [sacoP],
  });
  assert.equal(result.totalPieces, 1);
});

test('MEV-06: pedido sem embalagem é recusado', () => {
  refuses(
    () =>
      validatePacking({
        items: packingItems,
        packages: [],
        packageTypes: [caixaM],
      }),
    'PACKING_INVALID',
  );
  refuses(
    () =>
      validatePacking({
        items: [],
        packages: [],
        packageTypes: [caixaM],
      }),
    'NO_PACKAGES',
    ['packages'],
  );
});

// MEV-06/09: declared value ---------------------------------------------------

test('MEV-09: rateio do valor das peças fecha a soma exata', () => {
  const values = allocateDeclaredValue({
    piecesValueCents: 430000,
    packagePieces: [90, 80, 50],
  });
  assert.deepEqual(values, [175909, 156364, 97727]);
  assert.equal(
    values.reduce((sum, cents) => sum + cents, 0),
    430000,
  );
  assert.ok(Object.isFrozen(values));
});

test('MEV-09: rateio desempata para a primeira embalagem e aceita zero', () => {
  assert.deepEqual(
    allocateDeclaredValue({ piecesValueCents: 100, packagePieces: [1, 1, 1] }),
    [34, 33, 33],
  );
  assert.deepEqual(
    allocateDeclaredValue({ piecesValueCents: 2, packagePieces: [1, 1, 1] }),
    [1, 1, 0],
  );
  assert.deepEqual(
    allocateDeclaredValue({ piecesValueCents: 0, packagePieces: [3, 2] }),
    [0, 0],
  );
  assert.deepEqual(
    allocateDeclaredValue({ piecesValueCents: 999, packagePieces: [7] }),
    [999],
  );
});

test('MEV-09: rateio sem peças ou com valor quebrado é recusado', () => {
  refuses(
    () => allocateDeclaredValue({ piecesValueCents: 100, packagePieces: [] }),
    'NO_PIECES',
  );
  refuses(
    () =>
      allocateDeclaredValue({ piecesValueCents: 100, packagePieces: [2, 0] }),
    'NO_PIECES',
  );
  refuses(
    () => allocateDeclaredValue({ piecesValueCents: 10.5, packagePieces: [1] }),
    'INVALID_PIECES_VALUE',
  );
  refuses(
    () => allocateDeclaredValue({ piecesValueCents: -1, packagePieces: [1] }),
    'INVALID_PIECES_VALUE',
  );
});

test('MEV-09: valor da embalagem vira linhas que fecham ao centavo', () => {
  const lines = splitPackageValue({ valueCents: 10000, quantity: 3 });
  assert.deepEqual(lines, [
    { quantity: 2, unitValueCents: 3333 },
    { quantity: 1, unitValueCents: 3334 },
  ]);
  assert.ok(Object.isFrozen(lines));
  assert.ok(Object.isFrozen(lines[0]));
  assert.deepEqual(splitPackageValue({ valueCents: 175909, quantity: 90 }), [
    { quantity: 41, unitValueCents: 1954 },
    { quantity: 49, unitValueCents: 1955 },
  ]);
  assert.deepEqual(splitPackageValue({ valueCents: 9000, quantity: 3 }), [
    { quantity: 3, unitValueCents: 3000 },
  ]);
  assert.deepEqual(splitPackageValue({ valueCents: 2, quantity: 3 }), [
    { quantity: 1, unitValueCents: 0 },
    { quantity: 2, unitValueCents: 1 },
  ]);
  assert.deepEqual(splitPackageValue({ valueCents: 0, quantity: 4 }), [
    { quantity: 4, unitValueCents: 0 },
  ]);
  for (const [valueCents, quantity] of [
    [10000, 3],
    [175909, 90],
    [1, 7],
    [999_999, 13],
  ]) {
    const total = splitPackageValue({ valueCents, quantity }).reduce(
      (sum, line) => sum + line.quantity * line.unitValueCents,
      0,
    );
    assert.equal(total, valueCents);
  }
  refuses(
    () => splitPackageValue({ valueCents: 100, quantity: 0 }),
    'NO_PIECES',
    ['quantity'],
  );
  refuses(
    () => splitPackageValue({ valueCents: 10.5, quantity: 2 }),
    'INVALID_PIECES_VALUE',
    ['valueCents'],
  );
});

test('MEV-09: valor unitário arredonda meio centavo para cima', () => {
  assert.equal(unitValueCents(430000, 220), 1955);
  assert.equal(unitValueCents(5, 2), 3);
  assert.equal(unitValueCents(4, 3), 1);
  assert.equal(unitValueCents(0, 3), 0);
  refuses(() => unitValueCents(430000, 0), 'NO_PIECES', ['totalPieces']);
  refuses(() => unitValueCents(-1, 2), 'INVALID_PIECES_VALUE');
});

// MEV-02/07/08/09/14: Melhor Envio payloads ---------------------------------

test('MEV-02: corpo da cotação em cm, kg e reais', () => {
  const body = buildQuoteRequest({
    fromPostalCode: '69301-000',
    toPostalCode: '69.005-000',
    packages: [
      {
        lengthCm: 40,
        widthCm: 30,
        heightCm: 25,
        weightGrams: 16950,
        insuranceCents: 215000,
      },
      {
        lengthCm: 40,
        widthCm: 30,
        heightCm: 25,
        weightGrams: 16950,
        insuranceCents: 215055,
      },
    ],
    serviceIds: [1, 2],
  });
  assert.deepEqual(body, {
    from: { postal_code: '69301000' },
    to: { postal_code: '69005000' },
    volumes: [
      { height: 25, width: 30, length: 40, weight: 16.95 },
      { height: 25, width: 30, length: 40, weight: 16.95 },
    ],
    options: { insurance_value: 4300.55, receipt: false, own_hand: false },
    services: '1,2',
  });
  assert.ok(Object.isFrozen(body.options));
  const withoutServices = buildQuoteRequest({
    fromPostalCode: '69301000',
    toPostalCode: '69005000',
    packages: [
      {
        lengthCm: 16,
        widthCm: 11,
        heightCm: 2,
        weightGrams: 300,
        insuranceCents: 0,
      },
    ],
  });
  assert.equal('services' in withoutServices, false);
  assert.equal(withoutServices.volumes[0].weight, 0.3);
});

test('MEV-02: cotação com CEP, volume ou serviço inválido é recusada', () => {
  refuses(
    () =>
      buildQuoteRequest({
        fromPostalCode: '123',
        toPostalCode: '',
        packages: [],
      }),
    'INVALID_POSTAL_CODE',
    ['fromPostalCode', 'toPostalCode'],
  );
  refuses(
    () =>
      buildQuoteRequest({
        fromPostalCode: '69301000',
        toPostalCode: '69005000',
        packages: [],
      }),
    'INVALID_QUOTE_PACKAGES',
    ['packages'],
  );
  refuses(
    () =>
      buildQuoteRequest({
        fromPostalCode: '69301000',
        toPostalCode: '69005000',
        packages: [
          {
            lengthCm: 40,
            widthCm: 30,
            heightCm: 0,
            weightGrams: 1.5,
            insuranceCents: -1,
          },
        ],
      }),
    'INVALID_QUOTE_PACKAGES',
    [
      'packages[0].heightCm',
      'packages[0].weightGrams',
      'packages[0].insuranceCents',
    ],
  );
  refuses(
    () =>
      buildQuoteRequest({
        fromPostalCode: '69301000',
        toPostalCode: '69005000',
        packages: [
          {
            lengthCm: 40,
            widthCm: 30,
            heightCm: 25,
            weightGrams: 100,
            insuranceCents: 0,
          },
        ],
        serviceIds: [1, 0],
      }),
    'INVALID_SERVICE_IDS',
    ['serviceIds'],
  );
});

test('MEV-08: destinatário completo não tem pendência', () => {
  assert.deepEqual(missingRecipientFields(recipient), []);
  assert.deepEqual(
    missingRecipientFields({
      ...recipient,
      document: undefined,
      companyDocument: '11.222.333/0001-81',
    }),
    [],
  );
  assert.ok(Object.isFrozen(missingRecipientFields(recipient)));
});

test('MEV-08: destinatário incompleto lista o que falta', () => {
  assert.deepEqual(missingRecipientFields(null), [
    'name',
    'document',
    'address',
    'number',
    'district',
    'city',
    'stateAbbr',
    'postalCode',
    'phone',
  ]);
  assert.deepEqual(
    missingRecipientFields({
      ...recipient,
      document: '111.444.777-3',
      stateAbbr: 'Amazonas',
      postalCode: '6900-5000',
      phone: '9999-999',
      number: ' ',
    }),
    ['document', 'number', 'stateAbbr', 'postalCode', 'phone'],
  );
  assert.deepEqual(
    missingRecipientFields({ ...recipient, companyDocument: '11222333000181' }),
    ['document', 'companyDocument'],
    'CPF and CNPJ together are ambiguous',
  );
  assert.deepEqual(
    missingRecipientFields({
      ...recipient,
      document: '',
      companyDocument: '0000000000019',
    }),
    ['companyDocument'],
  );
});

test('MEV-08: CNPJ alfanumérico (julho de 2026) vale com dígitos certos', () => {
  for (const companyDocument of ['12.ABC.345/01DE-35', '12abc34501de35']) {
    assert.deepEqual(
      missingRecipientFields({ ...recipient, document: '', companyDocument }),
      [],
      companyDocument,
    );
  }
  for (const companyDocument of [
    '12.ABC.345/01DE-36',
    '12.ABC.345/01DE-3A',
    'AAAAAAAAAAAAAA',
  ]) {
    assert.deepEqual(
      missingRecipientFields({ ...recipient, document: '', companyDocument }),
      ['companyDocument'],
      companyDocument,
    );
  }
});

test('MEV-08: CPF e CNPJ com dígito errado ou repetido são inválidos', () => {
  for (const document of [
    '00000000000',
    '111.111.111-11',
    '111.444.777-36',
    '111.444.777-25',
  ]) {
    assert.deepEqual(
      missingRecipientFields({ ...recipient, document }),
      ['document'],
      document,
    );
  }
  for (const companyDocument of [
    '00000000000000',
    '11.222.333/0001-82',
    '11.222.333/0001-91',
  ]) {
    assert.deepEqual(
      missingRecipientFields({ ...recipient, document: '', companyDocument }),
      ['companyDocument'],
      companyDocument,
    );
  }
  assert.deepEqual(
    missingSenderFields({ ...sender, companyDocument: '11222333000180' }),
    ['companyDocument'],
  );
  refuses(
    () =>
      buildCartItem(
        cartInput({ recipient: { ...recipient, document: '11144477734' } }),
      ),
    'RECIPIENT_INCOMPLETE',
    ['document'],
  );
});

test('MEV-14: remetente de envio com NF-e precisa da IE', () => {
  const withoutIe = { ...sender, stateRegister: undefined };
  assert.deepEqual(missingSenderFields(withoutIe), []);
  assert.deepEqual(missingSenderFields(withoutIe, { commercial: true }), [
    'stateRegister',
  ]);
});

test('MEV-07/09: item do carrinho sem NF-e leva DC-e, lembrete e tag', () => {
  const body = buildCartItem(cartInput());
  assert.deepEqual(body, {
    service: 1,
    from: {
      name: 'Remetente Teste Ltda',
      phone: '0000000000',
      company_document: '11222333000181',
      address: 'Rua Exemplo',
      number: '100',
      district: 'Bairro Teste',
      city: 'Cidade Teste',
      state_abbr: 'RR',
      country_id: 'BR',
      postal_code: '69301000',
      email: 'expedicao@example.test',
      state_register: '000000000',
    },
    to: {
      name: 'Cliente Teste',
      phone: '00900000000',
      document: '11144477735',
      address: 'Avenida Fictícia',
      number: '42',
      district: 'Centro Teste',
      city: 'Outra Cidade',
      state_abbr: 'AM',
      country_id: 'BR',
      postal_code: '69005000',
      complement: 'Sala 1',
    },
    products: [
      { name: 'Camiseta', quantity: '41', unitary_value: '19.54' },
      { name: 'Camiseta', quantity: '49', unitary_value: '19.55' },
    ],
    volumes: [{ height: 25, width: 30, length: 40, weight: 13.95 }],
    options: {
      insurance_value: 1759.09,
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: true,
      reminder: 'Pedido 0123-CRM · Embalagem 1/3',
      tags: [{ tag: 'ord_123', url: null }],
    },
  });
  assert.equal('invoice' in body.options, false);
  assert.equal(body.volumes.length, 1);
  assert.ok(Object.isFrozen(body.to));
  assert.ok(Object.isFrozen(body.options.tags[0]));
});

test('MEV-14: item do carrinho com NF-e leva a chave e é comercial', () => {
  const key = '1'.repeat(44);
  const body = buildCartItem(
    cartInput({
      invoiceKey: `${key.slice(0, 4)} ${key.slice(4)}`,
      packageIndex: 2,
    }),
  );
  assert.equal(body.options.non_commercial, false);
  assert.deepEqual(body.options.invoice, { key });
  assert.equal(body.options.reminder, 'Pedido 0123-CRM · Embalagem 3/3');
  refuses(
    () => buildCartItem(cartInput({ invoiceKey: '123' })),
    'INVALID_INVOICE_KEY',
    ['invoiceKey'],
  );
  refuses(
    () =>
      buildCartItem(
        cartInput({
          invoiceKey: key,
          sender: { ...sender, stateRegister: '' },
        }),
      ),
    'SENDER_INCOMPLETE',
    ['stateRegister'],
  );
});

test('MEV-08: item do carrinho para em dado faltando do destinatário', () => {
  refuses(
    () =>
      buildCartItem(
        cartInput({ recipient: { ...recipient, district: '', phone: '' } }),
      ),
    'RECIPIENT_INCOMPLETE',
    ['district', 'phone'],
  );
  refuses(
    () => buildCartItem(cartInput({ sender: { ...sender, city: '' } })),
    'SENDER_INCOMPLETE',
    ['city'],
  );
});

test('MEV-07: item do carrinho com dado técnico inválido lista os campos', () => {
  refuses(
    () =>
      buildCartItem(
        cartInput({
          serviceId: 0,
          pkg: { lengthCm: 40, widthCm: 30, heightCm: 25, weightGrams: 0 },
          products: [{ name: '', quantity: 0, unitValueCents: -1 }],
          insuranceCents: 1.5,
          orderId: '',
          orderNumber: ' ',
          packageIndex: 3,
          packageCount: 3,
        }),
      ),
    'INVALID_CART_ITEM',
    [
      'serviceId',
      'pkg.weightGrams',
      'products[0].name',
      'products[0].quantity',
      'products[0].unitValueCents',
      'insuranceCents',
      'orderId',
      'orderNumber',
      'packageIndex',
    ],
  );
  refuses(
    () => buildCartItem(cartInput({ products: [], packageCount: 0 })),
    'INVALID_CART_ITEM',
    ['products', 'packageCount'],
  );
});

test('MEV-09: rateio de 10001 centavos em [1, 1] fecha em cada etiqueta', () => {
  const allocated = allocateDeclaredValue({
    piecesValueCents: 10001,
    packagePieces: [1, 1],
  });
  assert.deepEqual(allocated, [5001, 5000]);
  const bodies = allocated.map((insuranceCents, packageIndex) =>
    buildCartItem(
      cartInput({
        products: splitPackageValue({
          valueCents: insuranceCents,
          quantity: 1,
        }).map((line) => ({ name: 'Camiseta', ...line })),
        insuranceCents,
        packageIndex,
        packageCount: 2,
      }),
    ),
  );
  assert.deepEqual(
    bodies.map((body) => [body.products, body.options.insurance_value]),
    [
      [[{ name: 'Camiseta', quantity: '1', unitary_value: '50.01' }], 50.01],
      [[{ name: 'Camiseta', quantity: '1', unitary_value: '50.00' }], 50],
    ],
  );
});

test('MEV-09: 10000 centavos em 3 peças repete o nome com valores diferentes', () => {
  const body = buildCartItem(
    cartInput({
      products: splitPackageValue({ valueCents: 10000, quantity: 3 }).map(
        (line) => ({ name: 'Camiseta', ...line }),
      ),
      insuranceCents: 10000,
    }),
  );
  assert.deepEqual(body.products, [
    { name: 'Camiseta', quantity: '2', unitary_value: '33.33' },
    { name: 'Camiseta', quantity: '1', unitary_value: '33.34' },
  ]);
  assert.equal(body.options.insurance_value, 100);
});

test('MEV-09: produtos que não fecham com o seguro são recusados', () => {
  refuses(
    () =>
      buildCartItem(
        cartInput({
          products: [{ name: 'Camiseta', quantity: 90, unitValueCents: 1955 }],
          insuranceCents: 175909,
        }),
      ),
    'DECLARED_VALUE_MISMATCH',
    ['products', 'insuranceCents'],
  );
  refuses(
    () =>
      buildCartItem(
        cartInput({
          products: [{ name: 'Camiseta', quantity: 3, unitValueCents: 3333 }],
          insuranceCents: 10000,
        }),
      ),
    'DECLARED_VALUE_MISMATCH',
  );
});

test('MEV-09: seguro acima do limite do serviço é recusado só quando informado', () => {
  assert.equal(PAC_MAX_INSURANCE_CENTS, 300000);
  const above = {
    products: [{ name: 'Camiseta', quantity: 2, unitValueCents: 200000 }],
    insuranceCents: 400000,
  };
  // The PAC default is documentation, never applied implicitly.
  assert.equal(buildCartItem(cartInput(above)).options.insurance_value, 4000);
  refuses(
    () =>
      buildCartItem(
        cartInput({ ...above, maxInsuranceCents: PAC_MAX_INSURANCE_CENTS }),
      ),
    'INSURANCE_ABOVE_LIMIT',
    ['insuranceCents'],
  );
  assert.equal(
    buildCartItem(
      cartInput({
        products: [{ name: 'Camiseta', quantity: 2, unitValueCents: 150000 }],
        insuranceCents: 300000,
        maxInsuranceCents: PAC_MAX_INSURANCE_CENTS,
      }),
    ).options.insurance_value,
    3000,
  );
  refuses(
    () => buildCartItem(cartInput({ maxInsuranceCents: -1 })),
    'INVALID_CART_ITEM',
    ['maxInsuranceCents'],
  );

  const volume = { lengthCm: 40, widthCm: 30, heightCm: 25, weightGrams: 900 };
  const quote = {
    fromPostalCode: '69301000',
    toPostalCode: '69005000',
    packages: [
      { ...volume, insuranceCents: 300000 },
      { ...volume, insuranceCents: 300001 },
    ],
  };
  assert.equal(buildQuoteRequest(quote).options.insurance_value, 6000.01);
  refuses(
    () =>
      buildQuoteRequest({
        ...quote,
        maxInsuranceCents: PAC_MAX_INSURANCE_CENTS,
      }),
    'INSURANCE_ABOVE_LIMIT',
    ['packages[1].insuranceCents'],
  );
  refuses(
    () => buildQuoteRequest({ ...quote, maxInsuranceCents: 1.5 }),
    'INVALID_QUOTE_PACKAGES',
    ['maxInsuranceCents'],
  );
});

test('MEV-07: chave de compra da etiqueta é estável por versão', () => {
  assert.equal(
    labelPurchaseKey({
      orderId: 'ord_123',
      packingVersion: 2,
      packageIndex: 0,
    }),
    'me:label:ord_123:v2:0',
  );
  assert.notEqual(
    labelPurchaseKey({
      orderId: 'ord_123',
      packingVersion: 3,
      packageIndex: 0,
    }),
    labelPurchaseKey({
      orderId: 'ord_123',
      packingVersion: 2,
      packageIndex: 0,
    }),
  );
  refuses(
    () =>
      labelPurchaseKey({ orderId: 'a:b', packingVersion: 0, packageIndex: -1 }),
    'INVALID_PURCHASE_KEY',
    ['orderId', 'packingVersion', 'packageIndex'],
  );
});

// MEV-10: freight difference -------------------------------------------------

test('MEV-10: diferença dentro da tolerância é absorvida', () => {
  const result = decideFreightDifference({
    quotedCents: 26700,
    actualCents: 28140,
  });
  assert.deepEqual(result, {
    differenceCents: 1440,
    toleranceCents: 2000,
    decision: 'absorb',
  });
  assert.ok(Object.isFrozen(result));
});

test('MEV-10: diferença acima da tolerância vai ao gestor', () => {
  assert.deepEqual(
    decideFreightDifference({ quotedCents: 26700, actualCents: 31200 }),
    { differenceCents: 4500, toleranceCents: 2000, decision: 'needs_manager' },
  );
  // The 10% cap wins on a small quote: 10% of 5000 is 500.
  assert.deepEqual(
    decideFreightDifference({ quotedCents: 5000, actualCents: 5501 }),
    { differenceCents: 501, toleranceCents: 500, decision: 'needs_manager' },
  );
  assert.equal(
    decideFreightDifference({ quotedCents: 5000, actualCents: 5500 }).decision,
    'absorb',
  );
});

test('MEV-10: frete real igual ou mais barato não tem diferença', () => {
  assert.equal(
    decideFreightDifference({ quotedCents: 26700, actualCents: 26700 })
      .decision,
    'no_difference',
  );
  assert.deepEqual(
    decideFreightDifference({ quotedCents: 26700, actualCents: 25000 }),
    { differenceCents: -1700, toleranceCents: 2000, decision: 'no_difference' },
  );
});

test('MEV-10: tolerância configurável, sem erro de ponto flutuante', () => {
  assert.equal(
    decideFreightDifference({
      quotedCents: 100,
      actualCents: 129,
      maxRatio: 0.29,
      maxAbsoluteCents: 1000,
    }).toleranceCents,
    29,
  );
  assert.deepEqual(
    decideFreightDifference({
      quotedCents: 26700,
      actualCents: 26701,
      maxAbsoluteCents: 0,
    }),
    { differenceCents: 1, toleranceCents: 0, decision: 'needs_manager' },
  );
  assert.equal(
    decideFreightDifference({ quotedCents: 0, actualCents: 1 }).decision,
    'needs_manager',
  );
  refuses(
    () =>
      decideFreightDifference({
        quotedCents: -1,
        actualCents: 1.5,
        maxAbsoluteCents: -2,
        maxRatio: 2,
      }),
    'INVALID_FREIGHT_DIFFERENCE',
    ['quotedCents', 'actualCents', 'maxAbsoluteCents', 'maxRatio'],
  );
});
