import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { renderFichaHtml } from '../modules/orders/src/print/ficha-canonical-v2.js';
import { PRINCIPAL_LABELS } from '../modules/orders/src/print/ficha-canonical-v3.js';
import {
  PRINT_TEMPLATE,
  TEMPLATE_V2,
  TEMPLATE_V3,
  TEMPLATE_V4,
  TEMPLATE_V5,
  TEMPLATE_V6,
  TEMPLATE_V7,
  renderOrderFicha,
} from '../modules/orders/src/print/index.js';
import { printSnapshot } from '../modules/orders/src/print/print-snapshot.js';
import {
  fichaV3ApprovalStages,
  validateFichaPrintSwitch,
} from '../scripts/ficha-pdf-review.mjs';
import { syntheticItems } from './fixtures/order-items.js';
import { priceDraft } from './fixtures/size-pricing.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';

// PIM-10 (ADR 017): one switch decides the printed template. It names v3 since
// the PO's provisional approval (T74); without a recorded approval it must
// name v2. Fixtures are synthetic.

const rootUrl = new URL('../', import.meta.url);
const v3Gate = JSON.parse(
  await readFile(
    new URL('docs/phase0/ficha-pdf-approval-v3.json', rootUrl),
    'utf8',
  ),
);
const v4Gate = JSON.parse(
  await readFile(
    new URL('docs/phase0/ficha-pdf-approval-v4.json', rootUrl),
    'utf8',
  ),
);
const v6Gate = JSON.parse(
  await readFile(
    new URL('docs/phase0/ficha-pdf-approval-v6.json', rootUrl),
    'utf8',
  ),
);
const v7Gate = JSON.parse(
  await readFile(
    new URL('docs/phase0/ficha-pdf-approval-v7.json', rootUrl),
    'utf8',
  ),
);
const v5Gate = JSON.parse(
  await readFile(
    new URL('docs/phase0/ficha-pdf-approval-v5.json', rootUrl),
    'utf8',
  ),
);

const SELLER = Object.freeze({
  capabilities: [],
  functionName: 'Vendedor',
  id: 'seller-1',
  kind: 'human',
});

const readHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic',
  origin: 'https://crm.example.test',
  'x-request-id': '30000000-0000-4000-8000-000000000001',
});

function harness() {
  let clock = Date.parse('2026-10-02T15:00:00.000Z');
  let sequence = 0;
  const runtime = createOrderRuntime({
    access: {
      authorizeRead: async () => ({ actor: SELLER }),
      authorizeWrite: async () => ({ actor: SELLER }),
    },
    auditTrail: { append: async () => undefined },
    clock: () => {
      clock += 60_000;
      return new Date(clock);
    },
    conversations: {
      readAssignment: async () => ({
        assignedUserId: 'seller-1',
        version: 4,
      }),
      readAssignments: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, 'seller-1'])),
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: orderContextsFrom(() => ({
        briefing: { order_name: 'Equipe Sintetica' },
        customerName: 'Cliente Sintetico',
        openedAt: '2026-09-28T13:40:00.000Z',
      })),
      readUserNames: async (/** @type {string[]} */ ids) =>
        new Map(ids.map((id) => [id, 'Vendedora Um'])),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    idFactory: () => {
      sequence += 1;
      return `order-${sequence}`;
    },
    repository: new InMemoryOrderRepository(),
  });
  return { api: createApi({}, { orders: runtime }), runtime };
}

let seedSequence = 0;
/** @param {Record<string, unknown>} input */
function seed(input) {
  seedSequence += 1;
  return {
    actor: SELLER,
    correlationId: 'correlation-seed',
    idempotencyKey: `switch-seed-${seedSequence}`,
    ...input,
  };
}

/** @param {any} runtime @param {Record<string, unknown>} summary */
async function confirmedOrder(runtime, summary) {
  let { order } = await runtime.createManual(
    seed({ conversationId: 'conversation-1', expectedVersion: 4 }),
  );
  order = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'summary',
      value: summary,
    }),
  );
  order = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'items',
      value: syntheticItems(),
    }),
  );
  order = await runtime.patchSection(
    seed({
      expectedVersion: order.version,
      orderId: order.id,
      section: 'artwork',
      value: { feito_pela_silmer: false, feito_pelo_cliente: true },
    }),
  );
  order = await priceDraft(runtime, order, 482000, SELLER);
  order = await runtime.confirm(
    seed({
      amountText: '4.820,00',
      expectedVersion: order.version,
      orderId: order.id,
      paymentCondition: 'pix',
    }),
  );
  return runtime.recordMilestones(
    seed({
      deliveredOn: null,
      expectedVersion: order.version,
      orderId: order.id,
      paidOn: '2026-10-02',
    }),
  );
}

/** @param {any} api @param {string} url */
async function get(api, url) {
  return api.inject({ headers: readHeaders, method: 'GET', url });
}

test('the switch agrees with the recorded v6 approval (PIM-10)', () => {
  assert.doesNotThrow(() =>
    validateFichaPrintSwitch({
      gate: v3Gate,
      gateV4: v4Gate,
      gateV5: v5Gate,
      gateV6: v6Gate,
      gateV7: v7Gate,
      printTemplate: PRINT_TEMPLATE,
    }),
  );
  // OLIST-50: v7 is addressable but not selected while its sample waits for
  // the PO; the switch refuses it without a recorded approval.
  assert.notEqual(PRINT_TEMPLATE, TEMPLATE_V7);
  assert.throws(
    () =>
      validateFichaPrintSwitch({
        gate: v3Gate,
        gateV4: v4Gate,
        gateV5: v5Gate,
        gateV6: v6Gate,
        gateV7: v7Gate,
        printTemplate: TEMPLATE_V7,
      }),
    /before its approval is recorded/u,
  );
  const stages = fichaV3ApprovalStages(v3Gate);
  if (!stages.provisional && !stages.final) {
    assert.equal(PRINT_TEMPLATE, TEMPLATE_V2, 'v2 prints while v3 is pending');
  }
});

test('v4 switch fails closed without a recorded provisional approval', () => {
  assert.throws(
    () =>
      validateFichaPrintSwitch({ gate: v3Gate, printTemplate: TEMPLATE_V4 }),
    /before its approval is recorded/u,
  );
  const unapproved = structuredClone(v4Gate);
  unapproved.provisionalApproval.approved = false;
  assert.throws(
    () =>
      validateFichaPrintSwitch({
        gate: v3Gate,
        gateV4: unapproved,
        printTemplate: TEMPLATE_V4,
      }),
    /before its approval is recorded/u,
  );
});

test('the switch takes v3 with the provisional or the final approval, never without (PIM-10)', () => {
  /** @param {{provisional: boolean, final: boolean}} stages */
  const gateWith = (stages) => {
    const gate = structuredClone(v3Gate);
    gate.provisionalApproval.status = stages.provisional
      ? 'approved'
      : 'pending-human-approval';
    gate.provisionalApproval.approved = stages.provisional;
    gate.approval.status = stages.final ? 'approved' : 'pending-human-approval';
    gate.approval.approved = stages.final;
    return gate;
  };
  /** @param {any} gate */
  const v3With = (gate) => () =>
    validateFichaPrintSwitch({ gate, printTemplate: TEMPLATE_V3 });

  assert.throws(
    v3With(gateWith({ final: false, provisional: false })),
    /before its approval is recorded/u,
  );
  assert.throws(v3With(null), /before its approval is recorded/u);
  assert.doesNotThrow(v3With(gateWith({ final: false, provisional: true })));
  assert.doesNotThrow(v3With(gateWith({ final: true, provisional: false })));
  assert.doesNotThrow(() =>
    validateFichaPrintSwitch({
      gate: gateWith({ final: false, provisional: false }),
      printTemplate: TEMPLATE_V2,
    }),
  );
  assert.throws(
    () =>
      validateFichaPrintSwitch({
        gate: v3Gate,
        printTemplate: 'ficha-legacy-v1',
      }),
    /known ficha template/u,
  );
});

/** @param {any} t */
async function printedThroughRoute(t) {
  const { api, runtime } = harness();
  t.after(() => api.close());
  const confirmed = await confirmedOrder(runtime, {
    aplicacao: 'SILK',
    data_entrega_confirmada: '2026-10-24',
    nome: null,
  });
  const { order } = (await get(api, `/api/v1/orders/${confirmed.id}`)).json();
  const response = await get(api, `/api/v1/orders/${confirmed.id}/print`);
  assert.equal(response.statusCode, 200);
  return { order, response };
}

test('the print route prints whatever the switch names (PIM-10)', async (t) => {
  const { order, response } = await printedThroughRoute(t);

  assert.equal(response.body, renderOrderFicha(order));
  assert.equal(response.body, renderOrderFicha(order, PRINT_TEMPLATE));
});

test('orders print on v6 since the PO approved its sample (T100, PIM-10)', async (t) => {
  const { order, response } = await printedThroughRoute(t);

  assert.equal(PRINT_TEMPLATE, TEMPLATE_V6);
  assert.equal(response.body, renderOrderFicha(order, TEMPLATE_V6));
  assert.match(response.body, /5<\/b> Modelo de malha/u);
  assert.match(response.body, /Tipo de roupa/u);
  assert.match(response.body, /4<\/b> Técnica/u);
  assert.match(
    response.body,
    /Arte do pedido<\/span><strong>O cliente envia a arte/u,
  );
  assert.match(response.body, /Lastro do pedido/u);
  assert.match(response.body, /Data do pedido<\/span><strong>02\/10\/2026</u);
  assert.match(
    response.body,
    /Entrega prometida<\/span><strong>24\/10\/2026</u,
  );
  assert.match(response.body, /Primeiro contato<\/span><strong>28\/09\/2026</u);
  assert.match(response.body, /Pago em<\/span><strong>02\/10\/2026</u);
  assert.match(
    response.body,
    /Entregue em<\/span><strong><span class="empty">—<\/span>/u,
  );
  assert.doesNotMatch(
    response.body,
    />Modelo|>Viés gola|Tipo de serviço|Serviços dos itens/u,
  );
  // A printed order carries no sample band, review box or signature lines.
  assert.doesNotMatch(
    response.body,
    /Amostra sint|<div class="review-box">|<div class="signatures">/u,
  );
});

test('v2 still renders byte for byte through the switch function', async (t) => {
  const { order } = await printedThroughRoute(t);

  const v2 = renderOrderFicha(order, TEMPLATE_V2);

  assert.equal(
    v2,
    renderFichaHtml(printSnapshot(order, TEMPLATE_V2), { synthetic: false }),
  );
  assert.match(v2, /Entrega confirmada<\/span><strong>24\/10\/2026</u);
  assert.match(v2, /Vies gola \/ mangas/u);
  assert.doesNotMatch(v2, /Lastro do pedido|Tipo de roupa/u);
});

test('the same order renders on all three templates through one function (PIM-10)', async (t) => {
  const { api, runtime } = harness();
  t.after(() => api.close());
  const confirmed = await confirmedOrder(runtime, {
    data_entrega_confirmada: '2026-10-24',
    nome: 'Equipe Sintetica',
  });
  const { order } = (await get(api, `/api/v1/orders/${confirmed.id}`)).json();

  const v2 = renderOrderFicha(order, TEMPLATE_V2);
  const v3 = renderOrderFicha(order, TEMPLATE_V3);
  const v4 = renderOrderFicha(order, TEMPLATE_V4);
  const v5 = renderOrderFicha(order, TEMPLATE_V5);
  const v7 = renderOrderFicha(order, TEMPLATE_V7);

  assert.match(v2, /Entrega confirmada/u);
  // ADR 020: the order-wide technique is no longer written; v3 prints its
  // legacy cell empty.
  assert.match(v3, /Tipo de serviço<\/span><strong><span class="empty">—/u);
  assert.match(v3, /Entrega prometida<\/span><strong>24\/10\/2026</u);
  for (const label of PRINCIPAL_LABELS) assert.ok(v3.includes(label), label);
  // The trail comes from the order: first contact and payment; the order
  // date and the promised delivery print in the summary.
  assert.match(v3, /Primeiro contato<\/span><strong>28\/09\/2026</u);
  assert.match(v3, /Data do pedido<\/span><strong>02\/10\/2026</u);
  assert.match(v3, /Pagamento<\/span><strong>02\/10\/2026</u);
  assert.match(
    v3,
    /Entrega realizada<\/span><strong><span class="empty">—<\/span>/u,
  );
  assert.match(v4, /Definição da gola/u);
  // ADR 020: v5 prints who makes the art and the technique of each item.
  assert.match(v5, /Arte do pedido<\/span><strong>O cliente envia a arte/u);
  assert.match(
    v5,
    /4<\/b> Técnica<\/span><div class="point-value">SUBLIMAÇÃO/u,
  );
  // OLIST-49/50: v7 renames two labels and adds no money.
  assert.match(
    v7,
    /4<\/b> Aplicação<\/span><div class="point-value">SUBLIMAÇÃO/u,
  );
  assert.match(v7, /Previsão de entrega<\/span><strong>24\/10\/2026</u);
  assert.doesNotMatch(v7, /Técnica|Entrega prometida/u);
  for (const html of [v2, v3, v4, v5, v7]) {
    assert.doesNotMatch(html, /Amostra sint|4\.820,00|R\$|pix/iu);
    assert.doesNotMatch(html, /null|undefined/u);
  }
  assert.doesNotMatch(v3, /<div class="review-box">/u);
  assert.throws(
    () => renderOrderFicha(order, 'ficha-canonical-v9'),
    /Unknown/u,
  );
});
