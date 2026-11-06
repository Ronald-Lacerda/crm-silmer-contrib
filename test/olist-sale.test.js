import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildOlistSalePayload,
  reconcileOlistSale,
} from '../modules/olist/src/sale-payload.js';
import { createOlistSaleWriter } from '../modules/olist/src/sale-writer.js';
import { createOlistClient } from '../modules/olist/src/client.js';
import {
  parseOlistLosslessJson,
  olistNumberLexeme,
  olistIdentifierFromJson,
  olistIntegerFromJson,
} from '../modules/olist/src/lossless-json.js';
const REFERENCE = 'CRM-' + randomUUID();
const TICKET = { attemptId: randomUUID(), fence: randomUUID() };
function fixture() {
  const groupId = randomUUID();
  const lines = [
    {
      lineId: randomUUID(),
      size: 'M',
      quantity: 3,
      subtotalCents: 300,
      unitCents: 100,
      unitLexeme: '1.00',
    },
    {
      lineId: randomUUID(),
      size: 'G',
      quantity: 2,
      subtotalCents: 600,
      unitCents: 300,
      unitLexeme: '3.00',
    },
  ].map((line) => ({ ...line, groupId }));
  const snapshot = {
    policy: 'exact-cent-v1',
    notes: 'PRIVATE_INTERNAL_NOTE',
    artwork: { file: 'PRIVATE_ART' },
    customer: {
      tipoPessoa: 'F',
      cpfCnpj: '52998224725',
      nome: 'Comprador Sintético',
      celular: '5511999990000',
      email: 'buyer@example.test',
      situacao: 'B',
      endereco: {
        cep: '29010000',
        municipio: 'Vitória',
        uf: 'ES',
        endereco: 'Rua Sintética',
        bairro: 'Centro',
        numero: '12',
      },
    },
    commercial: {
      groups: [{ groupId, attributes: { garment: 'Camisa' }, lines }],
      totalCents: 900,
      orderDate: '2026-11-06',
      deliveryOn: '2026-11-20',
      paymentCondition: 'pix',
    },
    settings: {
      sellerId: 11,
      operationNatureId: 12,
      warehouseId: 13,
      originId: 14,
      paymentMethodId: 15,
      receivingMethodId: 16,
      paymentTerms: 'Vencimento explícito',
      paymentDueOn: '2026-11-10',
      priceListId: null,
      purchaseOrder: null,
    },
  };
  const resolved = {
    resolved: true,
    customerId: '101',
    groups: [
      {
        groupId,
        productId: '201',
        lines: lines.map((line, index) => ({
          lineId: line.lineId,
          productId: String(301 + index),
          sku: 'TEST-' + index,
        })),
      },
    ],
  };
  return {
    snapshot,
    resolved,
    plan: buildOlistSalePayload({ snapshot, resolved, reference: REFERENCE }),
  };
}
/** @param {any} plan */
function rawOrder(plan) {
  return (
    '{"id":401,"numeroPedido":99,"situacao":0,"data":' +
    JSON.stringify(plan.orderDate) +
    ',"dataPrevista":' +
    JSON.stringify(plan.deliveryOn) +
    ',"cliente":{"id":' +
    plan.customerId +
    ',"cpfCnpj":' +
    JSON.stringify(plan.buyerDocument) +
    '},"ecommerce":{"id":' +
    plan.originId +
    ',"numeroPedidoEcommerce":' +
    JSON.stringify(plan.reference) +
    '},"itens":[' +
    plan.prepared.lines
      .map((/** @type {any} */ line) => {
        const product = plan.lines.find(
          (/** @type {any} */ item) => item.lineId === line.lineId,
        );
        return (
          '{"produto":{"id":' +
          product.productId +
          ',"sku":' +
          JSON.stringify(product.sku) +
          '},"infoAdicional":' +
          JSON.stringify(line.lineId) +
          ',"quantidade":' +
          line.quantity +
          ',"valorUnitario":' +
          line.unitLexeme +
          '}'
        );
      })
      .reverse()
      .join(',') +
    '],"valorTotalProdutos":' +
    plan.totalLexeme +
    ',"valorTotalPedido":' +
    plan.totalLexeme +
    '}'
  );
}
/** @param {any} body @param {number} [status] */
const json = (body, status = 201) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('T08 sale payload uses the official allowlist, frozen dates and explicit single due date without paid or fiscal commands', async () => {
  const { snapshot, plan } = fixture();
  const payload = JSON.parse(plan.encoded);
  assert.equal(payload.idContato, 101);
  assert.equal(payload.situacao, 0);
  assert.deepEqual(payload.ecommerce, {
    id: 14,
    numeroPedidoEcommerce: REFERENCE,
  });
  assert.equal(payload.pagamento.parcelas[0].data, '2026-11-10');
  assert.equal(payload.pagamento.parcelas.length, 1);
  assert.equal(payload.data, '2026-11-06');
  assert.equal(payload.dataPrevista, '2026-11-20');
  assert.doesNotMatch(
    plan.encoded,
    /PRIVATE_|observacoes|anexo|artwork|condicaoPagamento|pago|baixa|estoque|notaFiscal/u,
  );
  snapshot.settings.paymentDueOn = '2027-01-01';
  assert.equal(plan.settings.paymentDueOn, '2026-11-10');
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.lines));
  const schemas = JSON.parse(
    await readFile(
      new URL(
        '../docs/integrations/olist/evidence/openapi-v3.projection.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).components.schemas;
  /** @param {any} schema @returns {Set<string>} */
  function fields(schema) {
    if (schema.$ref) return fields(schemas[schema.$ref.split('/').at(-1)]);
    return new Set([
      ...Object.keys(schema.properties ?? {}),
      ...(schema.allOf ?? []).flatMap((/** @type {any} */ item) => [
        ...fields(item),
      ]),
    ]);
  }
  for (const key of Object.keys(payload))
    assert.ok(fields(schemas.CriarPedidoModelRequest).has(key), key);
  for (const key of Object.keys(payload.pagamento))
    assert.ok(fields(schemas.PagamentoRequestModel).has(key), key);
});

test('T08 preflight rejects fractional cents, forged derived units, missing explicit due date and incomplete mappings before any write', () => {
  for (const change of [
    (/** @type {any} */ f) => {
      f.snapshot.commercial.groups[0].lines[0].subtotalCents = 100;
      f.snapshot.commercial.totalCents = 700;
    },
    (/** @type {any} */ f) => {
      f.snapshot.commercial.groups[0].lines[0].unitCents = 99;
    },
    (/** @type {any} */ f) => {
      f.snapshot.settings.paymentDueOn = null;
    },
    (/** @type {any} */ f) => {
      f.snapshot.settings.paymentDueOn = '2026-02-30';
    },
    (/** @type {any} */ f) => {
      f.resolved.groups[0].lines.pop();
    },
    (/** @type {any} */ f) => {
      f.resolved.groups[0].lines[1].lineId =
        f.resolved.groups[0].lines[0].lineId;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => buildOlistSalePayload({ ...f, reference: REFERENCE }));
  }
});

test('T08 request and readback preserve cents beyond binary decimal precision and accept exact decimal exponents', () => {
  const f = fixture();
  const line = f.snapshot.commercial.groups[0].lines[0];
  Object.assign(line, {
    quantity: 1,
    subtotalCents: Number.MAX_SAFE_INTEGER,
    unitCents: Number.MAX_SAFE_INTEGER,
    unitLexeme: '90071992547409.91',
  });
  f.snapshot.commercial.groups[0].lines = [line];
  f.snapshot.commercial.totalCents = Number.MAX_SAFE_INTEGER;
  f.resolved.groups[0].lines = f.resolved.groups[0].lines.slice(0, 1);
  const plan = buildOlistSalePayload({ ...f, reference: REFERENCE });
  assert.match(plan.encoded, /"valorUnitario":90071992547409\.91/u);
  assert.match(plan.encoded, /"valor":90071992547409\.91/u);
  assert.equal(
    olistNumberLexeme(
      parseOlistLosslessJson(plan.encoded).itens[0].valorUnitario,
    ),
    '90071992547409.91',
  );
  assert.deepEqual(reconcileOlistSale(plan, rawOrder(plan), 401), {
    matched: true,
    lineCount: 1,
    totalCents: Number.MAX_SAFE_INTEGER,
    number: '99',
  });
  const small = fixture().plan;
  const raw = rawOrder(small)
    .replace('"valorUnitario":1.00', '"valorUnitario":1e0')
    .replace('"valorTotalProdutos":9.00', '"valorTotalProdutos":9e0');
  assert.equal(reconcileOlistSale(small, raw, 401).matched, true);
});

test('T08 repeated products remain separate marker-addressed sale lines rather than being fused', () => {
  const f = fixture();
  f.resolved.groups[0].lines[1].productId =
    f.resolved.groups[0].lines[0].productId;
  f.resolved.groups[0].lines[1].sku = f.resolved.groups[0].lines[0].sku;
  const plan = buildOlistSalePayload({ ...f, reference: REFERENCE });
  assert.equal(JSON.parse(plan.encoded).itens.length, 2);
  assert.equal(reconcileOlistSale(plan, rawOrder(plan), 401).lineCount, 2);
});

test('T08 readback rejects per-line compensation even when both global totals still match', () => {
  const { plan } = fixture();
  const raw = rawOrder(plan)
    .replace('"valorUnitario":1.00', '"valorUnitario":2.00')
    .replace('"valorUnitario":3.00', '"valorUnitario":1.50');
  assert.throws(() => reconcileOlistSale(plan, raw, 401), {
    code: 'OLIST_SALE_READBACK_MISMATCH',
  });
});

test('T08 readback rejects lost, duplicate, fused or wrong product markers, global totals and unrequested fiscal/payment effects', () => {
  const { plan } = fixture();
  const raw = rawOrder(plan),
    first = plan.prepared.lines[0].lineId,
    second = plan.prepared.lines[1].lineId;
  const bodies = [
    raw.replace(first, 'unrecognized'),
    raw.replace(first, second),
    raw.replace('"id":301', '"id":999'),
    raw.replace('"sku":"TEST-0"', '"sku":"OTHER"'),
    raw.replace('"valorTotalPedido":9.00', '"valorTotalPedido":8.99'),
    raw.replace('"valorUnitario":1.00', '"valorUnitario":"1.00"'),
    raw.replace('"situacao":0', '"situacao":1'),
    raw.replace('"id":401', '"id":402'),
    raw.replace('"cpfCnpj":"52998224725"', '"cpfCnpj":"11111111111"'),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"valorFrete":0.01',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"idNotaFiscal":77',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"pagamentosIntegrados":[{}]',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"pagamentosIntegrados":{}',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"notaFiscal":true',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"notaFiscal":[]',
    ),
    raw.replace(
      '"valorTotalPedido":9.00',
      '"valorTotalPedido":9.00,"origemPedido":1',
    ),
  ];
  for (const body of bodies)
    assert.throws(() => reconcileOlistSale(plan, body, 401), {
      code: 'OLIST_SALE_READBACK_MISMATCH',
    });
});

test('T08 optional returned payment fields are verified without treating due date as proof of receipt', () => {
  const { plan } = fixture();
  const raw = rawOrder(plan);
  const payment =
    ',"pagamento":{"meioPagamento":{"id":15},"formaRecebimento":{"id":16},"parcelas":[{"data":"2026-11-10","valor":9.00}]}';
  const body = raw.slice(0, -1) + payment + '}';
  assert.equal(reconcileOlistSale(plan, body, 401).matched, true);
  for (const changed of [
    body.replace('2026-11-10', '2026-11-11'),
    body.replace('"valor":9.00', '"valor":9.01'),
    body.replace('"valor":9.00', '"valor":9.00,"transacao":{"id":11}'),
  ])
    assert.throws(() => reconcileOlistSale(plan, changed, 401), {
      code: 'OLIST_SALE_READBACK_MISMATCH',
    });
});

test('T08 lossless parser refuses duplicate keys, malformed/truncated JSON, non-JSON whitespace and excessive nesting', () => {
  for (const raw of [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"x":0.1',
    '{"x":01}',
    '\ufeff{}',
    '['.repeat(50) + '0' + ']'.repeat(50),
  ])
    assert.throws(() => parseOlistLosslessJson(raw), {
      code: 'OLIST_INVALID_RESPONSE',
    });
  assert.equal(
    olistNumberLexeme(parseOlistLosslessJson('{"x":0.10000000000000000001}').x),
    '0.10000000000000000001',
  );
});

test('T08 writer obtains credentials/quota then reserves once before its single closed POST; caller changes cannot alter frozen payload', async () => {
  const { plan } = fixture();
  /** @type {string[]} */
  const events = [];
  let seen = '';
  const writer = createOlistSaleWriter({
    credentials: async () => {
      events.push('credentials');
      return { token: 'synthetic-token', version: 4 };
    },
    quota: {
      reserve: async () => {
        events.push('quota');
      },
      observe: async () => {
        events.push('observe');
      },
    },
    fetch: async (url, init) => {
      events.push('POST');
      assert.equal(
        String(url),
        'https://api.tiny.com.br/public-api/v3/pedidos',
      );
      assert.equal(init?.redirect, 'error');
      seen = String(init?.body);
      return json({ id: 401, numeroPedido: 99 });
    },
  });
  const result = await writer.dispatch({
    plan,
    reserve: async (encoded, metadata) => {
      events.push('reserve');
      assert.equal(encoded, plan.encoded);
      assert.deepEqual(metadata, { connectionVersion: 4 });
      return TICKET;
    },
  });
  assert.deepEqual(events, [
    'credentials',
    'quota',
    'reserve',
    'POST',
    'observe',
  ]);
  assert.equal(seen, plan.encoded);
  assert.equal(result.remoteId, '401');
  assert.equal(result.remoteNumber, '99');
  assert.equal(result.reservation, TICKET);
});

test('T08 missing reservation, arbitrary encoded payload and pre-reservation failures issue zero POSTs', async () => {
  const { plan } = fixture();
  let posts = 0;
  const writer = createOlistSaleWriter({
    credentials: async () => ({ token: 'synthetic', version: 1 }),
    quota: { reserve: async () => {} },
    fetch: async () => {
      posts++;
      return json({ id: 401 });
    },
  });
  await assert.rejects(
    writer.dispatch({
      plan,
      reserve: async () => {
        throw new Error('synthetic pre-reservation failure');
      },
    }),
  );
  await assert.rejects(
    writer.dispatch({
      plan: { ...plan, encoded: '{"idContato":999}' },
      reserve: async () => TICKET,
    }),
  );
  assert.equal(posts, 0);
});

test('T08 all post-reservation errors remain uncertain and never expose upstream content or retry', async () => {
  const { plan } = fixture();
  for (const response of [
    json({ error: 'PRIVATE_SALE_BUYER_CANARY' }, 400),
    json({}, 401),
    json({}, 429),
    json({}, 500),
    json({ id: '401' }),
    new globalThis.Response('{"id":401', {
      headers: { 'content-type': 'application/json' },
    }),
    new globalThis.Response('PRIVATE_SALE_BUYER_CANARY', {
      headers: { 'content-type': 'text/html' },
    }),
  ]) {
    let posts = 0;
    const writer = createOlistSaleWriter({
      credentials: async () => ({ token: 'synthetic-token', version: 1 }),
      quota: { reserve: async () => {}, block: async () => {} },
      fetch: async () => {
        posts++;
        return response;
      },
    });
    await assert.rejects(
      writer.dispatch({ plan, reserve: async () => TICKET }),
      (error) => {
        const failure = /** @type {any} */ (error);
        assert.equal(failure.code, 'OLIST_SALE_UNCERTAIN');
        assert.equal(failure.reservation, TICKET);
        assert.doesNotMatch(
          JSON.stringify(failure),
          /PRIVATE_|synthetic-token/u,
        );
        return true;
      },
    );
    assert.equal(posts, 1);
  }
});

test('T08 known POST identity survives quota persistence or optional-number failure for immediate durable observation', async () => {
  const { plan } = fixture();
  for (const invalidNumber of [false, true]) {
    const writer = createOlistSaleWriter({
      credentials: async () => ({ token: 'synthetic', version: 1 }),
      quota: {
        reserve: async () => {},
        observe: async () => {
          throw new Error('synthetic quota failure');
        },
      },
      fetch: async () =>
        json({
          id: 401,
          numeroPedido: invalidNumber ? 'invalid-private-number' : 99,
        }),
    });
    const result = await writer.dispatch({ plan, reserve: async () => TICKET });
    assert.equal(result.remoteId, '401');
    assert.equal(result.quotaObservationFailed, true);
    assert.equal(result.invalidResponse, invalidNumber);
    assert.equal(result.remoteNumber, invalidNumber ? null : '99');
    assert.doesNotMatch(JSON.stringify(result), /invalid-private-number/u);
  }
});

test('T08 POST preserves 19-digit observed identities and signals unsafe GET addressing', async () => {
  const { plan } = fixture();
  for (const [id, number, unsafe] of [
    ['9007199254740991', '9007199254740993', false],
    ['9007199254740993', '9999999999999999999', true],
    ['9.007199254740993e15', '99e1', true],
  ]) {
    /** @type {string[]} */
    const events = [];
    const writer = createOlistSaleWriter({
      credentials: async () => ({ token: 'synthetic', version: 1 }),
      quota: { reserve: async () => {}, observe: async () => {} },
      fetch: async (_url, init) => {
        events.push(String(init?.method));
        assert.equal(init?.method, 'POST');
        return new globalThis.Response(
          '{"id":' + id + ',"numeroPedido":' + number + '}',
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const response = await writer.dispatch({
      plan,
      reserve: async () => TICKET,
    });
    assert.equal(
      response.remoteId,
      id === '9007199254740991' ? id : '9007199254740993',
    );
    assert.equal(response.remoteNumber, number === '99e1' ? '990' : number);
    assert.equal(response.invalidResponse, unsafe);
    assert.equal(response.reservation, TICKET);
    assert.deepEqual(response.body, {
      id: response.remoteId,
      number: response.remoteNumber,
    });
    assert.deepEqual(events, ['POST']);
  }
  for (const token of [
    '0',
    '-1',
    '1.1',
    '10000000000000000000',
    '1e20',
    '"401"',
  ])
    assert.throws(
      () => olistIdentifierFromJson(parseOlistLosslessJson(token)),
      {
        code: 'OLIST_INVALID_RESPONSE',
      },
    );
  assert.throws(
    () => olistIntegerFromJson(parseOlistLosslessJson('9007199254740993')),
    {
      code: 'OLIST_INVALID_RESPONSE',
    },
  );
});

test('T08 raw sale client keeps numeric lexemes, bounded official route and quota semantics', async () => {
  const { plan } = fixture();
  /** @type {string[]} */
  const events = [];
  const raw = rawOrder(plan);
  const client = createOlistClient({
    credentials: async () => {
      events.push('credentials');
      return { token: 'synthetic', version: 1 };
    },
    quota: {
      reserve: async () => {
        events.push('quota');
      },
      observe: async () => {
        events.push('observe');
      },
    },
    fetch: async (url, init) => {
      events.push('GET');
      assert.equal(
        String(url),
        'https://api.tiny.com.br/public-api/v3/pedidos/401',
      );
      assert.equal(init?.method, 'GET');
      return new globalThis.Response(raw, {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(await client.orderRaw(401), raw);
  assert.deepEqual(events, ['credentials', 'quota', 'GET', 'observe']);
  await assert.rejects(client.orderRaw(0), { code: 'INVALID_REQUEST' });
});
