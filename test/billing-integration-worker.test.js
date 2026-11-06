import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BILLING_COMMAND_JOB_TYPE,
  createBillingCommandJobHandler,
} from '../modules/integration-reliability/src/billing-command-worker.js';
import { createBillingWorkerRuntime } from '../apps/worker/src/worker.js';

const CHARGE = '50c242cc-7a80-48a0-b2ce-750807589e17';
const BASE = {
  endpoint:
    'https://automation.example.test/webhook/silmer/order-billing/create',
  clientId: 'synthetic-billing-worker',
  clientSecret: 'synthetic-billing-worker-secret-32-characters',
};
const JOB = {
  id: 'synthetic-job',
  jobType: BILLING_COMMAND_JOB_TYPE,
  idempotencyKey: CHARGE,
};

test('billing worker marks effect before HTTP and accepts a persisted acknowledgement', async () => {
  /** @type {string[]} */
  const calls = [];
  const handler = createBillingCommandJobHandler({
    ...BASE,
    fetchImpl: async (url, init) => {
      calls.push('http');
      assert.equal(url.href, BASE.endpoint);
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), {
        schema_version: '1.0',
        charge_id: CHARGE,
      });
      assert.equal(
        /** @type {any} */ (init.headers)['x-correlation-id'],
        CHARGE,
      );
      return { status: 200, json: async () => ({ accepted: true }) };
    },
  });
  const result = await handler(JOB, {
    markEffectStarted: async () => {
      calls.push('effect');
      return true;
    },
  });
  assert.deepEqual(calls, ['effect', 'http']);
  assert.deepEqual(result, { outcome: 'sent', providerExternalId: CHARGE });
});

test('a replay consumed by the CRM financial reservation is acknowledged without another provider effect', async () => {
  const handler = createBillingCommandJobHandler({
    ...BASE,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ accepted: true, duplicate: true }),
    }),
  });
  assert.equal(
    (await handler(JOB, { markEffectStarted: async () => true })).outcome,
    'sent',
  );
});

test('invalid command and lost lease never perform an HTTP call', async () => {
  let calls = 0;
  const handler = createBillingCommandJobHandler({
    ...BASE,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  assert.equal(
    (
      await handler(
        { ...JOB, idempotencyKey: 'invalid' },
        { markEffectStarted: async () => true },
      )
    ).errorCode,
    'BILLING_COMMAND_INVALID',
  );
  assert.equal(
    (await handler(JOB, { markEffectStarted: async () => false })).errorCode,
    'BILLING_LEASE_LOST',
  );
  assert.equal(calls, 0);
});

test('timeouts and callback failures are uncertain and never retryable after effect start', async () => {
  for (const kind of ['timeout', 'callback', 'malformed']) {
    const handler = createBillingCommandJobHandler({
      ...BASE,
      fetchImpl: async () => {
        if (kind === 'timeout')
          throw new Error('private upstream payload must never leak');
        return {
          status: kind === 'callback' ? 500 : 200,
          json: async () => ({ checkout_url: 'private-link' }),
        };
      },
    });
    const result = await handler(JOB, { markEffectStarted: async () => true });
    assert.deepEqual(result, {
      outcome: 'outcome_unknown',
      errorCode: 'BILLING_WORKFLOW_OUTCOME_UNKNOWN',
      retryable: false,
      retrySafe: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /private|payload|checkout_url/);
  }
});

test('a transaction failure before effect start remains safely retryable', async () => {
  let calls = 0;
  const handler = createBillingCommandJobHandler({
    ...BASE,
    fetchImpl: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  assert.deepEqual(
    await handler(JOB, {
      markEffectStarted: async () => {
        throw new Error('database unavailable');
      },
    }),
    {
      outcome: 'failed',
      errorCode: 'BILLING_WORKFLOW_NOT_STARTED',
      retryable: true,
      retrySafe: true,
    },
  );
  assert.equal(calls, 0);
});

test('workflow authentication rejection is a bounded failure without blind retry', async () => {
  const handler = createBillingCommandJobHandler({
    ...BASE,
    fetchImpl: async () => ({
      status: 401,
      json: async () => ({ message: 'private' }),
    }),
  });
  assert.deepEqual(
    await handler(JOB, { markEffectStarted: async () => true }),
    {
      outcome: 'failed',
      errorCode: 'BILLING_WORKFLOW_AUTH_REJECTED',
      retryable: false,
      retrySafe: false,
    },
  );
});

test('billing workflow transport requires HTTPS with an explicit loopback-only development exception', () => {
  for (const endpoint of [
    'http://automation.example.test/webhook',
    'https://secret@automation.example.test/webhook',
    'https://automation.example.test/webhook?token=private',
    'https://automation.example.test/webhook#fragment',
  ]) {
    assert.throws(
      () => createBillingCommandJobHandler({ ...BASE, endpoint }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      createBillingCommandJobHandler({
        ...BASE,
        endpoint: 'http://localhost:5678/webhook',
      }),
    TypeError,
  );
  assert.doesNotThrow(() =>
    createBillingCommandJobHandler({
      ...BASE,
      endpoint: 'http://localhost:5678/webhook',
      allowInsecureLocal: true,
    }),
  );
  assert.throws(
    () =>
      createBillingCommandJobHandler({
        ...BASE,
        endpoint: 'http://private-service/webhook',
        allowInsecureLocal: true,
      }),
    TypeError,
  );
});

test('dedicated billing queue composes with WorkerRuntime and settles one synthetic command', async () => {
  /** @type {any[]} */
  const calls = [];
  const queue = {
    claim: async (/** @type {any} */ input) => {
      assert.equal(input.queue, 'billing');
      return [{ ...JOB, attemptId: 'fixture-attempt', queue: 'billing' }];
    },
    heartbeat: async () => true,
    markEffectStarted: async () => true,
    settle: async (/** @type {any} */ input) => {
      calls.push(input);
    },
  };
  const logger = { info: () => {}, error: () => {}, warn: () => {} };
  const worker = createBillingWorkerRuntime({
    database: {},
    queue,
    logger: /** @type {any} */ (logger),
    environment: {
      ORDER_BILLING_N8N_URL: BASE.endpoint,
      N8N_COMMAND_CLIENT_ID: BASE.clientId,
      N8N_COMMAND_CLIENT_SECRET: BASE.clientSecret,
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ accepted: true }),
    }),
  });
  assert.equal(worker.queueName, 'billing');
  assert.equal(worker.leaseMs, 45000);
  await worker.runOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'sent');
});
