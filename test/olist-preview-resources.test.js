import assert from 'node:assert/strict';
import test from 'node:test';
import {
  identityHash,
  olistResourceIdentityHash,
  createOlistClient,
} from '../modules/olist/src/index.js';
import { planOlistResources } from '../apps/api/src/olist-preview-resources.js';

const config = { accountKey: 'a'.repeat(64), hmacKey: Buffer.alloc(32, 13) };
const attrs = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Polo',
  audience: '',
};
const norm = (/** @type {string} */ value) =>
  value.normalize('NFC').trim().toLocaleLowerCase('pt-BR');
const productHash = (/** @type {any} */ attributes) =>
  identityHash(config.hmacKey, 'product', [
    config.accountKey,
    ['garment', 'color', 'fabric', 'application', 'collar', 'audience'].map(
      (key) => norm(attributes[key]),
    ),
  ]);
/** @param {any} [patch] */
function fixture(patch = {}) {
  const plan = {
    customer: { cpfCnpj: '52998224725', tipoPessoa: 'F' },
    commercial: {
      groups: [
        {
          groupId: 'group-a',
          attributes: attrs,
          lines: [{ lineId: 'line-a', size: 'M' }],
        },
      ],
    },
  };
  /** @type {{method:string,value:any}[]} */
  const calls = [];
  const parent = {
    id: 10,
    tipo: 'V',
    situacao: 'A',
    sku: 'CRM-P-' + productHash(attrs),
    descricao: Object.values(attrs).filter(Boolean).join(' | '),
    variacoes: [
      { id: 11, sku: 'size-m', grade: [{ chave: 'Tamanho', valor: 'M' }] },
    ],
  };
  const client = {
    async findCustomer(/** @type {any} */ value) {
      calls.push({ method: 'findCustomer', value });
      return { id: 1 };
    },
    async contact(/** @type {any} */ value) {
      calls.push({ method: 'contact', value });
      return {
        id: value,
        cpfCnpj: '529.982.247-25',
        tipoPessoa: 'F',
        situacao: 'B',
        observacoes: 'private-upstream',
      };
    },
    async findProduct(/** @type {any} */ value) {
      calls.push({ method: 'findProduct', value });
      return { id: 10, codigo: value };
    },
    async product(/** @type {any} */ value) {
      calls.push({ method: 'product', value });
      return value === 10
        ? parent
        : {
            id: value,
            produtoPai: { id: 10 },
            tipoVariacao: 'V',
            situacao: 'A',
            sku: 'size-m',
          };
    },
    ...patch,
  };
  return { plan, calls, parent, client };
}

test('preview discovers customer, cryptographically identified parent and exact size with GET ports only', async () => {
  const { plan, calls, client } = fixture();
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.deepEqual(result, {
    customer: { action: 'reuse', remoteId: '1' },
    groups: [
      {
        groupId: 'group-a',
        action: 'reuse',
        remoteId: '10',
        lines: [{ lineId: 'line-a', action: 'reuse', remoteId: '11' }],
      },
    ],
    issues: [],
  });
  assert.equal(calls.length, 5);
  assert.ok(
    calls.every((call) =>
      ['findCustomer', 'contact', 'findProduct', 'product'].includes(
        call.method,
      ),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /529|private-upstream|observacoes/,
  );
});

test('absent records form creation plan but missing fiscal policy blocks product creation without defaults', async () => {
  const { plan, client } = fixture({
    findCustomer: async () => null,
    findProduct: async () => null,
  });
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(result.customer.action, 'create');
  assert.equal(result.groups[0].action, 'create');
  assert.equal(result.groups[0].lines[0].action, 'create');
  assert.deepEqual(result.issues, [
    { code: 'OLIST_PRODUCT_FISCAL_REQUIRED', field: 'groups.group-a' },
  ]);
});

test('uncertain, reserved and rejected resources require reconciliation and cannot become absent/new creations', async () => {
  for (const state of ['uncertain', 'reserved', 'rejected']) {
    const { plan, calls, client } = fixture();
    const resources = [
      {
        account_key: config.accountKey,
        kind: 'product',
        identity_hash: productHash(attrs),
        id: 'local-parent',
        state,
      },
    ];
    const result = await planOlistResources({
      config,
      plan,
      client,
      resources,
    });
    assert.equal(result.groups[0].action, 'blocked');
    assert.equal(result.groups[0].lines[0].action, 'blocked');
    assert.ok(
      result.issues.some(
        (entry) => entry.code === 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
      ),
    );
    assert.ok(
      calls.every((call) => !['findProduct', 'product'].includes(call.method)),
    );
  }
});

test('verified account-bound links are prioritized and variation link must match the current parent size', async () => {
  const { plan, client, calls } = fixture();
  const parentId = 'local-parent';
  const resources = [
    {
      account_key: config.accountKey,
      kind: 'customer',
      identity_hash: identityHash(config.hmacKey, 'customer', [
        config.accountKey,
        plan.customer.cpfCnpj,
      ]),
      state: 'confirmed',
      remote_id: '1',
    },
    {
      account_key: config.accountKey,
      kind: 'product',
      identity_hash: productHash(attrs),
      id: parentId,
      state: 'confirmed',
      remote_id: '10',
    },
    {
      account_key: config.accountKey,
      kind: 'variation',
      identity_hash: identityHash(config.hmacKey, 'variation', [
        config.accountKey,
        [parentId, 'm'],
      ]),
      state: 'confirmed',
      remote_id: '12',
    },
  ];
  const result = await planOlistResources({ config, plan, client, resources });
  assert.equal(result.customer.action, 'reuse');
  assert.equal(result.groups[0].action, 'reuse');
  assert.equal(result.groups[0].lines[0].action, 'blocked');
  assert.deepEqual(result.issues, [
    { code: 'OLIST_VARIATION_DIVERGENT', field: 'groups.group-a.lines.line-a' },
  ]);
  assert.ok(calls.every((call) => !call.method.startsWith('find')));
});

test('same size in different groups never reuses the other parent variation', async () => {
  const { plan, client, parent } = fixture();
  const second = structuredClone(plan.commercial.groups[0]);
  second.groupId = 'group-b';
  second.attributes = { ...attrs, color: 'Verde' };
  second.lines[0].lineId = 'line-b';
  plan.commercial.groups.push(second);
  client.findProduct = async (/** @type {string} */ sku) => ({
    id: sku === parent.sku ? 10 : 20,
    codigo: sku,
  });
  client.product = async (/** @type {number} */ id) =>
    id === 10
      ? parent
      : id === 20
        ? {
            ...parent,
            id: 20,
            sku: 'CRM-P-' + productHash(second.attributes),
            descricao: Object.values(second.attributes)
              .filter(Boolean)
              .join(' | '),
            variacoes: [
              {
                id: 21,
                sku: 'size-m-b',
                grade: [{ chave: 'Tamanho', valor: 'M' }],
              },
            ],
          }
        : {
            id,
            produtoPai: { id: id === 11 ? 10 : 20 },
            tipoVariacao: 'V',
            situacao: 'A',
            sku: id === 11 ? 'size-m' : 'size-m-b',
          };
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.groups[0].lines[0].remoteId, '11');
  assert.equal(result.groups[1].lines[0].remoteId, '21');
});

test('ambiguous customers and names without verifiable product attributes block safely', async () => {
  const { plan, client, parent } = fixture({
    findCustomer: async () => {
      throw Object.assign(new Error('private-upstream'), {
        code: 'OLIST_AMBIGUOUS_MATCH',
      });
    },
  });
  parent.descricao = 'Camisa';
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(result.customer.action, 'blocked');
  assert.equal(result.groups[0].action, 'blocked');
  assert.deepEqual(
    result.issues.map((entry) => entry.code),
    ['OLIST_AMBIGUOUS_MATCH', 'OLIST_PRODUCT_ATTRIBUTES_UNVERIFIED'],
  );
  assert.doesNotMatch(JSON.stringify(result), /private-upstream/);
});

test('duplicate sizes, wrong parent, inactive customer and incomplete lookups never permit reuse', async () => {
  const { plan, client, parent } = fixture();
  parent.variacoes.push({ ...parent.variacoes[0], id: 12 });
  client.contact = async (/** @type {number} */ id) => ({
    id,
    cpfCnpj: '52998224725',
    tipoPessoa: 'F',
    situacao: 'I',
  });
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(result.customer.action, 'blocked');
  assert.equal(result.groups[0].lines[0].action, 'blocked');
  assert.deepEqual(
    result.issues.map((entry) => entry.code),
    ['OLIST_CUSTOMER_DIVERGENT', 'OLIST_AMBIGUOUS_MATCH'],
  );
  const other = fixture({
    findProduct: async () => {
      throw Object.assign(new Error('private-upstream'), {
        code: 'OLIST_INCOMPLETE_LOOKUP',
      });
    },
  });
  const failed = await planOlistResources({
    config,
    plan: other.plan,
    client: other.client,
    resources: [],
  });
  assert.equal(failed.groups[0].action, 'blocked');
  assert.equal(failed.issues[0].code, 'OLIST_INCOMPLETE_LOOKUP');
});

test('resource identity remains compatible and accepts optional audience plus complete fabric combinations', () => {
  const prior = { ...attrs, audience: 'Adulto' };
  assert.equal(
    olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind: 'product',
      identity: prior,
    }),
    productHash(prior),
  );
  assert.equal(
    olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind: 'product',
      identity: attrs,
    }),
    productHash(attrs),
  );
  const long = {
    ...attrs,
    fabric: JSON.stringify(['A'.repeat(200), 'B'.repeat(200)]),
  };
  assert.equal(
    olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind: 'product',
      identity: long,
    }),
    productHash(long),
  );
  for (const field of ['garment', 'color', 'fabric', 'application', 'collar'])
    assert.throws(
      () =>
        olistResourceIdentityHash(config.hmacKey, {
          accountKey: config.accountKey,
          kind: 'product',
          identity: { ...attrs, [field]: '' },
        }),
      { code: 'INVALID_REQUEST' },
    );
});

test('actual client discovery uses bounded official GET endpoints and never enables creation methods', async () => {
  const { plan } = fixture();
  const calls = [];
  const client = createOlistClient({
    credentials: async () => ({ token: 'synthetic-token', version: 1 }),
    quota: {
      reserve: async () => {},
      observe: async () => {},
      block: async () => {},
    },
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.match(
        String(url),
        /^https:\/\/api\.tiny\.com\.br\/public-api\/v3\/(contatos|produtos)\?/,
      );
      return new globalThis.Response(
        JSON.stringify({ itens: [], paginacao: { total: 0, offset: 0 } }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(calls.length, 11);
  assert.equal(result.customer.action, 'create');
  assert.equal(result.groups[0].action, 'create');
});

test('logical discovery budget stops further reads even for many distinct groups', async () => {
  const { plan, calls, client } = fixture();
  client.findProduct = async (/** @type {string} */ value) => {
    calls.push({ method: 'findProduct', value });
    return null;
  };
  plan.commercial.groups = Array.from({ length: 80 }, (_, index) => ({
    groupId: 'group-' + index,
    attributes: { ...attrs, color: 'Cor ' + index },
    lines: [{ lineId: 'line-' + index, size: 'M' }],
  }));
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(calls.length, 64);
  assert.ok(
    result.issues.some((entry) => entry.code === 'OLIST_INCOMPLETE_LOOKUP'),
  );
});

test('confirmed parent links revalidate SKU and attributes even when local identity hash still matches', async () => {
  for (const field of ['sku', 'descricao']) {
    const { plan, client, parent } = fixture();
    parent[/** @type {'sku'|'descricao'} */ (field)] = 'changed remotely';
    const resources = [
      {
        account_key: config.accountKey,
        kind: 'product',
        identity_hash: productHash(attrs),
        id: 'local-parent',
        state: 'confirmed',
        remote_id: '10',
      },
    ];
    const result = await planOlistResources({
      config,
      plan,
      client,
      resources,
    });
    assert.equal(result.groups[0].action, 'blocked');
    assert.equal(result.groups[0].lines[0].action, 'blocked');
    assert.deepEqual(result.issues, [
      { code: 'OLIST_PRODUCT_ATTRIBUTES_UNVERIFIED', field: 'groups.group-a' },
    ]);
  }
});

test('customer reuse revalidates legal name, explicit IE and fiscal address without overwriting ERP', async () => {
  const expected = {
    nome: 'Comprador Sintético',
    inscricaoEstadual: 'ISENTO',
    endereco: {
      cep: '29010000',
      municipio: 'Vitória',
      uf: 'ES',
      endereco: 'Rua de Teste',
      bairro: 'Centro',
      numero: '12',
    },
  };
  for (const changed of [
    'nome',
    'inscricaoEstadual',
    'municipio',
    'cep',
    'numero',
    'complemento',
  ]) {
    const { plan, client } = fixture();
    Object.assign(plan.customer, expected);
    client.contact = async (/** @type {number} */ id) => ({
      id,
      ...plan.customer,
      endereco: { ...expected.endereco },
      ...(changed === 'nome' || changed === 'inscricaoEstadual'
        ? { [changed]: 'changed' }
        : { endereco: { ...expected.endereco, [changed]: 'changed' } }),
      situacao: 'B',
    });
    const resources = [
      {
        account_key: config.accountKey,
        kind: 'customer',
        identity_hash: identityHash(config.hmacKey, 'customer', [
          config.accountKey,
          plan.customer.cpfCnpj,
        ]),
        state: 'confirmed',
        remote_id: '1',
      },
    ];
    const result = await planOlistResources({
      config,
      plan,
      client,
      resources,
    });
    assert.equal(result.customer.action, 'blocked');
    assert.ok(
      result.issues.some((entry) => entry.code === 'OLIST_CUSTOMER_DIVERGENT'),
    );
  }
  const { plan, client } = fixture();
  Object.assign(plan.customer, expected);
  client.contact = async (/** @type {number} */ id) => ({
    id,
    ...plan.customer,
    endereco: { ...expected.endereco, cep: '29010-000' },
    situacao: 'B',
  });
  const result = await planOlistResources({
    config,
    plan,
    client,
    resources: [],
  });
  assert.equal(result.customer.action, 'reuse');
});

test('T09 a legacy parent uses only its frozen verified SKU and exact confirmed ID', async () => {
  const { plan, client, parent } = fixture();
  parent.sku = 'SYNTHETIC-LEGACY-SKU';
  const resources = [
    {
      account_key: config.accountKey,
      kind: 'product',
      identity_hash: productHash(attrs),
      id: 'local-parent',
      state: 'confirmed',
      remote_id: '10',
      verified_remote_sku: 'SYNTHETIC-LEGACY-SKU',
    },
  ];
  const before = await planOlistResources({ config, plan, client, resources });
  assert.equal(before.groups[0].action, 'reuse');
  assert.equal(before.groups[0].lines[0].action, 'reuse');
  parent.sku = 'REMOTE-CHANGED-SKU';
  const after = await planOlistResources({ config, plan, client, resources });
  assert.equal(after.groups[0].action, 'blocked');
  assert.equal(after.groups[0].lines[0].action, 'blocked');
});
