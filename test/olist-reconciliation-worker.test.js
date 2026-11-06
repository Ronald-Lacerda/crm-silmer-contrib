import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOlistReconciliationRuntime,
  createOlistReconciliationHandler,
} from '../apps/worker/src/olist-reconciliation-runtime.js';
import { createOlistReconciliationWorkerRuntime } from '../apps/worker/src/worker.js';
import { OlistError } from '../modules/olist/src/errors.js';
const ID = '00000000-0000-4000-8000-000000000009';
const EXPORT = '00000000-0000-4000-8000-000000000007';
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_DISPATCH_ENABLED: 'false',
  OLIST_CLIENT_ID: 'synthetic-admin-read',
  OLIST_CLIENT_SECRET: 'synthetic-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 41).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 42).toString('base64'),
};
function job() {
  return {
    jobType: 'olist.reconcile',
    queue: 'olist_reconcile',
    idempotencyKey: ID,
    olistExportId: EXPORT,
    actor: { id: 'forged' },
    snapshot: { private: 'PRIVATE_CANARY' },
  };
}
/** @param {any} [options] */
function fixture(options = {}) {
  /** @type {any[]} */ const events = [];
  const request = {
    id: ID,
    exportId: EXPORT,
    orderId: 'synthetic-order',
    resourceId: options.sale ? null : ID,
    stage: options.sale ? 'sale' : 'customer',
    status: 'queued',
    actor: { id: 'real-admin', kind: 'human' },
    authorizationVersion: 3,
    connectionGeneration: 2,
    ...options.request,
  };
  const repository = {
    async loadReadRequest(/** @type {any} */ input) {
      events.push(['load', input]);
      return request;
    },
    async guard(/** @type {any} */ input, /** @type {string} */ action) {
      events.push(['guard', input, action]);
      if (options.revoked) throw new OlistError('FORBIDDEN', 403);
    },
    async readResource(/** @type {any} */ input) {
      events.push(['resource', input]);
      return { id: ID, payload: {}, parent: null };
    },
    async readOperation(/** @type {any} */ input) {
      events.push(['operation', input]);
      return { id: EXPORT };
    },
    async completeReadRequest(/** @type {any} */ input) {
      events.push(['complete', input]);
      if (input.matched && options.revokeAtCommit)
        throw new OlistError('FORBIDDEN', 403);
      return {
        status: input.matched ? 'succeeded' : 'blocked',
        code: input.code,
      };
    },
  };
  const inspector = {
    async reconcileResource(/** @type {any} */ input) {
      events.push(['inspect-resource', input]);
      if (options.failure) throw options.failure;
      return {
        remoteId: '101',
        proof: { matched: true },
        actor: { id: 'untrusted-result' },
      };
    },
    async reconcileSale(/** @type {any} */ input) {
      events.push(['inspect-sale', input]);
      if (options.failure) throw options.failure;
      return {
        remoteId: '401',
        number: '99',
        proof: { matched: true, lineCount: 1, totalCents: 100 },
      };
    },
  };
  const dispatcher = createOlistReconciliationRuntime({
    database: {},
    environment,
    repository,
    inspector,
  });
  const context = {
    heartbeat: async () => {
      events.push(['heartbeat']);
      return options.lease !== false;
    },
    markEffectStarted: () => {
      throw new Error('Read-only jobs never reserve an ERP effect');
    },
  };
  return {
    events,
    request,
    dispatcher,
    context,
    run: () => createOlistReconciliationHandler({ dispatcher })(job(), context),
  };
}
test('T09 read worker is configured independently of creation dispatch and consumes only its dedicated queue', async () => {
  let touched = false;
  const queue = {
    async claim(/** @type {any} */ input) {
      touched = true;
      assert.equal(input.queue, 'olist_reconcile');
      return [];
    },
  };
  assert.equal(
    createOlistReconciliationWorkerRuntime({
      database: {},
      environment: {},
      queue,
    }),
    undefined,
  );
  assert.equal(touched, false);
  const worker = createOlistReconciliationWorkerRuntime({
    database: {},
    environment,
    queue,
    dispatcher: {},
  });
  assert.ok(worker);
  await worker.runOnce();
  assert.equal(touched, true);
});
test('T09 read handler accepts only its persisted identifiers and cannot select a creation job', async () => {
  /** @type {any[]} */ const calls = [];
  const handler = createOlistReconciliationHandler({
    dispatcher: {
      async dispatch(/** @type {any} */ input) {
        calls.push(input);
        return { status: 'succeeded' };
      },
    },
  });
  for (const patch of [
    { jobType: 'olist.export' },
    { queue: 'olist' },
    { idempotencyKey: 'https://example.test/arbitrary' },
    { olistExportId: 'another-order' },
  ]) {
    const result = await handler({ ...job(), ...patch }, {});
    assert.equal(result.outcome, 'failed');
  }
  assert.equal(calls.length, 0);
  const response = await handler(job(), {});
  assert.equal(response.outcome, 'sent');
  assert.deepEqual(calls, [{ requestId: ID, exportId: EXPORT }]);
});
test('T09 read job uses current persisted admin and epoch, then records only the requested resource without chaining effects', async () => {
  const f = fixture();
  assert.equal((await f.run()).outcome, 'sent');
  const guards = f.events.filter(([name]) => name === 'guard');
  assert.ok(guards.length);
  assert.equal(guards[0][1].actor.id, 'real-admin');
  assert.equal(guards[0][1].authorizationVersion, 3);
  assert.equal(guards[0][2], 'olist.reconcile');
  const saved = f.events.find(([name]) => name === 'complete')[1];
  assert.equal(saved.actor.id, 'real-admin');
  assert.equal(saved.remoteId, '101');
  assert.equal(
    f.events.some(([name]) => name === 'operation'),
    false,
  );
});
test('T09 sale reads never invoke resource resolution and every frozen request remains scoped to its export', async () => {
  const f = fixture({ sale: true });
  assert.equal((await f.run()).outcome, 'sent');
  assert.equal(
    f.events.some(([name]) => name === 'resource'),
    false,
  );
  const other = fixture({
    request: { exportId: '00000000-0000-4000-8000-000000000099' },
  });
  assert.equal((await other.run()).outcome, 'failed');
  assert.equal(
    other.events.some(([name]) => name === 'guard'),
    false,
  );
});
test('T09 revocation before reading or before commit cannot confirm anything; late bounded failure only updates the read ledger', async () => {
  for (const options of [{ revoked: true }, { revokeAtCommit: true }]) {
    const f = fixture(options);
    const result = await f.run();
    assert.equal(result.outcome, 'failed');
    assert.equal(result.errorCode, 'FORBIDDEN');
    const last = f.events.filter(([name]) => name === 'complete').at(-1)[1];
    assert.equal(last.matched, false);
    if (options.revoked)
      assert.equal(
        f.events.some(([name]) => name === 'inspect-resource'),
        false,
      );
  }
});
test('T09 lease loss blocks inspection and unknown upstream errors cannot leak PII or become a retry', async () => {
  for (const options of [
    { lease: false },
    { failure: new Error('PRIVATE_CANARY') },
    { failure: new OlistError('OLIST_AMBIGUOUS_MATCH') },
  ]) {
    const f = fixture(options);
    const result = await f.run();
    assert.equal(result.outcome, 'failed');
    assert.equal(result.retryable, false);
    assert.equal(result.retrySafe, false);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE_CANARY|untrusted-result/u,
    );
    if (options.lease === false)
      assert.equal(
        f.events.some(([name]) => name === 'inspect-resource'),
        false,
      );
  }
});
