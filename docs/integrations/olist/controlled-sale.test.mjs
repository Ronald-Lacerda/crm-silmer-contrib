import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildC01,
  c01Digest,
  executeC01,
  reconcileC01,
  C01_REFERENCE,
} from './controlled-sale.mjs';

// Synthetic identities only, deliberately not a real fiscal account.
// These responses test the tool guards; no remote network or real credentials.
const input = () => ({
  accountDocument: '00000000000000',
  buyer: { id: 101, document: '11111111111111' },
  parentId: 201,
  m: { id: 202, sku: 'synthetic-M' },
  g: { id: 203, sku: 'synthetic-G' },
  date: '2026-11-04',
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const page = (itens) => ({
  itens,
  paginacao: { offset: 0, limit: 100, total: itens.length },
});
const buyer = () => ({
  id: 101,
  cpfCnpj: '11111111111111',
  tipoPessoa: 'J',
  situacao: 'B',
  nome: 'Synthetic buyer',
  inscricaoEstadual: 'synthetic IE',
  endereco: {
    endereco: 'Synthetic street',
    numero: '1',
    bairro: 'Synthetic district',
    municipio: 'Synthetic city',
    uf: 'ES',
    cep: '00000000',
  },
});
const parent = () => ({
  id: 201,
  tipo: 'V',
  situacao: 'A',
  ncm: '00000000',
  origem: 0,
  unidade: 'UN',
  variacoes: [
    { id: 202, sku: 'synthetic-M', grade: [{ chave: 'Tamanho', valor: 'M' }] },
    { id: 203, sku: 'synthetic-G', grade: [{ chave: 'Tamanho', valor: 'G' }] },
  ],
});
const detail = (id, sku) => ({
  id,
  sku,
  situacao: 'A',
  produtoPai: { id: 201 },
});
const sale = () => ({
  id: 301,
  data: '2026-11-04',
  situacao: 0,
  cliente: { id: 101, cpfCnpj: '11111111111111' },
  ecommerce: { id: null, numeroPedidoEcommerce: C01_REFERENCE },
  itens: buildC01(input()).payload.itens,
  valorTotalProdutos: 3,
  valorTotalPedido: 3,
});
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'olist-c01-'));
  t.after(async () => {
    // Only the fixed synthetic file in the directory returned by mkdtemp.
    await unlink(join(directory, C01_REFERENCE + '.jsonl')).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await rmdir(directory);
  });
  return directory;
}
function fixture(override = () => undefined) {
  const calls = [];
  let created = false,
    posts = 0;
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace('/public-api/v3', '');
    const query = new URL(url).searchParams;
    calls.push({ path, method: options.method });
    const custom = await override({ path, query, options, created, posts });
    if (custom !== undefined) return custom;
    assert.equal(options.redirect, 'error');
    assert.match(url, /^https:\/\/api\.tiny\.com\.br\/public-api\/v3\//u);
    if (options.method === 'POST') {
      assert.equal(path, '/pedidos');
      assert.deepEqual(JSON.parse(options.body), buildC01(input()).payload);
      posts++;
      created = true;
      return json({ id: 301, numeroPedido: 'synthetic' });
    }
    assert.equal(options.method, 'GET');
    if (path === '/info') return json({ cpfCnpj: '00000000000000' });
    if (path === '/contatos') return json(page([buyer()]));
    if (path === '/contatos/101') return json(buyer());
    if (path === '/produtos/201') return json(parent());
    if (path === '/produtos') {
      const sku = query.get('codigo');
      assert.ok(['synthetic-M', 'synthetic-G'].includes(sku));
      return json(page([{ id: sku === 'synthetic-M' ? 202 : 203, sku }]));
    }
    if (path === '/produtos/202') return json(detail(202, 'synthetic-M'));
    if (path === '/produtos/203') return json(detail(203, 'synthetic-G'));
    if (path === '/pedidos') return json(page(created ? [sale()] : []));
    if (path === '/pedidos/301') return json(sale());
    throw new Error('Unplanned request');
  };
  return { fetcher, calls };
}
function options(directory, fetcher, extra = {}) {
  return {
    token: 'synthetic-token',
    approvedPlanDigest: c01Digest(input()),
    journalDirectory: directory,
    fetcher,
    ...extra,
  };
}

test('C01 payload fixes two exact lines and omits all downstream commands', () => {
  assert.deepEqual(buildC01(input()).payload, {
    idContato: 101,
    data: '2026-11-04',
    situacao: 0,
    ecommerce: { numeroPedidoEcommerce: C01_REFERENCE },
    itens: [
      { produto: { id: 202 }, quantidade: 1, valorUnitario: 1 },
      { produto: { id: 203 }, quantidade: 1, valorUnitario: 2 },
    ],
  });
  for (const change of [
    (p) => (p.payload = { itens: [] }),
    (p) => (p.m.id = p.g.id),
    (p) => (p.parentId = p.m.id),
    (p) => (p.date = '2026-02-30'),
    (p) => (p.buyer.id = '101'),
    (p) => (p.m.sku = p.g.sku),
    (p) => (p.buyer.document = '11111111111'),
  ]) {
    const p = input();
    change(p);
    assert.throws(() => buildC01(p), /INVALID_PLAN/u);
  }
});
test('digest binds fiscal identities, selections and frozen date', () => {
  const digest = c01Digest(input());
  for (const change of [
    (p) => (p.buyer.id = 102),
    (p) => (p.buyer.document = '22222222222222'),
    (p) => (p.accountDocument = '33333333333333'),
    (p) => (p.date = '2026-11-05'),
    (p) => (p.m.sku = 'other-synthetic'),
    (p) => (p.parentId = 204),
  ]) {
    const p = input();
    change(p);
    assert.notEqual(c01Digest(p), digest);
  }
});
test('missing or wrong approval digest prevents any network', async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  for (const approvedPlanDigest of [undefined, 'wrong']) {
    await assert.rejects(
      executeC01(
        input(),
        options(
          directory,
          async () => {
            calls++;
          },
          {
            approvedPlanDigest,
          },
        ),
      ),
      /EXPLICIT_APPROVAL_REQUIRED/u,
    );
  }
  assert.equal(calls, 0);
});
test('successful flow reserves and syncs before its sole POST, journals ID before readback', async (t) => {
  const directory = await temporary(t),
    journal = join(directory, C01_REFERENCE + '.jsonl');
  const f = fixture(async ({ path, options }) => {
    if (options.method === 'POST') {
      const saved = (await readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(saved[0].phase, 'reserved');
      assert.equal(
        saved.some((x) => x.phase === 'created'),
        false,
      );
    }
    if (path === '/pedidos/301') {
      const saved = await readFile(journal, 'utf8');
      assert.match(saved, /"phase":"created","id":301/u);
    }
  });
  const result = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(result.state, 'api_readback_matched');
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(result.getCount, 11);
  assert.equal(result.uiLineProofRequired, true);
  assert.equal(result.f1GatePassed, false);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  const publicText = JSON.stringify(result);
  for (const privateValue of [
    'synthetic-token',
    '11111111111111',
    '/101',
    '/202',
    '/301',
  ])
    assert.equal(publicText.includes(privateValue), false);
});
test('account mismatch stops after /info without reserving', async (t) => {
  const directory = await temporary(t);
  const f = fixture(({ path }) =>
    path === '/info' ? json({ cpfCnpj: '22222222222222' }) : undefined,
  );
  const r = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(r.code, 'ACCOUNT_MISMATCH');
  assert.equal(r.erpPostAttempts, 0);
  assert.equal(f.calls.length, 1);
});
test('ambiguous, truncated, missing or inexact contact lookup never permits POST', async (t) => {
  const directory = await temporary(t);
  for (const body of [
    page([]),
    page([buyer(), buyer()]),
    page([{ ...buyer(), id: 102 }]),
    { itens: [buyer()], paginacao: { offset: 0, limit: 100, total: 2 } },
    { itens: [buyer()] },
  ]) {
    const f = fixture(({ path }) =>
      path === '/contatos' ? json(body) : undefined,
    );
    assert.equal(
      (await executeC01(input(), options(directory, f.fetcher)))
        .erpPostAttempts,
      0,
    );
  }
});
test('incomplete fiscal/address buyer is not silently repaired', async (t) => {
  const directory = await temporary(t);
  for (const body of [
    { ...buyer(), inscricaoEstadual: null },
    { ...buyer(), endereco: {} },
    { ...buyer(), cpfCnpj: '22222222222222' },
    { ...buyer(), situacao: 'I' },
  ]) {
    const f = fixture(({ path }) =>
      path === '/contatos/101' ? json(body) : undefined,
    );
    const r = await executeC01(input(), options(directory, f.fetcher));
    assert.equal(r.code, 'BUYER_NOT_CONFIRMED');
    assert.equal(r.erpPostAttempts, 0);
  }
});
test('SKU, parent, size and fiscal source mismatches block before creation', async (t) => {
  const directory = await temporary(t);
  const badParent = parent();
  badParent.variacoes[0].grade[0].valor = 'G';
  for (const [target, body] of [
    ['/produtos/201', badParent],
    [
      '/produtos/202',
      { ...detail(202, 'synthetic-M'), produtoPai: { id: 999 } },
    ],
    ['/produtos/201', { ...parent(), ncm: null }],
    ['/produtos', page([{ id: 202, sku: 'wrong' }])],
  ]) {
    const f = fixture(({ path }) => (path === target ? json(body) : undefined));
    const r = await executeC01(input(), options(directory, f.fetcher));
    assert.equal(r.erpPostAttempts, 0);
  }
});
test('reference present or filter ignoring reference prevents inclusion', async (t) => {
  const directory = await temporary(t);
  const f = fixture(({ path }) =>
    path === '/pedidos' ? json(page([{ id: 999 }])) : undefined,
  );
  const r = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(r.code, 'REFERENCE_ALREADY_PRESENT');
  assert.equal(r.erpPostAttempts, 0);
});
test('network failure during POST remains uncertain; durable marker prevents another POST', async (t) => {
  const directory = await temporary(t);
  let posts = 0;
  const f = fixture(({ options }) => {
    if (options.method === 'POST') {
      posts++;
      throw new Error('synthetic-private-provider-error');
    }
  });
  const first = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(first.state, 'outcome_unknown');
  assert.equal(first.code, 'HTTP_OUTCOME_UNKNOWN');
  const second = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(second.code, 'RESERVATION_UNAVAILABLE');
  assert.equal(second.erpPostAttempts, 0);
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(first).includes('private-provider'), false);
});
test('HTTP failure, invalid JSON or success without ID never triggers a second inclusion', async (t) => {
  for (const reply of [
    () => json({ message: 'synthetic-private-provider-error' }, 503),
    () =>
      new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    () => json({ numeroPedido: 'missing-id' }),
  ]) {
    const directory = await temporary(t);
    let posts = 0;
    const f = fixture(({ options }) => {
      if (options.method === 'POST') {
        posts++;
        return reply();
      }
    });
    const r = await executeC01(input(), options(directory, f.fetcher));
    assert.equal(r.state, 'outcome_unknown');
    assert.equal(r.erpPostAttempts, 1);
    assert.equal(r.automaticRetry, false);
    assert.equal(JSON.stringify(r).includes('private-provider'), false);
    await executeC01(input(), options(directory, f.fetcher));
    assert.equal(posts, 1);
  }
});
test('equal global total with swapped line units requires reconciliation', async (t) => {
  const directory = await temporary(t),
    body = sale();
  body.itens[0].valorUnitario = 2;
  body.itens[1].valorUnitario = 1;
  const f = fixture(({ path }) =>
    path === '/pedidos/301' ? json(body) : undefined,
  );
  const r = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(r.state, 'created_requires_reconciliation');
  assert.equal(r.code, 'READBACK_DIVERGENT');
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
});
test('fiscal, installments, marketplace, status or total surprises never cause cleanup mutations', async (t) => {
  for (const change of [
    (b) => (b.idNotaFiscal = 901),
    (b) => (b.pagamento = { parcelas: [{ valor: 3 }] }),
    (b) => (b.ecommerce.id = 901),
    (b) => (b.situacao = 3),
    (b) => (b.valorTotalPedido = 3.01),
    (b) => b.itens.push(b.itens[0]),
  ]) {
    const directory = await temporary(t),
      body = sale();
    change(body);
    const f = fixture(({ path }) =>
      path === '/pedidos/301' ? json(body) : undefined,
    );
    const r = await executeC01(input(), options(directory, f.fetcher));
    assert.equal(r.state, 'created_requires_reconciliation');
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 1);
  }
});
test('readback HTTP failure retains durable created ID and never reissues POST', async (t) => {
  const directory = await temporary(t);
  const f = fixture(({ path }) =>
    path === '/pedidos/301' ? json({ private: 'synthetic' }, 500) : undefined,
  );
  const r = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(r.state, 'created_requires_reconciliation');
  assert.equal(r.code, 'HTTP_500');
  assert.match(
    await readFile(join(directory, C01_REFERENCE + '.jsonl'), 'utf8'),
    /"phase":"created","id":301/u,
  );
});
test('quota and expired session stop before any inclusion', async (t) => {
  const directory = await temporary(t);
  const f = fixture(({ path }) =>
    path === '/info'
      ? json({ cpfCnpj: '00000000000000' }, 200, {
          'x-ratelimit-remaining': '1',
        })
      : undefined,
  );
  assert.equal(
    (await executeC01(input(), options(directory, f.fetcher))).code,
    'QUOTA_LOW',
  );
  const controller = new AbortController();
  controller.abort();
  const r = await executeC01(
    input(),
    options(directory, f.fetcher, { signal: controller.signal }),
  );
  assert.equal(r.code, 'PROBE_STOPPED');
  assert.equal(r.getCount, 0);
  assert.equal(r.erpPostAttempts, 0);
});
test('concurrent executions share the same exclusive reservation', async (t) => {
  const directory = await temporary(t),
    f = fixture();
  const results = await Promise.all([
    executeC01(input(), options(directory, f.fetcher)),
    executeC01(input(), options(directory, f.fetcher)),
  ]);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(
    results.filter((r) => r.state === 'api_readback_matched').length,
    1,
  );
});
test('lookup and returned schemas used by C01 exist in official snapshot', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('./evidence/openapi-v3.projection.json', import.meta.url),
      'utf8',
    ),
  );
  for (const path of [
    '/info',
    '/contatos',
    '/contatos/{idContato}',
    '/produtos',
    '/produtos/{idProduto}',
    '/pedidos',
    '/pedidos/{idPedido}',
  ]) {
    // /info is in the separate read-only query schema projection.
    if (path === '/info') continue;
    assert.ok(schema.paths[path]?.get, path);
  }
  assert.ok(schema.paths['/pedidos']?.post);
  const projection = JSON.stringify(
    schema.components.schemas.ItemPedidoResponseModel,
  );
  assert.equal(projection.includes('valorUnitario'), true);
  assert.equal(projection.includes('subtotal'), false);
});

test('oversized or non-JSON provider responses stop without exposing raw content', async (t) => {
  for (const post of [false, true]) {
    const directory = await temporary(t);
    const f = fixture(({ path, options }) => {
      if ((post && options.method === 'POST') || (!post && path === '/info'))
        return json({ private: 'x'.repeat(131073) });
    });
    const r = await executeC01(input(), options(directory, f.fetcher));
    assert.equal(r.code, 'BODY_TOO_LARGE');
    assert.equal(r.state, post ? 'outcome_unknown' : 'blocked_before_write');
    assert.equal(r.erpPostAttempts, post ? 1 : 0);
    assert.equal(JSON.stringify(r).includes('xxxx'), false);
  }
  const directory = await temporary(t);
  const f = fixture(({ path }) =>
    path === '/info'
      ? new Response('synthetic-private-html', {
          headers: { 'content-type': 'text/html' },
        })
      : undefined,
  );
  const r = await executeC01(input(), options(directory, f.fetcher));
  assert.equal(r.code, 'INVALID_RESPONSE');
  assert.equal(r.erpPostAttempts, 0);
  assert.equal(JSON.stringify(r).includes('private-html'), false);
});
test('caller mutation during preflight cannot change the approved payload', async (t) => {
  const directory = await temporary(t),
    p = input(),
    digest = c01Digest(p);
  const f = fixture(({ path }) => {
    if (path === '/info') {
      p.buyer.id = 999;
      p.m.id = 998;
      p.date = '2026-11-05';
    }
  });
  const r = await executeC01(
    p,
    options(directory, f.fetcher, { approvedPlanDigest: digest }),
  );
  assert.equal(r.state, 'api_readback_matched');
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
});

test('preflight reuses an existing active A buyer without creating or granting account access', async (t) => {
  const directory = await temporary(t),
    active = { ...buyer(), situacao: 'A' };
  const f = fixture(({ path, query }) => {
    if (path === '/contatos/101') return json(active);
    if (path === '/contatos') {
      assert.equal(query.get('situacao'), 'A');
      return json(page([active]));
    }
  });
  const r = await executeC01(
    input(),
    options(directory, f.fetcher, {
      prepareOnly: true,
      approvedPlanDigest: undefined,
    }),
  );
  assert.equal(r.state, 'ready_for_approval');
  assert.equal(r.erpPostAttempts, 0);
  assert.equal(r.getCount, 9);
  assert.equal(
    f.calls.every((c) => c.method === 'GET'),
    true,
  );
  await assert.rejects(readFile(join(directory, C01_REFERENCE + '.jsonl')), {
    code: 'ENOENT',
  });
});
test('one bounded formatted-document read is permitted only after normalized lookup returns zero', async (t) => {
  const directory = await temporary(t),
    seen = [];
  const f = fixture(({ path, query }) => {
    if (path === '/contatos') {
      seen.push(query.get('cpfCnpj'));
      assert.equal(query.get('situacao'), 'B');
      return json(
        page(query.get('cpfCnpj') === '11111111111111' ? [] : [buyer()]),
      );
    }
  });
  const r = await executeC01(
    input(),
    options(directory, f.fetcher, {
      prepareOnly: true,
      approvedPlanDigest: undefined,
    }),
  );
  assert.equal(r.state, 'ready_for_approval');
  assert.equal(r.getCount, 10);
  assert.deepEqual(seen, ['11111111111111', '11.111.111/1111-11']);
  assert.equal(r.erpPostAttempts, 0);
  assert.equal(
    f.calls.every((c) => c.method === 'GET'),
    true,
  );
});

test('reconciliation reads only the journaled order and identifies a missing reference without another POST', async (t) => {
  const directory = await temporary(t),
    original = fixture();
  await executeC01(input(), options(directory, original.fetcher));
  const body = sale();
  body.ecommerce = null;
  const readOnly = fixture(({ path }) =>
    path === '/pedidos/301' ? json(body) : undefined,
  );
  const r = await reconcileC01(input(), {
    token: 'synthetic',
    journalDirectory: directory,
    fetcher: readOnly.fetcher,
  });
  assert.equal(r.state, 'read_only_reconciled');
  assert.equal(r.getCount, 2);
  assert.deepEqual(r.failedChecks, ['reference']);
  assert.equal(r.checks.lineValues, true);
  assert.equal(r.checks.orderTotal, true);
  assert.equal(r.erpPostAttempts, 0);
  assert.equal(
    readOnly.calls.every((c) => c.method === 'GET'),
    true,
  );
  for (const value of ['11111111111111', '/301', '/101'])
    assert.equal(JSON.stringify(r).includes(value), false);
});
test('reconciliation verifies the account before reading the order', async (t) => {
  const directory = await temporary(t),
    original = fixture();
  await executeC01(input(), options(directory, original.fetcher));
  const readOnly = fixture(({ path }) =>
    path === '/info' ? json({ cpfCnpj: '22222222222222' }) : undefined,
  );
  const r = await reconcileC01(input(), {
    token: 'synthetic',
    journalDirectory: directory,
    fetcher: readOnly.fetcher,
  });
  assert.equal(r.code, 'ACCOUNT_MISMATCH');
  assert.equal(r.getCount, 1);
  assert.equal(
    readOnly.calls.every((c) => c.method === 'GET'),
    true,
  );
});
test('unknown ID or a changed case never causes reconciliation to create or infer an order', async (t) => {
  const directory = await temporary(t),
    uncertain = fixture(({ options }) => {
      if (options.method === 'POST') throw new Error('synthetic');
    });
  await executeC01(input(), options(directory, uncertain.fetcher));
  let calls = 0;
  const r = await reconcileC01(input(), {
    token: 'synthetic',
    journalDirectory: directory,
    fetcher: async () => {
      calls++;
    },
  });
  assert.equal(r.code, 'NO_CONFIRMED_ORDER_ID');
  assert.equal(calls, 0);
  const changed = input();
  changed.buyer.id = 102;
  const other = await reconcileC01(changed, {
    token: 'synthetic',
    journalDirectory: directory,
    fetcher: async () => {
      calls++;
    },
  });
  assert.equal(other.code, 'CASE_JOURNAL_MISMATCH');
  assert.equal(calls, 0);
});
