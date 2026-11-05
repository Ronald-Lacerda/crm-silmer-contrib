import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  unlink,
  rmdir,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, publicEncrypt, constants } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  startMonetarySession,
  validateRenewedCredentials,
} from './monetary-readback-session.mjs';
import {
  READ_APPROVAL,
  FIVE_READ_APPROVAL,
} from './monetary-readback-probe.mjs';
import {
  exactCentFixture,
  exactCentMock,
} from './exact-cent-proof.fixtures.mjs';
import { EXACT_CENT_APPROVAL } from './exact-cent-proof.mjs';

const input = () => ({
  clientId: 'MOCK_CLIENT',
  clientSecret: 'MOCK_SECRET',
  v2Token: 'MOCK_LEGACY',
  verifiedAccountDocument: '00000000000000',
  credentialsRenewed: true,
});
function fixturePlan() {
  const plan = {
    approval: READ_APPROVAL,
    maximumReads: 6,
    accountDocument: '00000000000000',
    buyerDocument: '00000000000000',
    buyerId: '8',
    originId: '7',
    products: [
      { resource: 'new-M', id: '1', sku: 'MOCK-M' },
      { resource: 'new-G', id: '2', sku: 'MOCK-G' },
      { resource: 'existing-M-from-C01', id: '3', sku: 'MOCK-OTHER-M' },
    ],
    orders: ['C02', 'C03', 'C04'].map((alias, i) => ({
      alias,
      id: String(401 + i),
      reference: 'CRM-F1-20261104-' + alias,
      date: '2026-11-04',
      expected: {
        alias,
        totalCents: 1,
        lines: [{ resource: 'new-M', quantity: '1', subtotalCents: 1 }],
      },
    })),
  };
  return {
    plan,
    approvedDigest: createHash('sha256')
      .update(JSON.stringify(plan))
      .digest('hex'),
  };
}
async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('MOCK_SESSION_TIMEOUT');
}
async function setup(t, fetcher, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'olist-money-session-'));
  await writeFile(
    join(root, 'private-plan.json'),
    JSON.stringify(fixturePlan()),
  );
  await options.beforeStart?.(root);
  const session = await startMonetarySession(root, {
    fetcher,
    pause: async () => {},
    importIntervalMs: 10,
    lifetimeMs: 30000,
    ...options,
  });
  t.after(async () => {
    session.close();
    for (const f of await readdir(session.directory))
      await unlink(join(session.directory, f));
    await rmdir(session.directory);
    for (const f of await readdir(root)) await unlink(join(root, f));
    await rmdir(root);
  });
  const envelope = async (values) => {
    const ciphertext = publicEncrypt(
      {
        key: await readFile(session.publicKeyFile),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(JSON.stringify(values)),
    );
    const staging = session.encryptedInputFile + '.staged';
    await writeFile(staging, ciphertext, { flag: 'wx' });
    // Publish the complete ciphertext exclusively, never a temporarily empty file.
    await link(staging, session.encryptedInputFile);
    await unlink(staging);
  };
  return { root, session, envelope };
}
test('renewal and account binding are mandatory before OAuth', () => {
  assert.throws(
    () =>
      validateRenewedCredentials(
        { ...input(), credentialsRenewed: false },
        '00000000000000',
      ),
    /CREDENTIAL_RENEWAL_REQUIRED/,
  );
  assert.throws(
    () => validateRenewedCredentials(input(), '11111111111111'),
    /ACCOUNT_SESSION_NOT_VERIFIED/,
  );
  assert.throws(
    () =>
      validateRenewedCredentials({ ...input(), extra: 'NO' }, '00000000000000'),
    /INVALID_CREDENTIAL_ENVELOPE/,
  );
});
test('encrypted import and fresh OAuth make exactly six order reads without /info', async (t) => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method });
    let body;
    if (
      url ===
      'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token'
    ) {
      assert.equal(init.method, 'POST');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_secret'), 'MOCK_SECRET');
      body = { access_token: 'MOCK_ACCESS', refresh_token: 'MOCK_REFRESH' };
    } else {
      const isV3 = init.method === 'GET',
        orderId = isV3
          ? new URL(url).pathname.split('/').at(-1)
          : new URLSearchParams(init.body).get('id');
      const order = fixturePlan().plan.orders.find((o) => o.id === orderId);
      assert.ok(order);
      assert.ok(!url.endsWith('/info'));
      if (isV3) {
        assert.equal(init.headers.Authorization, 'Bearer MOCK_ACCESS');
        body = {
          id: Number(orderId),
          ecommerce: { id: 7, numeroPedidoEcommerce: order.reference },
          cliente: { id: 8, cpfCnpj: '00000000000000' },
          data: '2026-11-04',
          itens: [
            {
              produto: { id: 1, sku: 'MOCK-M' },
              quantidade: 1,
              valorUnitario: 0.01,
            },
          ],
          valorTotalProdutos: 0.01,
          valorTotalPedido: 0.01,
        };
      } else {
        assert.equal(url, 'https://api.tiny.com.br/api2/pedido.obter.php');
        assert.equal(
          new URLSearchParams(init.body).get('token'),
          'MOCK_LEGACY',
        );
        body = {
          retorno: {
            status: 'OK',
            pedido: {
              id: orderId,
              numero_ecommerce: order.reference,
              cliente: { cpf_cnpj: '00000000000000' },
              data_pedido: '04/11/2026',
              itens: [
                {
                  item: {
                    id_produto: '1',
                    codigo: 'MOCK-M',
                    quantidade: '1',
                    valor_unitario: '0.01',
                  },
                },
              ],
              total_produtos: '0.01',
              total_pedido: '0.01',
            },
          },
        };
      }
    }
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { root, session, envelope } = await setup(t, fetcher);
  await envelope(input());
  await waitUntil(() => session.phase === 'ready_oauth');
  await assert.rejects(readFile(session.encryptedInputFile), {
    code: 'ENOENT',
  });
  const html = await (await fetch('http://127.0.0.1:8765/')).text();
  const auth = new URL(
    html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'),
  );
  const res = await fetch(
    'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=' +
      auth.searchParams.get('state'),
    { redirect: 'manual' },
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  await waitUntil(
    () => session.phase === 'six_reads_completed_diagnostic_only',
  );
  assert.equal(calls.length, 7);
  assert.equal(session.result.attemptedReads, 6);
  assert.equal(session.result.f1GatePassed, false);
  const text =
    (await readFile(join(root, 'six-read-result.json'), 'utf8')) +
    (await readFile(join(root, 'six-read-journal.jsonl'), 'utf8'));
  for (const secret of [
    'MOCK_ACCESS',
    'MOCK_REFRESH',
    'MOCK_SECRET',
    'MOCK_LEGACY',
    'MOCK_CODE',
  ])
    assert.ok(!text.includes(secret));
  const duplicate = await fetch(
    'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=' +
      auth.searchParams.get('state'),
    { redirect: 'manual' },
  );
  assert.equal(duplicate.status, 409);
  assert.equal(calls.length, 7);
});
test('unrenewed encrypted credentials stop with zero network calls', async (t) => {
  let calls = 0;
  const { session, envelope } = await setup(t, () => {
    calls++;
    throw Error();
  });
  await envelope({ ...input(), credentialsRenewed: false });
  await waitUntil(() => session.result !== null);
  assert.equal(session.result.code, 'CREDENTIAL_RENEWAL_REQUIRED');
  assert.equal(calls, 0);
});

test('closing during encrypted import cannot resurrect an OAuth-ready session', async (t) => {
  let entered = false,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { session, envelope } = await setup(
    t,
    () => assert.fail('NO NETWORK'),
    {
      readEncryptedInput: async (file) => {
        entered = true;
        await held;
        return readFile(file);
      },
    },
  );
  await envelope(input());
  await waitUntil(() => entered);
  session.close();
  release();
  await delay(80);
  assert.equal(session.phase, 'closed');
  assert.equal(session.result, null);
});

test('forged callback state stops before OAuth and consumes no order budget', async (t) => {
  let calls = 0;
  const { root, session, envelope } = await setup(t, () => {
    calls++;
    throw Error();
  });
  await envelope(input());
  await waitUntil(() => session.phase === 'ready_oauth');
  const response = await fetch(
    'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=forged',
    { redirect: 'manual' },
  );
  assert.equal(response.status, 303);
  await waitUntil(() => session.result !== null);
  assert.equal(session.result.code, 'INVALID_CALLBACK_STATE');
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(root, 'six-read-journal.jsonl')), {
    code: 'ENOENT',
  });
});

for (const [label, responseFactory, code, status] of [
  [
    '401',
    () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 401 }),
    'HTTP_401',
    401,
  ],
  [
    'invalid JSON',
    () =>
      new Response('PRIVATE_PROVIDER_DETAIL', {
        headers: { 'Content-Type': 'application/json' },
      }),
    'INVALID_RESPONSE',
    200,
  ],
  [
    'network failure',
    () => {
      throw new Error('PRIVATE_URL_AND_SECRET');
    },
    'HTTP_OUTCOME_UNKNOWN',
    null,
  ],
])
  test(
    'OAuth ' +
      label +
      ' records safe stage/status and never spends order-read budget',
    async (t) => {
      let calls = 0;
      const { root, session, envelope } = await setup(t, (url, init) => {
        calls++;
        assert.equal(
          url,
          'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token',
        );

        assert.equal(init.method, 'POST');
        return responseFactory();
      });
      await envelope(input());
      await waitUntil(() => session.phase === 'ready_oauth');
      const html = await (await fetch('http://127.0.0.1:8765/')).text();
      const auth = new URL(
        html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'),
      );
      const callback = await fetch(
        'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=' +
          auth.searchParams.get('state'),
        { redirect: 'manual' },
      );
      assert.equal(callback.status, 303);
      await waitUntil(() => session.result !== null);
      assert.equal(session.result.code, code);
      assert.equal(session.result.stage, 'oauth_exchange');
      assert.equal(session.result.oauthPostAttempts, 1);
      assert.equal(session.result.oauthHttpStatus, status);
      assert.equal(calls, 1);
      assert.ok(!JSON.stringify(session.result).includes('PRIVATE'));
      await assert.rejects(readFile(join(root, 'six-read-journal.jsonl')), {
        code: 'ENOENT',
      });
    },
  );

test('five-read mode requires a separate explicit approval before OAuth or listening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'olist-five-approval-'));
  t.after(async () => {
    for (const f of await readdir(root)) await unlink(join(root, f));
    await rmdir(root);
  });
  await writeFile(
    join(root, 'private-plan.json'),
    JSON.stringify(fixturePlan()),
  );
  await writeFile(
    join(root, 'five-read-approval.json'),
    JSON.stringify({ approved: false, approval: FIVE_READ_APPROVAL }),
  );
  await assert.rejects(
    startMonetarySession(root, {
      mode: 'continuation-five',
      fetcher: () => assert.fail('NO NETWORK'),
    }),
    /EXPLICIT_FIVE_READ_APPROVAL_REQUIRED/,
  );
});

test('approved continuation session obtains one fresh token then exactly five fixed reads', async (t) => {
  const calls = [];
  let baseline;
  const fetcher = async (url, init) => {
    if (
      url ===
      'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token'
    ) {
      calls.push('oauth');
      return new Response(JSON.stringify({ access_token: 'MOCK_ACCESS' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const version = init.method === 'GET' ? 'v3' : 'v2';
    const orderId =
      version === 'v3'
        ? new URL(url).pathname.split('/').at(-1)
        : new URLSearchParams(init.body).get('id');
    const order = fixturePlan().plan.orders.find((o) => o.id === orderId);
    assert.ok(order);
    calls.push(order.alias + '-' + version);
    const body =
      version === 'v3'
        ? {
            id: Number(orderId),
            ecommerce: {
              id: 7,
              numeroPedidoEcommerce: order.reference,
            },
            cliente: { id: 8, cpfCnpj: '00000000000000' },
            data: '2026-11-04',
            itens: [
              {
                produto: { id: 1, sku: 'MOCK-M' },
                quantidade: 1,
                valorUnitario: 0.01,
              },
            ],
            valorTotalProdutos: 0.01,
            valorTotalPedido: 0.01,
          }
        : {
            retorno: {
              status: 'OK',
              pedido: {
                id: orderId,
                numero_ecommerce: order.reference,
                cliente: { cpf_cnpj: '00000000000000' },
                data_pedido: '04/11/2026',
                itens: [
                  {
                    item: {
                      id_produto: '1',
                      codigo: 'MOCK-M',
                      quantidade: '1',
                      valor_unitario: '0.01',
                    },
                  },
                ],
                total_produtos: '0.01',
                total_pedido: '0.01',
              },
            },
          };
    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': version === 'v2' ? 'text/plain' : 'application/json',
      },
    });
  };
  const { root, session, envelope } = await setup(t, fetcher, {
    mode: 'continuation-five',
    beforeStart: async (root) => {
      baseline =
        [
          {
            event: 'six-read-budget-reserved',
            planDigest: fixturePlan().approvedDigest,
            maximumReads: 6,
          },
          {
            event: 'read-attempt-reserved',
            attempt: 1,
            alias: 'C02',
            version: 'v3',
          },
          { event: 'read-compared', alias: 'C02', version: 'v3' },
          {
            event: 'read-attempt-reserved',
            attempt: 2,
            alias: 'C02',
            version: 'v2',
          },
          {
            event: 'stopped',
            code: 'INVALID_CONTENT_TYPE',
            attemptedReads: 2,
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n';
      await writeFile(join(root, 'six-read-journal.jsonl'), baseline);
      await writeFile(
        join(root, 'five-read-approval.json'),
        JSON.stringify({
          approved: true,
          approval: FIVE_READ_APPROVAL,
          previousJournalSha256: createHash('sha256')
            .update(baseline)
            .digest('hex'),
        }),
      );
    },
  });
  await envelope(input());
  await waitUntil(() => session.phase === 'ready_oauth');
  const html = await (await fetch('http://127.0.0.1:8765/')).text();
  assert.ok(html.includes('5 consultas'));
  const auth = new URL(
    html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'),
  );
  await fetch(
    'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=' +
      auth.searchParams.get('state'),
    { redirect: 'manual' },
  );
  await waitUntil(
    () => session.phase === 'five_read_continuation_completed_diagnostic_only',
  );
  assert.deepEqual(calls, [
    'oauth',
    'C02-v2',
    'C03-v3',
    'C03-v2',
    'C04-v3',
    'C04-v2',
  ]);
  assert.equal(session.result.attemptedReads, 5);
  assert.equal(session.result.maximumTotalOrderReadAttempts, 7);
  assert.equal(
    await readFile(join(root, 'six-read-journal.jsonl'), 'utf8'),
    baseline,
  );
  assert.equal(session.result.f1GatePassed, false);
});

test('exact-cent proof requires explicit scope approval before listening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'olist-exact-approval-'));
  t.after(async () => {
    for (const f of await readdir(root)) await unlink(join(root, f));
    await rmdir(root);
  });
  await writeFile(
    join(root, 'exact-cent-plan.json'),
    JSON.stringify(exactCentFixture()),
  );
  await writeFile(
    join(root, 'exact-cent-approval.json'),
    JSON.stringify({ approved: false }),
  );
  await assert.rejects(
    startMonetarySession(root, {
      mode: 'exact-cent-proof',
      fetcher: () => assert.fail('NO NETWORK'),
    }),
    /EXPLICIT_EXACT_CENT_APPROVAL_REQUIRED/,
  );
});

test('exact-cent OAuth session executes only three new orders and fourteen fixed reads', async (t) => {
  const prepared = exactCentFixture();
  const transport = exactCentMock(prepared.plan);
  let oauth = 0;
  const fetcher = async (url, init) => {
    if (
      url ===
      'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token'
    ) {
      oauth++;
      return new Response(JSON.stringify({ access_token: 'MOCK_ACCESS' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return transport.fetcher(url, init);
  };
  const { session, envelope } = await setup(t, fetcher, {
    mode: 'exact-cent-proof',
    beforeStart: async (root) => {
      await writeFile(
        join(root, 'exact-cent-plan.json'),
        JSON.stringify(prepared),
      );
      await writeFile(
        join(root, 'exact-cent-approval.json'),
        JSON.stringify({
          approved: true,
          approval: EXACT_CENT_APPROVAL,
          approvedDigest: prepared.approvedDigest,
        }),
      );
    },
  });
  await envelope(input());
  await waitUntil(() => session.phase === 'ready_oauth');
  const html = await (await fetch('http://127.0.0.1:8765/')).text();
  assert.ok(html.includes('3 novos pedidos'));
  assert.ok(html.includes('5,20'));
  const auth = new URL(
    html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'),
  );
  await fetch(
    'http://127.0.0.1:8765/olist/callback?code=MOCK_CODE&state=' +
      auth.searchParams.get('state'),
    { redirect: 'manual' },
  );
  await waitUntil(() => session.phase === 'exact_cent_api_proof_completed');
  assert.equal(oauth, 1);
  assert.equal(transport.calls.length, 17);
  assert.equal(session.result.createdOrders, 3);
  assert.equal(session.result.nominalTotalCents, 520);
  assert.equal(session.result.f1GatePassed, false);
});
