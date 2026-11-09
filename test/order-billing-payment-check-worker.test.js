import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBillingPaymentCheckJobHandler } from '../modules/integration-reliability/src/billing-payment-check-worker.js';
import { createBillingWorkerRuntime } from '../apps/worker/src/worker.js';
const ID = '50c242cc-7a80-48a0-b2ce-750807589e17';
const BASE = {
  endpoint: 'https://automation.example.test/check',
  clientId: 'synthetic-billing',
  clientSecret: 'synthetic-check-password-more-than-32',
};
const JOB = { jobType: 'billing.payment.check', idempotencyKey: ID + ':1' };
test('BFIN-06/07 check command carries no private identifiers and does not reserve a checkout effect', async () => {
  const handler = createBillingPaymentCheckJobHandler({
    ...BASE,
    fetchImpl: async (
      /** @type {URL} */ url,
      /** @type {RequestInit} */ init,
    ) => {
      assert.equal(url.href, BASE.endpoint);
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init.body)), {
        schema_version: '1.0',
        check_id: ID,
      });
      return { status: 200, json: async () => ({ accepted: true }) };
    },
  });
  assert.deepEqual(await handler(JOB), {
    outcome: 'sent',
    providerExternalId: ID,
  });
});
test('BFIN-08 receive-only worker consumes scheduled consultations without a checkout endpoint or irreversible effect reservation', async () => {
  /** @type {any[]} */ const settled = [];
  let effects = 0,
    requests = 0;
  const worker = createBillingWorkerRuntime({
    database: {
      transaction: async (/** @type {any} */ work) =>
        work({ query: async () => ({ rows: [] }) }),
    },
    environment: {
      ORDER_BILLING_ENABLED: 'false',
      ORDER_BILLING_RECEIVE_ENABLED: 'true',
      ORDER_BILLING_CHECK_N8N_URL: BASE.endpoint,
      N8N_COMMAND_CLIENT_ID: BASE.clientId,
      N8N_COMMAND_CLIENT_SECRET: BASE.clientSecret,
    },
    queue: {
      claim: async () => [
        { ...JOB, id: 'check-job', attemptId: 'check-attempt' },
      ],
      heartbeat: async () => true,
      markEffectStarted: async () => {
        effects++;
        return true;
      },
      settle: async (/** @type {any} */ value) => {
        settled.push(value);
      },
    },
    fetchImpl: async (/** @type {URL} */ url) => {
      requests++;
      assert.equal(url.href, BASE.endpoint);
      return { status: 200, json: async () => ({ accepted: true }) };
    },
    logger: {
      debug() {
        return {};
      },
      info() {
        return {};
      },
      warn() {
        return {};
      },
      error() {
        return {};
      },
    },
  });
  assert.equal(await worker.runOnce(), 1);
  assert.equal(requests, 1);
  assert.equal(effects, 0);
  assert.equal(settled[0].outcome, 'sent');
});
test('BFIN-08 query timeouts and non-success acknowledgements are safely retryable; auth refusal and invalid jobs are final', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('private-provider-detail');
    },
    async () => ({ status: 503, json: async () => ({}) }),
    async () => ({ status: 200, json: async () => ({ accepted: false }) }),
  ]) {
    const result = await createBillingPaymentCheckJobHandler({
      ...BASE,
      fetchImpl,
    })(JOB);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(result.retrySafe, true);
    assert.equal(result.errorCode, 'BILLING_CHECK_UNAVAILABLE');
  }
  const auth = await createBillingPaymentCheckJobHandler({
    ...BASE,
    fetchImpl: async () => ({ status: 403 }),
  })(JOB);
  assert.equal(auth.retryable, false);
  assert.equal(auth.errorCode, 'BILLING_CHECK_AUTH_REJECTED');
  const invalid = await createBillingPaymentCheckJobHandler({
    ...BASE,
    fetchImpl: async () => {
      throw new Error('must not call');
    },
  })({ ...JOB, idempotencyKey: 'invalid' });
  assert.equal(invalid.errorCode, 'BILLING_CHECK_INVALID');
  assert.throws(
    () =>
      createBillingPaymentCheckJobHandler({
        ...BASE,
        endpoint: 'http://example.test/check',
      }),
    /HTTPS/u,
  );
});
