import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  OlistError,
  olistResourceIdentityHash,
} from '../modules/olist/src/index.js';
import { createOlistResourceResolver } from '../modules/olist/src/resource-resolver.js';

const config = {
  accountKey: 'a'.repeat(64),
  contextKey: 'b'.repeat(64),
  hmacKey: Buffer.alloc(32, 53),
};
const customer = {
  tipoPessoa: 'F',
  cpfCnpj: '52998224725',
  nome: 'Comprador Sintético',
  celular: '5511999990000',
  email: 'comprador@example.test',
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
const attributes = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Polo',
  audience: '',
};
/** @param {string[]} [sizes] */
function snapshot(sizes = ['M', 'G']) {
  const groupId = randomUUID();
  return {
    policy: 'exact-cent-v1',
    sourceVersions: {
      contactId: 'contact-synthetic',
      contactVersion: 1,
      sourceRevision: 0,
    },
    customer: structuredClone(customer),
    productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
    commercial: {
      totalCents: sizes.length * 300,
      groups: [
        {
          groupId,
          attributes: structuredClone(attributes),
          lines: sizes.map((size) => ({
            groupId,
            lineId: randomUUID(),
            size,
            quantity: 3,
            subtotalCents: 300,
            unitCents: 100,
            unitLexeme: '1.00',
          })),
        },
      ],
    },
  };
}
/** A deliberately stateful fake: persistence constraints execute synchronously
 * before await, and simulated ERP rows survive failed responses/restarts.
 * @param {any} [settings] */
function fixture(settings = {}) {
  /** @type {Map<string,any>} */ const exports = new Map();
  /** @type {Map<string,any>} */ const resources = new Map();
  /** @type {Map<string,any>} */ const attempts = new Map();
  /** @type {Map<number,any>} */ const contacts = new Map();
  /** @type {Map<number,any>} */ const products = new Map();
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const writes = [];
  /** @type {any[]} */ const reads = [];
  let enabled = true,
    settingsVersion = 1,
    connectionGeneration = 0,
    sequence = 100;
  const base = {
    actor: { id: 'synthetic-actor', kind: 'human' },
    authorizationVersion: 1,
    connectionGeneration: 0,
    settingsVersion: 1,
    accountKey: config.accountKey,
    contextKey: config.contextKey,
    correlationId: 'synthetic-t22',
  };
  /** @param {any} input */
  function guard(input) {
    if (!enabled) throw new OlistError('FORBIDDEN', 403);
    if (input.connectionGeneration !== connectionGeneration)
      throw new OlistError('OLIST_CONNECTION_CHANGED');
    if (
      input.settingsVersion !== undefined &&
      input.settingsVersion !== settingsVersion
    )
      throw new OlistError('VERSION_CONFLICT');
    const operation = exports.get(input.exportId);
    if (
      !operation ||
      operation.actor_id !== input.actor.id ||
      operation.account_key !== input.accountKey
    )
      throw new OlistError('OLIST_EXPORT_UNAVAILABLE');
    return operation;
  }
  /** @param {any} input */
  function linked(input) {
    guard(input);
    const row = resources.get(input.resourceId);
    if (!row || !row.exports.has(input.exportId))
      throw new OlistError('OLIST_RESOURCE_NOT_FOUND', 404);
    return row;
  }
  /** @param {any} row */
  function view(row) {
    const current = [...attempts.values()].filter(
      (a) => a.resource_id === row.id,
    );
    return {
      ...structuredClone(row),
      attempts: structuredClone(current),
      latestAttempt: current.length
        ? {
            ...structuredClone(current.at(-1)),
            children: [...attempts.values()]
              .filter((a) => a.parent_attempt_id === current.at(-1).id)
              .map((a) => ({
                id: a.id,
                resource_id: a.resource_id,
                fence: a.fence,
                outcome: a.outcome,
                observed_remote_id: a.observed_remote_id,
              })),
          }
        : null,
    };
  }
  /** @param {any} input */
  async function reserve(input) {
    const row = linked(input);
    if (row.version !== input.expectedVersion)
      throw new OlistError('VERSION_CONFLICT');
    if (
      row.state !== 'pending' ||
      [...attempts.values()].some((a) => a.resource_id === row.id)
    )
      throw new OlistError('OLIST_EFFECT_ALREADY_RESERVED');
    const children = (input.dependentResourceIds ?? []).map(
      (/** @type {string} */ id) => linked({ ...input, resourceId: id }),
    );
    if (
      children.some(
        (/** @type {any} */ child) =>
          child.state !== 'pending' || child.parent_id !== row.id,
      )
    )
      throw new OlistError('OLIST_PARENT_UNRESOLVED');
    const ticket = {
      attemptId: randomUUID(),
      fence: randomUUID(),
      children: /** @type {any[]} */ ([]),
    };
    const attempt = {
      id: ticket.attemptId,
      fence: ticket.fence,
      resource_id: row.id,
      outcome: 'reserved',
      observed_remote_id: null,
      parent_attempt_id: null,
      children: ticket.children,
      requestPayload: structuredClone(input.requestPayload),
    };
    attempts.set(attempt.id, attempt);
    row.state = 'reserved';
    row.version++;
    for (const child of children) {
      const childTicket = {
        resourceId: child.id,
        attemptId: randomUUID(),
        fence: randomUUID(),
      };
      ticket.children.push(childTicket);
      child.state = 'reserved';
      child.version++;
      attempts.set(childTicket.attemptId, {
        id: childTicket.attemptId,
        fence: childTicket.fence,
        resource_id: child.id,
        parent_attempt_id: attempt.id,
        outcome: 'reserved',
        observed_remote_id: null,
      });
    }
    events.push({
      kind: 'reserve',
      resourceId: row.id,
      children: children.map((/** @type {any} */ child) => child.id),
    });
    return structuredClone(ticket);
  }
  const repository = {
    async readExport(/** @type {any} */ input) {
      guard(input);
      return structuredClone(exports.get(input.exportId));
    },
    async bindResource(/** @type {any} */ input) {
      guard(input);
      const identity = olistResourceIdentityHash(config.hmacKey, input);
      let row = [...resources.values()].find(
        (r) => r.kind === input.kind && r.identity_hash === identity,
      );
      if (row && JSON.stringify(row.payload) !== JSON.stringify(input.payload))
        throw new OlistError('OLIST_RESOURCE_DIVERGENT');
      if (!row) {
        row = {
          id: randomUUID(),
          account_key: config.accountKey,
          kind: input.kind,
          identity_hash: identity,
          reference:
            (input.kind === 'customer'
              ? 'CRM-C-'
              : input.kind === 'product'
                ? 'CRM-P-'
                : 'CRM-V-') + identity,
          parent_id: input.parentId ?? null,
          state: 'pending',
          version: 0,
          remote_id: null,
          payload: structuredClone(input.payload),
          exports: new Set(),
        };
        resources.set(row.id, row);
      }
      row.exports.add(input.exportId);
      events.push({ kind: 'bind', resourceId: row.id });
      return view(row);
    },
    async readResource(/** @type {any} */ input) {
      return view(linked(input));
    },
    async recordResourceBatchResult(/** @type {any} */ input) {
      const results = [];
      for (const value of input.results)
        results.push(await repository.recordResult({ ...input, ...value }));
      return { results };
    },
    reserveResourceEffect: reserve,
    reserveResourceBatchEffect: reserve,
    async reconcileResourceLookup(/** @type {any} */ input) {
      const row = linked(input),
        attempt = [...attempts.values()].find((a) => a.resource_id === row.id);
      if (
        row.version !== input.expectedVersion ||
        !['reserved', 'uncertain'].includes(row.state) ||
        !attempt
      )
        throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      row.state = 'confirmed';
      row.remote_id = String(input.remoteId);
      row.version++;
      if (attempt.outcome === 'reserved') attempt.outcome = 'confirmed';
      events.push({
        kind: 'reconciled',
        resourceId: row.id,
        remoteId: row.remote_id,
      });
      return view(row);
    },
    async confirmResourceLookup(/** @type {any} */ input) {
      const row = linked(input);
      if (row.state === 'confirmed' && row.remote_id === String(input.remoteId))
        return view(row);
      if (
        row.version !== input.expectedVersion ||
        row.state !== 'pending' ||
        [...attempts.values()].some((a) => a.resource_id === row.id)
      )
        throw new OlistError('OLIST_RESOURCE_RECONCILIATION_REQUIRED');
      row.state = 'confirmed';
      row.remote_id = String(input.remoteId);
      row.version++;
      events.push({ kind: 'lookup-confirm', resourceId: row.id });
      return view(row);
    },
    async recordObservedResourceId(/** @type {any} */ input) {
      const attempt = attempts.get(input.attemptId);
      assert.equal(attempt?.fence, input.fence);
      attempt.observed_remote_id = String(input.remoteId);
      events.push({
        kind: 'observed',
        resourceId: attempt.resource_id,
        remoteId: String(input.remoteId),
      });
    },
    async recordResult(/** @type {any} */ input) {
      const attempt = attempts.get(input.attemptId);
      assert.equal(attempt?.fence, input.fence);
      if (settings.failPersistenceOnce && input.outcome === 'confirmed') {
        settings.failPersistenceOnce = false;
        throw new Error('synthetic local failure');
      }
      const row = resources.get(attempt.resource_id);
      if (attempt.outcome === 'confirmed')
        return { outcome: 'confirmed', replayed: true };
      attempt.outcome = input.outcome;
      row.state = input.outcome;
      row.remote_id =
        input.outcome === 'confirmed' ? String(input.remoteId) : null;
      row.version++;
      if (input.outcome === 'uncertain')
        for (const child of attempts.values())
          if (
            child.parent_attempt_id === attempt.id &&
            child.outcome !== 'confirmed'
          ) {
            child.outcome = 'uncertain';
            const childRow = resources.get(child.resource_id);
            childRow.state = 'uncertain';
            childRow.version++;
          }
      events.push({
        kind: 'result',
        outcome: input.outcome,
        resourceId: row.id,
        remoteId: row.remote_id,
      });
      return { outcome: input.outcome, replayed: false };
    },
  };
  const client = {
    async findCustomer(/** @type {string} */ document) {
      reads.push({ kind: 'findCustomer', document });
      return structuredClone(
        [...contacts.values()].find((v) => v.cpfCnpj === document) ?? null,
      );
    },
    async contact(/** @type {number} */ id) {
      reads.push({ kind: 'contact', id });
      return structuredClone(contacts.get(Number(id)) ?? null);
    },
    async findProduct(/** @type {string} */ sku) {
      reads.push({ kind: 'findProduct', sku });
      return structuredClone(
        [...products.values()].find((v) => v.sku === sku) ?? null,
      );
    },
    async product(/** @type {number} */ id) {
      reads.push({ kind: 'product', id });
      if (
        settings.failReadBackVariation &&
        writes.at(-1)?.kind === 'variation'
      ) {
        settings.failReadBackVariation = false;
        throw new OlistError('OLIST_UNAVAILABLE', 503);
      }
      return structuredClone(products.get(Number(id)) ?? null);
    },
  };
  const writer = {
    async dispatch(/** @type {any} */ input) {
      const reservation = await input.reserve(structuredClone(input.payload), {
        connectionVersion: 0,
      });
      writes.push({
        kind: input.kind,
        payload: structuredClone(input.payload),
        reservation,
      });
      let id = ++sequence;
      /** @type {any} */ let body;
      if (input.kind === 'customer') {
        contacts.set(id, { ...structuredClone(input.payload), id });
        body = { id };
      } else if (input.kind === 'product') {
        assert.ok(
          input.payload.variacoes.length > 0,
          'A V parent must never be posted without initial variations',
        );
        const parent = {
          ...structuredClone(input.payload),
          id,
          situacao: 'A',
          tipoVariacao: 'P',
          variacoes: /** @type {any[]} */ ([]),
        };
        products.set(id, parent);
        for (const variation of input.payload.variacoes) {
          if (settings.partialParent && parent.variacoes.length === 1) break;
          const childId = ++sequence,
            child = {
              ...structuredClone(variation),
              id: childId,
              tipo: 'S',
              tipoVariacao: 'V',
              situacao: 'A',
              produtoPai: { id },
            };
          products.set(childId, child);
          parent.variacoes.push({
            id: childId,
            sku: child.sku,
            grade: child.grade,
          });
        }
        body = {
          id,
          variacoes: parent.variacoes.map((/** @type {any} */ v) => ({
            id: v.id,
            codigo: v.sku,
          })),
        };
      } else {
        const parent = products.get(Number(input.parentRemoteId));
        assert.ok(parent);
        const child = {
          ...structuredClone(input.payload),
          id,
          tipo: 'S',
          tipoVariacao: 'V',
          situacao: 'A',
          produtoPai: { id: parent.id },
        };
        products.set(id, child);
        parent.variacoes.push({ id, sku: child.sku, grade: child.grade });
        body = { id: settings.variationReturnsParentId ? parent.id : id };
        if (settings.variationReturnsParentId) id = parent.id;
      }
      if (settings.afterPost) await settings.afterPost(input.kind);
      if (settings.failAt === input.kind) {
        throw Object.assign(new OlistError('OLIST_RESOURCE_UNCERTAIN'), {
          reservation,
        });
      }
      return {
        remoteId: String(id),
        body,
        reservation,
        quotaObservationFailed: settings.quotaObservationFailed === input.kind,
      };
    },
  };
  function operation(/** @type {any} */ value = snapshot()) {
    const exportId = randomUUID();
    exports.set(exportId, {
      id: exportId,
      account_key: config.accountKey,
      context_key: config.contextKey,
      connection_generation: 0,
      settings_version: 1,
      actor_id: base.actor.id,
      authorization_version: 1,
      state: 'queued',
      snapshot: structuredClone(value),
    });
    return { ...base, exportId };
  }
  const resolver = createOlistResourceResolver({
    repository,
    client,
    writer,
    config,
  });
  return {
    resolver,
    repository,
    client,
    writer,
    config,
    base,
    operation,
    exports,
    resources,
    attempts,
    contacts,
    products,
    events,
    writes,
    reads,
    setEnabled: (/** @type {boolean} */ value) => {
      enabled = value;
    },
    setSettingsVersion: (/** @type {number} */ value) => {
      settingsVersion = value;
    },
    setConnectionGeneration: (/** @type {number} */ value) => {
      connectionGeneration = value;
    },
  };
}

test('T22 resolves and persists the customer, V parent and every initial variation before dependencies', async () => {
  const f = fixture(),
    input = f.operation();
  const result = await f.resolver.resolve(input);
  assert.equal(result.resolved, true);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].lines.length, 2);
  assert.deepEqual(
    f.writes.map((v) => v.kind),
    ['customer', 'product'],
  );
  assert.equal(
    [...f.resources.values()].filter((v) => v.state === 'confirmed').length,
    4,
  );
  const parentWrite = f.writes.find((v) => v.kind === 'product');
  assert.equal(parentWrite.reservation.children.length, 2);
  assert.ok([...f.attempts.values()].every((v) => v.outcome === 'confirmed'));
  const before = f.writes.length;
  assert.equal((await f.resolver.resolve(input)).resolved, true);
  assert.equal(
    f.writes.length,
    before,
    'Replay reuses durable IDs without another POST',
  );
});

test('T22 uses only the persisted export snapshot and never a caller-supplied customer or group', async () => {
  const f = fixture(),
    input = f.operation();
  await f.resolver.resolve({
    ...input,
    snapshot: { customer: { cpfCnpj: '00000000000' } },
    customer: { nome: 'Injected secret' },
    commercial: { groups: [] },
  });
  assert.equal(f.writes[0].payload.cpfCnpj, customer.cpfCnpj);
  assert.doesNotMatch(JSON.stringify(f.writes), /Injected secret|00000000000/);
});

test('T22 fiscal policy, exact-cent representation and customer validity block before any effect', async () => {
  for (const mutate of [
    (/** @type {any} */ value) => {
      value.productFiscal = null;
    },
    (/** @type {any} */ value) => {
      value.commercial.groups[0].lines[0].subtotalCents = 100;
      value.commercial.totalCents -= 200;
    },
    (/** @type {any} */ value) => {
      value.customer.cpfCnpj = '12345678900';
    },
  ]) {
    const f = fixture(),
      value = snapshot();
    mutate(value);
    await assert.rejects(f.resolver.resolve(f.operation(value)));
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.attempts.size,
      0,
      'No effect reservation is created for an invalid complete plan',
    );
    if (value.productFiscal !== null) assert.equal(f.resources.size, 0);
  }
});

test('T22 concurrent orders share one customer and parent, then add only the missing overlapping size', async () => {
  const f = fixture(),
    a = f.operation(snapshot(['M', 'G'])),
    b = f.operation(snapshot(['G', 'P']));
  await Promise.allSettled([f.resolver.resolve(a), f.resolver.resolve(b)]);
  assert.equal((await f.resolver.resolve(a)).resolved, true);
  assert.equal((await f.resolver.resolve(b)).resolved, true);
  assert.equal(f.writes.filter((v) => v.kind === 'customer').length, 1);
  assert.equal(f.writes.filter((v) => v.kind === 'product').length, 1);
  assert.equal(f.writes.filter((v) => v.kind === 'variation').length, 1);
  assert.equal(
    [...f.resources.values()].filter((v) => v.kind === 'variation').length,
    3,
  );
});

test('T22 uncertain customer and composite product requests remain reserved across restart and zero lookup never authorizes another POST', async () => {
  for (const kind of ['customer', 'product']) {
    const f = fixture({ failAt: kind, partialParent: true }),
      input = f.operation();
    await assert.rejects(f.resolver.resolve(input));
    const count = f.writes.length;
    f.contacts.clear();
    f.products.clear();
    const restarted = createOlistResourceResolver({
      repository: f.repository,
      client: f.client,
      writer: f.writer,
      config,
    });
    await assert.rejects(restarted.resolve(input));
    assert.equal(
      f.writes.length,
      count,
      'A negative read cannot erase an uncertain effect',
    );
    assert.ok(
      [...f.resources.values()].some((v) =>
        ['reserved', 'uncertain'].includes(v.state),
      ),
    );
    if (kind === 'product')
      assert.ok(
        [...f.resources.values()]
          .filter((v) => v.kind === 'variation')
          .every((v) => ['reserved', 'uncertain'].includes(v.state)),
      );
  }
});

test('T22 a misleading variation response ID is only evidence until parent/SKU/grade readback identifies the child', async () => {
  const f = fixture({ variationReturnsParentId: true }),
    a = f.operation(snapshot(['M']));
  await f.resolver.resolve(a);
  const b = f.operation(snapshot(['M', 'G']));
  const result = await f.resolver.resolve(b);
  const variation = f.writes.find((v) => v.kind === 'variation');
  assert.ok(variation);
  const parent = [...f.resources.values()].find((v) => v.kind === 'product');
  const child = [...f.resources.values()].find(
    (v) => v.kind === 'variation' && v.payload.size === 'g',
  );
  assert.equal(result.resolved, true);
  assert.notEqual(child.remote_id, parent.remote_id);
  const attempt = f.attempts.get(variation.reservation.attemptId);
  assert.equal(
    attempt.observed_remote_id,
    parent.remote_id,
    'Original ID must survive as evidence',
  );
  assert.equal(attempt.outcome, 'confirmed');
});

test('T22 revocation, settings or connection changes after an HTTP effect preserve its result and prevent the next inclusion', async () => {
  for (const change of ['actor', 'settings', 'connection']) {
    /** @type {any} */ const f = fixture({
      afterPost: async (/** @type {string} */ kind) => {
        if (kind === 'customer') {
          if (change === 'actor') f.setEnabled(false);
          else if (change === 'settings') f.setSettingsVersion(2);
          else f.setConnectionGeneration(1);
        }
      },
    });
    await assert.rejects(f.resolver.resolve(f.operation()));
    assert.deepEqual(
      f.writes.map((/** @type {any} */ v) => v.kind),
      ['customer'],
    );
    const saved = [...f.resources.values()].find(
      (/** @type {any} */ v) => v.kind === 'customer',
    );
    assert.ok(['confirmed', 'uncertain'].includes(saved.state));
    const evidence = [...f.attempts.values()].find(
      (/** @type {any} */ v) => v.resource_id === saved.id,
    );
    assert.ok(
      evidence.observed_remote_id,
      'Started effect retains its returned ID despite revoked authority',
    );
    assert.equal(
      evidence.observed_remote_id,
      String([...f.contacts.keys()][0]),
    );
  }
});

test('T22 persistence failure after a successful POST cannot release its reservation or repeat creation', async () => {
  const f = fixture({ failPersistenceOnce: true }),
    input = f.operation();
  await assert.rejects(f.resolver.resolve(input));
  assert.equal(f.writes.length, 1);
  assert.ok([...f.attempts.values()].some((v) => v.observed_remote_id));
  await Promise.allSettled([f.resolver.resolve(input)]);
  assert.equal(f.writes.filter((v) => v.kind === 'customer').length, 1);
});

test('T22 matching document or SKU never authorizes reuse of divergent current fiscal or product attributes', async () => {
  const buyerMismatch = fixture(),
    buyerInput = buyerMismatch.operation();
  buyerMismatch.contacts.set(70, {
    ...structuredClone(customer),
    id: 70,
    nome: 'Outra razão fiscal',
  });
  await assert.rejects(buyerMismatch.resolver.resolve(buyerInput));
  assert.equal(buyerMismatch.writes.length, 0);
  const productMismatch = fixture(),
    productInput = productMismatch.operation();
  productMismatch.contacts.set(70, { ...structuredClone(customer), id: 70 });
  const identity = olistResourceIdentityHash(config.hmacKey, {
    accountKey: config.accountKey,
    kind: 'product',
    identity: attributes,
  });
  productMismatch.products.set(80, {
    id: 80,
    sku: 'CRM-P-' + identity,
    descricao: 'Calça de nylon vermelha',
    tipo: 'V',
    tipoVariacao: 'P',
    situacao: 'A',
    variacoes: [],
  });
  await assert.rejects(productMismatch.resolver.resolve(productInput));
  assert.equal(productMismatch.writes.length, 0);
});

test('T22 exact positive readback resumes uncertainty without repeating the completed entity inclusion', async () => {
  const settings = { failAt: 'customer' },
    f = fixture(settings),
    input = f.operation();
  await assert.rejects(f.resolver.resolve(input));
  settings.failAt = '';
  const result = await f.resolver.resolve(input);
  assert.equal(result.resolved, true);
  assert.equal(f.writes.filter((v) => v.kind === 'customer').length, 1);
  assert.equal(f.writes.filter((v) => v.kind === 'product').length, 1);
  assert.ok([...f.resources.values()].every((v) => v.state === 'confirmed'));
});

test('T22 a partial composite cannot create its absent uncertain child after a successful parent readback', async () => {
  const settings = { failAt: 'product', partialParent: true },
    f = fixture(settings),
    input = f.operation();
  await assert.rejects(f.resolver.resolve(input));
  settings.failAt = '';
  const before = f.writes.length;
  await assert.rejects(f.resolver.resolve(input));
  assert.equal(f.writes.length, before);
  assert.equal(
    [...f.resources.values()].find((v) => v.kind === 'product').state,
    'confirmed',
  );
  const sizes = [...f.resources.values()].filter((v) => v.kind === 'variation');
  assert.equal(sizes.filter((v) => v.state === 'confirmed').length, 1);
  assert.equal(
    sizes.filter((v) => ['reserved', 'uncertain'].includes(v.state)).length,
    1,
  );
});

test('T22 quota observation failure preserves the received ID and blocks dependent creation', async () => {
  const f = fixture({ quotaObservationFailed: 'customer' }),
    input = f.operation();
  await assert.rejects(f.resolver.resolve(input));
  assert.deepEqual(
    f.writes.map((v) => v.kind),
    ['customer'],
  );
  const attempt = [...f.attempts.values()].find((v) => v.observed_remote_id);
  assert.ok(attempt);
  assert.equal(attempt.outcome, 'uncertain');
});

test('T22 a variation readback transport failure immediately records uncertainty and never retries its POST', async () => {
  const settings = { failReadBackVariation: false },
    f = fixture(settings);
  await f.resolver.resolve(f.operation(snapshot(['M'])));
  settings.failReadBackVariation = true;
  const input = f.operation(snapshot(['M', 'G']));
  await assert.rejects(f.resolver.resolve(input));
  const child = [...f.resources.values()].find(
    (v) => v.kind === 'variation' && v.payload.size === 'g',
  );
  assert.equal(child.state, 'uncertain');
  assert.ok(
    [...f.attempts.values()].find((v) => v.resource_id === child.id)
      .observed_remote_id,
  );
  await Promise.allSettled([f.resolver.resolve(input)]);
  assert.equal(f.writes.filter((v) => v.kind === 'variation').length, 1);
});

test('T22 missing remote fiscal origin cannot be coerced into the approved zero origin', async () => {
  for (const origin of [null, '']) {
    const f = fixture(),
      input = f.operation();
    f.contacts.set(70, { ...structuredClone(customer), id: 70 });
    const identity = olistResourceIdentityHash(config.hmacKey, {
      accountKey: config.accountKey,
      kind: 'product',
      identity: attributes,
    });
    f.products.set(80, {
      id: 80,
      sku: 'CRM-P-' + identity,
      descricao: Object.values(attributes).filter(Boolean).join(' | '),
      tipo: 'V',
      tipoVariacao: 'P',
      situacao: 'A',
      variacoes: [],
      ncm: '61091000',
      unidade: 'UN',
      origem: origin,
    });
    await assert.rejects(f.resolver.resolve(input));
    assert.equal(f.writes.length, 0);
  }
});
