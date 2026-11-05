/**
 * OLIST-T02: the specifically approved six-POST batch, never production export.
 * Every uncertain effect is journalled and stops all dependents. No retry/cleanup.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeDocument } from './read-only-probe.mjs';
export const PLAN_SHA256 =
  '7093d23b393e3a242bd8f615ceafd025b7de6753eca2ce60e3a244b88a3be745';
export const BATCH_NAME = 'F1-BATCH-20261104';
const API = 'https://api.tiny.com.br/public-api/v3';
const fail = (c) => {
  throw new Error(c);
};
const hash = (x) => createHash('sha256').update(x).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const doc = (x) => normalizeDocument(x);
const canonical = (x) =>
  String(x ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
const sameDoc = (a, b) => {
  try {
    return doc(a) === doc(b);
  } catch {
    return false;
  }
};
function exactKeys(o, keys) {
  if (
    !o ||
    Array.isArray(o) ||
    Object.keys(o).sort().join() !== [...keys].sort().join()
  )
    fail('INVALID_PRIVATE_PLAN');
}
export async function loadBatchPlan() {
  const raw = await readFile(
    new URL('./next-controlled-cases.json', import.meta.url),
  );
  if (hash(raw) !== PLAN_SHA256) fail('APPROVED_PLAN_CHANGED');
  return JSON.parse(raw);
}
export function bindBatch(publicPlan, input) {
  exactKeys(input, [
    'approved',
    'referencePrefix',
    'accountDocument',
    'customerSource',
    'customer',
    'existingBuyer',
    'existingParentId',
    'existingM',
    'existingG',
    'originIntegratorIdCandidate',
    'date',
    'newProductFiscal',
  ]);
  const c = input.customer;
  exactKeys(c, [
    'codigo',
    'nome',
    'fantasia',
    'tipoPessoa',
    'cpfCnpj',
    'inscricaoEstadual',
    'regimeTributario',
    'situacao',
    'endereco',
  ]);
  exactKeys(c.endereco, [
    'endereco',
    'numero',
    'bairro',
    'municipio',
    'uf',
    'cep',
    'complemento',
  ]);
  exactKeys(input.existingBuyer, ['id', 'document']);
  if (
    !positive(input.existingBuyer.id) ||
    !sameDoc(input.existingBuyer.document, input.existingBuyer.document)
  )
    fail('INVALID_PRIVATE_PLAN');
  exactKeys(input.existingM, ['id', 'sku']);
  exactKeys(input.existingG, ['id', 'sku']);
  if (
    input.referencePrefix !== 'CRM-F1-20261104' ||
    input.date !== '2026-11-04' ||
    input.customerSource !== 'account-company-form' ||
    c.nome !== 'S M R SOLUCOES COMERCIO E INDUSTRIA LTDA' ||
    c.fantasia !== 'SILMER' ||
    c.codigo !== 'CRM-F1-20261104-CLI' ||
    c.situacao !== 'B' ||
    c.tipoPessoa !== 'J' ||
    c.regimeTributario !== 1 ||
    !sameDoc(c.cpfCnpj, input.accountDocument) ||
    doc(c.cpfCnpj).length !== 14 ||
    !['inscricaoEstadual'].every(
      (k) => typeof c[k] === 'string' && c[k].trim(),
    ) ||
    !['endereco', 'numero', 'bairro', 'municipio', 'uf', 'cep'].every(
      (k) => typeof c.endereco[k] === 'string' && c.endereco[k].trim(),
    ) ||
    !positive(input.existingParentId) ||
    !positive(input.existingM.id) ||
    !positive(input.existingG.id) ||
    input.existingM.sku !== '29051-3' ||
    input.existingG.sku !== '29051-4' ||
    !positive(input.originIntegratorIdCandidate) ||
    JSON.stringify(input.newProductFiscal) !==
      JSON.stringify({ ncm: '6205.30.00', origem: 0, unidade: 'Un' })
  )
    fail('INVALID_PRIVATE_PLAN');
  if (
    publicPlan.referencePrefix !== input.referencePrefix ||
    publicPlan.orders.length !== 3 ||
    publicPlan.limits.maximumPostAttempts !== 6
  )
    fail('APPROVED_PLAN_CHANGED');
  const result = { publicPlan: clone(publicPlan), input: clone(input) };
  return { ...result, digest: hash(JSON.stringify(result)) };
}
function page(body) {
  if (
    !Array.isArray(body?.itens) ||
    body.paginacao?.offset !== 0 ||
    !Number.isSafeInteger(body.paginacao.total) ||
    body.paginacao.total !== body.itens.length ||
    body.itens.length > 100
  )
    fail('INCOMPLETE_LOOKUP');
  return body.itens;
}
function query(path, values) {
  return (
    path + '?' + new URLSearchParams({ ...values, limit: '100', offset: '0' })
  );
}
async function append(path, event, exclusive = false) {
  const f = await open(path, exclusive ? 'wx' : 'a', 0o600);
  try {
    await f.writeFile(JSON.stringify(event) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
export function parseWithLexemes(raw) {
  const body = JSON.parse(raw);
  const numeric = JSON.parse(raw, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') fail('DECIMAL_SOURCE_UNAVAILABLE');
    return { lexeme: context.source };
  });
  return { body, numeric };
}
function customerCheck(actual, expected, expectedId, newRecord) {
  if (
    actual?.id !== expectedId ||
    !sameDoc(actual.cpfCnpj, expected.cpfCnpj) ||
    actual.tipoPessoa !== 'J' ||
    !['A', 'B'].includes(actual.situacao) ||
    (newRecord &&
      (actual.situacao !== 'B' || actual.codigo !== expected.codigo)) ||
    canonical(actual.nome) !== canonical(expected.nome) ||
    String(actual.inscricaoEstadual).replace(/\W/g, '') !==
      expected.inscricaoEstadual.replace(/\W/g, '') ||
    !['endereco', 'numero', 'bairro', 'municipio', 'uf', 'cep'].every((k) =>
      k === 'cep'
        ? String(actual.endereco?.[k] ?? '').replace(/\D/g, '') ===
          expected.endereco[k].replace(/\D/g, '')
        : canonical(actual.endereco?.[k]) === canonical(expected.endereco[k]),
    )
  )
    fail('CUSTOMER_READBACK_DIVERGENT');
}
function parentCheck(p, expected, expectedId, sizes) {
  if (
    p?.id !== expectedId ||
    p.tipo !== 'V' ||
    p.sku !== expected.sku ||
    p.situacao !== 'A' ||
    p.unidade !== 'Un' ||
    String(p.ncm).replace(/\./g, '') !== '62053000' ||
    String(p.origem) !== '0' ||
    p.precos?.preco !== 0 ||
    !Array.isArray(p.variacoes) ||
    p.variacoes.length !== sizes.length
  )
    fail('PARENT_READBACK_DIVERGENT');
  const out = {};
  for (const size of sizes) {
    const found = p.variacoes.filter(
      (v) => v.sku === expected.sku + '-' + size,
    );
    if (
      found.length !== 1 ||
      !positive(found[0].id) ||
      found[0].grade?.length !== 1 ||
      found[0].grade[0].chave !== 'Tamanho' ||
      found[0].grade[0].valor !== size
    )
      fail('VARIATION_IDENTITY_DIVERGENT');
    out[size] = found[0].id;
  }
  if (new Set(Object.values(out)).size !== sizes.length)
    fail('VARIATION_IDENTITY_DIVERGENT');
  return out;
}
function childCheck(p, id, sku, parentId) {
  if (
    p?.id !== id ||
    p.sku !== sku ||
    p.produtoPai?.id !== parentId ||
    p.situacao !== 'A' ||
    p.precos?.preco !== 0
  )
    fail('VARIATION_READBACK_DIVERGENT');
}
export function orderPayload(
  order,
  customerId,
  parentIds,
  existingM,
  origin,
  date,
) {
  const ids = {
    'new-M': parentIds.M,
    'new-G': parentIds.G,
    'existing-M-from-C01': existingM,
  };
  return {
    idContato: customerId,
    data: date,
    situacao: 0,
    ecommerce: { id: origin, numeroPedidoEcommerce: order.reference },
    itens: order.items.map((x) => ({
      produto: { id: ids[x.resource] },
      quantidade: x.quantity,
      valorUnitario: Number(x.unitLexeme),
    })),
  };
}
function orderCheck(b, n, expected, id, document, diagnosticLines = null) {
  if (
    b?.id !== id ||
    b.situacao !== 0 ||
    b.data !== expected.data ||
    b.cliente?.id !== expected.idContato ||
    !sameDoc(b.cliente?.cpfCnpj, document)
  )
    fail('ORDER_IDENTITY_DIVERGENT');
  if (
    b.ecommerce?.id !== expected.ecommerce.id ||
    b.ecommerce?.numeroPedidoEcommerce !==
      expected.ecommerce.numeroPedidoEcommerce
  )
    fail('ORDER_REFERENCE_DIVERGENT');
  if (
    ![null, undefined, 0].includes(b.idNotaFiscal) ||
    (b.notaFiscal && Object.keys(b.notaFiscal).length) ||
    (b.pagamentosIntegrados?.length ?? 0) !== 0 ||
    (b.pagamento?.parcelas?.length ?? 0) !== 0 ||
    !['valorDesconto', 'valorFrete', 'valorOutrasDespesas'].every((k) =>
      [null, undefined, 0].includes(b[k]),
    )
  )
    fail('UNEXPECTED_ORDER_EFFECT');
  if (!Array.isArray(b.itens) || b.itens.length !== expected.itens.length)
    fail('ORDER_LINES_DIVERGENT');
  const unused = expected.itens.map((line, index) => ({ line, index }));
  const lines = b.itens.map((line, i) => {
    const candidates = unused.filter(
      (x) =>
        x.line.produto.id === line.produto?.id &&
        x.line.quantidade === line.quantidade &&
        x.line.valorUnitario === line.valorUnitario,
    );
    // A decimal change is diagnostic, but matching each repeated line must be unambiguous.
    let selected = candidates.length === 1 ? candidates[0] : null;
    if (
      !selected &&
      diagnosticLines &&
      expected.ecommerce.numeroPedidoEcommerce === 'CRM-F1-20261104-C03'
    ) {
      const diagnostic = unused.filter(
        (x) =>
          x.line.produto.id === line.produto?.id &&
          x.line.quantidade === 1 &&
          line.quantidade === 1 &&
          line.valorUnitario ===
            diagnosticLines[x.index]?.hypotheticalLineCents / 100,
      );
      if (diagnostic.length === 1) selected = diagnostic[0];
    }
    if (!selected) {
      const byIdentity = unused.filter(
        (x) =>
          x.line.produto.id === line.produto?.id &&
          x.line.quantidade === line.quantidade,
      );
      if (byIdentity.length !== 1) fail('ORDER_LINES_AMBIGUOUS');
      selected = byIdentity[0];
    }
    unused.splice(unused.indexOf(selected), 1);
    return {
      sourceLine: selected.index,
      quantity: line.quantidade,
      storedUnitLexeme: n.itens[i].valorUnitario?.lexeme ?? null,
      unitUnchanged: line.valorUnitario === selected.line.valorUnitario,
    };
  });
  if (
    typeof b.valorTotalPedido !== 'number' ||
    !Number.isFinite(b.valorTotalPedido) ||
    b.valorTotalPedido < 0 ||
    b.valorTotalPedido > 10
  )
    fail('ORDER_BUDGET_DIVERGENT');
  return {
    referencePreserved: true,
    originPreserved: true,
    lineCount: b.itens.length,
    lines,
    totalProductsLexeme: n.valorTotalProdutos?.lexeme ?? null,
    totalOrderLexeme: n.valorTotalPedido?.lexeme ?? null,
    uiIndependentLineProofRequired: true,
  };
}
export async function executeBatch(
  bound,
  {
    token,
    approvedDigest,
    journalDirectory,
    fetcher = fetch,
    signal,
    pause = delay,
    onProgress = () => {},
    correctedCustomer = false,
  } = {},
) {
  if (approvedDigest !== bound.digest) fail('EXPLICIT_APPROVAL_REQUIRED');
  if (
    typeof token !== 'string' ||
    !token ||
    typeof journalDirectory !== 'string'
  )
    fail('PRIVATE_SESSION_REQUIRED');
  const { input, publicPlan: plan } = bound;
  const originalJournal = join(journalDirectory, BATCH_NAME + '.jsonl');
  let originalCustomerHash = null;
  if (correctedCustomer) {
    const originalEvents = (await readFile(originalJournal, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const diagnosticEvents = (
      await readFile(join(journalDirectory, 'CUSTOMER-DIAG01.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    const reserved = originalEvents.find(
      (e) => e.event === 'reserved' && e.resource === 'customer',
    );
    if (
      originalEvents[0]?.planHash !== bound.digest ||
      !reserved ||
      originalEvents.some((e) => e.event === 'created') ||
      diagnosticEvents.some((e) => e.event === 'created') ||
      diagnosticEvents[0]?.originalPayloadHash !== reserved.payloadHash
    )
      fail('CORRECTION_STATE_NOT_ALLOWED');
    originalCustomerHash = reserved.payloadHash;
  }
  const journal = correctedCustomer
    ? join(journalDirectory, 'CUSTOMER-CORRECTED01-FULL.jsonl')
    : originalJournal;
  try {
    await readFile(journal);
    fail('BATCH_ALREADY_RESERVED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let gets = 0,
    anonymous = 0,
    posts = 0,
    reserved = false,
    last = 0;
  const calls = [],
    outcomes = [];
  const allowedGets = new Set([
    '/info',
    '/produtos/' + input.existingParentId,
    '/produtos/' + input.existingM.id,
    '/contatos/' + input.existingBuyer.id,
  ]);
  function allowedGet(p) {
    allowedGets.add(p);
    return p;
  }
  const search = (path, params) => allowedGet(query(path, params));
  async function request(path, method = 'GET', payload, unauth = false) {
    if (signal?.aborted) fail('PROBE_STOPPED');
    if (unauth && correctedCustomer) fail('REQUEST_NOT_ALLOWED');
    if (method === 'GET') {
      if (
        !allowedGets.has(path) ||
        (unauth ? ++anonymous > 1 : ++gets > (correctedCustomer ? 66 : 80))
      )
        fail('REQUEST_NOT_ALLOWED');
    } else if (method === 'POST') {
      if (!reserved || ++posts > 6) fail('REQUEST_NOT_ALLOWED');
    } else fail('REQUEST_NOT_ALLOWED');
    if (last)
      await pause(Math.max(0, 2600 - (Date.now() - last)), undefined, {
        signal,
      });
    last = Date.now();
    let response;
    try {
      response = await fetcher(API + path, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(!unauth ? { Authorization: 'Bearer ' + token } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      fail('HTTP_OUTCOME_UNKNOWN');
    }
    const summary = {
      method,
      path: path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}'),
      status: response.status,
      authenticated: !unauth,
    };
    calls.push(summary);
    onProgress({ gets, posts, last: summary });
    if (unauth) {
      await response.body?.cancel();
      if (![401, 403].includes(response.status))
        fail('AUTH_REJECTION_UNEXPECTED');
      return {};
    }
    if (response.status < 200 || response.status >= 300) {
      if (response.headers.get('content-type')?.includes('application/json')) {
        const reader = response.body?.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          if (reader)
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 32768) {
                await reader.cancel();
                break;
              }
              chunks.push(part.value);
            }
          const error = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const allowed = new Set([
            'nome',
            'codigo',
            'cpfCnpj',
            'tipoPessoa',
            'situacao',
            'tipos',
            'regimeTributario',
            'inscricaoEstadual',
            'endereco',
            'endereco.cep',
            'cep',
          ]);
          summary.validationFields = [
            ...new Set(
              (Array.isArray(error?.detalhes) ? error.detalhes : []).map((x) =>
                allowed.has(x?.campo) ? x.campo : 'other',
              ),
            ),
          ];
          summary.validationCategories = [
            ...new Set(
              (Array.isArray(error?.detalhes) ? error.detalhes : []).map(
                (x) => {
                  const m = canonical(x?.mensagem);
                  return /OBRIGAT|REQUIRED/.test(m)
                    ? 'required'
                    : /CARACT|TAMANHO|LIMITE|MAXIM|MÁXIM/.test(m)
                      ? 'length-or-limit'
                      : /EXIST|DUPLIC/.test(m)
                        ? 'already-exists'
                        : /INV.LID|VALID/.test(m)
                          ? 'invalid'
                          : 'unspecified';
                },
              ),
            ),
          ];
        } catch {
        } finally {
          reader?.releaseLock();
        }
      } else await response.body?.cancel();
      fail('HTTP_' + response.status);
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      fail('INVALID_RESPONSE');
    const reader = response.body?.getReader();
    if (!reader) fail('INVALID_RESPONSE');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.byteLength;
        if (size > 262144) {
          await reader.cancel();
          fail('BODY_TOO_LARGE');
        }
        chunks.push(p.value);
      }
    } finally {
      reader.releaseLock();
    }
    let parsed;
    try {
      parsed = parseWithLexemes(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('INVALID_RESPONSE');
    }
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (
      method === 'GET' &&
      remaining !== null &&
      (!/^\d+$/.test(remaining) || Number(remaining) < 2)
    )
      fail('QUOTA_LOW');
    if (Array.isArray(parsed.body?.itens))
      summary.count = parsed.body.itens.length;
    return parsed;
  }
  const get = async (p) => (await request(p)).body;
  const skuLookup = async (sku, situation = 'A') => {
    const all = page(
      await get(search('/produtos', { codigo: sku, situacao: situation })),
    );
    const items = correctedCustomer ? all.filter((x) => x.sku === sku) : all;
    if (items.some((x) => x.sku !== sku)) fail('PRODUCT_FILTER_NOT_EXACT');
    return items;
  };
  const refLookup = async (ref) =>
    page(await get(search('/pedidos', { numeroPedidoEcommerce: ref })));
  const expectSku = async (sku, id) => {
    const a = await skuLookup(sku);
    if (a.length !== 1 || a[0].id !== id) fail('PRODUCT_LOOKUP_DIVERGENT');
  };
  async function create(label, path, payload, extraResources = []) {
    const allowedPosts = {
      customer: '/contatos',
      parent: '/produtos',
      GG: '/produtos/{id}/variacoes',
      C02: '/pedidos',
      C03: '/pedidos',
      C04: '/pedidos',
    };
    if (path.replace(/\/\d+(?=\/|$)/g, '/{id}') !== allowedPosts[label])
      fail('REQUEST_NOT_ALLOWED');
    await append(journal, {
      event: 'reserved',
      resource: label,
      alsoReserves: extraResources,
      payloadHash: hash(JSON.stringify(payload)),
    });
    const response = await request(path, 'POST', payload);
    if (!positive(response.body?.id)) fail('CREATED_ID_MISSING');
    await append(journal, {
      event: 'created',
      resource: label,
      id: response.body.id,
      ...(label === 'parent'
        ? {
            initialChildIds: (response.body.variacoes ?? [])
              .map((v) => v.id)
              .filter(positive),
          }
        : {}),
    });
    allowedGet(
      (label === 'customer'
        ? '/contatos/'
        : label.startsWith('C0')
          ? '/pedidos/'
          : '/produtos/') + response.body.id,
    );
    return response.body.id;
  }
  try {
    if (!sameDoc((await get('/info')).cpfCnpj, input.accountDocument))
      fail('ACCOUNT_MISMATCH');
    if (!correctedCustomer) await request('/info', 'GET', undefined, true);
    const oldParent = await get('/produtos/' + input.existingParentId);
    const oldM = await get('/produtos/' + input.existingM.id);
    if (
      oldParent.sku !== '29051' ||
      oldParent.tipo !== 'V' ||
      !(oldParent.variacoes ?? []).some(
        (v) =>
          v.id === input.existingM.id &&
          v.sku === input.existingM.sku &&
          v.grade?.some((g) => g.chave === 'Tamanho' && g.valor === 'M'),
      ) ||
      oldM.sku !== input.existingM.sku ||
      oldM.id !== input.existingM.id ||
      oldM.produtoPai?.id !== input.existingParentId ||
      oldM.situacao !== 'A' ||
      (oldM.unidade || oldParent.unidade) !== 'Un' ||
      String(oldM.ncm || oldParent.ncm).replace(/\./g, '') !== '62053000' ||
      String(oldM.origem ?? oldParent.origem) !== '0' ||
      oldM.precos?.preco !== 34.9
    )
      fail('SOURCE_PRODUCT_CHANGED');
    const buyerSource = await get('/contatos/' + input.existingBuyer.id);
    if (
      buyerSource.id !== input.existingBuyer.id ||
      !sameDoc(buyerSource.cpfCnpj, input.existingBuyer.document)
    )
      fail('CUSTOMER_TYPE_SOURCE_MISMATCH');
    const clientTypes = (buyerSource.tipos ?? []).filter(
      (t) => canonical(t.descricao) === 'CLIENTE',
    );
    if (clientTypes.length !== 1 || !positive(clientTypes[0].id))
      fail('CUSTOMER_TYPE_UNPROVEN');
    const customerPayload = { ...input.customer, tipos: [clientTypes[0].id] };
    if (correctedCustomer) {
      if (hash(JSON.stringify(customerPayload)) !== originalCustomerHash)
        fail('ORIGINAL_PAYLOAD_CHANGED');
      delete customerPayload.codigo;
    }
    const customers = new Map();
    for (const document of new Set([
      doc(input.customer.cpfCnpj),
      input.customer.cpfCnpj,
    ])) {
      for (const situacao of ['A', 'B', 'I', 'E']) {
        const items = page(
          await get(search('/contatos', { cpfCnpj: document, situacao })),
        );
        if (
          items.some(
            (c) =>
              !sameDoc(c.cpfCnpj, input.customer.cpfCnpj) ||
              c.situacao !== situacao,
          )
        )
          fail('CUSTOMER_FILTER_NOT_EXACT');
        for (const c of items) {
          if (!positive(c.id)) fail('CUSTOMER_ID_INVALID');
          customers.set(c.id, c);
        }
      }
    }
    if (correctedCustomer) {
      for (const situacao of ['A', 'B', 'I', 'E']) {
        const coded = page(
          await get(
            search('/contatos', { codigo: input.customer.codigo, situacao }),
          ),
        );
        if (
          coded.some(
            (c) =>
              !sameDoc(c.cpfCnpj, input.customer.cpfCnpj) ||
              c.situacao !== situacao,
          )
        )
          fail('CUSTOMER_CODE_COLLISION');
        for (const c of coded) {
          if (!positive(c.id)) fail('CUSTOMER_ID_INVALID');
          customers.set(c.id, c);
        }
      }
    }
    if (customers.size > 1) fail('CUSTOMER_AMBIGUOUS');
    let customerId = customers.size ? [...customers.keys()][0] : null;
    if (customerId) {
      const customer = await get(allowedGet('/contatos/' + customerId));
      customerCheck(customer, input.customer, customerId, false);
      if (
        correctedCustomer &&
        (Number(customer.regimeTributario) !==
          input.customer.regimeTributario ||
          !(customer.tipos ?? []).some((t) => t.id === clientTypes[0].id))
      )
        fail('CUSTOMER_FISCAL_OR_TYPE_DIVERGENT');
    }
    for (const sku of [
      plan.parent.payload.sku,
      ...plan.parent.payload.variacoes.map((x) => x.sku),
      plan.additionalVariation.payload.sku,
    ]) {
      for (const s of ['A', 'I', 'E'])
        if ((await skuLookup(sku, s)).length) fail('TEST_SKU_EXISTS');
    }
    for (const order of plan.orders)
      if ((await refLookup(order.reference)).length)
        fail('TEST_REFERENCE_EXISTS');
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    await append(
      journal,
      {
        event: 'batch-reserved',
        planHash: bound.digest,
        maximumPosts: 6,
        ...(correctedCustomer
          ? {
              explicitLimitedCorrection: true,
              omittedField: 'codigo',
              originalCustomerHash,
              previousAuthenticatedGets: 54,
              maximumTotalAuthenticatedGets: 120,
              previousPostAttempts: 2,
              maximumTotalPostAttempts: 8,
            }
          : {}),
      },
      true,
    );
    reserved = true;
    if (!customerId) {
      customerId = await create('customer', '/contatos', customerPayload);
      const detail = await get('/contatos/' + customerId);
      customerCheck(detail, input.customer, customerId, !correctedCustomer);
      if (
        correctedCustomer &&
        (detail.situacao !== 'B' ||
          Number(detail.regimeTributario) !== input.customer.regimeTributario ||
          !Array.isArray(detail.tipos) ||
          detail.tipos.length !== 1 ||
          detail.tipos[0].id !== clientTypes[0].id)
      )
        fail('CUSTOMER_FISCAL_OR_TYPE_DIVERGENT');
      const found = page(
        await get(
          search('/contatos', {
            cpfCnpj: input.customer.cpfCnpj,
            situacao: 'B',
          }),
        ),
      );
      if (
        found.length !== 1 ||
        found[0].id !== customerId ||
        !sameDoc(found[0].cpfCnpj, input.customer.cpfCnpj)
      )
        fail('CUSTOMER_LOOKUP_DIVERGENT');
      const code = correctedCustomer ? detail.codigo : input.customer.codigo;
      if (typeof code === 'string' && code.trim()) {
        const coded = page(
          await get(search('/contatos', { codigo: code, situacao: 'B' })),
        );
        if (
          coded.length !== 1 ||
          coded[0].id !== customerId ||
          !sameDoc(coded[0].cpfCnpj, input.customer.cpfCnpj)
        )
          fail('CUSTOMER_CODE_DIVERGENT');
      }
      await append(journal, {
        event: 'api-reconciled',
        resource: 'customer',
        id: customerId,
        erpAssignedCodePresent: Boolean(code),
      });
    }
    outcomes.push({
      resource: 'customer',
      created: customers.size === 0,
      exactLookupConfirmed: true,
    });
    const parentId = await create('parent', '/produtos', plan.parent.payload, [
      'M',
      'G',
    ]);
    let ids = parentCheck(
      await get('/produtos/' + parentId),
      plan.parent.payload,
      parentId,
      ['M', 'G'],
    );
    await append(journal, { event: 'children-reconciled', ids });
    for (const size of ['M', 'G']) {
      childCheck(
        await get(allowedGet('/produtos/' + ids[size])),
        ids[size],
        plan.parent.payload.sku + '-' + size,
        parentId,
      );
      await expectSku(plan.parent.payload.sku + '-' + size, ids[size]);
    }
    await expectSku(plan.parent.payload.sku, parentId);
    outcomes.push({
      resource: 'parent-M-G',
      created: true,
      childrenConfirmed: 2,
      atomicityProven: false,
    });
    const ggId = await create(
      'GG',
      '/produtos/' + parentId + '/variacoes',
      plan.additionalVariation.payload,
    );
    const added = parentCheck(
      await get('/produtos/' + parentId),
      plan.parent.payload,
      parentId,
      ['M', 'G', 'GG'],
    );
    if (added.M !== ids.M || added.G !== ids.G || added.GG !== ggId)
      fail('VARIATION_LINK_CHANGED');
    childCheck(
      await get('/produtos/' + ggId),
      ggId,
      plan.additionalVariation.payload.sku,
      parentId,
    );
    await expectSku(plan.additionalVariation.payload.sku, ggId);
    outcomes.push({ resource: 'GG', created: true, lookupConfirmed: true });
    let total = 0;
    for (const order of plan.orders) {
      const label = order.reference.slice(-3);
      const payload = orderPayload(
        order,
        customerId,
        ids,
        input.existingM.id,
        input.originIntegratorIdCandidate,
        input.date,
      );
      const id = await create(label, '/pedidos', payload);
      const response = await request('/pedidos/' + id);
      const observed = {
        resource: label,
        created: true,
        referencePresent: Boolean(
          response.body?.ecommerce?.numeroPedidoEcommerce,
        ),
        originIdState:
          response.body?.ecommerce?.id === input.originIntegratorIdCandidate
            ? 'expected'
            : response.body?.ecommerce?.id === 0
              ? 'zero'
              : 'different-or-missing',
        observedMoney: {
          totalOrderLexeme: response.numeric?.valorTotalPedido?.lexeme ?? null,
          totalProductsLexeme:
            response.numeric?.valorTotalProdutos?.lexeme ?? null,
          lines: (response.body?.itens ?? []).map((line, i) => ({
            resource:
              line.produto?.id === ids.M
                ? 'new-M'
                : line.produto?.id === ids.G
                  ? 'new-G'
                  : line.produto?.id === input.existingM.id
                    ? 'existing-M'
                    : 'unexpected',
            quantity: line.quantidade,
            unitLexeme:
              response.numeric?.itens?.[i]?.valorUnitario?.lexeme ?? null,
          })),
        },
      };
      outcomes.push(observed);
      const proof = orderCheck(
        response.body,
        response.numeric,
        payload,
        id,
        input.customer.cpfCnpj,
      );
      total += response.body.valorTotalPedido;
      if (total > 10) fail('BATCH_BUDGET_DIVERGENT');
      const found = await refLookup(order.reference);
      if (found.length !== 1 || found[0].id !== id)
        fail('ORDER_REFERENCE_LOOKUP_DIVERGENT');
      await append(journal, { event: 'api-reconciled', resource: label, id });
      Object.assign(observed, { referenceLookupConfirmed: true, ...proof });
    }
    const after = await get('/produtos/' + input.existingM.id);
    if (after.precos?.preco !== oldM.precos.preco || after.sku !== oldM.sku)
      fail('EXISTING_CATALOG_CHANGED');
    return {
      ...(correctedCustomer
        ? {
            limitedCorrection: true,
            omittedField: 'codigo',
            previousAuthenticatedGets: 54,
            previousPostAttempts: 2,
          }
        : {}),
      task: 'OLIST-T02',
      state: 'api_batch_completed_ui_proof_required',
      gets,
      anonymousGets: anonymous,
      erpPostAttempts: posts,
      calls,
      outcomes,
      automaticRetry: false,
      f1GatePassed: false,
    };
  } catch (error) {
    const code = /^[A-Z][A-Z_0-9]+$/.test(error?.message ?? '')
      ? error.message
      : 'BATCH_STOPPED';
    return {
      ...(correctedCustomer
        ? {
            limitedCorrection: true,
            omittedField: 'codigo',
            previousAuthenticatedGets: 54,
            previousPostAttempts: 2,
          }
        : {}),
      task: 'OLIST-T02',
      state: posts ? 'stopped_preserve_confirmed_ids' : 'blocked_before_write',
      code,
      gets,
      anonymousGets: anonymous,
      erpPostAttempts: posts,
      calls,
      outcomes,
      automaticRetry: false,
      f1GatePassed: false,
    };
  }
}

/** Read-only reconciliation after the rejected first customer POST. Never retries it. */
export async function reconcileRejectedCustomer(
  bound,
  { token, journalDirectory, fetcher = fetch, signal, pause = delay } = {},
) {
  const events = (
    await readFile(join(journalDirectory, BATCH_NAME + '.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  if (
    events[0]?.planHash !== bound.digest ||
    !events.some((e) => e.event === 'reserved' && e.resource === 'customer') ||
    events.some((e) => e.event === 'created')
  )
    fail('RECONCILIATION_STATE_NOT_ALLOWED');
  const document = bound.input.customer.cpfCnpj;
  const paths = ['/info'];
  for (const formatted of new Set([doc(document), document]))
    for (const situacao of ['A', 'B', 'I', 'E'])
      paths.push(query('/contatos', { cpfCnpj: formatted, situacao }));
  for (const situacao of ['A', 'B', 'I', 'E'])
    paths.push(
      query('/contatos', { codigo: bound.input.customer.codigo, situacao }),
    );
  const calls = [];
  let allEmpty = true;
  for (const path of paths) {
    if (calls.length) await pause(2600, undefined, { signal });
    let r;
    try {
      r = await fetcher(API + path, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      fail('HTTP_OUTCOME_UNKNOWN');
    }
    if (r.status !== 200) fail('HTTP_' + r.status);
    if (!r.headers.get('content-type')?.includes('application/json'))
      fail('INVALID_RESPONSE');
    const reader = r.body?.getReader();
    if (!reader) fail('INVALID_RESPONSE');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 262144) {
          await reader.cancel();
          fail('BODY_TOO_LARGE');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (path === '/info') {
      if (!sameDoc(body.cpfCnpj, bound.input.accountDocument))
        fail('ACCOUNT_MISMATCH');
      calls.push({ path: '/info', status: 200 });
      continue;
    }
    const items = page(body);
    allEmpty = allEmpty && items.length === 0;
    calls.push({
      path: '/contatos',
      status: 200,
      filter: path.includes('cpfCnpj=') ? 'document' : 'stable-code',
      situation: new URL(API + path).searchParams.get('situacao'),
      count: items.length,
      exactDocumentMatches: items.filter((x) => sameDoc(x.cpfCnpj, document))
        .length,
    });
  }
  return {
    task: 'OLIST-T02',
    state: allEmpty
      ? 'no_matching_customer_observed_after_rejection'
      : 'possible_customer_requires_manual_reconciliation',
    gets: calls.length,
    erpPostAttempts: 0,
    allQueriesEmpty: allEmpty,
    calls,
    zeroDoesNotAuthorizeRetry: true,
    originalJournalPreserved: true,
    f1GatePassed: false,
  };
}

/** Exactly one explicitly approved additional POST, identical to the rejected payload. */
export async function diagnoseCustomerOnce(
  bound,
  {
    token,
    approvedDigest,
    journalDirectory,
    fetcher = fetch,
    signal,
    pause = delay,
    onProgress = () => {},
  } = {},
) {
  if (approvedDigest !== bound.digest) fail('EXPLICIT_APPROVAL_REQUIRED');
  const originalPath = join(journalDirectory, BATCH_NAME + '.jsonl');
  const events = (await readFile(originalPath, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const original = events.find(
    (e) => e.event === 'reserved' && e.resource === 'customer',
  );
  if (
    events[0]?.planHash !== bound.digest ||
    !original ||
    events.some((e) => e.event === 'created')
  )
    fail('DIAGNOSTIC_STATE_NOT_ALLOWED');
  const journal = join(journalDirectory, 'CUSTOMER-DIAG01.jsonl');
  try {
    await readFile(journal);
    fail('DIAGNOSTIC_ALREADY_RESERVED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let gets = 0,
    posts = 0,
    reserved = false,
    last = 0;
  const calls = [];
  const countedFetch = async (url, init) => {
    if (init.method === 'GET') {
      if (++gets > 17) fail('REQUEST_NOT_ALLOWED');
    } else if (init.method === 'POST') {
      if (!reserved || posts || url !== API + '/contatos')
        fail('REQUEST_NOT_ALLOWED');
      posts++;
    } else fail('REQUEST_NOT_ALLOWED');
    let response;
    try {
      response = await fetcher(url, init);
    } catch {
      fail('HTTP_OUTCOME_UNKNOWN');
    }
    calls.push({
      method: init.method,
      path: new URL(url).pathname
        .replace('/public-api/v3', '')
        .replace(/\/\d+(?=\/|$)/g, '/{id}'),
      status: response.status,
    });
    onProgress({ gets, posts, last: calls.at(-1) });
    return response;
  };
  async function request(path, method = 'GET', payload) {
    if (last)
      await pause(Math.max(0, 2600 - (Date.now() - last)), undefined, {
        signal,
      });
    last = Date.now();
    const response = await countedFetch(API + path, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
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
    } finally {
      reader.releaseLock();
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('INVALID_RESPONSE');
    }
    if (response.status < 200 || response.status >= 300) {
      const fields = new Set([
        'nome',
        'codigo',
        'cpfCnpj',
        'tipoPessoa',
        'situacao',
        'tipos',
        'regimeTributario',
        'inscricaoEstadual',
        'endereco',
        'endereco.cep',
        'endereco.pais',
        'endereco.uf',
        'endereco.numero',
        'endereco.municipio',
        'endereco.bairro',
        'endereco.complemento',
        'cep',
        'pais',
        'uf',
        'municipio',
        'telefone',
        'celular',
        'email',
        'vendedor',
        'fantasia',
        'contatos',
      ]);
      const details = Array.isArray(body?.detalhes) ? body.detalhes : [];
      calls.at(-1).validationFields = [
        ...new Set(
          details.map((x) => (fields.has(x?.campo) ? x.campo : 'other')),
        ),
      ];
      calls.at(-1).validationCategories = [
        ...new Set(
          details.map((x) => {
            const m = canonical(x?.mensagem);
            return /OBRIGAT|REQUIRED/.test(m)
              ? 'required'
              : /CARACT|TAMANHO|LIMITE|MAXIM|MÁXIM/.test(m)
                ? 'length-or-limit'
                : /EXIST|DUPLIC/.test(m)
                  ? 'already-exists'
                  : /INV.LID|VALID/.test(m)
                    ? 'invalid'
                    : 'unspecified';
          }),
        ),
      ];
      fail('HTTP_' + response.status);
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      fail('INVALID_RESPONSE');
    return body;
  }
  try {
    const reconciliation = await reconcileRejectedCustomer(bound, {
      token,
      journalDirectory,
      fetcher: countedFetch,
      signal,
      pause,
    });
    if (!reconciliation.allQueriesEmpty) fail('CUSTOMER_POSSIBLY_EXISTS');
    // The next request waits after the final reconciliation GET too.
    last = Date.now();
    const source = await request('/contatos/' + bound.input.existingBuyer.id);
    if (
      source.id !== bound.input.existingBuyer.id ||
      !sameDoc(source.cpfCnpj, bound.input.existingBuyer.document)
    )
      fail('CUSTOMER_TYPE_SOURCE_MISMATCH');
    const clientTypes = (source.tipos ?? []).filter(
      (t) => canonical(t.descricao) === 'CLIENTE',
    );
    if (clientTypes.length !== 1 || !positive(clientTypes[0].id))
      fail('CUSTOMER_TYPE_UNPROVEN');
    const payload = { ...bound.input.customer, tipos: [clientTypes[0].id] };
    if (hash(JSON.stringify(payload)) !== original.payloadHash)
      fail('ORIGINAL_PAYLOAD_CHANGED');
    await append(
      journal,
      {
        event: 'diagnostic-reserved',
        originalBatch: BATCH_NAME,
        originalPayloadHash: original.payloadHash,
        explicitAdditionalAttempt: true,
        maximumPosts: 1,
      },
      true,
    );
    reserved = true;
    const created = await request('/contatos', 'POST', payload);
    if (!positive(created?.id)) fail('CREATED_ID_MISSING');
    await append(journal, {
      event: 'created',
      resource: 'customer',
      id: created.id,
    });
    const customer = await request('/contatos/' + created.id);
    customerCheck(customer, bound.input.customer, created.id, true);
    if (
      Number(customer.regimeTributario) !==
        bound.input.customer.regimeTributario ||
      !Array.isArray(customer.tipos) ||
      customer.tipos.length !== 1 ||
      customer.tipos[0].id !== clientTypes[0].id
    )
      fail('CUSTOMER_FISCAL_OR_TYPE_DIVERGENT');
    const byDocument = page(
      await request(
        query('/contatos', {
          cpfCnpj: bound.input.customer.cpfCnpj,
          situacao: 'B',
        }),
      ),
    );
    const byCode = page(
      await request(
        query('/contatos', {
          codigo: bound.input.customer.codigo,
          situacao: 'B',
        }),
      ),
    );
    if (
      byDocument.length !== 1 ||
      byDocument[0].id !== created.id ||
      byCode.length !== 1 ||
      byCode[0].id !== created.id
    )
      fail('CUSTOMER_LOOKUP_DIVERGENT');
    await append(journal, {
      event: 'api-reconciled',
      resource: 'customer',
      id: created.id,
    });
    return {
      task: 'OLIST-T02',
      state: 'diagnostic_customer_created_and_reconciled',
      gets,
      erpPostAttempts: posts,
      calls,
      identicalOriginalPayload: true,
      confirmedIdStoredPrivately: true,
      originalJournalPreserved: true,
      dependentPosts: 0,
      resumeOriginallyApprovedDependentsAllowed: true,
      f1GatePassed: false,
    };
  } catch (e) {
    return {
      task: 'OLIST-T02',
      state: 'diagnostic_stopped_preserve_reservations',
      code: /^[A-Z][A-Z_0-9]+$/.test(e?.message ?? '')
        ? e.message
        : 'DIAGNOSTIC_STOPPED',
      gets,
      erpPostAttempts: posts,
      calls,
      originalJournalPreserved: true,
      dependentPosts: 0,
      automaticRetry: false,
      f1GatePassed: false,
    };
  }
}

/** Explicitly approved omission of codigo, plus the five unchanged dependent POSTs. */
export function executeCorrectedBatch(bound, options = {}) {
  return executeBatch(bound, { ...options, correctedCustomer: true });
}

/** Resolve the GG response/parent identity discrepancy with GETs only. */
export async function reconcileCreatedGG(
  bound,
  {
    token,
    journalDirectory,
    fetcher = fetch,
    signal,
    pause = delay,
    onProgress = () => {},
  } = {},
) {
  const path = join(journalDirectory, 'CUSTOMER-CORRECTED01-FULL.jsonl');
  const events = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const created = (resource) =>
    events.find((e) => e.event === 'created' && e.resource === resource)?.id;
  const parentId = created('parent'),
    responseId = created('GG'),
    initial = events.find((e) => e.event === 'children-reconciled')?.ids;
  if (
    events[0]?.planHash !== bound.digest ||
    !positive(parentId) ||
    !positive(responseId) ||
    !positive(initial?.M) ||
    !positive(initial?.G) ||
    events.some((e) => e.event === 'reserved' && /^C0[234]$/.test(e.resource))
  )
    fail('GG_RECONCILIATION_STATE_NOT_ALLOWED');
  let gets = 0;
  const calls = [],
    allowed = new Set([
      '/info',
      '/produtos/' + parentId,
      '/produtos/' + responseId,
      '/produtos/' + initial.M,
      '/produtos/' + initial.G,
    ]);
  async function get(route) {
    if (!allowed.has(route) || ++gets > 8) fail('REQUEST_NOT_ALLOWED');
    if (gets > 1) await pause(2600, undefined, { signal });
    const r = await fetcher(API + route, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    calls.push({
      method: 'GET',
      path: route.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}'),
      status: r.status,
    });
    onProgress({ gets, posts: 0, last: calls.at(-1) });
    if (
      r.status !== 200 ||
      !r.headers.get('content-type')?.includes('application/json')
    )
      fail('GG_READ_FAILED');
    const reader = r.body.getReader(),
      chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        bytes += p.value.byteLength;
        if (bytes > 262144) {
          await reader.cancel();
          fail('BODY_TOO_LARGE');
        }
        chunks.push(p.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  try {
    if (!sameDoc((await get('/info')).cpfCnpj, bound.input.accountDocument))
      fail('ACCOUNT_MISMATCH');
    const parent = await get('/produtos/' + parentId);
    const actual = parentCheck(
      parent,
      bound.publicPlan.parent.payload,
      parentId,
      ['M', 'G', 'GG'],
    );
    const responseIdRelation =
      responseId === actual.GG
        ? 'canonical-child'
        : responseId === parentId
          ? 'parent'
          : 'other';
    const initialMStable = actual.M === initial.M,
      initialGStable = actual.G === initial.G;
    if (!initialMStable || !initialGStable)
      fail('INITIAL_VARIATION_IDS_CHANGED');
    for (const size of ['M', 'G', 'GG']) {
      allowed.add('/produtos/' + actual[size]);
      childCheck(
        await get('/produtos/' + actual[size]),
        actual[size],
        bound.publicPlan.parent.payload.sku + '-' + size,
        parentId,
      );
    }
    const lookup = query('/produtos', {
      codigo: bound.publicPlan.additionalVariation.payload.sku,
      situacao: 'A',
    });
    allowed.add(lookup);
    const found = page(await get(lookup)).filter(
      (x) => x.sku === bound.publicPlan.additionalVariation.payload.sku,
    );
    if (found.length !== 1 || found[0].id !== actual.GG)
      fail('GG_LOOKUP_DIVERGENT');
    if (responseIdRelation === 'other') fail('GG_RESPONSE_ID_UNEXPLAINED');
    await append(path, {
      event: 'gg-reconciled',
      canonicalId: actual.GG,
      responseId,
      parentId,
      ids: actual,
      responseIdRelation,
    });
    return {
      task: 'OLIST-T02',
      state: 'gg_reconciled_by_parent_and_exact_sku',
      gets,
      erpPostAttempts: 0,
      calls,
      initialMStable,
      initialGStable,
      responseIdRelation,
      canonicalChildParentAndSkuConfirmed: true,
      canonicalIdStoredPrivately: true,
      originalResponseIdPreserved: true,
      readyForOriginallyApprovedOrders: true,
      f1GatePassed: false,
    };
  } catch (e) {
    return {
      task: 'OLIST-T02',
      state: 'gg_reconciliation_stopped',
      code: /^[A-Z][A-Z_0-9]+$/.test(e?.message ?? '')
        ? e.message
        : 'GG_RECONCILIATION_STOPPED',
      gets,
      erpPostAttempts: 0,
      calls,
      automaticRetry: false,
      f1GatePassed: false,
    };
  }
}

/** Resume only the three originally approved orders after successful read-only GG reconciliation. */
export async function executeRemainingOrders(
  bound,
  {
    token,
    approvedDigest,
    journalDirectory,
    fetcher = fetch,
    signal,
    pause = delay,
    onProgress = () => {},
    onlyC04 = false,
  } = {},
) {
  if (approvedDigest !== bound.digest) fail('EXPLICIT_APPROVAL_REQUIRED');
  const sourceFile = join(journalDirectory, 'CUSTOMER-CORRECTED01-FULL.jsonl');
  const source = (await readFile(sourceFile, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const gg = source.find((e) => e.event === 'gg-reconciled'),
    customerId = source.find(
      (e) => e.event === 'created' && e.resource === 'customer',
    )?.id;
  const original = (
    await readFile(join(journalDirectory, BATCH_NAME + '.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  const originalHash = original.find(
    (e) => e.event === 'reserved' && e.resource === 'customer',
  )?.payloadHash;
  if (
    source[0]?.planHash !== bound.digest ||
    !gg ||
    !positive(customerId) ||
    !originalHash ||
    source.some((e) => e.event === 'reserved' && /^C0[234]$/.test(e.resource))
  )
    fail('ORDER_RESUME_STATE_NOT_ALLOWED');
  const priorOrderFile = join(journalDirectory, 'F1-ORDERS-20261104.jsonl');
  let c03Id = null;
  if (onlyC04) {
    const prior = (await readFile(priorOrderFile, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    c03Id = prior.find(
      (e) => e.event === 'created' && e.resource === 'C03',
    )?.id;
    if (
      prior[0]?.planHash !== bound.digest ||
      !positive(c03Id) ||
      !prior.some(
        (e) => e.event === 'api-reconciled' && e.resource === 'C02',
      ) ||
      prior.some((e) => e.resource === 'C04')
    )
      fail('LAST_PROBE_STATE_NOT_ALLOWED');
  }
  const journal = onlyC04
    ? join(journalDirectory, 'F1-C04-20261104.jsonl')
    : priorOrderFile;
  try {
    await readFile(journal);
    fail('ORDERS_ALREADY_RESERVED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const { input, publicPlan: plan } = bound,
    ids = gg.ids,
    parentId = gg.parentId;
  let gets = 0,
    posts = 0,
    last = 0,
    reserved = false;
  const calls = [],
    outcomes = [];
  const allowed = new Set([
    '/info',
    '/contatos/' + customerId,
    '/produtos/' + parentId,
    '/produtos/' + ids.M,
    '/produtos/' + ids.G,
    '/produtos/' + input.existingM.id,
  ]);
  function refPath(ref) {
    const p = query('/pedidos', { numeroPedidoEcommerce: ref });
    allowed.add(p);
    return p;
  }
  async function request(path, method = 'GET', payload, serializedBody) {
    if (method === 'GET') {
      if (!allowed.has(path) || ++gets > (onlyC04 ? 6 : 20))
        fail('REQUEST_NOT_ALLOWED');
    } else if (
      method !== 'POST' ||
      path !== '/pedidos' ||
      !reserved ||
      ++posts > (onlyC04 ? 1 : 3)
    )
      fail('REQUEST_NOT_ALLOWED');
    if (last)
      await pause(Math.max(0, 2600 - (Date.now() - last)), undefined, {
        signal,
      });
    last = Date.now();
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
        ...(method === 'POST'
          ? { body: serializedBody ?? JSON.stringify(payload) }
          : {}),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      fail('HTTP_OUTCOME_UNKNOWN');
    }
    calls.push({
      method,
      path: path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}'),
      status: response.status,
    });
    onProgress({ gets, posts, last: calls.at(-1) });
    const reader = response.body?.getReader();
    if (!reader) fail('INVALID_RESPONSE');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 262144) {
          await reader.cancel();
          fail('BODY_TOO_LARGE');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let parsed;
    try {
      parsed = parseWithLexemes(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('INVALID_RESPONSE');
    }
    if (response.status < 200 || response.status >= 300) {
      const roots = new Set([
        'idContato',
        'data',
        'itens',
        'ecommerce',
        'situacao',
        'valorUnitario',
        'quantidade',
      ]);
      const details = Array.isArray(parsed.body?.detalhes)
        ? parsed.body.detalhes
        : [];
      calls.at(-1).validationFields = [
        ...new Set(
          details.map((d) =>
            typeof d?.campo === 'string' &&
            d.campo.length < 80 &&
            /^[A-Za-z0-9_.[\]]+$/.test(d.campo) &&
            roots.has(d.campo.split(/[.[]/)[0])
              ? d.campo
              : 'other',
          ),
        ),
      ];
      calls.at(-1).validationCategories = [
        ...new Set(
          details.map((d) =>
            /OBRIGAT/.test(canonical(d?.mensagem))
              ? 'required'
              : /TAMANHO|LIMITE|CARACT/.test(canonical(d?.mensagem))
                ? 'length-or-limit'
                : /INV.LID|VALID/.test(canonical(d?.mensagem))
                  ? 'invalid'
                  : 'unspecified',
          ),
        ),
      ];
      fail('HTTP_' + response.status);
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      fail('INVALID_RESPONSE');
    return parsed;
  }
  const get = async (p) => (await request(p)).body;
  try {
    if (!sameDoc((await get('/info')).cpfCnpj, input.accountDocument))
      fail('ACCOUNT_MISMATCH');
    let oldM;
    if (onlyC04) {
      allowed.add('/pedidos/' + c03Id);
      const actual = await request('/pedidos/' + c03Id),
        c03 = plan.orders.find((o) => o.reference.endsWith('C03'));
      const expected = orderPayload(
        c03,
        customerId,
        ids,
        input.existingM.id,
        input.originIntegratorIdCandidate,
        input.date,
      );
      orderCheck(
        actual.body,
        actual.numeric,
        expected,
        c03Id,
        input.customer.cpfCnpj,
        c03.items,
      );
      outcomes.push({
        resource: 'C03-read-only-diagnostic',
        totalProductsLexeme: actual.numeric?.valorTotalProdutos?.lexeme ?? null,
        totalOrderLexeme: actual.numeric?.valorTotalPedido?.lexeme ?? null,
        independentUiTotalCents: 110,
        productTotalProjectionMatchesUi: actual.body.valorTotalProdutos === 1.1,
      });
      if (actual.body.valorTotalPedido !== 1.1)
        fail('C03_DIAGNOSTIC_MONEY_DIVERGENT');
      const found = page(await get(refPath(c03.reference)));
      if (found.length !== 1 || found[0].id !== c03Id)
        fail('ORDER_REFERENCE_LOOKUP_DIVERGENT');
      const c04 = plan.orders.find((o) => o.reference.endsWith('C04'));
      if (page(await get(refPath(c04.reference))).length)
        fail('TEST_REFERENCE_EXISTS');
      await append(priorOrderFile, {
        event: 'api-reconciled-diagnostic',
        resource: 'C03',
        id: c03Id,
        matchedBy: 'predeclared-cent-hypothesis-and-independent-native-UI',
        unitReadbackPreservesPrecision: false,
      });
    } else {
      const customer = await get('/contatos/' + customerId);
      customerCheck(customer, input.customer, customerId, false);
      if (
        customer.situacao !== 'B' ||
        Number(customer.regimeTributario) !== input.customer.regimeTributario ||
        customer.tipos?.length !== 1 ||
        hash(
          JSON.stringify({ ...input.customer, tipos: [customer.tipos[0].id] }),
        ) !== originalHash
      )
        fail('CUSTOMER_FISCAL_OR_TYPE_DIVERGENT');
      const current = parentCheck(
        await get('/produtos/' + parentId),
        plan.parent.payload,
        parentId,
        ['M', 'G', 'GG'],
      );
      if (Object.keys(current).some((k) => current[k] !== ids[k]))
        fail('VARIATION_LINK_CHANGED');
      for (const size of ['M', 'G'])
        childCheck(
          await get('/produtos/' + ids[size]),
          ids[size],
          plan.parent.payload.sku + '-' + size,
          parentId,
        );
      oldM = await get('/produtos/' + input.existingM.id);
      if (
        oldM.id !== input.existingM.id ||
        oldM.sku !== input.existingM.sku ||
        oldM.produtoPai?.id !== input.existingParentId ||
        oldM.situacao !== 'A' ||
        oldM.precos?.preco !== 34.9
      )
        fail('SOURCE_PRODUCT_CHANGED');
      for (const order of plan.orders)
        if (page(await get(refPath(order.reference))).length)
          fail('TEST_REFERENCE_EXISTS');
    }
    await append(
      journal,
      {
        event: 'orders-reserved',
        planHash: bound.digest,
        source: 'GG reconciled without repeated creation',
        previousAuthenticatedGets: onlyC04 ? 114 : 100,
        maximumTotalAuthenticatedGets: 120,
        previousPostAttempts: onlyC04 ? 7 : 5,
        maximumTotalPostAttempts: 8,
      },
      true,
    );
    reserved = true;
    let total = onlyC04 ? 4.1 : 0;
    for (const order of onlyC04
      ? plan.orders.filter((o) => o.reference.endsWith('C04'))
      : plan.orders) {
      const label = order.reference.slice(-3),
        payload = orderPayload(
          order,
          customerId,
          ids,
          input.existingM.id,
          input.originIntegratorIdCandidate,
          input.date,
        );
      const serializedBody = serializeApprovedOrder(payload, order);
      await append(journal, {
        event: 'reserved',
        resource: label,
        payloadHash: hash(serializedBody),
      });
      const created = (
        await request('/pedidos', 'POST', payload, serializedBody)
      ).body;
      if (!positive(created?.id)) fail('CREATED_ID_MISSING');
      await append(journal, {
        event: 'created',
        resource: label,
        id: created.id,
      });
      allowed.add('/pedidos/' + created.id);
      const response = await request('/pedidos/' + created.id);
      const observed = {
        resource: label,
        created: true,
        referencePresent: Boolean(
          response.body?.ecommerce?.numeroPedidoEcommerce,
        ),
        originIdState:
          response.body?.ecommerce?.id === input.originIntegratorIdCandidate
            ? 'expected'
            : response.body?.ecommerce?.id === 0
              ? 'zero'
              : 'other',
        observedMoney: {
          totalOrderLexeme: response.numeric?.valorTotalPedido?.lexeme ?? null,
          lines: (response.body?.itens ?? []).map((x, i) => ({
            resource:
              x.produto?.id === ids.M
                ? 'new-M'
                : x.produto?.id === ids.G
                  ? 'new-G'
                  : x.produto?.id === input.existingM.id
                    ? 'existing-M'
                    : 'unexpected',
            quantity: x.quantidade,
            unitLexeme:
              response.numeric?.itens?.[i]?.valorUnitario?.lexeme ?? null,
          })),
        },
      };
      outcomes.push(observed);
      const proof = orderCheck(
        response.body,
        response.numeric,
        payload,
        created.id,
        input.customer.cpfCnpj,
      );
      total += response.body.valorTotalPedido;
      if (total > 10) fail('BATCH_BUDGET_DIVERGENT');
      const found = page(await get(refPath(order.reference)));
      if (found.length !== 1 || found[0].id !== created.id)
        fail('ORDER_REFERENCE_LOOKUP_DIVERGENT');
      await append(journal, {
        event: 'api-reconciled',
        resource: label,
        id: created.id,
      });
      Object.assign(observed, { referenceLookupConfirmed: true, ...proof });
    }
    if (!onlyC04) {
      const after = await get('/produtos/' + input.existingM.id);
      if (after.sku !== oldM.sku || after.precos?.preco !== oldM.precos.preco)
        fail('EXISTING_CATALOG_CHANGED');
    }
    return {
      task: 'OLIST-T02',
      state: 'approved_orders_completed_ui_proof_required',
      gets,
      erpPostAttempts: posts,
      calls,
      outcomes,
      previousAuthenticatedGets: onlyC04 ? 114 : 100,
      previousPostAttempts: onlyC04 ? 7 : 5,
      automaticRetry: false,
      f1GatePassed: false,
    };
  } catch (e) {
    return {
      task: 'OLIST-T02',
      state: 'order_proof_stopped_preserve_ids',
      code: /^[A-Z][A-Z_0-9]+$/.test(e?.message ?? '')
        ? e.message
        : 'ORDER_PROOF_STOPPED',
      gets,
      erpPostAttempts: posts,
      calls,
      outcomes,
      previousAuthenticatedGets: onlyC04 ? 114 : 100,
      previousPostAttempts: onlyC04 ? 7 : 5,
      automaticRetry: false,
      f1GatePassed: false,
    };
  }
}

/** Preserve the approved numeric literals, including 0.000010, without float formatting loss. */
export function serializeApprovedOrder(payload, order) {
  let i = 0;
  const text = JSON.stringify(payload).replace(
    /"valorUnitario":-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g,
    () => {
      const literal = order.items[i++]?.unitLexeme;
      if (
        typeof literal !== 'string' ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(literal)
      )
        fail('INVALID_APPROVED_DECIMAL');
      return '"valorUnitario":' + literal;
    },
  );
  if (
    i !== order.items.length ||
    JSON.stringify(JSON.parse(text)) !== JSON.stringify(payload)
  )
    fail('APPROVED_DECIMAL_MISMATCH');
  return text;
}

/** Original C04 only, after C03 is reconciled against the independent native UI proof. */
export function executeLastScaleProbe(bound, options = {}) {
  return executeRemainingOrders(bound, { ...options, onlyC04: true });
}
