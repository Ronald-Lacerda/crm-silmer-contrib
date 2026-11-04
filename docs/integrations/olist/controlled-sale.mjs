/**
 * OLIST-T02 / C01 only. Standalone proof tooling, not the production exporter.
 * No CLI and no OAuth connection. Importing this file performs no I/O.
 * The operator must obtain explicit approval; a matching digest is only a
 * local payload-integrity check, never proof of human authorization.
 */
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeDocument } from './read-only-probe.mjs';

const API = 'https://api.tiny.com.br/public-api/v3';
export const C01_REFERENCE = 'CRM-F1-20261104-C01';

function fail(code) {
  throw new Error(code);
}
function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_PLAN');
  return value;
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    fail('INVALID_PLAN');
  return value;
}
function keys(value, expected) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    fail('INVALID_PLAN');
}
function sameDocument(actual, expected) {
  try {
    return normalizeDocument(actual) === normalizeDocument(expected);
  } catch {
    return false;
  }
}
export function buildC01(input) {
  keys(input, ['accountDocument', 'buyer', 'parentId', 'm', 'g', 'date']);
  keys(input.buyer, ['id', 'document']);
  for (const item of [input.m, input.g]) {
    keys(item, ['id', 'sku']);
    id(item.id);
    text(item.sku);
  }
  id(input.buyer.id);
  id(input.parentId);
  if (
    new Set([input.parentId, input.m.id, input.g.id]).size !== 3 ||
    input.m.sku === input.g.sku
  )
    fail('INVALID_PLAN');
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.date) ||
    Number.isNaN(Date.parse(input.date + 'T00:00:00Z')) ||
    new Date(input.date + 'T00:00:00Z').toISOString().slice(0, 10) !==
      input.date
  )
    fail('INVALID_PLAN');
  const buyerDocument = normalizeDocument(input.buyer.document);
  if (buyerDocument.length !== 14) fail('INVALID_PLAN');
  const plan = {
    accountDocument: normalizeDocument(input.accountDocument),
    buyer: {
      id: input.buyer.id,
      document: buyerDocument,
    },
    parentId: input.parentId,
    m: { id: input.m.id, sku: input.m.sku },
    g: { id: input.g.id, sku: input.g.sku },
    payload: {
      idContato: input.buyer.id,
      data: input.date,
      situacao: 0,
      ecommerce: { numeroPedidoEcommerce: C01_REFERENCE },
      itens: [
        { produto: { id: input.m.id }, quantidade: 1, valorUnitario: 1 },
        { produto: { id: input.g.id }, quantidade: 1, valorUnitario: 2 },
      ],
    },
  };
  return plan;
}
function digestOf(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
export function c01Digest(input) {
  return digestOf(buildC01(input));
}
function list(body) {
  const page = body?.paginacao;
  if (
    !Array.isArray(body?.itens) ||
    !page ||
    page.offset !== 0 ||
    !Number.isSafeInteger(page.total) ||
    page.total !== body.itens.length ||
    page.total > 100
  )
    fail('INCOMPLETE_LOOKUP');
  return body.itens;
}
function exactOne(items, predicate) {
  // Even an unrelated result means this exact filter is not established.
  if (items.length !== 1 || !predicate(items[0])) fail('IDENTITY_MISMATCH');
}
function checkBuyer(body, plan) {
  const address = body?.endereco;
  if (
    body?.id !== plan.buyer.id ||
    !sameDocument(body.cpfCnpj, plan.buyer.document) ||
    body.tipoPessoa !== 'J' ||
    body.situacao !== 'B' ||
    !['nome', 'inscricaoEstadual'].every(
      (k) => typeof body[k] === 'string' && body[k].trim(),
    ) ||
    !['endereco', 'numero', 'bairro', 'municipio', 'uf', 'cep'].every(
      (k) => typeof address?.[k] === 'string' && address[k].trim(),
    )
  )
    fail('BUYER_NOT_CONFIRMED');
  // Presence is not a tax-registry or IE validation claim.
}
function checkParent(parent, plan) {
  if (
    parent?.id !== plan.parentId ||
    parent.tipo !== 'V' ||
    parent.situacao !== 'A' ||
    !Array.isArray(parent.variacoes)
  )
    fail('PRODUCT_NOT_CONFIRMED');
  for (const [size, selection] of [
    ['M', plan.m],
    ['G', plan.g],
  ]) {
    const found = parent.variacoes.filter((v) => v.id === selection.id);
    exactOne(
      found,
      (v) =>
        v.sku === selection.sku &&
        Array.isArray(v.grade) &&
        v.grade.length === 1 &&
        v.grade[0].chave === 'Tamanho' &&
        v.grade[0].valor === size,
    );
  }
}
function checkProduct(body, selection, plan, parent) {
  if (
    body?.id !== selection.id ||
    body.sku !== selection.sku ||
    body.situacao !== 'A' ||
    body.produtoPai?.id !== plan.parentId
  )
    fail('PRODUCT_NOT_CONFIRMED');
  // Inheritance is checked for presence, never synthesized.
  const ncm = body.ncm || parent.ncm;
  const unit = body.unidade || parent.unidade;
  const origin = body.origem ?? parent.origem;
  if (
    typeof ncm !== 'string' ||
    !/^\d{8}$/u.test(ncm.replace(/\./gu, '')) ||
    typeof unit !== 'string' ||
    !unit.trim() ||
    !/^[0-8]$/u.test(String(origin))
  )
    fail('PRODUCT_FISCAL_MISSING');
}
function checkOrder(body, plan, createdId) {
  const p = plan.payload;
  if (
    body?.id !== createdId ||
    body.situacao !== 0 ||
    body.data !== p.data ||
    body.cliente?.id !== plan.buyer.id ||
    !sameDocument(body.cliente?.cpfCnpj, plan.buyer.document) ||
    body.ecommerce?.numeroPedidoEcommerce !== C01_REFERENCE ||
    ![null, undefined, 0].includes(body.ecommerce?.id) ||
    !Array.isArray(body.itens) ||
    body.itens.length !== 2 ||
    body.valorTotalProdutos !== 3 ||
    body.valorTotalPedido !== 3 ||
    ![null, undefined, 0].includes(body.idNotaFiscal) ||
    (body.notaFiscal && Object.keys(body.notaFiscal).length) ||
    (body.pagamentosIntegrados?.length ?? 0) !== 0 ||
    (body.pagamento?.parcelas?.length ?? 0) !== 0 ||
    !['valorDesconto', 'valorFrete', 'valorOutrasDespesas'].every((k) =>
      [null, undefined, 0].includes(body[k]),
    )
  )
    fail('READBACK_DIVERGENT');
  for (const expected of p.itens) {
    const lines = body.itens.filter(
      (line) => line.produto?.id === expected.produto.id,
    );
    if (
      lines.length !== 1 ||
      lines[0].quantidade !== expected.quantidade ||
      lines[0].valorUnitario !== expected.valorUnitario
    )
      fail('READBACK_DIVERGENT');
  }
}
async function appendJournal(path, event, exclusive = false) {
  let file;
  try {
    file = await open(path, exclusive ? 'wx' : 'a', 0o600);
    await file.writeFile(JSON.stringify(event) + '\n');
    await file.sync();
  } finally {
    await file?.close();
  }
}

/**
 * No automatic retry, correction, cleanup or dependent creation.
 * journalDirectory must be a private, Git-ignored directory. It stores the
 * created order ID, never credentials, fiscal documents or response bodies.
 * A reserved marker permanently prevents a second POST of C01 through this
 * directory, even after a crash. Never remove it to make the test run again.
 */
export async function executeC01(
  input,
  { token, approvedPlanDigest, journalDirectory, fetcher = fetch, signal } = {},
) {
  const plan = buildC01(input);
  const digest = digestOf(plan);
  if (approvedPlanDigest !== digest) fail('EXPLICIT_APPROVAL_REQUIRED');
  if (
    typeof token !== 'string' ||
    !token ||
    typeof journalDirectory !== 'string' ||
    !journalDirectory
  )
    fail('PRIVATE_SESSION_REQUIRED');
  const buyerList =
    '/contatos?cpfCnpj=' +
    encodeURIComponent(plan.buyer.document) +
    '&limit=100&offset=0';
  const skuLists = [plan.m, plan.g].map(
    (v) =>
      '/produtos?codigo=' + encodeURIComponent(v.sku) + '&limit=100&offset=0',
  );
  const referenceList =
    '/pedidos?numeroPedidoEcommerce=' + C01_REFERENCE + '&limit=100&offset=0';
  const allowed = new Set([
    '/info',
    buyerList,
    '/contatos/' + plan.buyer.id,
    '/produtos/' + plan.parentId,
    ...skuLists,
    '/produtos/' + plan.m.id,
    '/produtos/' + plan.g.id,
    referenceList,
  ]);
  let getCount = 0,
    postAttempted = false,
    createdId = null;
  const summaries = [];
  async function request(path, method = 'GET', payload) {
    if (signal?.aborted) fail('PROBE_STOPPED');
    if (method === 'POST') {
      if (
        path !== '/pedidos' ||
        postAttempted ||
        JSON.stringify(payload) !== JSON.stringify(plan.payload)
      )
        fail('REQUEST_NOT_ALLOWED');
      postAttempted = true; // Before dispatch; any later failure remains uncertain.
    } else if (method !== 'GET' || !allowed.has(path) || ++getCount > 30) {
      fail('REQUEST_NOT_ALLOWED');
    }
    let response;
    try {
      response = await fetcher(API + path, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch {
      fail('HTTP_OUTCOME_UNKNOWN');
    }
    summaries.push({
      path: path.split('?')[0].replace(/\/\d+(?=\/|$)/gu, '/{id}'),
      method,
      status: response.status,
    });
    if (response.status < 200 || response.status >= 300)
      fail('HTTP_' + response.status);
    if (!response.headers.get('content-type')?.includes('application/json'))
      fail('INVALID_RESPONSE');
    const reader = response.body?.getReader();
    if (!reader) fail('INVALID_RESPONSE');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 131072) {
          await reader.cancel();
          fail('BODY_TOO_LARGE');
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error?.message === 'BODY_TOO_LARGE') throw error;
      fail('INVALID_RESPONSE');
    } finally {
      reader.releaseLock();
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('INVALID_RESPONSE');
    }
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (
      method === 'GET' &&
      remaining !== null &&
      (!/^\d+$/u.test(remaining) || Number(remaining) < 2)
    )
      fail('QUOTA_LOW');
    return body;
  }
  const directory = resolve(journalDirectory);
  const journal = join(directory, C01_REFERENCE + '.jsonl');
  try {
    if (!sameDocument((await request('/info'))?.cpfCnpj, plan.accountDocument))
      fail('ACCOUNT_MISMATCH');
    exactOne(
      list(await request(buyerList)),
      (v) =>
        v.id === plan.buyer.id && sameDocument(v.cpfCnpj, plan.buyer.document),
    );
    checkBuyer(await request('/contatos/' + plan.buyer.id), plan);
    const parent = await request('/produtos/' + plan.parentId);
    checkParent(parent, plan);
    for (let i = 0; i < 2; i++) {
      const selection = [plan.m, plan.g][i];
      exactOne(
        list(await request(skuLists[i])),
        (v) => v.id === selection.id && v.sku === selection.sku,
      );
      checkProduct(
        await request('/produtos/' + selection.id),
        selection,
        plan,
        parent,
      );
    }
    if (list(await request(referenceList)).length)
      fail('REFERENCE_ALREADY_PRESENT');
    if (signal?.aborted) fail('PROBE_STOPPED');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await appendJournal(
        journal,
        {
          phase: 'reserved',
          reference: C01_REFERENCE,
          payloadSha256: createHash('sha256')
            .update(JSON.stringify(plan.payload))
            .digest('hex'),
        },
        true,
      );
    } catch {
      fail('RESERVATION_UNAVAILABLE');
    }
    const result = await request('/pedidos', 'POST', plan.payload);
    if (!Number.isSafeInteger(result?.id) || result.id < 1)
      fail('SUCCESS_WITHOUT_ID');
    createdId = result.id;
    await appendJournal(journal, { phase: 'created', id: createdId });
    allowed.add('/pedidos/' + createdId);
    checkOrder(await request('/pedidos/' + createdId), plan, createdId);
    exactOne(
      list(await request(referenceList)),
      (v) =>
        v.id === createdId &&
        v.ecommerce?.numeroPedidoEcommerce === C01_REFERENCE,
    );
    await appendJournal(journal, {
      phase: 'api-readback-matched',
      uiLineProofRequired: true,
    });
    return {
      state: 'api_readback_matched',
      erpPostAttempts: 1,
      automaticRetry: false,
      getCount,
      queries: summaries,
      uiLineProofRequired: true,
      f1GatePassed: false,
    };
  } catch (error) {
    const code =
      /^(?:INVALID_PLAN|IDENTITY_MISMATCH|INCOMPLETE_LOOKUP|BUYER_NOT_CONFIRMED|PRODUCT_NOT_CONFIRMED|PRODUCT_FISCAL_MISSING|ACCOUNT_MISMATCH|REFERENCE_ALREADY_PRESENT|RESERVATION_UNAVAILABLE|HTTP_\d{3}|HTTP_OUTCOME_UNKNOWN|INVALID_RESPONSE|BODY_TOO_LARGE|QUOTA_LOW|PROBE_STOPPED|REQUEST_NOT_ALLOWED|SUCCESS_WITHOUT_ID|READBACK_DIVERGENT)$/u.test(
        error?.message ?? '',
      )
        ? error.message
        : 'PROBE_STOPPED';
    return {
      state: createdId
        ? 'created_requires_reconciliation'
        : postAttempted
          ? 'outcome_unknown'
          : 'blocked_before_write',
      code,
      erpPostAttempts: postAttempted ? 1 : 0,
      automaticRetry: false,
      getCount,
      queries: summaries,
      uiLineProofRequired: true,
      f1GatePassed: false,
    };
  }
}
