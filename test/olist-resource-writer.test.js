import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildCustomerPayload,
  buildProductPayload,
  buildVariationPayload,
  productDescription,
  validateResourcePayload,
} from '../modules/olist/src/resource-payloads.js';
import { createOlistResourceWriter } from '../modules/olist/src/resource-writer.js';

const REFERENCE = 'CRM-11111111-1111-4111-8111-111111111111';
const RESERVATION = Object.freeze({
  attemptId: 'synthetic-attempt',
  fence: 'synthetic-fence',
  batch: ['synthetic-child'],
});
const ATTRIBUTES = Object.freeze({
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Bordado',
  collar: 'Redonda',
  audience: '',
});
const FISCAL = Object.freeze({ ncm: '6109.10.00', origin: 0, unit: 'UN' });
/** @returns {any} */
function customer() {
  return {
    tipoPessoa: 'F',
    cpfCnpj: '529.982.247-25',
    nome: 'Comprador sintético',
    celular: '5511999990000',
    email: 'synthetic@example.test',
    endereco: {
      cep: '29010-000',
      municipio: 'Vitória',
      uf: 'ES',
      endereco: 'Rua sintética',
      bairro: 'Centro',
      numero: '10',
    },
    situacao: 'B',
  };
}
/** @param {unknown} body @param {ResponseInit} [init] */
function json(body, init = {}) {
  return new globalThis.Response(JSON.stringify(body), {
    status: 201,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}
/** @param {(url:string,init:RequestInit)=>Promise<Response>|Response} [handler] */
function fixture(handler = () => json({ id: 701 })) {
  /** @type {string[]} */
  const events = [];
  /** @type {{url:string,init:RequestInit}[]} */
  const requests = [];
  const writer = createOlistResourceWriter({
    credentials: async () => {
      events.push('credentials');
      return { token: 'synthetic-token', version: 7 };
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
      requests.push({ url: String(url), init: init ?? {} });
      return handler(String(url), init ?? {});
    },
  });
  const reserve = async (
    /** @type {any} */ payload,
    /** @type {any} */ metadata,
  ) => {
    events.push('reserve');
    assert.ok(Object.isFrozen(payload));
    assert.deepEqual(metadata, { connectionVersion: 7 });
    return RESERVATION;
  };
  return { writer, events, requests, reserve };
}

test('T22 customer builder validates fiscal completeness and never emits employee access or unproven codigo', () => {
  const payload = buildCustomerPayload(customer(), REFERENCE);
  assert.equal(payload.cpfCnpj, '52998224725');
  assert.equal(payload.endereco.cep, '29010000');
  assert.equal(payload.situacao, 'B');
  assert.equal(Object.hasOwn(payload, 'codigo'), false);
  assert.deepEqual(Object.keys(payload).sort(), [
    'celular',
    'cpfCnpj',
    'email',
    'endereco',
    'nome',
    'situacao',
    'tipoPessoa',
  ]);
  const source = customer();
  assert.throws(
    () =>
      buildCustomerPayload({ ...source, cpfCnpj: '12345678900' }, REFERENCE),
    { code: 'OLIST_CUSTOMER_INVALID' },
  );
  assert.throws(
    () => buildCustomerPayload({ ...source, situacao: 'A' }, REFERENCE),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () =>
      buildCustomerPayload({ ...source, observacoes: 'private' }, REFERENCE),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () => buildCustomerPayload({ ...source, codigo: REFERENCE }, REFERENCE),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () => buildCustomerPayload(source, 'https://other.example.test'),
    { code: 'INVALID_REQUEST' },
  );
  const company = { ...source, tipoPessoa: 'J', cpfCnpj: '04252011000110' };
  assert.throws(() => buildCustomerPayload(company, REFERENCE), {
    code: 'OLIST_CUSTOMER_INVALID',
  });
  assert.equal(
    buildCustomerPayload({ ...company, inscricaoEstadual: 'ISENTO' }, REFERENCE)
      .inscricaoEstadual,
    'ISENTO',
  );
});

test('T22 product and variation builders use explicit fiscal data and a nonempty initial size batch without catalog prices', () => {
  const input = {
    attributes: ATTRIBUTES,
    sku: REFERENCE,
    fiscal: FISCAL,
    variations: [
      { size: 'M', sku: 'CRM-V-M' },
      { size: 'G', sku: 'CRM-V-G' },
    ],
  };
  const before = structuredClone(input);
  const payload = buildProductPayload(input);
  assert.deepEqual(input, before);
  assert.equal(
    payload.descricao,
    'Camisa | Azul | ["Algodão"] | Bordado | Redonda',
  );
  assert.equal(payload.descricao, productDescription(ATTRIBUTES));
  assert.deepEqual(payload.grade, ['Tamanho']);
  assert.equal(payload.ncm, '61091000');
  assert.equal(payload.origem, 0);
  assert.equal(payload.unidade, 'UN');
  assert.deepEqual(payload.variacoes[0], {
    sku: 'CRM-V-M',
    grade: [{ chave: 'Tamanho', valor: 'M' }],
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /precos|estoque|anexos|observacoes|tributacao/,
  );
  for (const variations of [
    [],
    [
      { size: 'M', sku: 'CRM-V-M' },
      { size: 'm', sku: 'CRM-V-G' },
    ],
    [
      { size: 'M', sku: 'CRM-V-M' },
      { size: 'G', sku: 'CRM-V-M' },
    ],
  ])
    assert.throws(() => buildProductPayload({ ...input, variations }), {
      code: 'INVALID_REQUEST',
    });
  assert.throws(
    () => buildProductPayload({ ...input, fiscal: { ...FISCAL, origin: 9 } }),
    { code: 'OLIST_PRODUCT_FISCAL_REQUIRED' },
  );
  assert.throws(
    () =>
      buildProductPayload({
        ...input,
        fiscal: { ncm: '0000000', unit: 'UN', origin: 0 },
      }),
    { code: 'OLIST_PRODUCT_FISCAL_REQUIRED' },
  );
  const deferred = buildProductPayload({ ...input, fiscal: null });
  for (const field of [
    'ncm',
    'origem',
    'unidade',
    'estoque',
    'tributacao',
    'situacao',
  ])
    assert.equal(Object.hasOwn(deferred, field), false);
  assert.deepEqual(validateResourcePayload('product', deferred), deferred);
  assert.throws(() => buildProductPayload({ ...input, fiscal: undefined }), {
    code: 'INVALID_REQUEST',
  });
  for (const partial of [
    { ncm: '61091000' },
    { origem: 0 },
    { unidade: 'UN' },
    { ncm: null, origem: null, unidade: null },
  ])
    assert.throws(() =>
      validateResourcePayload('product', { ...deferred, ...partial }),
    );
  assert.throws(
    () => buildProductPayload(/** @type {any} */ ({ ...input, stock: 0 })),
    {
      code: 'INVALID_REQUEST',
    },
  );
  assert.deepEqual(
    buildVariationPayload({ size: 'M', sku: 'CRM-V-M', fiscal: FISCAL }),
    { sku: 'CRM-V-M', grade: [{ chave: 'Tamanho', valor: 'M' }] },
  );
});

test('T22 emitted fields match the captured official create schemas including inherited allOf fields', async () => {
  const captured = JSON.parse(
    await readFile(
      new URL(
        '../docs/integrations/olist/evidence/openapi-v3.projection.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  /** @param {any} schema @returns {{properties:Record<string,any>,required:string[]}} */
  function resolve(schema) {
    if (schema.$ref)
      return resolve(
        captured.components.schemas[schema.$ref.split('/').at(-1)],
      );
    const result = {
      properties: { ...schema.properties },
      required: [...(schema.required ?? [])],
    };
    for (const part of schema.allOf ?? []) {
      const resolved = resolve(part);
      Object.assign(result.properties, resolved.properties);
      result.required.push(...resolved.required);
    }
    return result;
  }
  for (const [kind, value] of /** @type {[string,any][]} */ ([
    ['CriarContatoModelRequest', buildCustomerPayload(customer(), REFERENCE)],
    [
      'CriarProdutoRequestModel',
      buildProductPayload({
        attributes: ATTRIBUTES,
        sku: REFERENCE,
        fiscal: FISCAL,
        variations: [{ size: 'M', sku: 'CRM-V-M' }],
      }),
    ],
    [
      'VariacaoProdutoRequestModel',
      buildVariationPayload({ size: 'M', sku: 'CRM-V-M' }),
    ],
    [
      'CriarProdutoRequestModel',
      buildProductPayload({
        attributes: ATTRIBUTES,
        sku: REFERENCE,
        fiscal: null,
        variations: [{ size: 'M', sku: 'CRM-V-M' }],
      }),
    ],
  ])) {
    const model = resolve(
      captured.components.schemas[/** @type {string} */ (kind)],
    );
    for (const key of Object.keys(value))
      assert.ok(Object.hasOwn(model.properties, key), key);
    for (const key of model.required) assert.ok(Object.hasOwn(value, key), key);
  }
  assert.ok(captured.paths['/produtos/{idProduto}/variacoes'].post);
});

test('T22 writer reserves after credentials and quota and then sends one immutable allowlisted official POST', async () => {
  const f = fixture();
  const payload = buildCustomerPayload(customer(), REFERENCE);
  const result = await f.writer.dispatch({
    kind: 'customer',
    payload,
    reserve: f.reserve,
  });
  assert.deepEqual(f.events, [
    'credentials',
    'quota',
    'reserve',
    'POST',
    'observe',
  ]);
  assert.equal(result.remoteId, '701');
  assert.equal(result.reservation, RESERVATION);
  assert.equal(result.quotaObservationFailed, false);
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.requests[0].url,
    'https://api.tiny.com.br/public-api/v3/contatos',
  );
  const init = f.requests[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(
    /** @type {any} */ (init.headers).authorization,
    'Bearer synthetic-token',
  );
  assert.deepEqual(JSON.parse(String(init.body)), payload);
});

test('T22 closed routes cover compound parent and extra variation; observed variation ID is not treated as a linked child', async () => {
  const f = fixture(() =>
    json({ id: 88, variacoes: [{ id: 89, codigo: 'CRM-V-M' }] }),
  );
  await f.writer.dispatch({
    kind: 'product',
    payload: buildProductPayload({
      attributes: ATTRIBUTES,
      sku: REFERENCE,
      fiscal: FISCAL,
      variations: [{ size: 'M', sku: 'CRM-V-M' }],
    }),
    reserve: f.reserve,
  });
  assert.equal(
    f.requests[0].url,
    'https://api.tiny.com.br/public-api/v3/produtos',
  );
  const result = await f.writer.dispatch({
    kind: 'variation',
    parentRemoteId: 88,
    payload: buildVariationPayload({ size: 'G', sku: 'CRM-V-G' }),
    reserve: f.reserve,
  });
  assert.equal(
    f.requests[1].url,
    'https://api.tiny.com.br/public-api/v3/produtos/88/variacoes',
  );
  assert.equal(
    result.remoteId,
    '88',
    'Observed parent ID remains evidence; resolver must verify child by parent/SKU/grade',
  );
  assert.deepEqual(result.body, {
    id: 88,
    variacoes: [{ id: 89, codigo: 'CRM-V-M' }],
  });
});

test('T22 invalid kind, parent, payload, reservation callback and fiscal fields cannot reach credentials or HTTP', async () => {
  const f = fixture();
  const payload = buildCustomerPayload(customer(), REFERENCE);
  for (const input of [
    { kind: 'sale', payload, reserve: f.reserve },
    { kind: 'customer', parentRemoteId: 1, payload, reserve: f.reserve },
    {
      kind: 'variation',
      parentRemoteId: '../1',
      payload: buildVariationPayload({ size: 'M', sku: 'CRM-V-M' }),
      reserve: f.reserve,
    },
    {
      kind: 'customer',
      payload: { ...payload, notes: 'private' },
      reserve: f.reserve,
    },
    { kind: 'customer', payload, reserve: undefined },
    {
      kind: 'customer',
      payload: { ...payload, situacao: 'A' },
      reserve: f.reserve,
    },
  ])
    await assert.rejects(f.writer.dispatch(/** @type {any} */ (input)), {
      code: 'INVALID_REQUEST',
    });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.requests, []);
  assert.throws(
    () =>
      validateResourcePayload('product', {
        sku: REFERENCE,
        tipo: 'V',
        descricao: 'synthetic',
        ncm: '61091000',
        origem: 0,
        unidade: 'UN',
        grade: ['Tamanho'],
        variacoes: [
          {
            sku: 'CRM-V-M',
            grade: [{ chave: 'Tamanho', valor: 'M' }],
            precos: { preco: 1 },
          },
        ],
      }),
    { code: 'INVALID_REQUEST' },
  );
});

test('T22 failure before a returned durable reservation performs zero HTTP calls', async () => {
  let posts = 0;
  const payload = buildCustomerPayload(customer(), REFERENCE);
  const sentinel = Object.assign(new Error('safe'), { code: 'FORBIDDEN' });
  for (const stage of ['credentials', 'quota', 'reserve']) {
    const writer = createOlistResourceWriter({
      credentials: async () => {
        if (stage === 'credentials') throw sentinel;
        return { token: 'synthetic-token', version: 1 };
      },
      quota: {
        reserve: async () => {
          if (stage === 'quota') throw sentinel;
        },
        observe: async () => {},
      },
      fetch: async () => {
        posts++;
        return json({ id: 1 });
      },
    });
    await assert.rejects(
      writer.dispatch({
        kind: 'customer',
        payload,
        reserve: async () => {
          throw sentinel;
        },
      }),
      { code: 'FORBIDDEN' },
    );
  }
  assert.equal(posts, 0);
});

test('T22 every failed or invalid post-reservation response is uncertain with no raw upstream cause and never retried', async () => {
  const privateText = 'synthetic-private fiscal data token';
  const handlers = [
    () => {
      throw new Error(privateText);
    },
    () => new globalThis.Response(privateText, { status: 500 }),
    () => new globalThis.Response(privateText, { status: 400 }),
    () => new globalThis.Response(privateText, { status: 401 }),
    () => new globalThis.Response(privateText, { status: 429 }),
    () =>
      new globalThis.Response(privateText, {
        status: 302,
        headers: { location: 'https://evil.example.test' },
      }),
    () =>
      new globalThis.Response(privateText, {
        status: 201,
        headers: { 'content-type': 'text/plain' },
      }),
    () =>
      new globalThis.Response('{"id":', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    () => json({ id: 0 }),
    () => json({ id: '1' }),
    () => json([1]),
    () => json({ id: Number.MAX_SAFE_INTEGER + 1 }),
    () => json({ id: 1 }, { status: 202 }),
    () =>
      json(
        { id: 1 },
        {
          headers: {
            'content-type': 'application/json',
            'content-length': '99999999',
          },
        },
      ),
  ];
  for (const handler of handlers) {
    const f = fixture(handler);
    await assert.rejects(
      f.writer.dispatch({
        kind: 'customer',
        payload: buildCustomerPayload(customer(), REFERENCE),
        reserve: f.reserve,
      }),
      (error) => {
        const candidate = /** @type {any} */ (error);
        assert.equal(candidate.code, 'OLIST_RESOURCE_UNCERTAIN');
        assert.equal(candidate.reservation, RESERVATION);
        assert.equal(candidate.cause, undefined);
        assert.doesNotMatch(
          JSON.stringify(candidate),
          /synthetic-private|529982|token/,
        );
        return true;
      },
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.events, ['credentials', 'quota', 'reserve', 'POST']);
  }
});

test('T22 response size is bounded during streaming and oversize does not permit another POST', async () => {
  const f = fixture(() => json({ id: 1, echo: 'x'.repeat(270000) }));
  await assert.rejects(
    f.writer.dispatch({
      kind: 'customer',
      payload: buildCustomerPayload(customer(), REFERENCE),
      reserve: f.reserve,
    }),
    { code: 'OLIST_RESOURCE_UNCERTAIN' },
  );
  assert.equal(f.requests.length, 1);
});

test('T22 a known ID survives failure to persist quota hints so the resolver can persist it before stopping dependencies', async () => {
  const writer = createOlistResourceWriter({
    credentials: async () => ({ token: 'synthetic-token', version: 1 }),
    quota: {
      reserve: async () => {},
      observe: async () => {
        throw new Error('synthetic quota persistence failure');
      },
    },
    fetch: async () => json({ id: 91 }),
  });
  const result = await writer.dispatch({
    kind: 'customer',
    payload: buildCustomerPayload(customer(), REFERENCE),
    reserve: async () => RESERVATION,
  });
  assert.equal(result.remoteId, '91');
  assert.equal(result.quotaObservationFailed, true);
  assert.equal(result.reservation, RESERVATION);
});

test('T22 mutable caller payload cannot change the serialized body between validation, quota and reservation', async () => {
  const payload = buildCustomerPayload(customer(), REFERENCE);
  let serialized = '';
  const writer = createOlistResourceWriter({
    credentials: async () => {
      payload.nome = 'mutated';
      return { token: 'synthetic-token', version: 1 };
    },
    quota: { reserve: async () => {}, observe: async () => {} },
    fetch: async (_url, init) => {
      serialized = String(init?.body);
      return json({ id: 1 });
    },
  });
  await writer.dispatch({
    kind: 'customer',
    payload,
    reserve: async (copy) => {
      assert.equal(copy.nome, 'Comprador sintético');
      assert.throws(() => {
        copy.nome = 'changed';
      }, TypeError);
      return RESERVATION;
    },
  });
  assert.equal(JSON.parse(serialized).nome, 'Comprador sintético');
});

/** @param {{refuse?:boolean,legacy?:boolean}} [config] */
function writeQuotaFixture(config = {}) {
  /** @type {string[]} */
  const events = [];
  /** @type {any[]} */
  const writes = [];
  let posts = 0;
  const writer = createOlistResourceWriter({
    credentials: async () => {
      events.push('credentials');
      return { token: 'synthetic-token', version: 7 };
    },
    quota: {
      reserve: async () => {
        events.push('reserve-legacy');
      },
      ...(config.legacy
        ? {}
        : {
            reserveWrite: async (/** @type {any} */ input) => {
              events.push('reserveWrite');
              writes.push(input);
              if (config.refuse)
                throw Object.assign(new Error('OLIST_RATE_LIMITED'), {
                  code: 'OLIST_RATE_LIMITED',
                  retryAfterMs: 30_000,
                });
            },
          }),
      observe: async () => {},
    },
    fetch: async () => {
      posts += 1;
      events.push('POST');
      return json({ id: 701 });
    },
  });
  const reserve = async () => {
    events.push('ticket');
    return RESERVATION;
  };
  return { writer, events, writes, reserve, posts: () => posts };
}
/** @param {string} kind */
function payloadFor(kind) {
  if (kind === 'customer')
    return { payload: buildCustomerPayload(customer(), REFERENCE) };
  if (kind === 'product')
    return {
      payload: buildProductPayload({
        attributes: ATTRIBUTES,
        sku: REFERENCE,
        fiscal: FISCAL,
        variations: [{ size: 'M', sku: 'CRM-V-M' }],
      }),
    };
  return {
    parentRemoteId: 88,
    payload: buildVariationPayload({ size: 'G', sku: 'CRM-V-G' }),
  };
}

test('L2 resource POST reserves write headroom per kind BEFORE the durable ticket and never waits', async () => {
  for (const [kind, readbacks] of /** @type {Array<[string, number]>} */ ([
    ['customer', 2],
    ['product', 2],
    ['variation', 3],
  ])) {
    const f = writeQuotaFixture();
    await f.writer.dispatch({
      kind,
      ...payloadFor(kind),
      reserve: f.reserve,
    });
    assert.deepEqual(f.writes, [{ readbacks }]);
    assert.deepEqual(f.events, [
      'credentials',
      'reserveWrite',
      'ticket',
      'POST',
    ]);
  }
});

test('L2 resource POST without write headroom creates no ticket and sends no POST', async () => {
  for (const kind of ['customer', 'product', 'variation']) {
    const f = writeQuotaFixture({ refuse: true });
    await assert.rejects(
      f.writer.dispatch({ kind, ...payloadFor(kind), reserve: f.reserve }),
      { code: 'OLIST_RATE_LIMITED', retryAfterMs: 30_000 },
    );
    assert.deepEqual(f.events, ['credentials', 'reserveWrite']);
    assert.equal(f.posts(), 0);
  }
});

test('L2 a quota without reserveWrite keeps the legacy single reserve', async () => {
  const f = writeQuotaFixture({ legacy: true });
  await f.writer.dispatch({
    kind: 'customer',
    ...payloadFor('customer'),
    reserve: f.reserve,
  });
  assert.deepEqual(f.events, [
    'credentials',
    'reserve-legacy',
    'ticket',
    'POST',
  ]);
});
