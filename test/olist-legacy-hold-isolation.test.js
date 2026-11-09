import assert from 'node:assert/strict';
import test from 'node:test';
import { createOlistDispatcher } from '../modules/olist/src/dispatcher.js';
import { createOlistReadonlyInspector } from '../modules/olist/src/readonly-inspector.js';
import { assertOlistCommercialWrite } from '../modules/orders/src/adapters/olist-commercial-lock.js';

const config = {
  accountKey: 'hold-synthetic-account',
  contextKey: 'hold-synthetic-context',
  hmacKey: Buffer.alloc(32, 94),
};
function operation() {
  return {
    id: '77777777-7777-4777-8777-777777777772',
    order_id: '77777777-7777-4777-8777-777777777773',
    account_key: config.accountKey,
    context_key: config.contextKey,
    actor_id: 'synthetic-previous-operator',
    authorization_version: 1,
    settings_version: 1,
    connection_generation: 1,
    reference: 'CRM-77777777-7777-4777-8777-777777777772',
    version: 2,
    state: 'legacy_review_required',
    stage: 'complete',
    remote_id: '401',
    remote_number: '99',
    observed_sale_id: '401',
    observed_sale_number: '99',
    saleAttempt: null,
    snapshot: {
      policy: 'legacy-sale-only-v1',
      linkMode: 'legacy-sale-only-v1',
      customer: { nome: 'Comprador sintético', celular: '5511999990000' },
      commercial: { groups: [], totalCents: 600 },
      historicalMetadata: { fiscalVerified: false, reusable: false },
    },
    resourceMapping: {
      mode: 'legacy-sale-only-v1',
      resolved: true,
      customerId: '101',
      groups: [],
      legacyCorrespondence: { groups: [] },
    },
    resource_mapping_hash: 'a'.repeat(64),
    readback_envelope: { syntheticImmutableEvidence: true },
  };
}
const forbidden = () =>
  assert.fail(
    'A historical hold cannot read ERP, prepare credentials, reserve, publish or dispatch',
  );

test('T16 a stale export job cannot dispatch a historical hold or report the withdrawn link as sent', async () => {
  const row = operation(),
    before = structuredClone(row);
  /** @type {string[]} */ const observed = [];
  const repository = new Proxy(
    {
      loadDispatchContext: async () => structuredClone(row),
      recordDispatchStop: async (/** @type {any} */ input) => {
        observed.push(input.code);
      },
    },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : forbidden,
    },
  );
  const dispatcher = createOlistDispatcher({
    repository,
    client: new Proxy({}, { get: () => forbidden }),
    resourceResolver: { resolve: forbidden },
    saleWriter: { dispatch: forbidden },
    prepare: forbidden,
    config,
  });
  const result = await dispatcher.dispatch({ exportId: row.id });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorCode, 'OLIST_LEGACY_REVIEW_REQUIRED');
  assert.equal(result.retryable, false);
  assert.equal(result.retrySafe, false);
  assert.equal(result.providerExternalId, undefined);
  assert.ok(observed.every((code) => code === 'OLIST_LEGACY_REVIEW_REQUIRED'));
  assert.deepEqual(row, before);
});

test('T16 a stale sale-read request cannot reactivate a historical hold, with or without its old mapping', async () => {
  const inspector = createOlistReadonlyInspector({
    config,
    client: new Proxy({}, { get: () => forbidden }),
  });
  for (const mapping of [true, false]) {
    const row = operation();
    if (!mapping) row.resourceMapping = /** @type {any} */ (null);
    const before = structuredClone(row);
    await assert.rejects(inspector.reconcileSale({ operation: row }), {
      code: 'OLIST_LEGACY_REVIEW_REQUIRED',
    });
    assert.deepEqual(row, before);
  }
});

test('T16 a known historical hold keeps commercial edits, reopening and confirmation locked', async () => {
  const current = { id: operation().order_id, status: 'pendente' };
  const tx = {
    query: async () => ({
      rows: [{ order_id: current.id, state: 'legacy_review_required' }],
    }),
  };
  for (const eventType of [
    'order.updated',
    'order.reopened',
    'order.confirmed',
  ])
    await assert.rejects(
      assertOlistCommercialWrite(
        tx,
        current,
        { ...current, status: 'confirmado' },
        eventType,
      ),
      { code: 'ORDER_OLIST_LOCKED' },
    );
});
