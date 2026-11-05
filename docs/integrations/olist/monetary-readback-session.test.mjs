import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, publicEncrypt, constants } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  startMonetarySession,
  validateRenewedCredentials,
} from './monetary-readback-session.mjs';
import { READ_APPROVAL } from './monetary-readback-probe.mjs';

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
    await writeFile(session.encryptedInputFile, ciphertext, { flag: 'wx' });
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
