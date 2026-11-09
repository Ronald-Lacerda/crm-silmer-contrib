import assert from 'node:assert/strict';
import test from 'node:test';
import { createOlistJobHandler } from '../apps/worker/src/olist-runtime.js';
import { createOlistWorkerRuntime } from '../apps/worker/src/worker.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const EXPORT_ID = '00000000-0000-4000-8000-000000000008';
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_DISPATCH_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-worker',
  OLIST_CLIENT_SECRET: 'synthetic-worker-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 61).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 62).toString('base64'),
};
function job() {
  return {
    id: 'synthetic-olist-job',
    jobType: 'olist.export',
    queue: 'olist',
    attemptId: 'synthetic-processing-attempt',
    olistExportId: EXPORT_ID,
    idempotencyKey: 'another-reference-must-not-be-used',
    actor: { id: 'forged-actor', olistEnabled: true },
    snapshot: { customer: 'PRIVATE_WORKER_PAYLOAD_CANARY' },
    settings: { sellerId: 99999 },
  };
}
const logger = createSafeLogger({
  service: 'crm-silmer-worker',
  sink: () => {},
});

test('T08 dispatch is opt-in: absence/false or connection configuration alone never touches database, queue or HTTP', () => {
  let touches = 0;
  const options = {
    database: {
      query() {
        touches++;
        throw new Error('Unexpected database access');
      },
      transaction() {
        touches++;
        throw new Error('Unexpected transaction');
      },
    },
    queue: {
      claim() {
        touches++;
        throw new Error('Unexpected claim');
      },
    },
    dispatcher: {
      dispatch() {
        touches++;
        throw new Error('Unexpected dispatch');
      },
    },
    fetch: async () => {
      touches++;
      throw new Error('Unexpected HTTP');
    },
    logger,
  };
  for (const flag of [undefined, 'false', 'TRUE', '1'])
    assert.equal(
      createOlistWorkerRuntime({
        ...options,
        environment: { ...environment, OLIST_DISPATCH_ENABLED: flag },
      }),
      undefined,
    );
  assert.equal(
    createOlistWorkerRuntime({
      ...options,
      environment: { OLIST_DISPATCH_ENABLED: 'true' },
    }),
    undefined,
  );
  assert.equal(touches, 0);
});

test('T08 enabled worker claims only the Olist queue and settles explicit results without automatic retry', async () => {
  /** @type {any[]} */ const calls = [];
  let claimed = false;
  const queue = {
    async claim(/** @type {any} */ input) {
      calls.push(['claim', input]);
      if (claimed) return [];
      claimed = true;
      return [job()];
    },
    async heartbeat() {
      return true;
    },
    async markEffectStarted(/** @type {any} */ input) {
      calls.push(['mark', input]);
      return true;
    },
    async settle(/** @type {any} */ input) {
      calls.push(['settle', input]);
      return true;
    },
  };
  const worker = createOlistWorkerRuntime({
    database: {},
    environment,
    queue,
    logger,
    dispatcher: {
      async dispatch(/** @type {any} */ input) {
        calls.push(['dispatch', input]);
        return {
          outcome: 'sent',
          providerExternalId: '401',
          retryable: false,
          retrySafe: false,
        };
      },
    },
  });
  assert.ok(worker);
  assert.equal(worker.queueName, 'olist');
  assert.equal(typeof worker.handlers['olist.export'], 'function');
  assert.equal(worker.handlers['n8n.command.deliver'], undefined);
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(
    calls.map((row) => row[0]),
    ['claim', 'mark', 'dispatch', 'settle'],
  );
  assert.equal(calls[0][1].queue, 'olist');
  assert.equal(calls[2][1].exportId, EXPORT_ID);
  assert.doesNotMatch(
    JSON.stringify(calls[2][1]),
    /forged-actor|PRIVATE_WORKER_PAYLOAD_CANARY|99999|another-reference/u,
  );
  assert.equal(calls[3][1].outcome, 'sent');
  assert.equal(calls[3][1].retryable, false);
  assert.equal(calls[3][1].retrySafe, false);
  assert.equal(await worker.runOnce(), 0);
});

test('T08 handler marks the effect boundary before invoking the dispatcher and forwards only the persisted export id', async () => {
  /** @type {any[]} */ const calls = [];
  const handler = createOlistJobHandler({
    environment,
    dispatcher: {
      async dispatch(/** @type {any} */ input) {
        calls.push(['dispatch', input]);
        return {
          outcome: 'outcome_unknown',
          errorCode: 'OLIST_SALE_UNCERTAIN',
          retryable: false,
          retrySafe: false,
        };
      },
    },
  });
  const result = await handler(job(), {
    async markEffectStarted(/** @type {any} */ input) {
      calls.push(['boundary', input]);
      return true;
    },
    async heartbeat() {
      return true;
    },
  });
  assert.equal(calls[0][0], 'boundary');
  assert.equal(calls[0][1].provider, 'olist');
  assert.equal(calls[1][1].exportId, EXPORT_ID);
  assert.equal(calls[1][1].actor, undefined);
  assert.equal(calls[1][1].snapshot, undefined);
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.retryable, false);
  assert.equal(result.retrySafe, false);
});

test('T08 losing the processing lease prevents dispatcher/HTTP entry', async () => {
  let calls = 0;
  const handler = createOlistJobHandler({
    environment,
    dispatcher: {
      async dispatch() {
        calls++;
        return { outcome: 'sent' };
      },
    },
  });
  const result = await handler(job(), {
    async markEffectStarted() {
      return false;
    },
    async heartbeat() {
      return false;
    },
  });
  assert.notEqual(result.outcome, 'sent');
  assert.equal(result.retryable, false);
  assert.equal(result.retrySafe, false);
  assert.equal(calls, 0);
});

test('T08 malformed jobs cannot select another target or enter the effect boundary', async () => {
  let calls = 0;
  const handler = createOlistJobHandler({
    environment,
    dispatcher: {
      async dispatch() {
        calls++;
        return { outcome: 'sent' };
      },
    },
  });
  for (const value of [
    { id: 'x', jobType: 'olist.export' },
    { ...job(), olistExportId: '../../private' },
    { ...job(), olistExportId: '' },
  ]) {
    const result = await handler(value, {
      async markEffectStarted() {
        calls++;
        return true;
      },
      async heartbeat() {
        return true;
      },
    });
    assert.notEqual(result.outcome, 'sent');
    assert.equal(result.retryable, false);
    assert.equal(result.retrySafe, false);
  }
  assert.equal(calls, 0);
});

test('T08 unexpected provider exceptions are bounded and never become a safe retry or PII log', async () => {
  /** @type {any[]} */ const records = [];
  const safeLogger = createSafeLogger({
    service: 'crm-silmer-worker',
    sink: (record) => records.push(record),
  });
  const queue = {
    async claim() {
      return [job()];
    },
    async heartbeat() {
      return true;
    },
    async markEffectStarted() {
      return true;
    },
    async settle(/** @type {any} */ value) {
      records.push(value);
      return true;
    },
  };
  const worker = createOlistWorkerRuntime({
    database: {},
    environment,
    queue,
    logger: safeLogger,
    dispatcher: {
      async dispatch() {
        throw new Error(
          'PRIVATE_PROVIDER_BODY_CANARY buyer@example.test Bearer PRIVATE_TOKEN_CANARY',
        );
      },
    },
  });
  assert.ok(worker);
  await worker.runOnce();
  const settlement = records.find((row) => row.jobId === job().id);
  assert.equal(settlement.outcome, 'outcome_unknown');
  assert.equal(settlement.retryable, false);
  assert.equal(settlement.retrySafe, false);
  assert.doesNotMatch(
    JSON.stringify(records),
    /PRIVATE_|buyer@example|Bearer/u,
  );
});

test('LIVENESS the handler grants a retry only to a plain pre-effect failure with a retryable code and both flags', async () => {
  /** @param {any} response */
  async function run(response) {
    const handler = createOlistJobHandler({
      environment,
      dispatcher: { dispatch: async () => response },
    });
    return handler(job(), {
      async markEffectStarted() {
        return true;
      },
      async heartbeat() {
        return true;
      },
    });
  }
  for (const code of [
    'OLIST_RATE_LIMITED',
    'OLIST_UNAVAILABLE',
    'OLIST_REFRESH_IN_PROGRESS',
  ]) {
    const granted = await run({
      outcome: 'failed',
      errorCode: code,
      retryable: true,
      retrySafe: true,
    });
    assert.deepEqual(granted, {
      outcome: 'failed',
      errorCode: code,
      retryable: true,
      retrySafe: true,
    });
  }
  /** @type {any[]} */
  const denied = [
    // One flag is not enough.
    { outcome: 'failed', errorCode: 'OLIST_RATE_LIMITED', retryable: true },
    { outcome: 'failed', errorCode: 'OLIST_RATE_LIMITED', retrySafe: true },
    // Neither is a code outside the set, however flagged.
    {
      outcome: 'failed',
      errorCode: 'OLIST_SALE_ALREADY_EXISTS',
      retryable: true,
      retrySafe: true,
    },
    {
      outcome: 'failed',
      errorCode: 'ORDER_CANCELLED',
      retryable: true,
      retrySafe: true,
    },
    {
      outcome: 'failed',
      errorCode: 'PRIVATE_UNKNOWN_CODE',
      retryable: true,
      retrySafe: true,
    },
    { outcome: 'failed', retryable: true, retrySafe: true },
    // An uncertain or successful effect is never retried.
    {
      outcome: 'outcome_unknown',
      errorCode: 'OLIST_RATE_LIMITED',
      retryable: true,
      retrySafe: true,
    },
    {
      outcome: 'outcome_unknown',
      errorCode: 'OLIST_SALE_UNCERTAIN',
      retryable: true,
      retrySafe: true,
    },
    {
      outcome: 'sent',
      providerExternalId: '401',
      retryable: true,
      retrySafe: true,
    },
    // Truthy is not true.
    {
      outcome: 'failed',
      errorCode: 'OLIST_UNAVAILABLE',
      retryable: 1,
      retrySafe: 'yes',
    },
  ];
  for (const response of denied) {
    const result = await run(response);
    assert.equal(result.retryable, false, JSON.stringify(response));
    assert.equal(result.retrySafe, false, JSON.stringify(response));
  }
  const unknown = await run({
    outcome: 'failed',
    errorCode: 'PRIVATE_UNKNOWN_CODE',
    retryable: true,
    retrySafe: true,
  });
  assert.equal(unknown.errorCode, 'OLIST_DISPATCH_FAILED');
});

test('LIVENESS the handler maps the new codes through and a thrown retryable code stays uncertain and terminal', async () => {
  const handler = createOlistJobHandler({
    environment,
    dispatcher: {
      async dispatch() {
        throw Object.assign(new Error('PRIVATE_CANARY'), {
          code: 'OLIST_RATE_LIMITED',
        });
      },
    },
  });
  const result = await handler(job(), {
    async markEffectStarted() {
      return true;
    },
    async heartbeat() {
      return true;
    },
  });
  assert.deepEqual(result, {
    outcome: 'outcome_unknown',
    errorCode: 'OLIST_RATE_LIMITED',
    retryable: false,
    retrySafe: false,
  });
  const unavailable = createOlistJobHandler({
    environment,
    dispatcher: {
      async dispatch() {
        return {
          outcome: 'failed',
          errorCode: 'OLIST_EXPORT_UNAVAILABLE',
          retryable: false,
          retrySafe: false,
        };
      },
    },
  });
  const archived = await unavailable(job(), {
    async markEffectStarted() {
      return true;
    },
    async heartbeat() {
      return true;
    },
  });
  assert.equal(archived.errorCode, 'OLIST_EXPORT_UNAVAILABLE');
  assert.equal(archived.retryable, false);
});

test('LIVENESS the worker settles a granted retry as retryable and retrySafe', async () => {
  /** @type {any[]} */ const settled = [];
  let claimed = false;
  const worker = createOlistWorkerRuntime({
    database: {},
    environment,
    logger,
    queue: {
      async claim() {
        if (claimed) return [];
        claimed = true;
        return [job()];
      },
      async heartbeat() {
        return true;
      },
      async markEffectStarted() {
        return true;
      },
      async settle(/** @type {any} */ input) {
        settled.push(input);
        return true;
      },
    },
    dispatcher: {
      async dispatch() {
        return {
          outcome: 'failed',
          errorCode: 'OLIST_RATE_LIMITED',
          retryable: true,
          retrySafe: true,
        };
      },
    },
  });
  assert.ok(worker);
  assert.equal(await worker.runOnce(), 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].errorCode, 'OLIST_RATE_LIMITED');
  assert.equal(settled[0].retryable, true);
  assert.equal(settled[0].retrySafe, true);
});
