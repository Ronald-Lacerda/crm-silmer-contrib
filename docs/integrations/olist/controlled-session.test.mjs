import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicEncrypt, constants, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startC01Session } from './controlled-session.mjs';
import { buildC01, c01Digest, C01_REFERENCE } from './controlled-sale.mjs';

const input = () => ({
  accountDocument: '00000000000000',
  buyer: { id: 101, document: '11111111111111' },
  parentId: 201,
  m: { id: 202, sku: 'synthetic-M' },
  g: { id: 203, sku: 'synthetic-G' },
  date: '2026-11-04',
});
const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const page = (itens) => ({
  itens,
  paginacao: { offset: 0, limit: 100, total: itens.length },
});
function remote() {
  let created = false;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ method: options.method, path: new URL(url).pathname });
    if (url.includes('/protocol/openid-connect/token'))
      return json({ access_token: 'synthetic-private-token' });
    const path = new URL(url).pathname.replace('/public-api/v3', '');
    if (options.method === 'POST') {
      assert.equal(path, '/pedidos');
      assert.deepEqual(JSON.parse(options.body), buildC01(input()).payload);
      created = true;
      return json({ id: 301 });
    }
    const buyer = {
      id: 101,
      cpfCnpj: '11111111111111',
      tipoPessoa: 'J',
      situacao: 'B',
      nome: 'synthetic',
      inscricaoEstadual: 'synthetic',
      endereco: {
        endereco: 'synthetic',
        numero: '1',
        bairro: 'synthetic',
        municipio: 'synthetic',
        uf: 'ES',
        cep: '00000000',
      },
    };
    const sale = {
      id: 301,
      situacao: 0,
      data: '2026-11-04',
      cliente: buyer,
      ecommerce: { numeroPedidoEcommerce: C01_REFERENCE },
      itens: buildC01(input()).payload.itens,
      valorTotalPedido: 3,
      valorTotalProdutos: 3,
    };
    if (path === '/info') return json({ cpfCnpj: '00000000000000' });
    if (path === '/contatos') return json(page([buyer]));
    if (path === '/contatos/101') return json(buyer);
    if (path === '/produtos/201')
      return json({
        id: 201,
        tipo: 'V',
        situacao: 'A',
        ncm: '00000000',
        unidade: 'UN',
        origem: 0,
        variacoes: [
          {
            id: 202,
            sku: 'synthetic-M',
            grade: [{ chave: 'Tamanho', valor: 'M' }],
          },
          {
            id: 203,
            sku: 'synthetic-G',
            grade: [{ chave: 'Tamanho', valor: 'G' }],
          },
        ],
      });
    if (path === '/produtos') {
      const sku = new URL(url).searchParams.get('codigo');
      return json(page([{ id: sku === 'synthetic-M' ? 202 : 203, sku }]));
    }
    if (path === '/produtos/202')
      return json({
        id: 202,
        sku: 'synthetic-M',
        situacao: 'A',
        produtoPai: { id: 201 },
      });
    if (path === '/produtos/203')
      return json({
        id: 203,
        sku: 'synthetic-G',
        situacao: 'A',
        produtoPai: { id: 201 },
      });
    if (path === '/pedidos') return json(page(created ? [sale] : []));
    if (path === '/pedidos/301') return json(sale);
    throw new Error('Unplanned request');
  };
  return { fetcher, calls };
}
async function session(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'olist-c01-session-'));
  const run = await startC01Session(root, options);
  t.after(async () => {
    run.close();
    for (const name of [
      'public-key.pem',
      'credentials.enc',
      'case.enc',
      'result.json',
    ])
      await unlink(join(run.directory, name)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    await unlink(join(root, 'controlled', C01_REFERENCE + '.jsonl')).catch(
      (e) => {
        if (e.code !== 'ENOENT') throw e;
      },
    );
    await rmdir(join(root, 'controlled')).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await rmdir(run.directory);
    await rmdir(root);
  });
  return { ...run, privateRoot: root };
}
async function importEnvelopes(run, selection = input()) {
  const publicKey = await readFile(join(run.directory, 'public-key.pem'));
  for (const [name, value] of [
    [
      'credentials.enc',
      {
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-private-secret',
        expectedDocument: '00000000000000',
      },
    ],
    ['case.enc', selection],
  ]) {
    const clear = Buffer.from(JSON.stringify(value));
    const box = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      clear,
    );
    clear.fill(0);
    await writeFile(join(run.directory, name), box, { flag: 'wx' });
  }
}
async function waitPage(predicate) {
  let page = '';
  for (let i = 0; i < 100; i++) {
    page = await (await fetch('http://127.0.0.1:8765/')).text();
    if (predicate(page)) return page;
    await delay(25);
  }
  assert.fail('Expected local session state was not reached');
}
async function authorize() {
  const page = await waitPage((p) => p.includes('Conectar Olist'));
  const href = page.match(/href="([^"]+)"/u)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const url =
    'http://127.0.0.1:8765/olist/callback?state=' +
    state +
    '&code=synthetic-code';
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  return url;
}
test('session rejects unknown mode or create without review digest before listening', async () => {
  await assert.rejects(
    startC01Session(undefined, { mode: 'other' }),
    /EXPLICIT_APPROVAL_REQUIRED/u,
  );
  await assert.rejects(
    startC01Session(undefined, { mode: 'create' }),
    /EXPLICIT_APPROVAL_REQUIRED/u,
  );
});
test('default OAuth session performs nine GETs and no business POST, then discards inputs', async (t) => {
  const mock = remote(),
    run = await session(t, { fetcher: mock.fetcher });
  await importEnvelopes(run);
  const url = await authorize();
  const page = await waitPage((p) => p.includes('ready_for_approval'));
  const result = JSON.parse(
    await readFile(join(run.directory, 'result.json'), 'utf8'),
  );
  assert.equal(result.erpPostAttempts, 0);
  assert.equal(result.getCount, 9);
  assert.equal(result.planDigest, c01Digest(input()));
  assert.equal(result.f1GatePassed, false);
  assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 1); // OAuth only.
  for (const value of [
    'synthetic-private',
    '11111111111111',
    '00000000000000',
    '/101',
    '/202',
  ])
    assert.equal(page.includes(value), false);
  for (const name of ['credentials.enc', 'case.enc'])
    await assert.rejects(readFile(join(run.directory, name)), {
      code: 'ENOENT',
    });
  const replay = await fetch(url, { redirect: 'manual' });
  assert.equal(replay.status, 409);
  assert.equal(mock.calls.length, 10);
});
test('explicit create mode consumes fixed digest and permits exactly one sale POST', async (t) => {
  const mock = remote(),
    run = await session(t, {
      fetcher: mock.fetcher,
      mode: 'create',
      approvedPlanDigest: c01Digest(input()),
    });
  await importEnvelopes(run);
  const url = await authorize();
  await waitPage((p) => p.includes('api_readback_matched'));
  const result = JSON.parse(
    await readFile(join(run.directory, 'result.json'), 'utf8'),
  );
  assert.equal(result.erpPostAttempts, 1);
  assert.equal(result.getCount, 11);
  assert.equal(result.uiLineProofRequired, true);
  assert.equal(result.f1GatePassed, false);
  assert.equal(
    mock.calls.filter(
      (c) => c.path === '/public-api/v3/pedidos' && c.method === 'POST',
    ).length,
    1,
  );
  const replay = await fetch(url, { redirect: 'manual' });
  assert.equal(replay.status, 409);
  assert.equal(
    mock.calls.filter(
      (c) => c.path === '/public-api/v3/pedidos' && c.method === 'POST',
    ).length,
    1,
  );
});
test('account/case envelope mismatch and changed approved input stop before OAuth or API', async (t) => {
  for (const mode of ['prepare', 'create']) {
    const mock = remote(),
      run = await session(t, {
        fetcher: mock.fetcher,
        mode,
        approvedPlanDigest: c01Digest(input()),
      });
    const selection = input();
    if (mode === 'prepare') selection.accountDocument = '22222222222222';
    else selection.buyer.id = 102;
    await importEnvelopes(run, selection);
    await waitPage((p) => p.includes('CREDENTIAL_IMPORT_FAILED'));
    assert.equal(mock.calls.length, 0);
    run.close();
    // The next session can bind once the old server has stopped.
    await delay(20);
  }
});

test('reconcile OAuth mode performs exactly two GETs and no sale POST', async (t) => {
  const mock = remote(),
    run = await session(t, { fetcher: mock.fetcher, mode: 'reconcile' });
  await mkdir(join(run.privateRoot, 'controlled'));
  await writeFile(
    join(run.privateRoot, 'controlled', C01_REFERENCE + '.jsonl'),
    JSON.stringify({
      phase: 'reserved',
      payloadSha256: createHash('sha256')
        .update(JSON.stringify(buildC01(input()).payload))
        .digest('hex'),
    }) +
      '\n' +
      JSON.stringify({ phase: 'created', id: 301 }) +
      '\n',
  );
  await importEnvelopes(run);
  const page = await waitPage((p) => p.includes('Conectar Olist'));
  assert.ok(page.includes('Somente dois GET'));
  await authorize();
  await waitPage((p) => p.includes('read_only_reconciled'));
  const result = JSON.parse(
    await readFile(join(run.directory, 'result.json'), 'utf8'),
  );
  assert.equal(result.getCount, 2);
  assert.equal(result.erpPostAttempts, 0);
  assert.deepEqual(result.failedChecks, []);
  assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 1); // OAuth only.
  assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 2);
});
