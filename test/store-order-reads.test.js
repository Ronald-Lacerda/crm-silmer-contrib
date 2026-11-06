import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { InMemoryIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import { renderOrderFicha } from '../modules/orders/src/print/index.js';
import { orderContextsFrom } from './fixtures/order-contexts.js';
import {
  STORE_NOW,
  STORE_RECEIPT_URL,
  otherStoreOrderBody,
  storeOrderBody,
} from './fixtures/store-order.js';

const ADMIN = Object.freeze({
  capabilities: ['COMMERCIAL_ADMIN'],
  functionName: 'Vendedor',
  id: 'admin-1',
  kind: 'human',
});
const readHeaders = Object.freeze({
  cookie: 'crm_session=session-synthetic',
  origin: 'https://crm.example.test',
});
const writeHeaders = Object.freeze({
  ...readHeaders,
  'content-type': 'application/json',
  'x-csrf-token': 'csrf-synthetic',
});

/** @param {{denyRead?: boolean, pdfRenderer?: (html: string) => Promise<Buffer>}} [options] */
function harness(options = {}) {
  const repository = new InMemoryOrderRepository();
  let ids = 0;
  const store = createStoreOrderService({
    acceptTest: true,
    clock: () => STORE_NOW,
    fabCode: '01',
    hmacKey: Buffer.alloc(32, 27),
    idFactory: () => `order-store-${(ids += 1)}`,
    repository,
  });
  /** @type {string[][]} */
  const assignmentReads = [];
  const runtime = createOrderRuntime({
    access: {
      authorizeRead: async () => {
        if (options.denyRead) {
          throw Object.assign(new Error('forbidden'), {
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }
        return { actor: ADMIN };
      },
      authorizeWrite: async () => ({ actor: ADMIN }),
    },
    auditTrail: { append: async () => undefined },
    clock: () => STORE_NOW,
    conversations: {
      readAssignment: async () => ({ assignedUserId: 'admin-1', version: 1 }),
      readAssignments: async (/** @type {string[]} */ conversationIds) => {
        assignmentReads.push(conversationIds);
        return new Map(conversationIds.map((id) => [id, 'admin-1']));
      },
      readLatestMessageStates: async () => new Map(),
      readOrderContexts: orderContextsFrom(() => ({
        briefing: null,
        customerName: 'Cliente do Bot',
      })),
      readUserNames: async (/** @type {string[]} */ userIds) =>
        new Map(userIds.map((id) => [id, 'Administradora'])),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    idempotencyStore: new InMemoryIdempotencyRecordStore(),
    phoneDigestsFor: store.phoneDigestsFor,
    repository,
  });
  const api = createApi(
    {},
    { orders: runtime, orderPdfRenderer: options.pdfRenderer },
  );
  /** @param {(body: any) => void} [change] @param {any} [body] */
  async function notify(change, body = storeOrderBody(change)) {
    const outcome = await store.record({
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: `correlation-${body.pedido_id}`,
      record: store.parse(body),
    });
    return outcome.order;
  }
  return { api, assignmentReads, notify, repository, runtime };
}

test('LOJ-21/LOJ-22: a store order reads as locked, paid through InfinitePay, with no seller', async () => {
  const { api, assignmentReads, notify } = harness();
  const created = await notify((body) => {
    body.entrega = { tipo: 'envio', cep: '69301-000' };
  });
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}`,
  });
  assert.equal(response.statusCode, 200);
  const { order } = response.json();
  assert.equal(order.origin, 'loja');
  assert.equal(order.locked, true);
  assert.equal(order.isTest, false);
  assert.equal(order.status, 'confirmado');
  assert.equal(order.conversationId, null);
  assert.equal(order.seller, null);
  assert.equal(order.lastMessage, null);
  assert.deepEqual(order.confirmedBy, {
    id: 'system:loja-do-site',
    name: 'Loja do site',
  });
  assert.equal(order.paidOn, '2026-10-07');
  assert.equal(order.storeNumber, 'LJ-5B0C77ED');
  assert.equal(order.leadTimeBusinessDays, 10);
  assert.deepEqual(order.gatewayPayment, {
    confirmedAt: '2026-10-08T02:15:55.000Z',
    invoiceSlug: 'fatura-sintetica-1',
    paidAmountCents: 18000,
    receiptUrl: null,
    source: 'infinitepay',
    transactionNsu: 'nsu-sintetico-0001',
  });
  assert.equal(order.ficha.loja.telefone, '5527900000001');
  assert.deepEqual(order.ficha.observations, [
    'Dados de envio — CEP: 69301-000. Entrar em contato para pegar as informações de entrega.',
  ]);
  assert.equal('paymentDeclaredAt' in order, false);
  // No conversation was looked up for an order that has none.
  assert.deepEqual(assignmentReads, []);
  await api.close();
});

test('LOJ-08/LOJ-23: the list filters "Loja do site" and finds a store order by its phone or LJ- number', async () => {
  const { api, notify, runtime } = harness();
  const created = await notify();
  await runtime.createManual({
    actor: ADMIN,
    conversationId: 'conversation-1',
    correlationId: 'correlation-manual',
    expectedVersion: 1,
    idempotencyKey: 'manual-1',
  });
  const store = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?origin=loja',
  });
  assert.equal(store.statusCode, 200);
  assert.deepEqual(
    store.json().items.map((/** @type {any} */ order) => order.id),
    [created.id],
  );
  const all = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders',
  });
  assert.equal(all.json().items.length, 2);
  const byPhone = await api.inject({
    headers: writeHeaders,
    method: 'POST',
    url: '/api/v1/orders/search',
    payload: { q: '(27) 90000-0001' },
  });
  assert.deepEqual(
    byPhone.json().items.map((/** @type {any} */ order) => order.id),
    [created.id],
  );
  for (const q of ['LJ-5B0C77ED', 'lj5b0c77ed']) {
    const byStoreNumber = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url: `/api/v1/orders?q=${encodeURIComponent(q)}`,
    });
    assert.deepEqual(
      byStoreNumber.json().items.map((/** @type {any} */ order) => order.id),
      [created.id],
      q,
    );
  }
  const invalid = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders?origin=site',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_FILTER');
  await api.close();
});

test('LOJ-07: every write on a store order answers 409 ORDER_LOCKED', async () => {
  const { api, notify } = harness();
  const created = await notify();
  const base = `/api/v1/orders/${created.id}`;
  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const writes = [
    [
      'PATCH',
      `${base}/sections/observations`,
      { expectedVersion: 1, value: [] },
    ],
    [
      'POST',
      `${base}/confirm`,
      { amountText: '180,00', expectedVersion: 1, paymentCondition: 'pix' },
    ],
    ['POST', `${base}/reopen`, { expectedVersion: 1 }],
    [
      'PATCH',
      `${base}/milestones`,
      { deliveredOn: '2026-10-07', expectedVersion: 1, paidOn: '2026-10-07' },
    ],
  ];
  let key = 0;
  for (const [method, url, body] of writes) {
    const response = await api.inject({
      headers: { ...writeHeaders, 'idempotency-key': `locked-${(key += 1)}` },
      method: /** @type {any} */ (method),
      payload: body,
      url,
    });
    assert.equal(response.statusCode, 409, url);
    assert.deepEqual(response.json(), { error: { code: 'ORDER_LOCKED' } });
  }
  await api.close();
});

test('LOJ-10/LOJ-36: the store order prints Produzir, Cliente and Pagamento only, on one page', async () => {
  const { api, notify } = harness();
  const created = await notify(
    (body) => (body.pagamento.receipt_url = STORE_RECEIPT_URL),
  );
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}/print`,
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/html/u);
  assert.equal(response.headers['content-disposition'], undefined);
  const html = response.body;
  for (const expected of [
    'PEDIDO DA LOJA',
    'Origem: Loja do site · LJ-5B0C77ED',
    '<span>Pedido</span><strong>01-CRM</strong>',
    '<section class="produce"><h2>Produzir</h2>',
    '<dt>Produto</dt><dd>Camisa dry fit</dd>',
    '<dt>Cor</dt><dd>Preto</dd>',
    '<div class="size"><dt>Tamanho</dt><dd>M</dd></div>',
    '<dt>Quantidade</dt><dd>10 peças</dd>',
    '<dt>Prazo da cor</dt><dd>10 dias úteis</dd>',
    '<dt>Pedido em</dt><dd>07/10/2026 às 23:15<span class="note">confirmado pela loja do site</span></dd>',
    '<h2>Cliente</h2>',
    '<dt>Nome</dt><dd>Cliente Sintetico da Loja</dd>',
    '<dt>WhatsApp</dt><dd>+55 (27) 90000-0001</dd>',
    '<h2>Pagamento</h2>',
    '<dt>Valor pago</dt><dd>R$ 180,00</dd>',
    '<dt>Forma</dt><dd>Pix</dd>',
    'Pago — confirmado pela InfinitePay em 07/10/2026 às 23:15',
    `Comprovante: <a href="${STORE_RECEIPT_URL}" rel="noopener noreferrer">Comprovante InfinitePay</a>`,
    '<span>Ficha da loja · 01-CRM · LJ-5B0C77ED</span><span>Página 1 de 1</span>',
  ]) {
    assert.ok(html.includes(expected), expected);
  }
  for (const absent of [
    /T[ée]cnica/u,
    /Arte/u,
    /Observa[çc]/u,
    /CONTROLE DE PRODUÇÃO/u,
    /Vendedor/u,
    /teste/iu,
    /Retirada/u,
    /informado pelo cliente/u,
    /Sicredi/u,
    // ADR 031: nothing the kit's production or contact does not use.
    /Camisa Masculina Lisa Dry Fit/u,
    /Camiseta|Masculino|Dry fit liso|Gola redonda/u,
    /Número da loja|<dt>Número<\/dt>/u,
    /<dt>Valor<\/dt>/u,
    /NSU|nsu-sintetico|Fatura|fatura-sintetica/u,
    /Data do pedido/u,
  ]) {
    assert.doesNotMatch(html, absent);
  }
  // Every label prints at 12px or more.
  assert.match(html, /dt \{[^}]*font-size: 12px;/u);
  assert.doesNotMatch(html, /font-size: (?:[0-9]|1[01])px/u);
  await api.close();
});

test('LOJ-10: "Baixar ficha" sends the same document as pedido-NN-CRM.html', async () => {
  const { api, notify } = harness();
  const created = await notify((body) => (body.teste = true));
  const download = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}/print?download=1`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal(
    download.headers['content-disposition'],
    `attachment; filename="pedido-01-CRM.html"; filename*=UTF-8''pedido-01-CRM.html`,
  );
  assert.match(download.body, /Pedido de teste — não produzir nem entregar/u);
  for (const query of ['download=2', 'download=1&x=1', 'formato=pdf']) {
    const refused = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url: `/api/v1/orders/${created.id}/print?${query}`,
    });
    assert.equal(refused.statusCode, 400, query);
  }
  await api.close();
});

test('LOJ-27/PIM-13: only a completed PDF generation clears the store notice', async (t) => {
  let fail = true;
  const { api, notify, repository } = harness({
    pdfRenderer: async (html) => {
      assert.match(html, /PEDIDO DA LOJA/u);
      if (fail) throw new Error('renderer unavailable');
      return Buffer.from('%PDF-1.7\nsynthetic PDF');
    },
  });
  t.after(() => api.close());
  const created = await notify();
  const url = `/api/v1/orders/${created.id}/pdf`;
  const head = await api.inject({ headers: readHeaders, method: 'HEAD', url });
  assert.equal(head.statusCode, 200);
  const afterHead = await repository.findById(created.id);
  assert.ok(afterHead);
  assert.equal(afterHead.fichaFirstPrintedAt, null);

  const failed = await api.inject({ headers: readHeaders, method: 'GET', url });
  assert.equal(failed.statusCode, 500);
  const afterFailure = await repository.findById(created.id);
  assert.ok(afterFailure);
  assert.equal(afterFailure.fichaFirstPrintedAt, null);

  fail = false;
  const generated = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url,
  });
  assert.equal(generated.statusCode, 200);
  assert.match(String(generated.headers['content-type']), /^application\/pdf/u);
  assert.match(
    String(generated.headers['content-disposition']),
    /pedido-01-CRM\.pdf/u,
  );
  assert.equal(generated.rawPayload.toString(), '%PDF-1.7\nsynthetic PDF');
  const first = await repository.findById(created.id);
  assert.ok(first);
  assert.equal(first.fichaFirstPrintedBy, ADMIN.id);
  assert.ok(first.fichaFirstPrintedAt);

  const again = await api.inject({ headers: readHeaders, method: 'GET', url });
  assert.equal(again.statusCode, 200);
  const after = await repository.findById(created.id);
  assert.ok(after);
  assert.equal(after.fichaFirstPrintedAt, first.fichaFirstPrintedAt);
});

test('LOJ-10: the simplified ficha escapes what the customer typed', () => {
  const html = renderOrderFicha({
    ficha: {
      items: [],
      loja: { telefone: '5527900000001' },
      summary: { cliente: '<img src=x onerror=alert(1)>' },
    },
    gatewayPayment: {
      receiptUrl: 'https://recibo.infinitepay.io/"><script>alert(1)</script>',
    },
    number: '09-CRM',
    origin: 'loja',
  });
  assert.doesNotMatch(html, /<img|<script/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(
    html,
    /href="https:\/\/recibo\.infinitepay\.io\/&quot;&gt;&lt;script&gt;/u,
  );
  // A link that is not https is never printed.
  const plain = renderOrderFicha({
    ficha: { items: [], loja: {}, summary: {} },
    gatewayPayment: { receiptUrl: 'javascript:alert(1)' },
    number: '10-CRM',
    origin: 'loja',
  });
  assert.doesNotMatch(plain, /javascript:|Comprovante InfinitePay/u);
});

test('LOJ-09: the summary counts a store sale like any sale and skips tests', async () => {
  const { api, notify } = harness();
  await notify((body) => (body.teste = true));
  await notify(undefined, otherStoreOrderBody(2));
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/summary',
  });
  const { daily, deliveries, period, today, ...totals } = response.json();
  assert.deepEqual(totals, {
    averageTicketCents: 18000,
    confirmedCount: 1,
    pendingCount: 0,
    soldAmountCents: 18000,
    storeNewCount: 1,
    storeNewOldestPaidAt: '2026-10-08T02:15:55.000Z',
    totalPiecesSold: 10,
  });
  // A store order promises no delivery day, so it is never late.
  assert.equal(deliveries.overdueCount, 0);
  assert.equal(typeof today, 'string');
  assert.equal(period.key, 'hoje');
  // PNL-05: seven days ending today; the test order sold nothing.
  assert.equal(daily.length, 7);
  assert.equal(daily.at(-1).day, today);
  assert.equal(
    daily.reduce(
      (/** @type {number} */ total, /** @type {any} */ day) =>
        total + day.confirmedCount,
      0,
    ),
    period.confirmedCount,
  );
  await api.close();
});

/** @param {import('fastify').FastifyInstance} api */
async function readSummary(api) {
  const response = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: '/api/v1/orders/summary',
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

test('LOJ-26: a paid store order is new until its ficha is printed; a test order never is', async () => {
  const { api, notify } = harness();
  assert.equal((await readSummary(api)).storeNewCount, 0);
  assert.equal((await readSummary(api)).storeNewOldestPaidAt, null);
  await notify((body) => (body.teste = true));
  assert.equal((await readSummary(api)).storeNewCount, 0);
  const created = await notify(undefined, otherStoreOrderBody(2));
  const summary = await readSummary(api);
  assert.equal(summary.storeNewCount, 1);
  assert.equal(
    summary.storeNewOldestPaidAt,
    created.gatewayPayment?.confirmedAt,
  );
  const read = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}`,
  });
  assert.equal(read.json().order.fichaFirstPrintedAt, null);
  assert.equal(read.json().order.fichaFirstPrintedBy, null);
  await api.close();
});

test('LOJ-27/LOJ-28: the first print records who and when, once; later prints and downloads change nothing', async () => {
  const { api, notify, repository } = harness();
  const created = await notify();
  const versionBefore = (await repository.findById(created.id))?.version;
  const printed = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}/print`,
  });
  assert.equal(printed.statusCode, 200);
  assert.match(printed.body, /PEDIDO DA LOJA/u);
  const first = (
    await api.inject({
      headers: readHeaders,
      method: 'GET',
      url: `/api/v1/orders/${created.id}`,
    })
  ).json().order;
  assert.equal(first.fichaFirstPrintedAt, STORE_NOW.toISOString());
  assert.deepEqual(first.fichaFirstPrintedBy, {
    id: 'admin-1',
    name: 'Administradora',
  });
  assert.equal(first.version, Number(versionBefore) + 1);
  assert.equal(first.updatedAt, created.updatedAt);
  assert.equal((await readSummary(api)).storeNewCount, 0);
  assert.equal((await readSummary(api)).storeNewOldestPaidAt, null);

  // LOJ-29: the live event fires on the first print, with ids only.
  const events = repository.eventsFor(created.id);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ['order.created', 'order.ficha_first_printed'],
  );
  assert.deepEqual(events[1].payload, {
    conversationId: null,
    orderId: created.id,
  });
  const audits = repository
    .audits()
    .filter((audit) => audit.action === 'order.ficha.first_print');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'admin-1');
  assert.equal(audits[0].reason, 'STORE_FICHA_FIRST_PRINTED');
  assert.doesNotMatch(
    JSON.stringify(audits),
    /Cliente Sintetico|5527900000001|nsu-sintetico/u,
  );

  for (const url of [
    `/api/v1/orders/${created.id}/print`,
    `/api/v1/orders/${created.id}/print?download=1`,
  ]) {
    const again = await api.inject({
      headers: readHeaders,
      method: 'GET',
      url,
    });
    assert.equal(again.statusCode, 200, url);
  }
  const after = await repository.findById(created.id);
  assert.ok(after);
  assert.equal(after.fichaFirstPrintedAt, first.fichaFirstPrintedAt);
  assert.equal(after.fichaFirstPrintedBy, 'admin-1');
  assert.equal(after.version, first.version);
  assert.equal(repository.eventsFor(created.id).length, 2);
  assert.equal(
    repository
      .audits()
      .filter((audit) => audit.action === 'order.ficha.first_print').length,
    1,
  );
  await api.close();
});

test('LOJ-28: a HEAD on the print route records no first print', async () => {
  const { api, notify, repository } = harness();
  const created = await notify();
  for (const url of [
    `/api/v1/orders/${created.id}/print`,
    `/api/v1/orders/${created.id}/print?download=1`,
  ]) {
    const head = await api.inject({
      headers: readHeaders,
      method: 'HEAD',
      url,
    });
    assert.equal(head.statusCode, 200, url);
    assert.equal(head.body, '');
  }
  const stored = await repository.findById(created.id);
  assert.equal(stored?.fichaFirstPrintedAt, null);
  assert.equal(stored?.version, created.version);
  assert.deepEqual(
    repository.eventsFor(created.id).map((event) => event.eventType),
    ['order.created'],
  );
  assert.equal((await readSummary(api)).storeNewCount, 1);
  await api.close();
});

test('LOJ-27: "Baixar ficha" counts as the first print', async () => {
  const { api, notify } = harness();
  const created = await notify();
  const download = await api.inject({
    headers: readHeaders,
    method: 'GET',
    url: `/api/v1/orders/${created.id}/print?download=1`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal((await readSummary(api)).storeNewCount, 0);
  await api.close();
});

test('LOJ-28: a print without a session is refused and records nothing', async () => {
  const denied = harness({ denyRead: true });
  const created = await denied.notify();
  for (const url of [
    `/api/v1/orders/${created.id}/print`,
    `/api/v1/orders/${created.id}/print?download=1`,
  ]) {
    const refused = await denied.api.inject({
      headers: readHeaders,
      method: 'GET',
      url,
    });
    assert.equal(refused.statusCode, 403, url);
  }
  const stored = await denied.repository.findById(created.id);
  assert.equal(stored?.fichaFirstPrintedAt, null);
  assert.equal(stored?.version, created.version);
  assert.deepEqual(
    denied.repository.eventsFor(created.id).map((event) => event.eventType),
    ['order.created'],
  );
  await denied.api.close();
});

test('LOJ-28: printing an order of the conversation records no first print', async () => {
  const { api, runtime, repository } = harness();
  const { order: pending } = await runtime.createManual({
    actor: ADMIN,
    conversationId: 'conversation-1',
    correlationId: 'correlation-manual',
    expectedVersion: 1,
    idempotencyKey: 'manual-print',
  });
  // Only a store order records it, even when asked directly.
  const result = await repository.recordFirstPrint({
    actorId: 'admin-1',
    correlationId: 'correlation-print',
    now: STORE_NOW,
    orderId: pending.id,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.order.fichaFirstPrintedAt, null);
  await api.close();
});
