import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  unlink,
  rmdir,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  READ_APPROVAL,
  runReadbackProbe,
  normalizeReadback,
  parseDecimalJson,
  preparePrivatePlan,
  FIVE_READ_APPROVAL,
} from './monetary-readback-probe.mjs';

const credentials = {
  credentialsRenewed: true,
  verifiedAccountDocument: '00000000000000',
  v3AccessToken: 'MOCK_V3_SECRET',
  v2Token: 'MOCK_V2_SECRET',
};
const hash = (p) =>
  createHash('sha256').update(JSON.stringify(p)).digest('hex');
function plan() {
  const values = [
    [
      ['new-M', '3', 100],
      ['new-G', '3', 200],
    ],
    [
      ['new-M', '1', 1],
      ['new-M', '1', 2],
      ['existing-M-from-C01', '1', 103],
      ['new-G', '1', 4],
    ],
    [
      ['new-M', '1000', 1],
      ['new-G', '1', 1],
    ],
  ];
  return {
    approval: READ_APPROVAL,
    maximumReads: 6,
    accountDocument: '00000000000000',
    buyerDocument: '00000000000000',
    buyerId: '100',
    originId: '777',
    products: [
      { resource: 'new-M', id: '201', sku: 'MOCK-M' },
      { resource: 'new-G', id: '202', sku: 'MOCK-G' },
      { resource: 'existing-M-from-C01', id: '11', sku: 'MOCK-OTHER-M' },
    ],
    orders: ['C02', 'C03', 'C04'].map((alias, i) => ({
      alias,
      id: String(400 + i),
      reference: 'CRM-F1-20261104-' + alias,
      date: '2026-11-04',
      expected: {
        alias,
        totalCents: [300, 110, 2][i],
        lines: values[i].map(([resource, quantity, subtotalCents]) => ({
          resource,
          quantity,
          subtotalCents,
        })),
      },
    })),
  };
}
function providerBody(p, order, version) {
  const units = {
    C02: ['0.3333', '0.6667'],
    C03: ['0.005', '0.015', '1.025', '0.035'],
    C04: ['0.000010', '0.01'],
  }[order.alias];
  const lines = order.expected.lines
    .map((line, i) => {
      const product = p.products.find((x) => x.resource === line.resource);
      return version === 'v3'
        ? {
            produto: { id: Number(product.id), sku: product.sku },
            quantidade: Number(line.quantity),
            valorUnitario: Number(units[i]),
          }
        : {
            item: {
              id_produto: Number(product.id),
              codigo: product.sku,
              quantidade: line.quantity,
              valor_unitario: units[i],
            },
          };
    })
    .reverse();
  const total = order.expected.totalCents / 100;
  return version === 'v3'
    ? {
        id: Number(order.id),
        cliente: { id: 100, cpfCnpj: p.buyerDocument },
        ecommerce: { id: 777, numeroPedidoEcommerce: order.reference },
        data: order.date,
        itens: lines,
        valorTotalProdutos: total,
        valorTotalPedido: total,
        privateUnexpected: 'DO_NOT_COPY_PROVIDER_BODY',
      }
    : {
        retorno: {
          status: 'OK',
          pedido: {
            id: order.id,
            numero_ecommerce: order.reference,
            cliente: { cpf_cnpj: p.buyerDocument },
            data_pedido: '04/11/2026',
            itens: lines,
            total_produtos: String(total),
            total_pedido: String(total),
          },
        },
      };
}
const response = (body) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
async function scenario(t, change = {}) {
  const p = plan(),
    directory = await mkdtemp(join(tmpdir(), 'olist-readback-'));
  const journalPath = join(directory, 'reads.jsonl'),
    calls = [];
  t.after(async () => {
    await unlink(journalPath).catch(() => {});
    await rmdir(directory);
  });
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const version = init.method === 'GET' ? 'v3' : 'v2';
    let order;
    if (version === 'v3') {
      assert.equal(init.headers.Authorization, 'Bearer MOCK_V3_SECRET');
      order = p.orders.find(
        (o) => url === 'https://api.tiny.com.br/public-api/v3/pedidos/' + o.id,
      );
      assert.ok(order);
      assert.equal(init.body, undefined);
    } else {
      assert.equal(url, 'https://api.tiny.com.br/api2/pedido.obter.php');
      const form = new URLSearchParams(init.body);
      assert.deepEqual([...form.keys()].sort(), ['formato', 'id', 'token']);
      assert.equal(form.get('formato'), 'json');
      assert.equal(form.get('token'), 'MOCK_V2_SECRET');
      order = p.orders.find((o) => o.id === form.get('id'));
      assert.ok(order);
    }
    // The reservation must already be durable when the request begins.
    const journal = await readFile(journalPath, 'utf8');
    assert.ok(journal.includes('"attempt":' + calls.length));
    if (change.fetcher)
      return change.fetcher({ p, order, version, calls, init });
    const body = providerBody(p, order, version);
    change.mutate?.(body, version);
    return response(body);
  };
  const options = {
    credentials: { ...credentials, ...change.credentials },
    approvedDigest: hash(p),
    journalPath,
    fetcher,
    pause: async () => {},
    ...change.options,
  };
  return {
    p,
    calls,
    journalPath,
    options,
    run: () => runReadbackProbe(p, options),
  };
}
test('six reads use only fixed endpoints; accurate mock still cannot close F1', async (t) => {
  const s = await scenario(t),
    result = await s.run();
  assert.equal(result.attemptedReads, 6);
  assert.equal(result.erpWrites, 0);
  assert.equal(result.results.length, 6);
  assert.equal(result.f1GatePassed, false);
  assert.equal(s.calls.filter((c) => c.init.method === 'POST').length, 3);
  assert.ok(
    result.results.every((r) => r.comparison.allSubtotalMultisetsMatch),
  );
  assert.equal(result.results[2].comparison.everySourceLineIdentified, false);
  const journal = await readFile(s.journalPath, 'utf8');
  for (const secret of [
    'MOCK_V3_SECRET',
    'MOCK_V2_SECRET',
    '00000000000000',
    'MOCK-M',
    'DO_NOT_COPY_PROVIDER_BODY',
    'numero_ecommerce',
    'cpfCnpj',
  ])
    assert.ok(!journal.includes(secret));
  await assert.rejects(s.run(), /READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED/);
  assert.equal(s.calls.length, 6);
});
test('unrenewed credentials block before journal or HTTP', async (t) => {
  const s = await scenario(t, { credentials: { credentialsRenewed: false } });
  await assert.rejects(s.run(), /CREDENTIAL_RENEWAL_REQUIRED/);
  assert.equal(s.calls.length, 0);
  await assert.rejects(readFile(s.journalPath), { code: 'ENOENT' });
});
test('wrong account session and altered approval block before HTTP', async (t) => {
  const s = await scenario(t, {
    credentials: { verifiedAccountDocument: '11111111111111' },
  });
  await assert.rejects(s.run(), /ACCOUNT_SESSION_NOT_VERIFIED/);
  s.options.credentials = credentials;
  s.p.orders[0].id = '999';
  await assert.rejects(s.run(), /READ_PLAN_APPROVAL_REQUIRED/);
  assert.equal(s.calls.length, 0);
});
test('existing journal and concurrent runs cannot grant another six reads', async (t) => {
  const s = await scenario(t);
  const result = await Promise.allSettled([s.run(), s.run()]);
  assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(s.calls.length, 6);
});
test('timeout stops without retry and preserves consumed attempt', async (t) => {
  const s = await scenario(t, {
    fetcher: () => {
      throw new Error('PRIVATE_TOKEN_URL_BODY');
    },
  });
  const r = await s.run();
  assert.equal(r.code, 'READBACK_HTTP_OUTCOME_UNKNOWN');
  assert.equal(r.attemptedReads, 1);
  assert.equal(s.calls.length, 1);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
});

test('rejected response cancels its unread body before stopping', async (t) => {
  let cancelled = false;
  const s = await scenario(t, {
    fetcher: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 401 },
      ),
  });
  const r = await s.run();
  assert.equal(r.code, 'READBACK_HTTP_REJECTED');
  assert.equal(cancelled, true);
});
for (const [name, makeResponse, code] of [
  [
    'HTTP rejection',
    () => new Response('SECRET', { status: 401 }),
    'READBACK_HTTP_REJECTED',
  ],
  [
    'redirect',
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://example.invalid' },
      }),
    'READBACK_HTTP_REJECTED',
  ],
  [
    'HTML',
    () => new Response('SECRET', { headers: { 'Content-Type': 'text/html' } }),
    'INVALID_CONTENT_TYPE',
  ],
  [
    'invalid JSON',
    () =>
      new Response('SECRET', {
        headers: { 'Content-Type': 'application/json' },
      }),
    'INVALID_PROVIDER_JSON',
  ],
  [
    'oversized body',
    () =>
      new Response('x'.repeat(131073), {
        headers: { 'Content-Type': 'application/json' },
      }),
    'RESPONSE_TOO_LARGE',
  ],
])
  test(name + ' consumes one attempt and stops', async (t) => {
    const s = await scenario(t, { fetcher: makeResponse });
    const r = await s.run();
    assert.equal(r.code, code);
    assert.equal(r.attemptedReads, 1);
    assert.equal(s.calls.length, 1);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  });
test('HTTP 200 with v2 error stops at second attempt without provider error disclosure', async (t) => {
  const s = await scenario(t, {
    fetcher: ({ p, order, version }) =>
      response(
        version === 'v3'
          ? providerBody(p, order, version)
          : { retorno: { status: 'Erro', erros: ['SECRET'] } },
      ),
  });
  const r = await s.run();
  assert.equal(r.code, 'PROVIDER_READ_REJECTED');
  assert.equal(r.attemptedReads, 2);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('identity mismatch stops before trying another version', async (t) => {
  const s = await scenario(t, {
    mutate: (b) => {
      b.ecommerce.numeroPedidoEcommerce = 'OTHER';
    },
  });
  const r = await s.run();
  assert.equal(r.code, 'ORDER_IDENTITY_DIVERGENT');
  assert.equal(r.attemptedReads, 1);
});
test('product ID and SKU disagreement is not silently matched', () => {
  const p = plan(),
    order = p.orders[0],
    b = providerBody(p, order, 'v3');
  b.itens[0].produto.sku = 'MOCK-M';
  assert.throws(
    () =>
      normalizeReadback('v3', parseDecimalJson(JSON.stringify(b)), p, order),
    /PRODUCT_IDENTITY_DIVERGENT/,
  );
});
test('raw decimal source survives JSON parsing and missing unit is not zero', () => {
  assert.deepEqual(parseDecimalJson('{"a":0.000010,"b":1e-5,"c":1.00}'), {
    a: '0.000010',
    b: '1e-5',
    c: '1.00',
  });
  const p = plan(),
    order = p.orders[0],
    b = providerBody(p, order, 'v3');
  delete b.itens[0].valorUnitario;
  assert.throws(
    () =>
      normalizeReadback('v3', parseDecimalJson(JSON.stringify(b)), p, order),
    /INVALID_MONETARY_INPUT/,
  );
});
test('exhausted quota stops without an implicit auxiliary request', async (t) => {
  const s = await scenario(t, {
    fetcher: ({ p, order, version }) => {
      const r = response(providerBody(p, order, version));
      r.headers.set('x-ratelimit-remaining', '0');
      return r;
    },
  });
  const r = await s.run();
  assert.equal(r.code, 'READBACK_RATE_LIMIT_EXHAUSTED');
  assert.equal(s.calls.length, 1);
});
test('abort reserves no HTTP slot and does not permit restart of the budget', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const s = await scenario(t, { options: { signal: controller.signal } });
  const r = await s.run();
  assert.equal(r.code, 'READBACK_STOPPED');
  assert.equal(s.calls.length, 0);
  await assert.rejects(s.run(), /READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED/);
});
test('journal cannot be replaced to reset budget through ordinary execution', async (t) => {
  const s = await scenario(t);
  await writeFile(s.journalPath, 'reserved');
  await assert.rejects(s.run(), /READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED/);
  assert.equal(s.calls.length, 0);
});

for (const type of ['text/plain; charset=utf-8', 'text/html; charset=UTF-8'])
  test(
    'v2 accepts strictly parsed JSON labelled ' +
      type +
      ' while v3 remains JSON-only',
    async (t) => {
      const s = await scenario(t, {
        fetcher: ({ p, order, version }) =>
          new Response(JSON.stringify(providerBody(p, order, version)), {
            headers: {
              'Content-Type': version === 'v2' ? type : 'application/json',
            },
          }),
      });
      const result = await s.run();
      assert.equal(result.attemptedReads, 6);
      assert.equal(result.state, 'six_reads_completed_diagnostic_only');
      assert.equal(result.f1GatePassed, false);
      const events = (await readFile(s.journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(
        events.filter(
          (e) => e.event === 'read-response-received' && e.version === 'v2',
        ).length,
        3,
      );
    },
  );
test('HTML from v2 is rejected as invalid JSON instead of being interpreted or repaired', async (t) => {
  const s = await scenario(t, {
    fetcher: ({ p, order, version }) =>
      version === 'v3'
        ? response(providerBody(p, order, version))
        : new Response('<html>PRIVATE_CHALLENGE</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
  });
  const r = await s.run();
  assert.equal(r.attemptedReads, 2);
  assert.equal(r.code, 'INVALID_PROVIDER_JSON');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_CHALLENGE'));
});
test('explicit five-read continuation is fixed, preserves the original two slots and cannot restart', async (t) => {
  const s = await scenario(t, {
    fetcher: ({ p, order, version }) =>
      new Response(JSON.stringify(providerBody(p, order, version)), {
        headers: {
          'Content-Type':
            version === 'v3' ? 'application/json' : 'application/octet-stream',
        },
      }),
  });
  const stopped = await s.run();
  assert.equal(stopped.code, 'INVALID_CONTENT_TYPE');
  assert.equal(stopped.attemptedReads, 2);
  const previous = await readFile(s.journalPath),
    journalPath = join(s.journalPath, '..', 'five-read-journal.jsonl');
  const continuation = {
    approval: FIVE_READ_APPROVAL,
    previousJournalPath: s.journalPath,
    previousJournalSha256: createHash('sha256').update(previous).digest('hex'),
  };
  const calls = [];
  const fetcher = async (url, init) => {
    const version = init.method === 'GET' ? 'v3' : 'v2';
    const orderId =
      version === 'v3'
        ? new URL(url).pathname.split('/').at(-1)
        : new URLSearchParams(init.body).get('id');
    const order = s.p.orders.find((o) => o.id === orderId);
    assert.ok(order);
    calls.push([order.alias, version]);
    const ledger = await readFile(journalPath, 'utf8');
    assert.ok(ledger.includes('"attempt":' + calls.length));
    return new Response(JSON.stringify(providerBody(s.p, order, version)), {
      headers: {
        'Content-Type': version === 'v2' ? 'text/plain' : 'application/json',
      },
    });
  };
  const options = { ...s.options, journalPath, continuation, fetcher };
  try {
    await assert.rejects(
      runReadbackProbe(s.p, {
        ...options,
        continuation: { ...continuation, approval: 'NOT_APPROVED' },
      }),
      /FIVE_READ_APPROVAL_REQUIRED/,
    );
    await assert.rejects(
      runReadbackProbe(s.p, {
        ...options,
        continuation: {
          ...continuation,
          previousJournalSha256: '0'.repeat(64),
        },
      }),
      /PREVIOUS_READ_JOURNAL_CHANGED/,
    );
    await assert.rejects(
      runReadbackProbe(s.p, {
        ...options,
        journalPath: join(s.journalPath, '..', 'alternate.jsonl'),
      }),
      /CONTINUATION_JOURNAL_PATH_INVALID/,
    );
    assert.equal(calls.length, 0);
    const r = await runReadbackProbe(s.p, options);
    assert.equal(r.state, 'five_read_continuation_completed_diagnostic_only');
    assert.equal(r.attemptedReads, 5);
    assert.equal(r.previousOrderReadAttempts, 2);
    assert.equal(r.maximumTotalOrderReadAttempts, 7);
    assert.deepEqual(calls, [
      ['C02', 'v2'],
      ['C03', 'v3'],
      ['C03', 'v2'],
      ['C04', 'v3'],
      ['C04', 'v2'],
    ]);
    assert.deepEqual(await readFile(s.journalPath), previous);
    await assert.rejects(
      runReadbackProbe(s.p, options),
      /READ_JOURNAL_UNAVAILABLE_OR_ALREADY_RESERVED/,
    );
    assert.equal(calls.length, 5);
  } finally {
    await unlink(journalPath).catch(() => {});
  }
});

test('private preparation derives existing IDs without network or copying fiscal fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'olist-readback-plan-'));
  const files = [
    'f1-next-cases-private.json',
    'c02-c04-ui-proof.json',
    'controlled/CUSTOMER-CORRECTED01-FULL.jsonl',
    'controlled/F1-ORDERS-20261104.jsonl',
    'controlled/F1-C04-20261104.jsonl',
  ];
  t.after(async () => {
    for (const file of files) await unlink(join(root, file));
    await rmdir(join(root, 'controlled'));
    await rmdir(root);
  });
  await mkdir(join(root, 'controlled'));
  const p = plan();
  await writeFile(
    join(root, files[0]),
    JSON.stringify({
      accountDocument: p.accountDocument,
      customer: { cpfCnpj: p.buyerDocument, nome: 'DO_NOT_COPY_FISCAL_DATA' },
      originIntegratorIdCandidate: 777,
      existingM: { id: 11, sku: 'MOCK-OTHER-M' },
      date: '2026-11-04',
    }),
  );
  const ui = { independentNativeUi: true, noOrderEdited: true };
  for (const o of p.orders)
    ui[o.alias] = {
      reference: o.reference,
      totalCents: o.expected.totalCents,
      lines: o.expected.lines.map((l) => ({
        ...l,
        resource:
          l.resource === 'existing-M-from-C01' ? 'existing-M' : l.resource,
        quantity: Number(l.quantity),
      })),
    };
  await writeFile(join(root, files[1]), JSON.stringify(ui));
  await writeFile(
    join(root, files[2]),
    [
      { event: 'created', resource: 'customer', id: 100 },
      { event: 'children-reconciled', ids: { M: 201, G: 202 } },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  const entries = (orders) =>
    orders.flatMap((o) => [
      { event: 'created', resource: o.alias, id: Number(o.id) },
      { event: 'api-reconciled', resource: o.alias, id: Number(o.id) },
    ]);
  await writeFile(
    join(root, files[3]),
    entries(p.orders.slice(0, 2))
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  await writeFile(
    join(root, files[4]),
    entries(p.orders.slice(2))
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  const prepared = await preparePrivatePlan(root);
  assert.equal(prepared.approvedDigest, hash(prepared.plan));
  assert.deepEqual(
    prepared.plan.orders.map((o) => o.id),
    ['400', '401', '402'],
  );
  assert.equal(
    prepared.plan.orders[1].expected.lines[2].resource,
    'existing-M-from-C01',
  );
  assert.ok(!JSON.stringify(prepared).includes('DO_NOT_COPY_FISCAL_DATA'));
  await writeFile(
    join(root, files[4]),
    entries(p.orders.slice(2))
      .concat([{ event: 'created', resource: 'C04', id: 402 }])
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  await assert.rejects(preparePrivatePlan(root), /PRIVATE_BASELINE_AMBIGUOUS/);
});
