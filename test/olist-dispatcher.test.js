import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOlistDispatcher } from '../modules/olist/src/dispatcher.js';
import { OlistError } from '../modules/olist/src/errors.js';
import { createOlistSaleWriter } from '../modules/olist/src/sale-writer.js';
import { captureOlistExistingBuyer } from '../modules/olist/src/existing-buyer.js';

const config = {
  configured: true,
  accountKey: 'a'.repeat(64),
  contextKey: 'b'.repeat(64),
  hmacKey: Buffer.alloc(32, 81),
};
const EXPORT_ID = '00000000-0000-4000-8000-000000000008';
const REFERENCE = 'CRM-' + EXPORT_ID;
const customer = {
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
    numero: '12',
  },
};
const attributes = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Polo',
  audience: '',
};
function fixturePlan() {
  const groups = [100, 200].map((subtotalCents) => {
    const groupId = randomUUID();
    return {
      groupId,
      attributes: structuredClone(attributes),
      lines: [
        {
          groupId,
          lineId: randomUUID(),
          size: 'M',
          quantity: 1,
          subtotalCents,
          unitCents: subtotalCents,
          unitLexeme: subtotalCents === 100 ? '1.00' : '2.00',
        },
      ],
    };
  });
  return {
    policy: 'exact-cent-v1',
    customer: structuredClone(customer),
    productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
    sourceVersions: {
      contactId: 'synthetic-contact',
      contactVersion: 1,
      sourceRevision: 0,
    },
    acceptedAt: '2026-11-06T12:00:00.000Z',
    settings: {
      sellerId: 7,
      operationNatureId: 8,
      warehouseId: 9,
      paymentMethodId: 10,
      originId: 11,
      priceListId: null,
      paymentTerms: 'À vista',
      paymentDueOn: '2026-12-01',
      receivingMethodId: null,
      purchaseOrder: null,
    },
    commercial: {
      groups,
      totalCents: 300,
      orderDate: '2026-11-06',
      deliveryOn: '2026-11-20',
      paymentCondition: 'pix',
    },
  };
}
/** Currency fields in the provider fixture are raw numeric lexemes, never
 * reconstructed from Number values. Two negotiated lines intentionally share
 * a product while retaining separate markers and prices.
 * @param {any} plan @param {any} [options] */
function rawOrder(plan, options = {}) {
  const lines = plan.prepared.lines.map(
    (/** @type {any} */ line, /** @type {number} */ index) => {
      const mapping = plan.lines.find(
        (/** @type {any} */ entry) => entry.lineId === line.lineId,
      );
      const marker = options.duplicateMarker
        ? plan.prepared.lines[0].lineId
        : line.lineId;
      const value = options.compensated
        ? index === 0
          ? '1.01'
          : '1.99'
        : options.precisionLoss && index === 0
          ? '1.00000000000000001'
          : line.unitLexeme;
      return (
        '{"produto":{"id":' +
        (options.wrongProduct && index === 0 ? '999' : mapping.productId) +
        '},"quantidade":' +
        (options.wrongQuantity && index === 0 ? '2' : line.quantity) +
        ',"valorUnitario":' +
        value +
        ',' +
        (options.missingMarker
          ? ''
          : '"infoAdicional":' + JSON.stringify(marker) + ',') +
        '"unidade":"UN"}'
      );
    },
  );
  if (options.reverse) lines.reverse();
  if (options.omitLine) lines.pop();
  const products = options.wrongProductsTotal ? '3.01' : '3.00';
  const total = options.wrongOrderTotal ? '3.01' : '3.00';
  return (
    '{"id":401,"numeroPedido":401,"situacao":0,"data":' +
    JSON.stringify(plan.orderDate) +
    ',"cliente":{"id":' +
    plan.customerId +
    ',"cpfCnpj":' +
    JSON.stringify(options.wrongBuyer ? '04252011000110' : plan.buyerDocument) +
    '},"ecommerce":{"id":' +
    plan.originId +
    ',"numeroPedidoEcommerce":' +
    JSON.stringify(
      options.wrongReference ? 'CRM-another-export' : plan.reference,
    ) +
    '},"itens":[' +
    lines.join(',') +
    '],"valorTotalProdutos":' +
    products +
    ',"valorTotalPedido":' +
    total +
    '}'
  );
}
/** Stateful storage and provider survive dispatcher instances/restarts. Fences
 * and global state change synchronously before awaiting, as a SQL CAS does.
 * @param {any} [options] */
function fixture(options = {}) {
  const snapshot = fixturePlan();
  const resolved = {
    resolved: true,
    customerId: '101',
    groups: snapshot.commercial.groups.map((group) => ({
      groupId: group.groupId,
      productId: '11',
      lines: group.lines.map((line) => ({
        lineId: line.lineId,
        productId: '201',
      })),
    })),
  };
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const posts = [];
  /** @type {any[]} */ const reads = [];
  /** @type {any[]} */ const patience = [];
  /** @type {any[]} */ const retryChecks = [];
  let enabled = true,
    currentSettings = 1,
    currentGeneration = 0,
    currentSource = 1;
  /** @type {any} */ let providerSale = null;
  /** @type {any} */ const operation = {
    id: EXPORT_ID,
    account_key: config.accountKey,
    context_key: config.contextKey,
    order_id: randomUUID(),
    order_version: 1,
    settings_version: 1,
    connection_generation: 0,
    actor_id: 'synthetic-seller',
    authorization_version: 1,
    version: 1,
    reference: REFERENCE,
    state: 'queued',
    stage: 'customer',
    remote_id: null,
    remote_number: null,
    snapshot,
    actor: { id: 'synthetic-seller', kind: 'human' },
    authorizationVersion: 1,
    connectionGeneration: 0,
    settingsVersion: 1,
    accountKey: config.accountKey,
    contextKey: config.contextKey,
    resources: null,
    resourceMapping: null,
    saleAttempt: null,
  };
  /** @param {any} [input] */
  function guard(input) {
    if (input?.exportId && input.exportId !== EXPORT_ID)
      throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    if (!enabled) throw new OlistError('FORBIDDEN', 403);
    if (
      currentSettings !== operation.settings_version ||
      currentSource !== operation.snapshot.sourceVersions.contactVersion
    )
      throw new OlistError('VERSION_CONFLICT');
    if (currentGeneration !== operation.connection_generation)
      throw new OlistError('OLIST_CONNECTION_CHANGED');
  }
  /** @param {any} input */ function ticket(input) {
    assert.equal(input.attemptId, operation.saleAttempt?.id);
    assert.equal(input.fence, operation.saleAttempt?.fence);
  }
  const repository = {
    async loadDispatchContext(/** @type {any} */ input) {
      assert.equal(input.exportId, EXPORT_ID);
      events.push('load');
      return structuredClone(operation);
    },
    async validateDispatch(/** @type {any} */ input) {
      guard(input);
      events.push('guard');
      return structuredClone(operation);
    },
    async readExport(/** @type {any} */ input) {
      guard(input);
      return structuredClone(operation);
    },
    async updateStage(/** @type {any} */ input) {
      guard(input);
      if (operation.saleAttempt) {
        if (input.stage === operation.stage) return structuredClone(operation);
        throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
      }
      operation.stage = input.stage;
      operation.state = input.state ?? 'resolving';
      operation.version++;
      events.push('stage:' + input.stage);
      return structuredClone(operation);
    },
    async markReady(/** @type {any} */ input) {
      guard(input);
      if (operation.saleAttempt)
        throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
      assert.equal(input.resources.customerId, resolved.customerId);
      operation.resources = structuredClone(input.resources);
      operation.resourceMapping = structuredClone(input.resources);
      operation.state = 'ready';
      operation.stage = 'sale';
      operation.version++;
      events.push('ready');
      return structuredClone(operation);
    },
    async reserveSaleEffect(/** @type {any} */ input) {
      guard(input);
      if (operation.state !== 'ready' || operation.saleAttempt)
        throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
      assert.equal(input.connectionVersion, 3);
      assert.equal(typeof input.requestPayload.encoded, 'string');
      operation.saleAttempt = {
        id: randomUUID(),
        fence: randomUUID(),
        outcome: 'reserved',
        requestPayload: structuredClone(input.requestPayload),
        observedRemoteId: null,
        observedNumber: null,
      };
      operation.state = 'reserved';
      operation.stage = 'sale';
      operation.version++;
      events.push('reserve');
      return {
        attemptId: operation.saleAttempt.id,
        fence: operation.saleAttempt.fence,
      };
    },
    async persistSaleObservedId(/** @type {any} */ input) {
      ticket(input);
      if (options.failObservedOnce) {
        options.failObservedOnce = false;
        throw new Error('PRIVATE_DATABASE_CANARY');
      }
      const id = String(input.remoteId);
      assert.ok(
        !operation.saleAttempt.observedRemoteId ||
          operation.saleAttempt.observedRemoteId === id,
      );
      operation.saleAttempt.observedRemoteId = id;
      operation.saleAttempt.observed_remote_id = id;
      operation.saleAttempt.observedNumber = input.remoteNumber ?? null;
      operation.saleAttempt.observed_number = input.remoteNumber ?? null;
      events.push('observed');
    },
    async markSaleUncertain(/** @type {any} */ input) {
      ticket(input);
      if (operation.state === 'confirmed') return { outcome: 'confirmed' };
      if (operation.saleAttempt.outcome === 'reserved')
        operation.saleAttempt.outcome = 'uncertain';
      operation.state = 'uncertain';
      operation.version++;
      events.push('uncertain');
      return { outcome: 'uncertain' };
    },
    /** Same contract as the real gate: queued/resolving/ready, no sale
     * attempt, no sale id and nothing reserved or uncertain. */
    async assertRetrySafe(/** @type {any} */ input) {
      retryChecks.push(input);
      if (options.retrySafe !== undefined) return options.retrySafe;
      return (
        ['queued', 'resolving', 'ready'].includes(operation.state) &&
        !operation.saleAttempt &&
        !operation.remote_id
      );
    },
    async recordDispatchStop(/** @type {any} */ input) {
      operation.last_error_code = input.code ?? input.errorCode;
      events.push('stop');
    },
    async finishSale(/** @type {any} */ input) {
      ticket(input);
      assert.equal(input.matched, true);
      if (options.failFinishOnce) {
        options.failFinishOnce = false;
        throw new Error('PRIVATE_COMMIT_CANARY');
      }
      operation.state = 'confirmed';
      operation.stage = 'complete';
      operation.remote_id = String(input.remoteId);
      operation.remote_number = input.number ?? input.remoteNumber ?? '401';
      if (operation.saleAttempt.outcome === 'reserved')
        operation.saleAttempt.outcome = 'confirmed';
      operation.version++;
      events.push('finish');
      return { outcome: 'confirmed' };
    },
  };
  const client = {
    async findOrder(/** @type {string} */ reference, /** @type {any} */ opts) {
      reads.push(['find', reference]);
      patience.push(['find', opts?.patient === true]);
      events.push('find');
      const failure = options.findFails?.shift();
      if (failure) throw new OlistError(failure);
      if (options.searchAbsent) return null;
      return providerSale || options.preexistingSale
        ? { id: 401, numeroPedido: 401, numeroPedidoEcommerce: REFERENCE }
        : null;
    },
    async orderRaw(/** @type {number} */ id, /** @type {any} */ opts) {
      assert.equal(id, 401);
      reads.push(['raw', id]);
      patience.push(['raw', opts?.patient === true]);
      events.push('get');
      // A read that does not ask for patience gives up when the quota is busy.
      if (options.rawBusyUnlessPatient && opts?.patient !== true)
        throw new OlistError('OLIST_RATE_LIMITED', 429);
      assert.equal(operation.saleAttempt.observedRemoteId, '401');
      assert.equal(operation.saleAttempt.observedNumber, '401');
      if (options.readErrorOnce) {
        options.readErrorOnce = false;
        throw new OlistError('OLIST_UNAVAILABLE', 503);
      }
      assert.ok(providerSale);
      return rawOrder(providerSale, options.readback ?? {});
    },
  };
  const resourceResolver = {
    async resolve(/** @type {any} */ input) {
      guard(input);
      events.push('resources');
      if (options.resourceError) throw new OlistError(options.resourceError);
      options.afterResources?.();
      return structuredClone(resolved);
    },
  };
  const saleWriter = options.saleWriter ?? {
    async dispatch(/** @type {any} */ input) {
      options.beforeReserve?.();
      const reservation = await input.reserve(input.plan.encoded, {
        connectionVersion: 3,
      });
      events.push('post');
      posts.push(input.plan.encoded);
      providerSale = input.plan;
      if (options.timeoutOnce) {
        options.timeoutOnce = false;
        throw Object.assign(new OlistError('OLIST_SALE_UNCERTAIN'), {
          reservation,
        });
      }
      return {
        remoteId: options.remoteId ?? '401',
        number: '401',
        remoteNumber: '401',
        reservation,
        quotaObservationFailed: options.quotaObservationFailed === true,
        invalidResponse: options.invalidResponse === true,
      };
    },
  };
  const dispatcher = () =>
    createOlistDispatcher({
      repository,
      client,
      resourceResolver,
      saleWriter,
      config,
      ...(options.prepare ? { prepare: options.prepare } : {}),
    });
  return {
    snapshot,
    resolved,
    operation,
    events,
    posts,
    reads,
    patience,
    retryChecks,
    dispatcher,
    repository,
    client,
    options,
    revoke() {
      enabled = false;
    },
    enable() {
      enabled = true;
    },
    changeSettings() {
      currentSettings++;
    },
    changeGeneration() {
      currentGeneration++;
    },
    changeSource() {
      currentSource++;
    },
  };
}

function noRetry(/** @type {any} */ result) {
  assert.equal(result.retryable, false);
  assert.equal(result.retrySafe, false);
}

test('T08 persists observed sale id before GET and confirms every correlated line, including repeated products and reordered response', async () => {
  const f = fixture({ readback: { reverse: true } });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  noRetry(result);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.state, 'confirmed');
  assert.equal(f.operation.stage, 'complete');
  assert.ok(f.events.indexOf('reserve') < f.events.indexOf('post'));
  assert.ok(f.events.indexOf('post') < f.events.indexOf('observed'));
  assert.ok(f.events.indexOf('observed') < f.events.indexOf('get'));
  assert.ok(f.events.indexOf('get') < f.events.indexOf('finish'));
  const repeat = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(repeat.outcome, 'sent');
  assert.equal(f.posts.length, 1);
});

test('T17 an ERP-existing buyer is freshly rechecked before the sale ticket and a changed identity prevents the POST', async () => {
  for (const changed of [false, true]) {
    const contact = {
      id: 101,
      nome: 'Comprador Sintético',
      celular: '5511999990000',
      situacao: 'A',
    };
    const f = fixture({
      afterResources: () => {
        if (changed) contact.celular = '5511999990001';
      },
    });
    const captured = captureOlistExistingBuyer({
      config,
      buyer: { name: contact.nome, phone: contact.celular },
      contact,
    });
    Object.assign(f.snapshot, captured);
    const client = /** @type {any} */ (f.client);
    client.contact = async (/** @type {number} */ id) => {
      assert.equal(id, 101);
      f.events.push('buyer-get');
      return contact;
    };
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    if (changed) {
      assert.equal(result.outcome, 'outcome_unknown');
      assert.equal(result.errorCode, 'OLIST_CUSTOMER_DIVERGENT');
      assert.equal(f.operation.saleAttempt, null);
      assert.equal(f.posts.length, 0);
    } else {
      assert.equal(result.outcome, 'sent');
      assert.ok(f.events.indexOf('buyer-get') < f.events.indexOf('reserve'));
      assert.equal(f.posts.length, 1);
    }
  }
});

test('T08 same global total cannot hide a divergent negotiated line or a lost/duplicated marker', async () => {
  for (const readback of [
    { compensated: true },
    { precisionLoss: true },
    { missingMarker: true },
    { duplicateMarker: true },
    { omitLine: true },
    { wrongQuantity: true },
    { wrongProduct: true },
    { wrongProductsTotal: true },
    { wrongOrderTotal: true },
    { wrongBuyer: true },
    { wrongReference: true },
  ]) {
    const f = fixture({ readback });
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown', JSON.stringify(readback));
    noRetry(result);
    assert.equal(f.operation.state, 'uncertain');
    assert.equal(f.operation.saleAttempt.observedRemoteId, '401');
    assert.equal(f.posts.length, 1);
    await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(
      f.posts.length,
      1,
      'readback divergence never authorizes another POST',
    );
  }
});

test('T08 timeout plus zero after restart never permits a second sale, regardless of another dispatcher instance', async () => {
  const f = fixture({ timeoutOnce: true, searchAbsent: true });
  const first = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(first.outcome, 'outcome_unknown');
  noRetry(first);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.state, 'uncertain');
  assert.equal(f.operation.saleAttempt.observedRemoteId, null);
  const attemptId = f.operation.saleAttempt.id;
  const second = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(second.outcome, 'outcome_unknown');
  noRetry(second);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.saleAttempt.id, attemptId);
});

test('T08 an exact positive readback recovers a timed-out sale without recreating earlier resources or the sale', async () => {
  const f = fixture({ timeoutOnce: true });
  await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  const attempts = f.operation.saleAttempt.id;
  const resourcesCalls = f.events.filter(
    (event) => event === 'resources',
  ).length;
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  noRetry(result);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.saleAttempt.id, attempts);
  assert.equal(
    f.operation.saleAttempt.outcome,
    'uncertain',
    'the historical uncertain attempt is not rewritten',
  );
  assert.equal(f.operation.state, 'confirmed');
  assert.equal(
    f.events.filter((event) => event === 'resources').length,
    resourcesCalls,
  );
});

test('T08 failure to persist a verified result keeps the observed id and resumes only by GET', async () => {
  const f = fixture({ failFinishOnce: true });
  const first = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(first.outcome, 'outcome_unknown');
  noRetry(first);
  assert.equal(f.operation.saleAttempt.observedRemoteId, '401');
  const posts = f.posts.length;
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  assert.equal(f.posts.length, posts);
});

test('T08 failing to persist a POST id stops before GET and cannot recreate after a zero lookup', async () => {
  const f = fixture({ failObservedOnce: true, searchAbsent: true });
  const first = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(first.outcome, 'outcome_unknown');
  noRetry(first);
  assert.equal(f.posts.length, 1);
  assert.equal(f.events.filter((event) => event === 'get').length, 0);
  await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(f.posts.length, 1);
});

test('T08 current authority/configuration/source is checked again at the final reservation after resources are resolved', async () => {
  for (const change of [
    'revoke',
    'changeSettings',
    'changeGeneration',
    'changeSource',
  ]) {
    const f = fixture();
    f.options.beforeReserve = () => f[/** @type {'revoke'} */ (change)]();
    const before = structuredClone(f.resolved);
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.notEqual(result.outcome, 'sent', change);
    noRetry(result);
    assert.equal(f.posts.length, 0);
    assert.equal(f.operation.saleAttempt, null);
    assert.deepEqual(f.resolved, before);
  }
});

test('T08 resource uncertainty blocks the sale and unexpected errors do not leak provider data', async () => {
  for (const code of [
    'OLIST_RESOURCE_UNCERTAIN',
    'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
  ]) {
    const f = fixture({ resourceError: code });
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown');
    noRetry(result);
    assert.equal(f.posts.length, 0);
  }
  const f = fixture();
  f.repository.loadDispatchContext = async () => {
    throw new Error(
      'PRIVATE_BODY_CANARY buyer@example.test PRIVATE_TOKEN_CANARY',
    );
  };
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  noRetry(result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|buyer@example/u);
  assert.equal(f.posts.length, 0);
});

test('T08 concurrent workers share one durable sale reservation even when both have resolved the same resources', async () => {
  const f = fixture();
  const outcomes = await Promise.all([
    f.dispatcher().dispatch({ exportId: EXPORT_ID }),
    f.dispatcher().dispatch({ exportId: EXPORT_ID }),
  ]);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.state, 'confirmed');
  assert.ok(
    outcomes.some((/** @type {any} */ result) => result.outcome === 'sent'),
  );
  outcomes.forEach(noRetry);
});

test('T08 quota observation and readback failure preserve a known sale identifier and cannot start another sale', async () => {
  for (const option of [
    { quotaObservationFailed: true },
    { invalidResponse: true },
    { readErrorOnce: true },
  ]) {
    const f = fixture(option);
    const first = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(first.outcome, 'outcome_unknown');
    noRetry(first);
    assert.equal(f.operation.saleAttempt.observedRemoteId, '401');
    assert.equal(f.posts.length, 1);
    f.options.quotaObservationFailed = false;
    f.options.invalidResponse = false;
    const resumed = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(resumed.outcome, 'sent');
    assert.equal(f.posts.length, 1);
  }
});

test('T08 sale preflight rejects missing or invalid due date and inexact cents before customer resolution or HTTP', async () => {
  for (const invalid of ['missing-due', 'invalid-due', 'fractional-cent']) {
    const f = fixture();
    if (invalid === 'missing-due')
      delete (/** @type {any} */ (f.snapshot.settings).paymentDueOn);
    if (invalid === 'invalid-due')
      f.snapshot.settings.paymentDueOn = '2026-02-30';
    if (invalid === 'fractional-cent')
      f.snapshot.commercial.groups[0].lines[0].quantity = 3;
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'failed', invalid);
    assert.equal(
      result.errorCode,
      invalid === 'fractional-cent'
        ? 'OLIST_SALE_EXACT_CENT_REQUIRED'
        : 'OLIST_PAYMENT_DUE_REQUIRED',
    );
    noRetry(result);
    assert.equal(f.posts.length, 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.events.includes('resources'), false);
    assert.equal(f.operation.saleAttempt, null);
  }
});

test('T08 finding an unbound remote sale requires explicit reconciliation and cannot create resources or another sale', async () => {
  const f = fixture({ preexistingSale: true });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'OLIST_SALE_ALREADY_EXISTS');
  noRetry(result);
  assert.equal(f.posts.length, 0);
  assert.equal(f.operation.saleAttempt, null);
  assert.equal(f.events.includes('resources'), false);
  assert.equal(f.events.includes('get'), false);
  assert.equal(f.operation.remote_id, null);
});

test('T08 recovery refuses a missing or changed reserved request without HTTP or a second POST', async () => {
  for (const change of ['missing', 'different']) {
    const f = fixture({ timeoutOnce: true });
    await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.ok(f.operation.saleAttempt);
    const reads = f.reads.length;
    const posts = f.posts.length;
    f.operation.saleAttempt.requestPayload =
      change === 'missing' ? null : { encoded: '{}' };
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown');
    assert.equal(result.errorCode, 'OLIST_SALE_REQUEST_CHANGED');
    assert.equal(f.reads.length, reads);
    assert.equal(f.posts.length, posts);
    noRetry(result);
  }
});

test('T08 unsafe integer identity is observed exactly and stops before any GET', async () => {
  const f = fixture({ remoteId: '9007199254740993', invalidResponse: true });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(f.operation.saleAttempt.observedRemoteId, '9007199254740993');
  assert.equal(f.operation.saleAttempt.observedNumber, '401');
  assert.equal(f.events.includes('get'), false);
  assert.equal(f.posts.length, 1);
  noRetry(result);
});

test('T08 sale reference is checked again after registrations and before reserving any sale', async () => {
  const options = {
    preexistingSale: false,
    afterResources: () => {
      options.preexistingSale = true;
    },
  };
  const f = fixture(options);
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'OLIST_SALE_ALREADY_EXISTS');
  assert.equal(f.events.includes('resources'), true);
  assert.equal(f.reads.filter(([kind]) => kind === 'find').length, 2);
  assert.equal(f.operation.saleAttempt, null);
  assert.equal(f.posts.length, 0);
  noRetry(result);
});

const RETRY_CODES = [
  'OLIST_RATE_LIMITED',
  'OLIST_UNAVAILABLE',
  'OLIST_REFRESH_IN_PROGRESS',
];
/** @param {any} result */
function retryable(result) {
  assert.equal(result.outcome, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(result.retrySafe, true);
}

test('LIVENESS a "not now" failure before any ticket is a safe retry: RATE_LIMITED, UNAVAILABLE and REFRESH_IN_PROGRESS', async () => {
  for (const code of RETRY_CODES) {
    for (const where of ['lookup', 'resources']) {
      const f = fixture(
        where === 'lookup' ? { findFails: [code] } : { resourceError: code },
      );
      const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
      retryable(result);
      assert.equal(result.errorCode, code, where);
      assert.equal(f.posts.length, 0);
      assert.equal(f.operation.saleAttempt, null);
      assert.equal(f.events.includes('reserve'), false);
      assert.equal(f.events.includes('uncertain'), false);
      assert.equal(f.retryChecks.length, 1, 'the database gate decides');
      assert.deepEqual(f.retryChecks[0], {
        exportId: EXPORT_ID,
        accountKey: config.accountKey,
        contextKey: config.contextKey,
      });
      // The stop is still recorded as a safe code for the administrator.
      assert.equal(f.operation.last_error_code, code);
    }
  }
});

test('LIVENESS the retry needs assertRetrySafe: without it behavior is exactly the current one', async () => {
  for (const code of RETRY_CODES) {
    const f = fixture({ findFails: [code], retrySafe: false });
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(
      result.outcome,
      code === 'OLIST_RATE_LIMITED' ? 'failed' : 'outcome_unknown',
      code,
    );
    assert.equal(result.errorCode, code);
    noRetry(result);
    assert.equal(f.retryChecks.length, 1);
    assert.equal(f.posts.length, 0);
  }
  // A gate that throws is not a green light either.
  const broken = fixture({ findFails: ['OLIST_UNAVAILABLE'] });
  broken.repository.assertRetrySafe = async () => {
    throw new Error('PRIVATE_DATABASE_CANARY');
  };
  const result = await broken.dispatcher().dispatch({ exportId: EXPORT_ID });
  noRetry(result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
});

test('LIVENESS other lookup and resource failures never become a retry and never reach the gate', async () => {
  for (const code of [
    'OLIST_INCOMPLETE_LOOKUP',
    'OLIST_AMBIGUOUS_MATCH',
    'OLIST_RESOURCE_UNAVAILABLE',
    'OLIST_RESOURCE_UNCERTAIN',
    'OLIST_AUTH',
  ]) {
    const f = fixture({ findFails: [code] });
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown', code);
    noRetry(result);
    assert.equal(f.retryChecks.length, 0, code);
  }
});

test('LIVENESS with a sale ticket nothing is retried, whatever the code', async () => {
  for (const code of RETRY_CODES) {
    const f = fixture({
      saleWriter: {
        async dispatch(/** @type {any} */ input) {
          const reservation = await input.reserve(input.plan.encoded, {
            connectionVersion: 3,
          });
          throw Object.assign(new OlistError(code, 429), { reservation });
        },
      },
    });
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown', code);
    noRetry(result);
    assert.equal(f.operation.state, 'uncertain');
    assert.equal(f.retryChecks.length, 0, 'a ticket never reaches the gate');
  }
});

test('LIVENESS a recovery of an existing sale attempt is never a retry, even when the gate would say yes', async () => {
  for (const code of RETRY_CODES) {
    const f = fixture({ timeoutOnce: true });
    await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.ok(f.operation.saleAttempt);
    // The earlier attempt left no observed id: the lookup must run again.
    f.operation.saleAttempt.observedRemoteId = null;
    f.operation.saleAttempt.observed_remote_id = null;
    f.options.findFails = [code];
    f.options.retrySafe = true;
    const posts = f.posts.length;
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'outcome_unknown', code);
    noRetry(result);
    assert.equal(f.retryChecks.length, 0);
    assert.equal(f.posts.length, posts);
  }
});

test('LIVENESS no quota room for the sale and its readbacks defers with no ticket and no POST', async () => {
  let fetches = 0;
  const f = fixture({
    saleWriter: createOlistSaleWriter({
      credentials: async () => ({ token: 'synthetic-token', version: 3 }),
      quota: {
        reserve: async () => {
          assert.fail('the old reserve must not run when reserveWrite exists');
        },
        reserveWrite: async (/** @type {any} */ input) => {
          assert.equal(input.readbacks, 2, 'a sale needs two readbacks');
          throw Object.assign(new OlistError('OLIST_RATE_LIMITED', 429), {
            retryAfterMs: 30_000,
          });
        },
        observe: async () => {},
      },
      fetch: async () => {
        fetches += 1;
        throw new Error('no HTTP without quota room');
      },
    }),
  });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  retryable(result);
  assert.equal(result.errorCode, 'OLIST_RATE_LIMITED');
  assert.equal(fetches, 0);
  assert.equal(f.operation.saleAttempt, null, 'no ticket was created');
  assert.equal(f.events.includes('reserve'), false);
  assert.equal(f.events.includes('post'), false);
  assert.equal(f.operation.state, 'ready', 'resources stay resolved');
});

test('LIVENESS the readback after the POST asks for the patient wait instead of turning a busy window into an uncertain sale', async () => {
  const f = fixture({ rawBusyUnlessPatient: true });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  noRetry(result);
  assert.equal(f.posts.length, 1);
  assert.equal(f.operation.state, 'confirmed');
  assert.deepEqual(
    f.patience.filter(([kind]) => kind === 'raw'),
    [['raw', true]],
  );
  // Reads made before any ticket exists keep the common profile.
  assert.deepEqual(
    f.patience.filter(([kind]) => kind === 'find'),
    [
      ['find', false],
      ['find', false],
    ],
  );
});

test('LIVENESS recovery reads of a ticketed sale are patient', async () => {
  const f = fixture({ timeoutOnce: true, rawBusyUnlessPatient: true });
  await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  f.patience.length = 0;
  f.operation.saleAttempt.observedRemoteId = null;
  f.operation.saleAttempt.observed_remote_id = null;
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  assert.deepEqual(f.patience, [
    ['find', true],
    ['raw', true],
  ]);
  assert.equal(f.posts.length, 1);
});

test('LIVENESS an invalidated export never dispatches, whatever code closed it', async () => {
  for (const code of [
    'OLIST_EXPORT_INVALIDATED',
    'ORDER_CANCELLED',
    'OLIST_RATE_LIMITED',
    'OLIST_SALE_UNCERTAIN',
    undefined,
  ]) {
    const f = fixture({ findFails: ['OLIST_RATE_LIMITED'] });
    f.operation.state = 'invalidated';
    f.operation.last_error_code = code;
    const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
    assert.equal(result.outcome, 'failed', String(code));
    assert.equal(
      result.errorCode,
      code === 'ORDER_CANCELLED'
        ? 'ORDER_CANCELLED'
        : 'OLIST_EXPORT_UNAVAILABLE',
    );
    noRetry(result);
    assert.equal(f.posts.length, 0);
    assert.equal(f.reads.length, 0, 'no HTTP at all');
    assert.equal(f.retryChecks.length, 0);
    for (const event of [
      'guard',
      'resources',
      'reserve',
      'post',
      'stage:customer',
    ])
      assert.equal(f.events.includes(event), false, event);
  }
});

test('LIVENESS prepare renews the token before the local guard that would end the job as CONNECTION_CHANGED', async () => {
  let renewed = false;
  /** @param {any} f */
  function expiring(f) {
    const guarded = f.repository.validateDispatch;
    f.repository.validateDispatch = async (/** @type {any} */ input) => {
      if (!renewed) throw new OlistError('OLIST_CONNECTION_CHANGED');
      return guarded(input);
    };
  }
  const old = fixture();
  expiring(old);
  const stale = await old.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(stale.outcome, 'failed');
  assert.equal(stale.errorCode, 'OLIST_CONNECTION_CHANGED');
  assert.equal(old.posts.length, 0);

  const f = fixture({
    prepare: async (/** @type {any} */ base) => {
      assert.equal(base.exportId, EXPORT_ID);
      assert.equal(base.accountKey, config.accountKey);
      renewed = true;
    },
  });
  expiring(f);
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  assert.equal(result.outcome, 'sent');
  assert.equal(f.posts.length, 1);
  // The guard only passes once renewed, so prepare necessarily ran before it.
  assert.equal(renewed, true);
  assert.ok(f.events.includes('guard'));
});

test('LIVENESS a refresh in progress during prepare is a retry, and nothing else ran', async () => {
  const f = fixture({
    prepare: async () => {
      throw new OlistError('OLIST_REFRESH_IN_PROGRESS', 503);
    },
  });
  const result = await f.dispatcher().dispatch({ exportId: EXPORT_ID });
  retryable(result);
  assert.equal(result.errorCode, 'OLIST_REFRESH_IN_PROGRESS');
  assert.equal(f.events.includes('guard'), false);
  assert.equal(f.reads.length, 0);
  assert.equal(f.posts.length, 0);
  const reconnect = fixture({
    prepare: async () => {
      throw new OlistError('OLIST_RECONNECT_REQUIRED');
    },
  });
  const terminal = await reconnect
    .dispatcher()
    .dispatch({ exportId: EXPORT_ID });
  assert.equal(terminal.outcome, 'failed');
  assert.equal(terminal.errorCode, 'OLIST_RECONNECT_REQUIRED');
  noRetry(terminal);
});

test('M4 the dispatcher keeps no read memory: findOrder and the sale readback always reach the client, also across dispatches of one instance', async () => {
  const f = fixture({ failFinishOnce: true });
  const dispatcher = f.dispatcher();
  const first = await dispatcher.dispatch({ exportId: EXPORT_ID });
  assert.equal(first.outcome, 'outcome_unknown');
  // Both reference searches ran before the POST; the proof read came after it.
  assert.deepEqual(f.reads, [
    ['find', REFERENCE],
    ['find', REFERENCE],
    ['raw', 401],
  ]);
  assert.equal(f.posts.length, 1);
  f.reads.length = 0;
  f.patience.length = 0;
  // The same instance recovers: the sale proof is read again, never reused.
  const second = await dispatcher.dispatch({ exportId: EXPORT_ID });
  assert.equal(second.outcome, 'sent');
  assert.deepEqual(f.reads, [['raw', 401]]);
  assert.deepEqual(f.patience, [['raw', true]]);
  assert.equal(f.posts.length, 1);
});
