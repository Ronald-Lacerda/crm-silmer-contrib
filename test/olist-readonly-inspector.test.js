import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOlistReadonlyInspector } from '../modules/olist/src/readonly-inspector.js';
import { buildOlistSalePayload } from '../modules/olist/src/sale-payload.js';
import { productDescription } from '../modules/olist/src/resource-payloads.js';
import {
  createOlistResourceResolver,
  verifyProduct,
} from '../modules/olist/src/resource-resolver.js';
import { OlistError } from '../modules/olist/src/errors.js';

const config = {
  hmacKey: Buffer.alloc(32, 92),
  accountKey: 'a'.repeat(64),
  contextKey: 'b'.repeat(64),
};
const REFERENCE = 'CRM-00000000-0000-4000-8000-000000000009';
const CUSTOMER = {
  tipoPessoa: 'F',
  cpfCnpj: '52998224725',
  nome: 'Comprador Sintético',
  celular: '5511999990000',
  situacao: 'B',
  endereco: {
    cep: '29010000',
    municipio: 'Vitória',
    uf: 'ES',
    endereco: 'Rua Sintética',
    bairro: 'Centro',
    numero: '10',
  },
};
const ATTR = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Polo',
  audience: '',
};
/** @param {any} [options] */
function fixture(options = {}) {
  const groupId = randomUUID();
  const snapshot = {
    policy: 'exact-cent-v1',
    sourceVersions: {
      contactId: null,
      contactVersion: null,
      sourceRevision: 0,
    },
    customer: structuredClone(CUSTOMER),
    productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
    settings: {
      sellerId: 11,
      operationNatureId: 12,
      warehouseId: 13,
      paymentMethodId: 14,
      originId: 15,
      priceListId: null,
      purchaseOrder: null,
      paymentTerms: 'À vista',
      paymentDueOn: '2026-11-30',
    },
    commercial: {
      orderDate: '2026-11-06',
      deliveryOn: '2026-11-20',
      totalCents: 300,
      groups: [
        {
          groupId,
          attributes: structuredClone(ATTR),
          lines: [
            {
              groupId,
              lineId: randomUUID(),
              size: 'M',
              quantity: 1,
              subtotalCents: 100,
              unitCents: 100,
              unitLexeme: '1.00',
            },
            {
              groupId,
              lineId: randomUUID(),
              size: 'G',
              quantity: 1,
              subtotalCents: 200,
              unitCents: 200,
              unitLexeme: '2.00',
            },
          ],
        },
      ],
    },
  };
  const resources = {
    resolved: true,
    customerId: '101',
    groups: [
      {
        groupId,
        productId: '201',
        lines: snapshot.commercial.groups[0].lines.map((line, i) => ({
          lineId: line.lineId,
          productId: String(301 + i),
        })),
      },
    ],
  };
  const plan = buildOlistSalePayload({
    snapshot,
    resolved: resources,
    reference: REFERENCE,
  });
  /** @type {any} */ const parent = {
    id: 201,
    tipo: 'V',
    situacao: 'A',
    sku: 'LEGACY-PARENT',
    descricao: productDescription(ATTR),
    ncm: '61091000',
    origem: 0,
    unidade: 'UN',
    variacoes: [
      { id: 301, sku: 'LEGACY-M', grade: [{ chave: 'Tamanho', valor: 'M' }] },
      { id: 302, sku: 'LEGACY-G', grade: [{ chave: 'Tamanho', valor: 'G' }] },
    ],
  };
  /** @type {Map<number,any>} */ const products = new Map([
    [201, parent],
    [
      301,
      {
        id: 301,
        situacao: 'A',
        tipoVariacao: 'V',
        sku: 'LEGACY-M',
        produtoPai: { id: 201 },
      },
    ],
    [
      302,
      {
        id: 302,
        situacao: 'A',
        tipoVariacao: 'V',
        sku: 'LEGACY-G',
        produtoPai: { id: 201 },
      },
    ],
  ]);
  /** @type {any} */ const customer = { id: 101, ...structuredClone(CUSTOMER) };
  /** @type {any[]} */ const reads = [];
  let posts = 0;
  /** @type {any} */ const body = {
    id: 401,
    numeroPedido: 99,
    situacao: 0,
    data: '2026-11-06',
    dataPrevista: '2026-11-20',
    cliente: { id: 101, cpfCnpj: CUSTOMER.cpfCnpj },
    ecommerce: {
      id: 15,
      ...(options.legacy ? {} : { numeroPedidoEcommerce: REFERENCE }),
    },
    itens: snapshot.commercial.groups[0].lines
      .map((line, i) => ({
        produto: { id: 301 + i },
        quantidade: 1,
        valorUnitario: 1 + i,
        ...(options.legacy ? {} : { infoAdicional: line.lineId }),
      }))
      .reverse(),
    valorTotalProdutos: 3,
    valorTotalPedido: 3,
  };
  const client = {
    async orderRaw(/** @type {number} */ id) {
      reads.push(['order', id]);
      return options.rawOverride ?? JSON.stringify(body);
    },
    async contact(/** @type {number} */ id) {
      reads.push(['contact', id]);
      return structuredClone(customer);
    },
    async product(/** @type {number} */ id) {
      reads.push(['product', id]);
      return structuredClone(products.get(id));
    },
    async findOrder(/** @type {string} */ reference) {
      reads.push(['findOrder', reference]);
      if (options.ambiguous) throw new OlistError('OLIST_AMBIGUOUS_MATCH');
      return options.absent ? null : { id: 401, numeroPedido: 99 };
    },
    async findCustomerAcrossStates() {
      reads.push(['findCustomer']);
      if (options.ambiguous) throw new OlistError('OLIST_AMBIGUOUS_MATCH');
      return options.absent ? null : { id: 101 };
    },
    async findProductAcrossStates() {
      reads.push(['findProduct']);
      if (options.ambiguous) throw new OlistError('OLIST_AMBIGUOUS_MATCH');
      return options.absent ? null : { id: 201 };
    },
    async createOrder() {
      posts++;
      throw new Error('PRIVATE_POST_CANARY');
    },
    async createProduct() {
      posts++;
      throw new Error('PRIVATE_POST_CANARY');
    },
    async createVariation() {
      posts++;
      throw new Error('PRIVATE_POST_CANARY');
    },
    async createCustomer() {
      posts++;
      throw new Error('PRIVATE_POST_CANARY');
    },
  };
  const inspector = createOlistReadonlyInspector({ client, config });
  const operation = {
    id: randomUUID(),
    reference: REFERENCE,
    snapshot,
    resources,
    resourceMapping: resources,
    saleAttempt: {
      requestPayload: { encoded: plan.encoded },
      observedRemoteId: '401',
      observedNumber: '99',
    },
  };
  return {
    snapshot,
    resources,
    plan,
    parent,
    products,
    customer,
    body,
    client,
    reads,
    inspector,
    operation,
    options,
    posts: () => posts,
    inspect: () =>
      inspector.existingSale({
        snapshot,
        reference: REFERENCE,
        remoteId: '401',
      }),
  };
}

test('T09 existing legacy sale is verified by full buyer, fiscal parent/grade and exact independent lines with zero creations', async () => {
  const f = fixture({ legacy: true });
  const result = await f.inspect();
  assert.equal(result.remoteId, '401');
  assert.equal(result.number, '99');
  assert.deepEqual(result.resources, {
    ...f.resources,
    groups: f.resources.groups.map((group) => ({
      ...group,
      verifiedSku: f.parent.sku,
    })),
  });
  assert.equal(result.proof.matched, true);
  assert.equal(result.proof.lineCount, 2);
  assert.equal(result.proof.totalCents, 300);
  assert.match(result.remoteDigest, /^[a-f0-9]{64}$/u);
  assert.equal(f.posts(), 0);
  assert.ok(f.reads.some(([kind]) => kind === 'contact'));
  assert.ok(f.reads.some(([kind, id]) => kind === 'product' && id === 201));
  assert.doesNotMatch(
    JSON.stringify(result),
    /Comprador|52998224725|Rua Sintética|PRIVATE/u,
  );
});

test('T09 matching modern reference and stable markers use the same exact comparison', async () => {
  const f = fixture();
  assert.equal((await f.inspect()).proof.matched, true);
  assert.equal(f.posts(), 0);
});

test('T09 a present foreign reference or wrong stable marker cannot use the legacy exception', async () => {
  for (const corruption of ['reference', 'marker', 'missing-origin', 'date']) {
    const f = fixture({ legacy: true });
    if (corruption === 'reference')
      f.body.ecommerce.numeroPedidoEcommerce = 'CRM-another-order';
    if (corruption === 'marker') f.body.itens[0].infoAdicional = randomUUID();
    if (corruption === 'missing-origin') delete f.body.ecommerce.id;
    if (corruption === 'date') f.body.data = '2026-11-05';
    await assert.rejects(f.inspect());
    assert.equal(f.posts(), 0);
  }
});

test('T09 parent description alone, a wrong child parent or mismatched buyer are not linking evidence', async () => {
  for (const corruption of [
    'fiscal',
    'origin',
    'unit',
    'attributes',
    'parent',
    'grade',
    'document',
    'address',
    'phone',
  ]) {
    const f = fixture({ legacy: true });
    if (corruption === 'fiscal') f.parent.ncm = '99999999';
    if (corruption === 'origin') f.parent.origem = null;
    if (corruption === 'unit') f.parent.unidade = 'KG';
    if (corruption === 'attributes')
      f.parent.descricao = productDescription({ ...ATTR, color: 'Verde' });
    if (corruption === 'parent') f.products.get(301).produtoPai.id = 999;
    if (corruption === 'grade') f.parent.variacoes[0].grade[0].valor = 'P';
    if (corruption === 'document') f.customer.cpfCnpj = '04252011000110';
    if (corruption === 'address') f.customer.endereco.numero = '99';
    if (corruption === 'phone') f.customer.celular = '5511999990001';
    await assert.rejects(f.inspect(), { name: 'OlistError' }, corruption);
    assert.equal(f.posts(), 0);
  }
});

test('T09 omitted, duplicated and compensating lines fail even when both global totals match', async () => {
  for (const corruption of [
    'compensated',
    'duplicate',
    'omit',
    'quantity',
    'global',
    'fiscal-effect',
    'paid',
  ]) {
    const f = fixture({ legacy: true });
    if (corruption === 'compensated') {
      f.body.itens[0].valorUnitario = 1.99;
      f.body.itens[1].valorUnitario = 1.01;
    }
    if (corruption === 'duplicate')
      f.body.itens[0] = structuredClone(f.body.itens[1]);
    if (corruption === 'omit') f.body.itens.pop();
    if (corruption === 'quantity') f.body.itens[0].quantidade = 2;
    if (corruption === 'global') f.body.valorTotalPedido = 3.01;
    if (corruption === 'fiscal-effect') f.body.idNotaFiscal = 123;
    if (corruption === 'paid') f.body.pagamentosIntegrados = [{ id: 1 }];
    await assert.rejects(f.inspect(), { name: 'OlistError' }, corruption);
    assert.equal(f.posts(), 0);
  }
});

test('T09 monetary precision is preserved rather than rounded for legacy matching', async () => {
  const f = fixture({ legacy: true });
  f.options.rawOverride = JSON.stringify(f.body).replace(
    '"valorUnitario":1',
    '"valorUnitario":1.00000000000000001',
  );
  await assert.rejects(f.inspect());
  assert.equal(f.posts(), 0);
});

test('T09 the digest includes independent buyer and product evidence for link revalidation', async () => {
  const f = fixture({ legacy: true });
  const first = await f.inspect();
  f.customer.email = 'changed@example.test';
  const second = await f.inspect();
  assert.notEqual(first.remoteDigest, second.remoteDigest);
  assert.deepEqual(first.resources, second.resources);
});

test('T09 sale effect reconciliation retains strict request bytes, reference and markers and never discovers by approximation', async () => {
  const f = fixture();
  const result = await f.inspector.reconcileSale({ operation: f.operation });
  assert.equal(result.proof.matched, true);
  assert.deepEqual(f.reads, [['order', 401]]);
  assert.equal(f.posts(), 0);
  for (const corruption of ['bytes', 'reference', 'marker', 'number']) {
    const bad = fixture();
    if (corruption === 'bytes')
      bad.operation.saleAttempt.requestPayload.encoded = '{}';
    if (corruption === 'reference')
      delete bad.body.ecommerce.numeroPedidoEcommerce;
    if (corruption === 'marker') delete bad.body.itens[0].infoAdicional;
    if (corruption === 'number')
      bad.operation.saleAttempt.observedNumber = '98';
    await assert.rejects(
      bad.inspector.reconcileSale({ operation: bad.operation }),
    );
    if (corruption === 'bytes') assert.equal(bad.reads.length, 0);
    assert.equal(bad.posts(), 0);
  }
});

test('T09 sale lookup zero or ambiguity after uncertainty never clears or recreates an effect', async () => {
  for (const options of [{ absent: true }, { ambiguous: true }]) {
    const f = fixture(options);
    delete (/** @type {any} */ (f.operation.saleAttempt).observedRemoteId);
    await assert.rejects(f.inspector.reconcileSale({ operation: f.operation }));
    assert.equal(f.posts(), 0);
    assert.equal(f.reads.filter(([kind]) => kind === 'order').length, 0);
    assert.equal(
      f.operation.saleAttempt.requestPayload.encoded,
      f.plan.encoded,
    );
  }
});

test('T09 known resource ID is verified by GET and zero/ambiguous discovery retains uncertainty without any creation', async () => {
  const f = fixture();
  const resource = {
    kind: 'customer',
    reference: 'CRM-customer',
    payload: CUSTOMER,
    state: 'uncertain',
    latestAttempt: { observed_remote_id: '101' },
  };
  assert.equal(
    (await f.inspector.reconcileResource({ resource })).remoteId,
    '101',
  );
  assert.deepEqual(f.reads, [['contact', 101]]);
  assert.equal(f.posts(), 0);
  for (const options of [{ absent: true }, { ambiguous: true }]) {
    const bad = fixture(options);
    await assert.rejects(
      bad.inspector.reconcileResource({
        resource: { ...resource, latestAttempt: {} },
      }),
    );
    assert.equal(bad.posts(), 0);
  }
});

test('T09 parent resource requires its canonical SKU, fiscal identity and attributes', async () => {
  const f = fixture();
  f.parent.sku = 'CRM-P-synthetic';
  const resource = {
    kind: 'product',
    reference: f.parent.sku,
    payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
    state: 'uncertain',
    latestAttempt: {},
  };
  assert.equal(
    (await f.inspector.reconcileResource({ resource })).remoteId,
    '201',
  );
  f.parent.sku = 'OTHER';
  await assert.rejects(f.inspector.reconcileResource({ resource }), {
    code: 'OLIST_PRODUCT_DIVERGENT',
  });
  assert.equal(f.posts(), 0);
});

test('T09 a variation observes its parent response without confusing it with the canonical child', async () => {
  const f = fixture();
  f.parent.sku = 'CRM-P-synthetic';
  f.parent.variacoes[0].sku = 'CRM-V-synthetic';
  f.products.get(301).sku = 'CRM-V-synthetic';
  const parent = {
    kind: 'product',
    reference: f.parent.sku,
    state: 'confirmed',
    remote_id: '201',
    payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
  };
  const resource = {
    kind: 'variation',
    reference: 'CRM-V-synthetic',
    state: 'uncertain',
    payload: { size: 'm' },
    latestAttempt: { observed_remote_id: '201' },
  };
  const result = await f.inspector.reconcileResource({ resource, parent });
  assert.equal(result.remoteId, '301');
  assert.equal(result.proof.parentRemoteId, '201');
  assert.equal(resource.latestAttempt.observed_remote_id, '201');
  resource.latestAttempt.observed_remote_id = '302';
  await assert.rejects(f.inspector.reconcileResource({ resource, parent }), {
    code: 'OLIST_VARIATION_DIVERGENT',
  });
  assert.equal(f.posts(), 0);
});

test('T09 uncertain variations with zero, duplicate sizes or another deterministic SKU stay unresolved', async () => {
  for (const corruption of ['zero', 'duplicate', 'sku', 'parent-pending']) {
    const f = fixture();
    f.parent.sku = 'CRM-P-synthetic';
    f.parent.variacoes[0].sku = 'CRM-V-synthetic';
    f.products.get(301).sku = 'CRM-V-synthetic';
    const parent = {
      kind: 'product',
      reference: f.parent.sku,
      state: 'confirmed',
      remote_id: '201',
      payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
    };
    const resource = {
      kind: 'variation',
      reference: 'CRM-V-synthetic',
      state: 'uncertain',
      payload: { size: 'M' },
      latestAttempt: {},
    };
    if (corruption === 'zero') f.parent.variacoes.shift();
    if (corruption === 'duplicate')
      f.parent.variacoes.push(structuredClone(f.parent.variacoes[0]));
    if (corruption === 'sku') f.parent.variacoes[0].sku = 'OTHER';
    if (corruption === 'parent-pending') parent.state = 'reserved';
    await assert.rejects(f.inspector.reconcileResource({ resource, parent }));
    assert.equal(f.posts(), 0);
  }
});

test('T09 legacy mapping refuses ambiguous identical lines rather than relying on their array index', async () => {
  const f = fixture({ legacy: true });
  const original = f.snapshot.commercial.groups[0].lines[0];
  const secondGroupId = randomUUID();
  const duplicate = {
    ...original,
    groupId: secondGroupId,
    lineId: randomUUID(),
  };
  f.snapshot.commercial.groups.push({
    groupId: secondGroupId,
    attributes: structuredClone(ATTR),
    lines: [duplicate],
  });
  f.snapshot.commercial.totalCents = 400;
  f.body.itens.push({ produto: { id: 301 }, quantidade: 1, valorUnitario: 1 });
  f.body.valorTotalPedido = 4;
  f.body.valorTotalProdutos = 4;
  await assert.rejects(f.inspect(), { code: 'OLIST_AMBIGUOUS_MATCH' });
  assert.equal(f.posts(), 0);
});

test('T09 modern markers disambiguate identical lines without merging them', async () => {
  const f = fixture();
  const original = f.snapshot.commercial.groups[0].lines[0];
  const secondGroupId = randomUUID();
  const duplicate = {
    ...original,
    groupId: secondGroupId,
    lineId: randomUUID(),
  };
  f.snapshot.commercial.groups.push({
    groupId: secondGroupId,
    attributes: structuredClone(ATTR),
    lines: [duplicate],
  });
  f.snapshot.commercial.totalCents = 400;
  f.body.itens.push({
    produto: { id: 301 },
    quantidade: 1,
    valorUnitario: 1,
    infoAdicional: duplicate.lineId,
  });
  f.body.valorTotalPedido = 4;
  f.body.valorTotalProdutos = 4;
  const result = await f.inspect();
  assert.equal(result.proof.lineCount, 3);
  assert.equal(result.proof.totalCents, 400);
  assert.equal(result.resources.groups[1].lines[0].productId, '301');
  assert.equal(f.posts(), 0);
});

test('T09 a legacy exception cannot be used by lookup-only reconciliation with no own sale attempt', async () => {
  const f = fixture({ legacy: true });
  await assert.rejects(
    f.inspector.reconcileSale({
      operation: { ...f.operation, saleAttempt: null },
    }),
    { code: 'OLIST_SALE_REFERENCE_CONFLICT' },
  );
  assert.equal(f.posts(), 0);
});

test('T09 independent parent candidates with matching attributes require analysis', async () => {
  const f = fixture({ legacy: true });
  const another = structuredClone(f.parent);
  another.id = 202;
  another.sku = 'LEGACY-PARENT-2';
  f.products.set(202, another);
  f.products.get(302).produtoPai.id = 202;
  await assert.rejects(f.inspect(), { code: 'OLIST_AMBIGUOUS_MATCH' });
  assert.equal(f.posts(), 0);
});

test('T09 legacy parent SKU is reusable only through its exact confirmed identity', () => {
  const f = fixture();
  const node = {
    row: {
      state: 'confirmed',
      remote_id: '201',
      reference: 'CRM-P-canonical',
      verified_remote_sku: f.parent.sku,
    },
    attributes: ATTR,
  };
  assert.equal(
    verifyProduct(f.parent, node, f.snapshot.productFiscal),
    f.parent,
  );
  for (const state of ['pending', 'reserved', 'uncertain'])
    assert.throws(
      () =>
        verifyProduct(
          f.parent,
          { ...node, row: { ...node.row, state } },
          f.snapshot.productFiscal,
        ),
      { code: 'OLIST_PRODUCT_DIVERGENT' },
    );
  assert.throws(
    () =>
      verifyProduct(
        f.parent,
        { ...node, row: { ...node.row, remote_id: '999' } },
        f.snapshot.productFiscal,
      ),
    { code: 'OLIST_PRODUCT_DIVERGENT' },
  );
  f.parent.ncm = '99999999';
  assert.throws(() => verifyProduct(f.parent, node, f.snapshot.productFiscal), {
    code: 'OLIST_PRODUCT_FISCAL_DIVERGENT',
  });
});

test('T09 linked legacy resources are reused by the T22 resolver without any additional ERP POST', async () => {
  const f = fixture({ legacy: true });
  await f.inspect();
  const buyer = {
    id: randomUUID(),
    kind: 'customer',
    state: 'confirmed',
    remote_id: '101',
    payload: f.snapshot.customer,
  };
  const parent = {
    id: randomUUID(),
    kind: 'product',
    state: 'confirmed',
    remote_id: '201',
    reference: 'CRM-P-canonical',
    verified_remote_sku: f.parent.sku,
    payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
  };
  const children = ['M', 'G'].map((size, i) => ({
    id: randomUUID(),
    kind: 'variation',
    state: 'confirmed',
    remote_id: String(301 + i),
    parent_id: parent.id,
    reference: 'CRM-V-canonical-' + size,
    payload: { size: size.toLowerCase() },
  }));
  const rows = [buyer, parent, ...children];
  let posts = 0;
  const repository = {
    async readExport() {
      return { snapshot: f.snapshot, settings_version: 1 };
    },
    async bindResource(/** @type {any} */ input) {
      return rows.find(
        (row) =>
          row.kind === input.kind &&
          (input.kind !== 'variation' ||
            /** @type {any} */ (row).payload.size === input.identity),
      );
    },
    async readResource(/** @type {any} */ input) {
      return rows.find((row) => row.id === input.resourceId);
    },
  };
  const resolver = createOlistResourceResolver({
    repository,
    client: f.client,
    config,
    writer: {
      async dispatch() {
        posts++;
        throw new Error('Unexpected ERP mutation');
      },
    },
  });
  const resolved = await resolver.resolve({ exportId: randomUUID() });
  assert.deepEqual(resolved, f.resources);
  assert.equal(posts, 0);
  assert.equal(f.posts(), 0);
});

test('T09 the frozen verified SKU rejects later remote edits and old confirmed links remain strict', () => {
  const f = fixture();
  const row = {
    state: 'confirmed',
    remote_id: '201',
    reference: 'CRM-P-canonical',
    verified_remote_sku: f.parent.sku,
  };
  const node = { row, attributes: ATTR };
  assert.equal(
    verifyProduct(f.parent, node, f.snapshot.productFiscal),
    f.parent,
  );
  f.parent.sku = 'CHANGED-REMOTELY';
  assert.throws(() => verifyProduct(f.parent, node, f.snapshot.productFiscal), {
    code: 'OLIST_PRODUCT_DIVERGENT',
  });
  const legacyRow = { ...row, verified_remote_sku: null };
  f.parent.sku = 'LEGACY-PARENT';
  assert.throws(
    () =>
      verifyProduct(
        f.parent,
        { ...node, row: legacyRow },
        f.snapshot.productFiscal,
      ),
    { code: 'OLIST_PRODUCT_DIVERGENT' },
  );
  f.parent.sku = legacyRow.reference;
  assert.equal(
    verifyProduct(
      f.parent,
      { ...node, row: legacyRow },
      f.snapshot.productFiscal,
    ),
    f.parent,
  );
});

/** @param {ReturnType<typeof fixture>} f */
async function linkedOperation(f) {
  const checked = await f.inspect();
  return {
    ...f.operation,
    state: 'linked',
    saleAttempt: null,
    remote_id: '401',
    remote_number: '99',
    observed_sale_id: '401',
    observed_sale_number: '99',
    resources: checked.resources,
    resourceMapping: checked.resources,
    verifiedParents: checked.resources.groups.map(
      (/** @type {any} */ group) => ({
        remoteId: group.productId,
        sku: group.verifiedSku,
      }),
    ),
  };
}

test('T09 a linked legacy sale is rechecked by its immutable known ID without requiring an invented reference', async () => {
  const f = fixture({ legacy: true });
  const operation = await linkedOperation(f);
  f.reads.length = 0;
  const checked = await f.inspector.reconcileSale({ operation });
  assert.equal(checked.remoteId, '401');
  assert.equal(checked.number, '99');
  assert.deepEqual(checked.resources, operation.resourceMapping);
  assert.equal(
    f.reads.some(([kind]) => kind === 'findOrder'),
    false,
  );
  assert.equal(f.posts(), 0);
});

test('T09 linked reconciliation rejects changed buyer or child IDs and changed sale number despite equal commercial contents', async () => {
  for (const corruption of ['buyer', 'child', 'number']) {
    const f = fixture({ legacy: true });
    const operation = await linkedOperation(f);
    if (corruption === 'buyer') {
      f.body.cliente.id = 102;
      f.customer.id = 102;
    }
    if (corruption === 'child') {
      const child = structuredClone(f.products.get(301));
      child.id = 303;
      f.products.set(303, child);
      f.parent.variacoes[0].id = 303;
      f.body.itens.find(
        (/** @type {any} */ item) => item.produto.id === 301,
      ).produto.id = 303;
    }
    if (corruption === 'number') f.body.numeroPedido = 100;
    await assert.rejects(f.inspector.reconcileSale({ operation }), {
      code: 'OLIST_SALE_READBACK_MISMATCH',
    });
    assert.equal(f.posts(), 0);
  }
});

test('T09 linked legacy reconciliation retains its verified SKU and rejects a foreign reference', async () => {
  for (const corruption of ['sku', 'reference']) {
    const f = fixture({ legacy: true });
    const operation = await linkedOperation(f);
    if (corruption === 'sku') f.parent.sku = 'CHANGED-REMOTELY';
    if (corruption === 'reference')
      f.body.ecommerce.numeroPedidoEcommerce = 'CRM-another-order';
    await assert.rejects(f.inspector.reconcileSale({ operation }), {
      code:
        corruption === 'sku'
          ? 'OLIST_PRODUCT_DIVERGENT'
          : 'OLIST_SALE_REFERENCE_CONFLICT',
    });
    assert.equal(f.posts(), 0);
  }
});

test('T09 the known-ID legacy exception cannot be transferred to reserved, uncertain or unlinked operations', async () => {
  for (const state of ['reserved', 'uncertain', 'ready', 'queued']) {
    const f = fixture({ legacy: true });
    const operation = { ...(await linkedOperation(f)), state };
    await assert.rejects(f.inspector.reconcileSale({ operation }), {
      code: 'OLIST_SALE_REFERENCE_CONFLICT',
    });
    assert.equal(f.posts(), 0);
  }
  const f = fixture({ legacy: true });
  const operation = await linkedOperation(f);
  operation.verifiedParents = [];
  await assert.rejects(f.inspector.reconcileSale({ operation }), {
    code: 'OLIST_PRODUCT_DIVERGENT',
  });
  assert.equal(f.posts(), 0);
});

test('T09 linked reconciliation rejects reparenting even when sale child IDs and attributes remain equal', async () => {
  const f = fixture({ legacy: true });
  const operation = await linkedOperation(f);
  const another = structuredClone(f.parent);
  another.id = 202;
  another.sku = 'VERIFIED-SECOND-PARENT';
  f.products.set(202, another);
  for (const child of f.products.values())
    if (child.produtoPai) child.produtoPai.id = 202;
  operation.verifiedParents.push({ remoteId: '202', sku: another.sku });
  await assert.rejects(f.inspector.reconcileSale({ operation }), {
    code: 'OLIST_SALE_READBACK_MISMATCH',
  });
  assert.equal(f.posts(), 0);
});
