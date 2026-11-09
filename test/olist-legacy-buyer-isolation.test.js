import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from '@crm-silmer/orders';
import { syntheticItems } from './fixtures/order-items.js';
import { buildOlistPreviewPlan } from '../apps/api/src/olist-preview-plan.js';
import { buildOlistSalePayload } from '../modules/olist/src/sale-payload.js';
import {
  captureOlistExistingBuyer,
  resolveOlistExistingBuyer,
} from '../modules/olist/src/existing-buyer.js';
import {
  captureOlistLegacyBuyerProof,
  assertOlistLegacyBuyerProof,
} from '../modules/olist/src/legacy-buyer-proof.js';

const config = {
  accountKey: 'legacy-isolation-synthetic',
  hmacKey: Buffer.alloc(32, 93),
};
const buyer = {
  name: 'Comprador sintético',
  phone: '5511999990000',
  registration: null,
};
const contact = {
  id: 101,
  nome: buyer.name,
  celular: '5511999990001',
  situacao: 'B',
};

test('T16 historical buyer proof is private, authentic and bound to the selected account, sale and buyer', () => {
  const captured = captureOlistLegacyBuyerProof({
    config,
    buyer,
    contact,
    saleId: '401',
  });
  const input = {
    config,
    customer: captured.customer,
    proof: captured.legacyBuyerProof,
    saleId: '401',
    customerId: '101',
  };
  assert.doesNotThrow(() => assertOlistLegacyBuyerProof(input));
  assert.equal(captured.legacyBuyerProof.phoneMismatch, true);
  assert.equal(captured.legacyBuyerProof.reusable, false);
  assert.doesNotMatch(
    JSON.stringify(captured.legacyBuyerProof),
    /551199999000[01]|Comprador/u,
  );
  for (const change of [
    { config: { ...config, accountKey: 'other-synthetic-account' } },
    { saleId: '402' },
    { customerId: '102' },
    { proof: { ...input.proof, phoneMismatch: false } },
    { proof: { ...input.proof, reusable: true } },
    { proof: { ...input.proof, erpPhonesHash: '0'.repeat(64) } },
    { customer: { ...input.customer, celular: '5511999990002' } },
  ])
    assert.throws(() => assertOlistLegacyBuyerProof({ ...input, ...change }), {
      code: 'OLIST_CUSTOMER_DIVERGENT',
    });
});

test('T16 historical selection never relaxes exact phone matching for a new ERP-existing buyer', async () => {
  assert.throws(() => captureOlistExistingBuyer({ config, buyer, contact }), {
    code: 'OLIST_CUSTOMER_DIVERGENT',
  });
  await assert.rejects(
    resolveOlistExistingBuyer({
      config,
      buyer,
      client: {
        findCustomerByIdentity: async () => contact,
        createCustomer: () =>
          assert.fail('No customer creator may be a fallback'),
      },
    }),
    { code: 'OLIST_CUSTOMER_DIVERGENT' },
  );
});

test('T16 a historical buyer proof cannot substitute for canonical buyer registration or automatic identity', () => {
  let groups = createSizePricing([[{ size: 'M', quantity: 3 }]]);
  groups = reviewSizePricingSubtotal(
    groups,
    groups[0].id,
    groups[0].lines[0].id,
    600,
  );
  const item = syntheticItems()[0];
  item.grade = [{ tamanho: 'M', quantidade: 3 }];
  const settings = {
    sellerId: 11,
    operationNatureId: 12,
    warehouseId: 13,
    originId: 14,
    paymentDuePolicy: 'erp',
    productFiscal: null,
  };
  const input = {
    source: {
      sourceRevision: 0,
      issues: [],
      order: {
        status: 'pendente',
        origin: 'atendimento',
        finalAmountCents: 600,
        paymentCondition: 'pix',
        orderDate: null,
        ficha: {
          summary: { data_entrega_confirmada: '2026-11-20' },
          items: [item],
          sizePricing: groups,
          artwork: {
            feito_pelo_cliente: false,
            feito_pela_silmer: false,
            sem_estampa: true,
          },
        },
      },
    },
    buyer,
    settings,
    now: new Date('2026-11-09T12:00:00Z'),
  };
  const { legacyBuyerProof } = captureOlistLegacyBuyerProof({
    config,
    buyer,
    contact,
    saleId: '401',
  });
  const rejected = buildOlistPreviewPlan({ ...input, ...{ legacyBuyerProof } });
  assert.equal(rejected.eligible, false);
  assert.ok(
    rejected.issues.some((issue) =>
      issue.field.startsWith('buyer.registration.'),
    ),
  );
  assert.ok(
    rejected.issues.every((issue) => issue.field.startsWith('buyer.')),
    JSON.stringify(rejected.issues),
  );
  const wrongSource = buildOlistPreviewPlan({
    ...input,
    buyerSource: legacyBuyerProof,
  });
  assert.equal(wrongSource.eligible, false);
  assert.ok(wrongSource.issues.some((issue) => issue.field === 'buyer.source'));
  const groupId = groups[0].id,
    lineId = groups[0].lines[0].id;
  const snapshot = {
    policy: 'exact-cent-v1',
    settings,
    customer: { nome: buyer.name, celular: buyer.phone },
    productFiscal: null,
    productFiscalDeferred: true,
    legacyBuyerProof,
    commercial: {
      groups: [
        {
          groupId,
          attributes: { garment: 'Camisa' },
          lines: [
            {
              groupId,
              lineId,
              size: 'M',
              quantity: 3,
              subtotalCents: 600,
              unitCents: 200,
              unitLexeme: '2.00',
            },
          ],
        },
      ],
      totalCents: 600,
      orderDate: '2026-11-09',
      deliveryOn: '2026-11-20',
      paymentCondition: 'pix',
      paymentDueOn: null,
    },
  };
  const resolved = {
    resolved: true,
    customerId: '101',
    groups: [
      { groupId, productId: '201', lines: [{ lineId, productId: '301' }] },
    ],
  };
  const reference = 'CRM-synthetic-isolation';
  // Prove the sale fixture is otherwise executable with the normal exact
  // identity proof; the following refusals must come from buyer isolation.
  const exact = captureOlistExistingBuyer({
    config,
    buyer: { ...buyer, phone: contact.celular },
    contact,
  });
  assert.doesNotThrow(() =>
    buildOlistSalePayload({
      snapshot: { ...snapshot, ...exact },
      resolved,
      reference,
    }),
  );
  assert.throws(
    () => buildOlistSalePayload({ snapshot, resolved, reference }),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () =>
      buildOlistSalePayload({
        snapshot: { ...snapshot, buyerSource: legacyBuyerProof },
        resolved,
        reference,
      }),
    { code: 'OLIST_SALE_PLAN_INVALID' },
  );
});
