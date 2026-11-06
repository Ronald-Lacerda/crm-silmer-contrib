import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStoreOrder,
  matchStoreCatalog,
  parseStoreOrderRecord,
} from '../modules/orders/src/domain/store-order.js';
import {
  applyStoreSourceCommand,
  projectStoreSource,
  storeSourceView,
} from '../modules/orders/src/domain/store-order-source.js';
import { STORE_NOW, storeOrderBody } from './fixtures/store-order.js';

/** @param {(body:any) => void} [change] @returns {import('../modules/orders/src/domain/order.js').Order} */
function orderFixture(change) {
  const record = parseStoreOrderRecord(storeOrderBody(change));
  const match = matchStoreCatalog(record, { acceptTest: true, now: STORE_NOW });
  return {
    ...buildStoreOrder({
      record,
      match,
      id: 'store-source-synthetic',
      fabCode: '01',
      now: STORE_NOW,
    }),
    number: '01-CRM',
    numberSequence: 1,
    version: 1,
    createdAt: STORE_NOW.toISOString(),
    updatedAt: STORE_NOW.toISOString(),
    reopenedAt: null,
    reopenedBy: null,
    deliveredOn: null,
  };
}

/** @param {import('../modules/orders/src/domain/store-order-source.js').StoreSourceData} data */
function recordFor(data) {
  return {
    data,
    revision: 1,
    orderVersion: 1,
    sourceValid: true,
    updatedBy: 'synthetic-admin',
    updatedAt: STORE_NOW.toISOString(),
  };
}

const REGISTRATION = Object.freeze({
  personType: 'individual',
  document: '52998224725',
  legalName: 'Comprador Sintético',
  postalCode: '29010-000',
  city: 'Vitória',
  state: 'ES',
  street: 'Rua Sintética',
  district: 'Centro',
  number: '10',
});

/** @param {import('../modules/orders/src/domain/store-order-source.js').StoreSourceData} data @param {Record<string,unknown>} [override] */
function detailsCommand(data, override = {}) {
  return {
    action: 'set_store_details',
    deliveryOn: '2026-11-20',
    applications: data.groups.map((group) => ({
      groupId: group.id,
      application: 'SEM ESTAMPA',
    })),
    registration: { ...REGISTRATION },
    ...override,
  };
}

test('OLIST-T24 kit, unit product and test order use their sole stored line without a Contact or a catalog lookup', () => {
  const kit = orderFixture();
  const unit = orderFixture((body) => {
    body.produto.slug = 'bloquinho-22';
    body.item.cor_id = 'branca-amarela';
    body.item.prazo_dias = 1;
    body.item.quantidade = 2;
    body.valor_centavos = 6000;
    body.pagamento.valor_pago_centavos = 6000;
  });
  const testOrder = orderFixture((body) => {
    body.teste = true;
    body.valor_centavos = 100;
    body.pagamento.valor_pago_centavos = 100;
  });
  for (const order of [kit, unit, testOrder]) {
    const original = structuredClone(order);
    const source = applyStoreSourceCommand(order, null, {
      action: 'initialize',
    });
    assert.equal(order.contactId, undefined);
    assert.match(source.groups[0].id, /^[0-9a-f-]{36}$/u);
    assert.equal(source.groups[0].lines[0].quantity, order.totalPieces);
    assert.equal(
      source.groups[0].lines[0].subtotalCents,
      order.finalAmountCents,
    );
    assert.equal(source.groups[0].lines[0].subtotalReviewed, true);
    assert.equal(source.details.deliveryOn, null);
    assert.equal(source.details.applications[0].application, null);
    assert.equal(source.details.registration, null);
    assert.deepEqual(order, original);
  }
  // Snapshot survives catalog withdrawal/repricing. This path has no catalog port.
  const historical = structuredClone(unit);
  assert.ok(historical.ficha.loja);
  historical.ficha.loja.produto.slug = 'produto-retirado-do-catalogo';
  historical.totalPieces = 1;
  historical.ficha.items[0].grade[0].quantidade = 1;
  historical.finalAmountCents = 3000;
  const source = applyStoreSourceCommand(historical, null, {
    action: 'initialize',
  });
  assert.equal(historical.gatewayPayment?.paidAmountCents, 6000);
  assert.equal(source.groups[0].lines[0].subtotalCents, 3000);
});

test('OLIST-T24 missing fiscal data, forecast and application remain explicit, including store test orders', () => {
  for (const order of [
    orderFixture(),
    orderFixture((body) => {
      body.teste = true;
      body.valor_centavos = 100;
      body.pagamento.valor_pago_centavos = 100;
    }),
  ]) {
    const absent = projectStoreSource(order, null);
    assert.equal(absent.mode, 'store');
    assert.equal(absent.sourceValid, false);
    assert.equal(absent.pricing, null);
    assert.ok(
      absent.issues.some(
        (issue) => issue.code === 'STORE_ORDER_COMPLEMENT_REQUIRED',
      ),
    );
    const data = applyStoreSourceCommand(order, null, { action: 'initialize' });
    const projected = projectStoreSource(order, recordFor(data));
    assert.equal(projected.pricing?.totalCents, order.finalAmountCents);
    for (const field of [
      'deliveryOn',
      'applications.' + data.groups[0].id,
      'registration.personType',
      'registration.document',
      'registration.street',
    ])
      assert.ok(
        projected.issues.some((issue) => issue.field === field),
        field,
      );
    // Neither leadTimeBusinessDays nor an observation containing CEP is parsed.
    order.leadTimeBusinessDays = 0;
    order.ficha.observations = ['CEP: 29010-000. Aplicação: DTF.'];
    assert.equal(
      projectStoreSource(order, recordFor(data)).details?.deliveryOn,
      null,
    );
    assert.equal(
      projectStoreSource(order, recordFor(data)).details?.registration,
      null,
    );
  }
});

test('OLIST-T24 explicit details create a transient ready view and preserve original ficha, gateway and IDs', () => {
  const order = orderFixture();
  const original = structuredClone(order);
  const initial = applyStoreSourceCommand(order, null, {
    action: 'initialize',
  });
  const current = structuredClone(initial);
  const ready = applyStoreSourceCommand(
    order,
    initial,
    detailsCommand(initial),
  );
  assert.deepEqual(initial, current);
  assert.deepEqual(ready.groups, initial.groups);
  assert.equal(ready.details.registration?.document, REGISTRATION.document);
  assert.equal(ready.details.registration?.postalCode, '29010000');
  const projected = projectStoreSource(order, recordFor(ready));
  assert.deepEqual(projected.issues, []);
  assert.equal(projected.sourceValid, true);
  assert.equal(projected.buyer?.phone, order.ficha.loja?.telefone);
  const view = storeSourceView(order, ready);
  assert.equal(view.ficha.summary.data_entrega_confirmada, '2026-11-20');
  assert.equal(view.ficha.items[0].tipo_servico, 'SEM ESTAMPA');
  assert.equal(view.ficha.sizePricing?.[0].id, initial.groups[0].id);
  assert.equal(view.finalAmountCents, original.finalAmountCents);
  assert.deepEqual(view.gatewayPayment, original.gatewayPayment);
  assert.deepEqual(order, original);
});

test('OLIST-T24 partial registration is a valid draft, while malformed fiscal values and dates are refused', () => {
  const order = orderFixture();
  const data = applyStoreSourceCommand(order, null, { action: 'initialize' });
  const draft = applyStoreSourceCommand(
    order,
    data,
    detailsCommand(data, { registration: { personType: 'company' } }),
  );
  const fields = projectStoreSource(order, recordFor(draft)).issues.map(
    (issue) => issue.field,
  );
  assert.ok(fields.includes('registration.document'));
  assert.ok(fields.includes('registration.stateRegistration'));
  const invalidValues = [
    detailsCommand(data, {
      registration: { ...REGISTRATION, document: '00000000000' },
    }),
    detailsCommand(data, {
      registration: { ...REGISTRATION, totalCents: 18000 },
    }),
    detailsCommand(data, { registration: { ...REGISTRATION, state: 'XX' } }),
    detailsCommand(data, { deliveryOn: '2026-02-30' }),
    detailsCommand(data, { deliveryOn: '20/11/2026' }),
    detailsCommand(data, {
      applications: [{ groupId: data.groups[0].id, application: '  ' }],
    }),
  ];
  for (const value of invalidValues)
    assert.throws(() => applyStoreSourceCommand(order, data, value), {
      code: 'ORDER_SOURCE_INVALID',
    });
  const company = applyStoreSourceCommand(
    order,
    data,
    detailsCommand(data, {
      registration: {
        ...REGISTRATION,
        personType: 'company',
        document: '11222333000181',
        stateRegistration: 'ISENTO',
      },
    }),
  );
  assert.deepEqual(projectStoreSource(order, recordFor(company)).issues, []);
});

test('OLIST-T24 commands cannot overwrite checkout prices, quantities, review flags, buyer snapshot or group identities', () => {
  const order = orderFixture();
  const data = applyStoreSourceCommand(order, null, { action: 'initialize' });
  const before = structuredClone(data);
  const forgeries = [
    { ...detailsCommand(data), groups: data.groups },
    { ...detailsCommand(data), subtotalCents: 100 },
    { ...detailsCommand(data), quantity: 1 },
    { ...detailsCommand(data), buyer: { name: 'Outro' } },
    detailsCommand(data, {
      applications: [{ groupId: 'forged', application: 'DTF' }],
    }),
    detailsCommand(data, {
      applications: [
        {
          groupId: data.groups[0].id,
          application: 'DTF',
          subtotalReviewed: true,
        },
      ],
    }),
    detailsCommand(data, { applications: [] }),
    detailsCommand(data, {
      applications: [
        ...data.details.applications,
        ...data.details.applications,
      ],
    }),
  ];
  for (const value of forgeries)
    assert.throws(() => applyStoreSourceCommand(order, data, value), {
      code: 'ORDER_SOURCE_INVALID',
    });
  assert.throws(
    () =>
      applyStoreSourceCommand(order, null, {
        action: 'initialize',
        id: data.groups[0].id,
      }),
    { code: 'ORDER_SOURCE_INVALID' },
  );
  assert.throws(
    () => applyStoreSourceCommand(order, data, { action: 'initialize' }),
    { code: 'SIZE_PRICING_ALREADY_INITIALIZED' },
  );
  assert.throws(
    () => applyStoreSourceCommand(order, null, detailsCommand(data)),
    { code: 'SIZE_PRICING_NOT_INITIALIZED' },
  );
  assert.deepEqual(data, before);
});

test('OLIST-T24 invalid or fabricated store snapshots do not gain trust from origin alone', () => {
  /** @type {Array<(order:any) => void>} */
  const mutations = [
    (o) => {
      o.gatewayPayment = null;
    },
    (o) => {
      o.gatewayPayment.source = 'other';
    },
    (o) => {
      o.gatewayPayment.paidAmountCents = 1;
    },
    (o) => {
      o.gatewayPayment.transactionNsu = undefined;
    },
    (o) => {
      o.gatewayPayment.invoiceSlug = 99;
    },
    (o) => {
      o.gatewayPayment.confirmedAt = '2026-02-30T12:00:00Z';
    },
    (o) => {
      o.paymentCondition = 'cartao_credito';
    },
    (o) => {
      o.totalPieces = 9;
    },
    (o) => {
      o.finalAmountCents = 0;
    },
    (o) => {
      o.ficha.items.push(structuredClone(o.ficha.items[0]));
    },
    (o) => {
      o.ficha.items[0].grade.push({ tamanho: 'G', quantidade: 2 });
    },
    (o) => {
      o.ficha.loja.telefone = '';
    },
    (o) => {
      o.ficha.loja.produto = null;
    },
    (o) => {
      o.contactId = 'forged-contact';
    },
    (o) => {
      o.ficha.sizePricing = [];
    },
  ];
  for (const mutate of mutations) {
    const order = orderFixture();
    mutate(order);
    assert.throws(
      () => applyStoreSourceCommand(order, null, { action: 'initialize' }),
      { code: 'ORDER_SOURCE_INVALID' },
    );
  }
  const regular = orderFixture();
  regular.origin = 'atendimento';
  assert.throws(
    () => applyStoreSourceCommand(regular, null, { action: 'initialize' }),
    { code: 'ORDER_LOCKED' },
  );
  const pending = orderFixture();
  pending.status = 'pendente';
  assert.throws(
    () => applyStoreSourceCommand(pending, null, { action: 'initialize' }),
    { code: 'ORDER_STATUS_CONFLICT' },
  );
});

test('OLIST-T24 stale source never publishes valid prices or buyer and forged stored prices are refused', () => {
  const order = orderFixture();
  const data = applyStoreSourceCommand(order, null, { action: 'initialize' });
  const ready = applyStoreSourceCommand(order, data, detailsCommand(data));
  const stale = projectStoreSource(order, {
    ...recordFor(ready),
    sourceValid: false,
  });
  assert.equal(stale.pricing, null);
  assert.equal(stale.buyer, null);
  assert.equal(stale.sourceValid, false);
  assert.ok(stale.issues.some((issue) => issue.code === 'ORDER_SOURCE_STALE'));
  const bad = structuredClone(ready);
  bad.groups[0].lines[0].subtotalCents = 1;
  assert.throws(() => projectStoreSource(order, recordFor(bad)), {
    code: 'ORDER_SOURCE_INVALID',
  });
  const unreviewed = structuredClone(ready);
  unreviewed.groups[0].lines[0].subtotalReviewed = false;
  assert.throws(() => storeSourceView(order, unreviewed), {
    code: 'ORDER_SOURCE_INVALID',
  });
});

test('OLIST-T24 already explicit snapshot forecast/application cannot be silently overridden', () => {
  const order = orderFixture();
  order.ficha.summary.data_entrega_confirmada = '2026-11-20';
  order.ficha.items[0].tipo_servico = 'DTF';
  const data = applyStoreSourceCommand(order, null, { action: 'initialize' });
  assert.throws(
    () => applyStoreSourceCommand(order, data, detailsCommand(data)),
    { code: 'ORDER_SOURCE_INVALID' },
  );
  assert.throws(
    () =>
      applyStoreSourceCommand(
        order,
        data,
        detailsCommand(data, {
          deliveryOn: '2026-11-21',
          applications: [{ groupId: data.groups[0].id, application: 'DTF' }],
        }),
      ),
    { code: 'ORDER_SOURCE_INVALID' },
  );
  const selected = applyStoreSourceCommand(
    order,
    data,
    detailsCommand(data, {
      deliveryOn: null,
      applications: [{ groupId: data.groups[0].id, application: null }],
    }),
  );
  const view = storeSourceView(order, selected);
  assert.equal(view.ficha.summary.data_entrega_confirmada, '2026-11-20');
  assert.equal(view.ficha.items[0].tipo_servico, 'DTF');
});

test('OLIST-T24 quantity and amount correction makes old complements unusable without rewriting the gateway', () => {
  const order = orderFixture((body) => {
    body.produto.slug = 'bloquinho-22';
    body.item.cor_id = 'branca-amarela';
    body.item.prazo_dias = 1;
    body.item.quantidade = 2;
    body.valor_centavos = 6000;
    body.pagamento.valor_pago_centavos = 6000;
  });
  const initial = applyStoreSourceCommand(order, null, {
    action: 'initialize',
  });
  const ready = applyStoreSourceCommand(
    order,
    initial,
    detailsCommand(initial),
  );
  const gateway = structuredClone(order.gatewayPayment);
  const corrected = structuredClone(order);
  corrected.version++;
  corrected.totalPieces = 1;
  corrected.ficha.items[0].grade[0].quantidade = 1;
  corrected.finalAmountCents = 3000;
  const stale = projectStoreSource(corrected, {
    ...recordFor(ready),
    sourceValid: false,
  });
  assert.equal(stale.pricing, null);
  assert.equal(stale.buyer, null);
  assert.ok(stale.issues.some((issue) => issue.code === 'ORDER_SOURCE_STALE'));
  assert.deepEqual(corrected.gatewayPayment, gateway);
  const renewed = applyStoreSourceCommand(corrected, null, {
    action: 'initialize',
  });
  assert.notEqual(renewed.groups[0].id, ready.groups[0].id);
  assert.equal(renewed.groups[0].lines[0].quantity, 1);
  assert.equal(renewed.groups[0].lines[0].subtotalCents, 3000);
  assert.equal(renewed.details.registration, null);
  assert.equal(renewed.details.deliveryOn, null);
});

test('OLIST-T24 malformed original application never becomes ready or raises a trim TypeError', () => {
  const original = orderFixture();
  const data = applyStoreSourceCommand(original, null, {
    action: 'initialize',
  });
  const ready = applyStoreSourceCommand(
    original,
    data,
    detailsCommand(data, {
      applications: [{ groupId: data.groups[0].id, application: null }],
    }),
  );
  for (const application of [
    'DTF\u0000',
    'DTF\n',
    'x'.repeat(201),
    42,
    [],
    {},
  ]) {
    const malformed = structuredClone(original);
    /** @type {any} */ (malformed.ficha.items[0]).tipo_servico = application;
    for (const work of [
      () => applyStoreSourceCommand(malformed, null, { action: 'initialize' }),
      () => projectStoreSource(malformed, recordFor(ready)),
      () => storeSourceView(malformed, ready),
    ])
      assert.throws(work, {
        code: 'ORDER_SOURCE_INVALID',
        fields: ['items.0.tipo_servico'],
      });
  }
});

test('OLIST-T24 every fabric entry must be valid before a store complement can be ready', () => {
  const original = orderFixture();
  const data = applyStoreSourceCommand(original, null, {
    action: 'initialize',
  });
  const ready = applyStoreSourceCommand(original, data, detailsCommand(data));
  const sparse = new Array(2);
  sparse[0] = 'Algodão';
  for (const fabrics of [
    ['Algodão', 'x\u0000'],
    ['Algodão', 'x'.repeat(201)],
    ['Algodão', 42],
    [],
    sparse,
  ]) {
    const malformed = structuredClone(original);
    /** @type {any} */ (malformed.ficha.items[0]).malhas = fabrics;
    const projected = projectStoreSource(malformed, recordFor(ready));
    assert.ok(
      projected.issues.some(
        (issue) =>
          issue.code === 'STORE_ITEM_FIELD_REQUIRED' &&
          issue.field === 'items.0.malhas',
      ),
    );
  }
  const valid = structuredClone(original);
  valid.ficha.items[0].malhas = ['Algodão', 'Dry fit'];
  assert.deepEqual(projectStoreSource(valid, recordFor(ready)).issues, []);
});
