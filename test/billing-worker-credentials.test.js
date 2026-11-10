import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBillingCommandJobHandler } from '../modules/integration-reliability/src/billing-command-worker.js';
import { createBillingPaymentCheckJobHandler } from '../modules/integration-reliability/src/billing-payment-check-worker.js';
import { createBillingWorkerRuntime } from '../apps/worker/src/worker.js';

const ID = '50c242cc-7a80-48a0-b2ce-750807589e17';
const BASE = {
  endpoint: 'https://automation.example.test/billing',
  clientId: 'synthetic-billing',
  clientSecret: 'test-basic-13',
};
const CLIENTS = [
  {
    name: 'checkout',
    create: createBillingCommandJobHandler,
    job: { jobType: 'billing.checkout.create', idempotencyKey: ID },
    payload: { schema_version: '1.0', charge_id: ID },
  },
  {
    name: 'payment-check',
    create: createBillingPaymentCheckJobHandler,
    job: { jobType: 'billing.payment.check', idempotencyKey: `${ID}:1` },
    payload: { schema_version: '1.0', check_id: ID },
  },
];

for (const client of CLIENTS) {
  test(`BREL-09 ${client.name}: legacy Basic bytes and upper bounds survive transport`, async () => {
    assert.equal(BASE.clientSecret.length, 13);
    for (const credentials of [
      BASE,
      { ...BASE, clientId: 'u'.repeat(256), clientSecret: 's'.repeat(1024) },
      { ...BASE, clientId: ' synthetic ', clientSecret: ' legacy:13 ' },
    ]) {
      let requests = 0;
      const handler = client.create({
        ...credentials,
        fetchImpl: async (
          /** @type {URL} */ url,
          /** @type {RequestInit} */ init,
        ) => {
          requests++;
          assert.equal(url.href, BASE.endpoint);
          assert.equal(init.method, 'POST');
          assert.equal(init.redirect, 'error');
          assert.ok(init.signal instanceof AbortSignal);
          assert.equal(
            new globalThis.Headers(init.headers).get('authorization'),
            `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
          );
          assert.deepEqual(JSON.parse(String(init.body)), client.payload);
          return { status: 200, json: async () => ({ accepted: true }) };
        },
      });
      assert.deepEqual(
        await handler(client.job, { markEffectStarted: async () => true }),
        { outcome: 'sent', providerExternalId: ID },
      );
      assert.equal(requests, 1);
    }
  });

  test(`BREL-09 ${client.name}: invalid Basic components fail before transport`, () => {
    for (const field of ['clientId', 'clientSecret']) {
      const maximum = field === 'clientId' ? 256 : 1024;
      for (const value of [
        undefined,
        null,
        13,
        '',
        ' \t ',
        'synthetic\rsecret',
        'synthetic\nsecret',
        's'.repeat(maximum + 1),
        ...(field === 'clientId' ? ['synthetic:user'] : []),
      ]) {
        assert.throws(
          () =>
            client.create({
              ...BASE,
              [field]: value,
              fetchImpl: async () => {
                assert.fail('invalid credentials must not reach transport');
              },
            }),
          {
            name: 'TypeError',
            message: 'Valid billing workflow credentials are required',
          },
        );
      }
    }
  });

  test(`BREL-09 ${client.name}: endpoint and timeout guards remain enforced`, () => {
    for (const endpoint of [
      'http://automation.example.test/billing',
      'https://user:password@automation.example.test/billing',
      `${BASE.endpoint}?private=value`,
      `${BASE.endpoint}#fragment`,
    ]) {
      assert.throws(() => client.create({ ...BASE, endpoint }), TypeError);
    }
    for (const timeoutMs of [0, -1, 1.5, 60001]) {
      assert.throws(() => client.create({ ...BASE, timeoutMs }), TypeError);
    }
  });

  test(`BREL-09 ${client.name}: legacy authentication failures and redirects never become success`, async () => {
    for (const status of [401, 403, 302]) {
      let requests = 0;
      const handler = client.create({
        ...BASE,
        fetchImpl: async () => {
          requests++;
          return { status, json: async () => ({ accepted: true }) };
        },
      });
      const result = await handler(client.job, {
        markEffectStarted: async () => true,
      });
      assert.deepEqual(
        result,
        status !== 302
          ? {
              outcome: 'failed',
              errorCode:
                client.name === 'checkout'
                  ? 'BILLING_WORKFLOW_AUTH_REJECTED'
                  : 'BILLING_CHECK_AUTH_REJECTED',
              retryable: false,
              retrySafe: false,
            }
          : client.name === 'checkout'
            ? {
                outcome: 'outcome_unknown',
                errorCode: 'BILLING_WORKFLOW_OUTCOME_UNKNOWN',
                retryable: false,
                retrySafe: false,
              }
            : {
                outcome: 'failed',
                errorCode: 'BILLING_CHECK_UNAVAILABLE',
                retryable: true,
                retrySafe: true,
              },
      );
      assert.equal(requests, 1);
    }
  });
}

test('BREL-09/04 receive-only starts with legacy Basic and refuses checkout without HTTP or effect reservation', async () => {
  /** @type {any[]} */
  const settled = [];
  let requests = 0;
  const worker = createBillingWorkerRuntime({
    environment: {
      ORDER_BILLING_ENABLED: 'false',
      ORDER_BILLING_CHAT_SEND_ENABLED: 'false',
      ORDER_BILLING_RECEIVE_ENABLED: 'true',
      ORDER_BILLING_CHECK_N8N_URL: BASE.endpoint,
      N8N_COMMAND_CLIENT_ID: BASE.clientId,
      N8N_COMMAND_CLIENT_SECRET: BASE.clientSecret,
    },
    database: {
      transaction: async (/** @type {any} */ work) =>
        work({ query: async () => ({ rows: [] }) }),
    },
    queue: {
      claim: async () =>
        CLIENTS.map((client) => ({
          ...client.job,
          id: client.name,
          attemptId: `${client.name}-attempt`,
        })),
      heartbeat: async () => true,
      markEffectStarted: async () => {
        assert.fail('receive-only must not reserve an irreversible effect');
      },
      settle: async (/** @type {any} */ value) => settled.push(value),
    },
    fetchImpl: async (
      /** @type {URL} */ url,
      /** @type {RequestInit} */ init,
    ) => {
      requests++;
      assert.equal(url.href, BASE.endpoint);
      assert.deepEqual(JSON.parse(String(init.body)), CLIENTS[1].payload);
      assert.equal(
        new globalThis.Headers(init.headers).get('authorization'),
        `Basic ${Buffer.from(`${BASE.clientId}:${BASE.clientSecret}`).toString('base64')}`,
      );
      return { status: 200, json: async () => ({ accepted: true }) };
    },
    logger: /** @type {any} */ ({ info() {}, error() {}, warn() {} }),
  });
  assert.equal(await worker.runOnce(), 2);
  assert.equal(requests, 1);
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].errorCode, 'BILLING_DISABLED');
  assert.equal(settled[0].retryable, false);
  assert.equal(settled[1].outcome, 'sent');
});
