/** OLIST-T02: one-shot, bounded proof of the explicitly approved smaller scope. */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createSizePricing,
  reviewSizePricingSubtotal,
} from '../../../modules/orders/src/domain/size-pricing.js';
import {
  prepareExactCentExport,
  reconcileExactCentExport,
} from '../../../modules/orders/src/domain/olist-exact-cent.js';
import { normalizeDocument } from './read-only-probe.mjs';
import { parseDecimalJson } from './monetary-readback-probe.mjs';

const API = 'https://api.tiny.com.br/public-api/v3';
export const EXACT_CENT_APPROVAL = 'OLIST-T02-EXACT-CENT-C05-C07-THREE-ORDERS';
const aliases = ['C05', 'C06', 'C07'];
const resources = ['new-M', 'new-G', 'existing-M-from-C01'];
const specs = [
  [
    ['new-M', 3, 3],
    ['new-G', 3, 6],
  ],
  [
    ['new-M', 1, 1],
    ['new-M', 1, 2],
    ['existing-M-from-C01', 1, 3],
    ['new-G', 1, 4],
  ],
  [
    ['new-M', 500, 500],
    ['new-G', 1, 1],
  ],
];
const fail = (code) => {
  throw new Error(code);
};
const digest = (plan) =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const validId = (id) =>
  typeof id === 'string' &&
  /^[1-9]\d{0,15}$/.test(id) &&
  Number.isSafeInteger(Number(id)) &&
  String(Number(id)) === id;
const document = (value) => normalizeDocument(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validateExactCentPlan(plan, approvedDigest) {
  if (
    plan?.approval !== EXACT_CENT_APPROVAL ||
    plan.maximumGets !== 14 ||
    plan.maximumPosts !== 3 ||
    plan.maximumOrderTotalCents !== 520 ||
    plan.date !== '2026-11-05' ||
    plan.referencePrefix !== 'CRM-F1-CENT-20261105' ||
    digest(plan) !== approvedDigest ||
    !validId(plan.buyerId) ||
    !validId(plan.originId) ||
    !Array.isArray(plan.products) ||
    !same(
      plan.products.map((p) => p.resource),
      resources,
    ) ||
    !Array.isArray(plan.orders) ||
    !same(
      plan.orders.map((o) => o.alias),
      aliases,
    )
  )
    fail('EXACT_CENT_PLAN_INVALID');
  document(plan.accountDocument);
  document(plan.buyerDocument);
  if (
    new Set(plan.products.map((p) => p.id)).size !== 3 ||
    new Set(plan.products.map((p) => p.sku)).size !== 3 ||
    plan.products.some(
      (p) =>
        !validId(p.id) ||
        typeof p.sku !== 'string' ||
        !p.sku ||
        p.sku.length > 100,
    )
  )
    fail('EXACT_CENT_PLAN_INVALID');
  const markers = new Set();
  for (const [index, order] of plan.orders.entries()) {
    if (
      order.reference !== plan.referencePrefix + '-' + order.alias ||
      !same(
        order.items,
        specs[index].map(([resource, quantity, subtotalCents]) => ({
          resource,
          quantity,
          subtotalCents,
        })),
      )
    )
      fail('EXACT_CENT_PLAN_INVALID');
    const prepared = prepareExactCentExport(order.groups);
    if (
      !prepared.eligible ||
      prepared.lines.length !== order.items.length ||
      prepared.lines.some(
        (line, i) =>
          line.quantity !== order.items[i].quantity ||
          line.subtotalCents !== order.items[i].subtotalCents ||
          markers.has(line.lineId),
      )
    )
      fail('EXACT_CENT_PLAN_INVALID');
    prepared.lines.forEach((line) => markers.add(line.lineId));
  }
  if (
    plan.orders.reduce(
      (sum, o) => sum + prepareExactCentExport(o.groups).totalCents,
      0,
    ) !== 520
  )
    fail('EXACT_CENT_PLAN_INVALID');
  return true;
}

export async function prepareExactCentPlan(privateRoot) {
  const previous = JSON.parse(
    await readFile(
      join(privateRoot, 'monetary-readback/private-plan.json'),
      'utf8',
    ),
  ).plan;
  const plan = {
    approval: EXACT_CENT_APPROVAL,
    maximumGets: 14,
    maximumPosts: 3,
    maximumOrderTotalCents: 520,
    date: '2026-11-05',
    referencePrefix: 'CRM-F1-CENT-20261105',
    accountDocument: previous.accountDocument,
    buyerDocument: previous.buyerDocument,
    buyerId: previous.buyerId,
    originId: previous.originId,
    products: previous.products,
    orders: specs.map((rows, index) => {
      let groups = createSizePricing(
        rows.map(([resource, quantity]) => [
          { size: resource === 'new-G' ? 'G' : 'M', quantity },
        ]),
        randomUUID,
      );
      rows.forEach(([, , subtotal], i) => {
        groups = reviewSizePricingSubtotal(
          groups,
          groups[i].id,
          groups[i].lines[0].id,
          subtotal,
        );
      });
      return {
        alias: aliases[index],
        reference: 'CRM-F1-CENT-20261105-' + aliases[index],
        groups,
        items: rows.map(([resource, quantity, subtotalCents]) => ({
          resource,
          quantity,
          subtotalCents,
        })),
      };
    }),
  };
  const approvedDigest = digest(plan);
  validateExactCentPlan(plan, approvedDigest);
  return { plan, approvedDigest };
}

function referencePath(order) {
  return (
    '/pedidos?numeroPedidoEcommerce=' + order.reference + '&limit=100&offset=0'
  );
}
function listing(body) {
  if (
    !Array.isArray(body?.itens) ||
    body?.paginacao?.offset !== '0' ||
    body.paginacao.total !== String(body.itens.length) ||
    body.itens.length > 1
  )
    fail('EXACT_CENT_LOOKUP_INCOMPLETE');
  return body.itens;
}

export function exactCentPayload(plan, order) {
  const prepared = prepareExactCentExport(order.groups);
  if (!prepared.eligible) fail('EXACT_CENT_EXPORT_BLOCKED');
  const payload = {
    idContato: Number(plan.buyerId),
    data: plan.date,
    situacao: 0,
    ecommerce: {
      id: Number(plan.originId),
      numeroPedidoEcommerce: order.reference,
    },
    itens: prepared.lines.map((line, i) => ({
      produto: {
        id: Number(
          plan.products.find((p) => p.resource === order.items[i].resource).id,
        ),
      },
      quantidade: line.quantity,
      valorUnitario: line.unitLexeme,
      infoAdicional: line.lineId,
    })),
  };
  // Only validated decimal money literals are unquoted; no binary conversion.
  return JSON.stringify(payload).replace(
    /"valorUnitario":"(\d+\.\d{2})"/g,
    '"valorUnitario":$1',
  );
}

function checkOrder(body, plan, order, createdId) {
  if (
    body?.id !== createdId ||
    body.situacao !== '0' ||
    body.data !== plan.date ||
    body.cliente?.id !== plan.buyerId ||
    document(body.cliente?.cpfCnpj) !== document(plan.buyerDocument) ||
    body.ecommerce?.id !== plan.originId ||
    body.ecommerce.numeroPedidoEcommerce !== order.reference ||
    ![null, undefined, '0'].includes(body.idNotaFiscal) ||
    (body.notaFiscal && Object.keys(body.notaFiscal).length) ||
    (body.pagamentosIntegrados?.length ?? 0) !== 0 ||
    (body.pagamento?.parcelas?.length ?? 0) !== 0 ||
    !['valorDesconto', 'valorFrete', 'valorOutrasDespesas'].every((k) =>
      [null, undefined, '0', '0.00'].includes(body[k]),
    ) ||
    !Array.isArray(body.itens)
  )
    fail('EXACT_CENT_ORDER_DIVERGENT');
  const prepared = prepareExactCentExport(order.groups);
  const lines = body.itens.map((line) => {
    const index = prepared.lines.findIndex(
      (expected) => expected.lineId === line.infoAdicional,
    );
    if (index < 0) fail('EXACT_CENT_MARKER_DIVERGENT');
    const product = plan.products.find(
      (p) => p.resource === order.items[index].resource,
    );
    if (
      line.produto?.id !== product.id ||
      line.produto?.sku !== product.sku ||
      !/^[1-9]\d*$/.test(line.quantidade ?? '') ||
      !Number.isSafeInteger(Number(line.quantidade))
    )
      fail('EXACT_CENT_PRODUCT_DIVERGENT');
    return {
      lineId: line.infoAdicional,
      quantity: Number(line.quantidade),
      unitLexeme: line.valorUnitario,
    };
  });
  const checked = reconcileExactCentExport(prepared, {
    lines,
    totalProductsLexeme: body.valorTotalProdutos,
    totalOrderLexeme: body.valorTotalPedido,
  });
  return {
    alias: order.alias,
    lineCount: checked.lineCount,
    totalCents: checked.totalCents,
    markerIdentityVerified: true,
    exactLineMoneyVerified: true,
    exactTotalsVerified: true,
  };
}

export async function executeExactCentProof(
  plan,
  {
    credentials,
    approvedDigest,
    journalPath,
    fetcher = fetch,
    pause = delay,
    signal,
  } = {},
) {
  plan = JSON.parse(JSON.stringify(plan));
  credentials = { ...credentials };
  validateExactCentPlan(plan, approvedDigest);
  if (
    credentials.credentialsRenewed !== true ||
    document(credentials.verifiedAccountDocument) !==
      document(plan.accountDocument) ||
    typeof credentials.v3AccessToken !== 'string' ||
    !credentials.v3AccessToken ||
    /[\r\n]/.test(credentials.v3AccessToken)
  )
    fail('EXACT_CENT_CREDENTIALS_REQUIRED');
  const file = await open(journalPath, 'wx', 0o600);
  let gets = 0,
    posts = 0,
    spentCents = 0,
    currentAlias = null,
    dispatched = false,
    quotaExhausted = false;
  const createdIds = [],
    results = [];
  const allowedGets = new Set([
    '/info',
    '/contatos/' + plan.buyerId,
    ...plan.products.map((p) => '/produtos/' + p.id),
    ...plan.orders.map(referencePath),
  ]);
  const record = async (event) => {
    await file.writeFile(JSON.stringify(event) + '\n');
    await file.sync();
  };
  async function request(path, method = 'GET', body) {
    if (signal?.aborted) fail('EXACT_CENT_PROOF_ABORTED');
    if (quotaExhausted) fail('EXACT_CENT_QUOTA_EXHAUSTED');
    if (method === 'GET') {
      if (!allowedGets.has(path) || gets >= 14 || body !== undefined)
        fail('EXACT_CENT_REQUEST_NOT_ALLOWED');
      gets++;
    } else if (
      method !== 'POST' ||
      path !== '/pedidos' ||
      !dispatched ||
      posts > 3 ||
      body !==
        exactCentPayload(
          plan,
          plan.orders.find((o) => o.alias === currentAlias),
        )
    )
      fail('EXACT_CENT_REQUEST_NOT_ALLOWED');
    await record({
      event: 'http-reserved',
      alias: currentAlias,
      method,
      gets,
      posts,
    });
    let response;
    try {
      response = await fetcher(API + path, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + credentials.v3AccessToken,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch {
      fail('EXACT_CENT_HTTP_OUTCOME_UNKNOWN');
    }
    if (
      response.status !== (method === 'POST' ? 201 : 200) ||
      response.redirected ||
      response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    ) {
      await response.body?.cancel().catch(() => {});
      fail('EXACT_CENT_HTTP_REJECTED');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 131072) fail('EXACT_CENT_BODY_TOO_LARGE');
      chunks.push(chunk);
    }
    const parsed = parseDecimalJson(Buffer.concat(chunks).toString('utf8'));
    // A confirmed POST ID must be persisted even when the response uses the
    // final quota slot. Stop before the next request, never discard that ID.
    if (response.headers.get('x-ratelimit-remaining') === '0')
      quotaExhausted = true;
    return parsed;
  }
  try {
    await record({
      event: 'exact-cent-budget-reserved',
      planDigest: approvedDigest,
      maximumGets: 14,
      maximumPosts: 3,
      maximumCents: 520,
    });
    const account = await request('/info');
    if (document(account.cpfCnpj) !== document(plan.accountDocument))
      fail('EXACT_CENT_ACCOUNT_MISMATCH');
    const buyer = await request('/contatos/' + plan.buyerId);
    if (
      buyer.id !== plan.buyerId ||
      document(buyer.cpfCnpj) !== document(plan.buyerDocument) ||
      !['A', 'B'].includes(buyer.situacao)
    )
      fail('EXACT_CENT_BUYER_MISMATCH');
    for (const product of plan.products) {
      const found = await request('/produtos/' + product.id);
      if (
        found.id !== product.id ||
        found.sku !== product.sku ||
        found.situacao !== 'A'
      )
        fail('EXACT_CENT_PRODUCT_DIVERGENT');
    }
    for (const order of plan.orders) {
      currentAlias = order.alias;
      dispatched = false;
      if (listing(await request(referencePath(order))).length)
        fail('EXACT_CENT_REFERENCE_EXISTS');
      await pause(1500);
      if (signal?.aborted) fail('EXACT_CENT_PROOF_ABORTED');
      const amount = prepareExactCentExport(order.groups).totalCents;
      if (posts >= 3 || spentCents + amount > 520)
        fail('EXACT_CENT_BUDGET_EXHAUSTED');
      posts++;
      spentCents += amount;
      await record({
        event: 'post-attempt-reserved',
        alias: order.alias,
        posts,
        amountCents: amount,
        spentCents,
      });
      dispatched = true;
      const created = await request(
        '/pedidos',
        'POST',
        exactCentPayload(plan, order),
      );
      if (!validId(created?.id) || createdIds.includes(created.id))
        fail('EXACT_CENT_CREATED_ID_MISSING');
      createdIds.push(created.id);
      await record({ event: 'created', alias: order.alias, id: created.id });
      allowedGets.add('/pedidos/' + created.id);
      const checked = checkOrder(
        await request('/pedidos/' + created.id),
        plan,
        order,
        created.id,
      );
      const matched = listing(await request(referencePath(order)));
      if (
        matched.length !== 1 ||
        matched[0].id !== created.id ||
        matched[0].ecommerce?.numeroPedidoEcommerce !== order.reference ||
        matched[0].ecommerce?.id !== plan.originId
      )
        fail('EXACT_CENT_REFERENCE_DIVERGENT');
      results.push(checked);
      await record({ event: 'api-verified', ...checked });
    }
    const result = {
      state: 'exact_cent_api_proof_completed',
      gets,
      postAttempts: posts,
      createdOrders: createdIds.length,
      nominalTotalCents: spentCents,
      results,
      apiProofPassed: true,
      nativeUiRequired: true,
      f1GatePassed: false,
      businessWrites: {
        orders: createdIds.length,
        contacts: 0,
        products: 0,
        fiscal: 0,
        inventory: 0,
        financial: 0,
      },
    };
    await record({ event: 'finished', ...result });
    return result;
  } catch (error) {
    const code = /^EXACT_CENT_[A-Z_]+$/.test(error?.message ?? '')
      ? error.message
      : 'EXACT_CENT_PROOF_STOPPED';
    const result = {
      state: 'exact_cent_proof_stopped',
      code,
      gets,
      postAttempts: posts,
      createdOrders: createdIds.length,
      nominalTotalCents: spentCents,
      results,
      apiProofPassed: false,
      f1GatePassed: false,
      possibleExternalEffect: posts > results.length,
    };
    await record({ event: 'stopped', ...result });
    return result;
  } finally {
    credentials = null;
    await file.close();
  }
}
