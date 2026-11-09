import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  blankItem,
  changeSizePricingQuantity,
  createSizePricing,
  reviewSizePricingSubtotal,
} from '@crm-silmer/orders';
import { buildOlistPreviewPlan } from '../apps/api/src/olist-preview-plan.js';

function fixture() {
  let id = 1;
  let groups = createSizePricing(
    [[{ size: 'M', quantity: 2 }], [{ size: 'M', quantity: 3 }]],
    () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
  );
  groups = reviewSizePricingSubtotal(
    groups,
    groups[0].id,
    groups[0].lines[0].id,
    600,
  );
  groups = reviewSizePricingSubtotal(
    groups,
    groups[1].id,
    groups[1].lines[0].id,
    1200,
  );
  /** @type {any} */
  const order = {
    status: 'confirmado',
    origin: 'atendimento',
    version: 4,
    orderDate: null,
    finalAmountCents: 1800,
    paymentCondition: 'pix',
    missingFields: [],
    ficha: {
      summary: {
        cliente: 'Nome sintético',
        nome: null,
        data_entrega_confirmada: '2026-11-20',
      },
      items: groups.map((group, index) => ({
        ...blankItem(),
        tipo: index === 0 ? 'Camiseta' : 'Polo',
        cor: 'Azul',
        tipo_servico: 'Sublimação',
        malhas: ['Poliéster', 'Algodão'],
        gola: 'Redonda',
        grade: group.lines.map((line) => ({
          tamanho: line.size,
          quantidade: line.quantity,
        })),
      })),
      sizePricing: groups,
      artwork: {
        feito_pelo_cliente: false,
        feito_pela_silmer: false,
        sem_estampa: true,
        files: ['private-art'],
      },
      observations: ['private-notes'],
      serviceData: { privateConversation: 'private-conversation' },
    },
  };
  return {
    source: { order, sourceRevision: 0, issues: [] },
    buyer: {
      name: 'Cliente sintético',
      phone: '11987654321',
      email: null,
      registration: {
        personType: 'individual',
        document: '529.982.247-25',
        legalName: 'Comprador sintético',
        postalCode: '01001-000',
        city: 'São Paulo',
        state: 'SP',
        street: 'Rua sintética',
        district: 'Centro',
        number: 'S/N',
      },
    },
    settings: {
      sellerId: 7,
      operationNatureId: 8,
      warehouseId: 9,
      paymentMethodId: 10,
      originId: 11,
      paymentTerms: '30 dias',
      paymentDueOn: '2026-11-30',
      purchaseOrder: null,
      priceListId: null,
    },
    now: new Date('2026-11-06T01:00:00.000Z'),
  };
}

/** @param {ReturnType<typeof buildOlistPreviewPlan>} plan @param {string} code */
function hasIssue(plan, code) {
  assert.ok(
    plan.issues.some((entry) => entry.code === code),
    JSON.stringify(plan.issues),
  );
  assert.equal(plan.eligible, false);
  assert.deepEqual(
    plan.commercial.groups,
    [],
    'a blocked source must never expose an executable partial plan',
  );
}

test('T06 builds exact identity-addressed lines, minimal buyer and São Paulo proposal without mutating source', () => {
  const input = fixture();
  const before = structuredClone(input);
  const plan = buildOlistPreviewPlan(input);
  assert.deepEqual(input, before);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.commercial.orderDate, '2026-11-05');
  assert.equal(plan.commercial.deliveryOn, '2026-11-20');
  assert.equal(plan.commercial.totalCents, 1800);
  assert.equal(plan.commercial.groups.length, 2);
  assert.equal(plan.commercial.groups[0].lines[0].unitLexeme, '3.00');
  assert.equal(plan.commercial.groups[1].lines[0].unitLexeme, '4.00');
  assert.equal(plan.commercial.groups[0].lines[0].size, 'M');
  assert.notEqual(
    plan.commercial.groups[0].lines[0].lineId,
    plan.commercial.groups[1].lines[0].lineId,
  );
  assert.equal(plan.commercial.groups[0].attributes.audience, '');
  assert.equal(
    plan.commercial.groups[0].attributes.fabric,
    '["Algodão","Poliéster"]',
  );
  assert.deepEqual(plan.customer, {
    tipoPessoa: 'F',
    cpfCnpj: '52998224725',
    nome: 'Comprador sintético',
    celular: '5511987654321',
    endereco: {
      cep: '01001000',
      municipio: 'São Paulo',
      uf: 'SP',
      endereco: 'Rua sintética',
      bairro: 'Centro',
      numero: 'S/N',
    },
    situacao: 'B',
  });
  assert.doesNotMatch(
    JSON.stringify(plan),
    /private-|serviceData|observations|artwork|paidOn|files/,
  );
});

test('T06 complete pendente and confirmado have equal proposals; existing orderDate wins', () => {
  const input = fixture();
  input.source.order.orderDate = '2026-10-31';
  const confirmed = buildOlistPreviewPlan(input);
  input.source.order.status = 'pendente';
  assert.deepEqual(buildOlistPreviewPlan(input), confirmed);
  assert.equal(confirmed.commercial.orderDate, '2026-10-31');
});

test('T06 confirmed missingFields=[] never proves completeness', () => {
  const input = fixture();
  input.source.order.ficha.items[0].tipo_servico = '';
  const plan = buildOlistPreviewPlan(input);
  hasIssue(plan, 'OLIST_ORDER_REQUIRED');
  assert.ok(
    plan.issues.some((entry) => entry.field === 'items[0].tipo_servico'),
  );
});

test('T06 missing art, prediction and commercial condition remain blockers while optional fields do not', () => {
  for (const field of ['artwork', 'deliveryOn', 'paymentCondition']) {
    const input = fixture();
    if (field === 'artwork')
      input.source.order.ficha.artwork.sem_estampa = false;
    if (field === 'deliveryOn')
      input.source.order.ficha.summary.data_entrega_confirmada = null;
    if (field === 'paymentCondition')
      input.source.order.paymentCondition = null;
    hasIssue(buildOlistPreviewPlan(input), 'OLIST_ORDER_REQUIRED');
  }
  const input = fixture();
  delete input.source.order.ficha.items[0].publico;
  delete input.source.order.ficha.summary.nome;
  assert.equal(buildOlistPreviewPlan(input).eligible, true);
});

test('T06 fractional unit blocks entire export without rounding or changing commercial totals', () => {
  const input = fixture();
  const groups = input.source.order.ficha.sizePricing;
  input.source.order.ficha.sizePricing = reviewSizePricingSubtotal(
    groups,
    groups[1].id,
    groups[1].lines[0].id,
    100,
  );
  input.source.order.finalAmountCents = 700;
  const before = structuredClone(input);
  const plan = buildOlistPreviewPlan(input);
  hasIssue(plan, 'OLIST_FRACTIONAL_CENT_UNIT');
  assert.equal(plan.commercial.totalCents, 700);
  assert.deepEqual(input, before);
});

test('T06 quantity changes require human subtotal review and preserve identity', () => {
  const input = fixture();
  const groups = input.source.order.ficha.sizePricing;
  input.source.order.ficha.sizePricing = changeSizePricingQuantity(
    groups,
    groups[0].id,
    groups[0].lines[0].id,
    4,
  );
  input.source.order.ficha.items[0].grade[0].quantidade = 4;
  hasIssue(buildOlistPreviewPlan(input), 'SIZE_SUBTOTAL_REVIEW_REQUIRED');
});

test('T06 source revisions must be complete and fresh, regardless of historical/store origin', () => {
  for (const origin of ['atendimento', 'loja']) {
    const input = fixture();
    input.source.order.origin = origin;
    const complete = buildOlistPreviewPlan(input);
    assert.equal(complete.eligible, true);
    const source = {
      order: null,
      sourceRevision: 2,
      issues: [{ code: 'ORDER_SOURCE_STALE', field: 'priceBreakdown' }],
    };
    hasIssue(buildOlistPreviewPlan({ ...input, source }), 'ORDER_SOURCE_STALE');
    assert.equal(source.order, null);
  }
});

test('T06 no legacy rateio, corrupt grade, invalid date or total is accepted', () => {
  for (const field of ['composition', 'alignment', 'total', 'date', 'origin']) {
    const input = fixture();
    if (field === 'composition') delete input.source.order.ficha.sizePricing;
    if (field === 'alignment')
      input.source.order.ficha.items[0].grade[0].quantidade = 5;
    if (field === 'total') input.source.order.finalAmountCents = 999;
    if (field === 'date') input.source.order.orderDate = '2026-02-30';
    if (field === 'origin')
      input.source.order.ficha.artwork.feito_pelo_cliente = true;
    const plan = buildOlistPreviewPlan(input);
    assert.equal(plan.eligible, false, field);
    assert.deepEqual(plan.commercial.groups, []);
  }
});

test('T06 buyer CPF/CNPJ DV, fiscal address, explicit IE and contact data are required', () => {
  for (const field of ['document', 'postalCode', 'number', 'phone', 'name']) {
    const input = fixture();
    if (field === 'document') input.buyer.registration.document = '11111111111';
    else if (field === 'phone') input.buyer.phone = '';
    else if (field === 'name') input.buyer.name = '';
    else
      input.buyer.registration[/** @type {'number'|'postalCode'} */ (field)] =
        '';
    const plan = buildOlistPreviewPlan(input);
    assert.equal(plan.eligible, false, field);
    assert.equal(plan.customer, null);
  }
  const input = fixture();
  input.buyer.registration = {
    ...input.buyer.registration,
    personType: 'company',
    document: '11222333000181',
  };
  hasIssue(buildOlistPreviewPlan(input), 'OLIST_BUYER_REQUIRED');
  Object.assign(input.buyer.registration, { stateRegistration: 'ISENTO' });
  const plan = buildOlistPreviewPlan(input);
  assert.equal(plan.eligible, true);
  assert.equal(plan.customer.tipoPessoa, 'J');
  assert.equal(plan.customer.inscricaoEstadual, 'ISENTO');
});

test('T06 buyer null or malformed optional email cannot produce a customer payload', () => {
  const input = fixture();
  hasIssue(
    buildOlistPreviewPlan({ ...input, buyer: null }),
    'OLIST_BUYER_REQUIRED',
  );
  hasIssue(
    buildOlistPreviewPlan({
      ...input,
      buyer: { ...input.buyer, email: 'invalid' },
    }),
    'OLIST_BUYER_INVALID',
  );
});

test('T06 explicit central parameters are required; no seller, payment or fiscal defaults are invented', () => {
  for (const field of [
    'sellerId',
    'operationNatureId',
    'warehouseId',
    'paymentMethodId',
    'originId',
    'paymentTerms',
  ]) {
    const input = fixture();
    input.settings = { ...input.settings, [field]: null };
    hasIssue(buildOlistPreviewPlan(input), 'OLIST_SETTINGS_REQUIRED');
  }
  const input = fixture();
  input.settings.priceListId = /** @type {any} */ (-1);
  hasIssue(buildOlistPreviewPlan(input), 'OLIST_SETTINGS_INVALID');
});

test('T06 buyer allowlist matches the captured official schema and excludes unrelated registration fields', () => {
  const input = fixture();
  Object.assign(input.buyer.registration, {
    instagram: 'perfil_sintetico',
    complement: 'Sala 2',
  });
  const { customer } = buildOlistPreviewPlan(input);
  const schema = JSON.parse(
    readFileSync(
      new URL(
        '../docs/integrations/olist/evidence/openapi-v3.projection.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).components.schemas;
  /** @param {string} name @returns {Record<string,any>} */
  function properties(name) {
    const current = schema[name];
    return Object.assign(
      {},
      current.properties,
      ...(current.allOf ?? []).map((/** @type {any} */ part) =>
        part.$ref ? properties(part.$ref.split('/').at(-1)) : part.properties,
      ),
    );
  }
  const allowedCustomer = properties('CriarContatoModelRequest');
  assert.ok(
    Object.keys(customer).every((key) => Object.hasOwn(allowedCustomer, key)),
  );
  assert.ok(
    Object.keys(customer.endereco).every((key) =>
      Object.hasOwn(properties('EnderecoModel'), key),
    ),
  );
  assert.equal(customer.endereco.complemento, 'Sala 2');
  assert.equal(customer.situacao, 'B', 'a buyer never receives system access');
  assert.equal(Object.hasOwn(customer, 'instagram'), false);
});

test('T06 control characters and invalid/overflow monetary compositions fail closed', () => {
  for (const field of [
    'principal',
    'fabric',
    'size',
    'overflow',
    'fractionalCents',
  ]) {
    const input = fixture();
    const item = input.source.order.ficha.items[0];
    const group = input.source.order.ficha.sizePricing[0];
    if (field === 'principal') item.tipo = 'Camiseta\u0000';
    if (field === 'fabric') item.malhas = ['Malha\u0000'];
    if (field === 'size') {
      item.grade[0].tamanho = 'M\u0000';
      group.lines[0].size = 'M\u0000';
    }
    if (field === 'overflow')
      group.lines[0].subtotalCents = Number.MAX_SAFE_INTEGER + 1;
    if (field === 'fractionalCents') group.lines[0].subtotalCents = 100.5;
    const plan = buildOlistPreviewPlan(input);
    assert.equal(plan.eligible, false, field);
    assert.deepEqual(plan.commercial.groups, []);
  }
});

test('T06 no compensation between lines or mutation of historical/store snapshots', () => {
  const input = fixture();
  const groups = input.source.order.ficha.sizePricing;
  groups[0].lines[0].subtotalCents = 601;
  groups[1].lines[0].subtotalCents = 1199;
  input.source.order.origin = 'loja';
  const before = structuredClone(input);
  const plan = buildOlistPreviewPlan(input);
  hasIssue(plan, 'OLIST_FRACTIONAL_CENT_UNIT');
  assert.equal(plan.commercial.totalCents, 1800);
  assert.deepEqual(input, before);
});

test('T17 per-order due day is explicit, calendar-valid and independent of payment text or clock', () => {
  const input = fixture();
  const settings = {
    ...input.settings,
    paymentDuePolicy: 'per_order',
    paymentDueOn: null,
  };
  for (const paymentDueOn of [
    undefined,
    null,
    '',
    'amanhã',
    '30 dias',
    '2027-02-29',
    '2026-11-31',
    '2026-11-30T00:00:00Z',
    20261130,
  ])
    hasIssue(
      buildOlistPreviewPlan({ ...input, settings, paymentDueOn }),
      'OLIST_PAYMENT_DUE_REQUIRED',
    );
  const plan = buildOlistPreviewPlan({
    ...input,
    settings,
    paymentDueOn: '2028-02-29',
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.commercial.paymentDueOn, '2028-02-29');
  assert.equal(settings.paymentDueOn, null);
  assert.equal(
    buildOlistPreviewPlan(input).commercial.paymentDueOn,
    '2026-11-30',
  );
  hasIssue(
    buildOlistPreviewPlan({ ...input, paymentDueOn: '2026-12-01' }),
    'OLIST_SETTINGS_INVALID',
  );
});
