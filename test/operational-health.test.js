import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationalHealth } from '../apps/api/src/operational-health.js';
import { createServerApi } from '../apps/api/src/server.js';
import { WorkerRuntime } from '../apps/worker/src/worker.js';
import {
  createSafeLogger,
  MetricRegistry,
} from '../modules/shared/src/index.js';

const quiet = createSafeLogger({ service: 'crm-silmer-api', sink: () => {} });
const healthy = { worker: true, queue: true, commands: true };

test('OPSH-02/03: cold, healthy, stale, failure, recovery and each degraded signal', async () => {
  let time = 1_800_000_000_000;
  let fail = false;
  let checks = healthy;
  let queries = 0;
  const health = createOperationalHealth({
    now: () => time,
    sample: async () => {
      queries++;
      if (fail) throw new Error('private');
      return checks;
    },
  });
  assert.deepEqual(health.read(), {
    statusCode: 503,
    body: { status: 'unavailable' },
  });
  await health.refresh();
  assert.deepEqual(health.read(), {
    statusCode: 200,
    body: {
      status: 'ok',
      checkedAt: new Date(time).toISOString(),
      checks: { worker: 'ok', queue: 'ok', commands: 'ok' },
    },
  });
  for (let i = 0; i < 1000; i++) health.read();
  assert.equal(queries, 1);
  time += 120_000;
  assert.equal(health.read().statusCode, 200);
  time += 1;
  assert.equal(health.read().statusCode, 503);
  for (const key of ['worker', 'queue', 'commands']) {
    checks = { ...healthy, [key]: false };
    await health.refresh();
    assert.equal(health.read().statusCode, 503);
    assert.equal(health.read().body.checks?.[key], 'degraded');
  }
  fail = true;
  await health.refresh();
  assert.deepEqual(health.read(), {
    statusCode: 503,
    body: { status: 'unavailable' },
  });
  fail = false;
  checks = healthy;
  await health.refresh();
  assert.equal(health.read().statusCode, 200);
  await health.stop();
});

test('OPSH-03: sampling never overlaps; stop drains and prevents new sampling', async () => {
  let release = () => {};
  let queries = 0;
  const health = createOperationalHealth({
    sample: async () => {
      queries++;
      await new Promise((resolve) => {
        release = () => resolve(undefined);
      });
      return healthy;
    },
  });
  const first = health.refresh();
  assert.equal(health.refresh(), first);
  let stopped = false;
  const closing = health.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await closing;
  await health.refresh();
  assert.equal(queries, 1);
});

test('OPSH-02/05: public operational route reads snapshot without collecting incidents or disclosing errors', async () => {
  let collected = 0;
  const health = createOperationalHealth({ sample: async () => healthy });
  const api = createServerApi({
    environment: {},
    logger: quiet,
    operationalHealth: health,
    healthErrors: /** @type {any} */ ({
      cleanup: async () => {},
      recordApiFailure: async () => {
        collected++;
      },
    }),
  });
  await api.ready();
  await health.refresh();
  try {
    const response = await api.inject('/api/health/operations');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json().checks, {
      worker: 'ok',
      queue: 'ok',
      commands: 'ok',
    });
    const live = await api.inject('/api/health/live');
    assert.equal(live.statusCode, 200);
    await health.stop();
    // A separate unavailable runtime verifies the public failure path.
    const unavailable = createServerApi({
      environment: {},
      logger: quiet,
      healthErrors: /** @type {any} */ ({
        cleanup: async () => {},
        recordApiFailure: async () => {
          collected++;
        },
      }),
    });
    try {
      const failure = await unavailable.inject('/api/health/operations');
      assert.equal(failure.statusCode, 503);
      assert.deepEqual(failure.json(), { status: 'unavailable' });
      assert.equal(collected, 0);
    } finally {
      await unavailable.close();
    }
  } finally {
    await api.close();
  }
});

test('OPSH-01: publishes durable progress and queue age without failures; failures do not reset age', async () => {
  const metrics = new MetricRegistry({ logger: quiet });
  /** @type {any[]} */ const writes = [];
  const worker = new WorkerRuntime({
    logger: quiet,
    metrics,
    queueName: 'external_effects',
    now: () => 1_800_000_000_000,
    healthSignals: {
      publish: async (/** @type {any} */ input) => {
        writes.push(input);
        return { heartbeat: 1_800_000_000, age: 345 };
      },
    },
  });
  await worker.poll();
  await worker.emitHeartbeat();
  assert.deepEqual(writes, [
    { queue: 'external_effects', pollCompletedAt: new Date(1_800_000_000_000) },
  ]);
  assert.equal(metrics.snapshot().worker_oldest_job_age_seconds, 345);
  worker.recordJobFailure({ errorCode: 'JOB_FAILED' });
  assert.equal(metrics.snapshot().worker_oldest_job_age_seconds, 345);
  assert.equal(
    metrics.snapshot().worker_heartbeat_unixtime_seconds,
    1_800_000_000,
  );
  await worker.stop();
});

test('OPSH-04/05: daily cleanup cadence, no incident collection from periodic health sampling', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let cleanups = 0;
  let collections = 0;
  const health = createOperationalHealth({ sample: async () => healthy });
  const api = createServerApi({
    environment: {},
    logger: quiet,
    operationalHealth: health,
    healthErrors: /** @type {any} */ ({
      cleanup: async () => {
        cleanups++;
      },
      list: async () => {
        collections++;
        return {};
      },
      recordApiFailure: async () => {},
    }),
  });
  try {
    await api.ready();
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(cleanups, 1);
    t.mock.timers.tick(60 * 60_000);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(cleanups, 1);
    t.mock.timers.tick(23 * 60 * 60_000);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(cleanups, 2);
    assert.equal(collections, 0);
    await api.inject('/api/v1/admin/health-errors');
    assert.equal(collections, 1);
  } finally {
    await api.close();
  }
});

test('OPSH-01: stalled or failed polls do not publish fabricated progress', async () => {
  let fail = false;
  let time = 1_800_000_000_000;
  /** @type {any[]} */ const writes = [];
  const worker = new WorkerRuntime({
    logger: quiet,
    now: () => time,
    queueName: 'external_effects',
    healthSignals: {
      publish: async (/** @type {any} */ input) => {
        writes.push(input);
        return { heartbeat: time / 1000, age: 0 };
      },
    },
    queue: {
      claim: async () => {
        if (fail) throw new Error('private');
        return [];
      },
      heartbeat: async () => {},
      markEffectStarted: async () => {},
      settle: async () => {},
    },
  });
  await worker.emitHeartbeat();
  assert.equal(writes[0].pollCompletedAt, null);
  await worker.poll();
  await worker.emitHeartbeat();
  assert.equal(writes[1].pollCompletedAt.getTime(), time);
  fail = true;
  time += 130_000;
  await worker.poll();
  await worker.emitHeartbeat();
  assert.equal(writes[2].pollCompletedAt.getTime(), time - 130_000);
  await worker.stop();
});

test('OPSH-01: heartbeat publication never overlaps and stop waits for persistence', async () => {
  let writes = 0;
  let release = () => {};
  const worker = new WorkerRuntime({
    logger: quiet,
    healthSignals: {
      publish: async () => {
        writes++;
        await new Promise((resolve) => {
          release = () => resolve(undefined);
        });
        return { heartbeat: 1_800_000_000, age: 0 };
      },
    },
  });
  const first = worker.emitHeartbeat();
  assert.equal(worker.emitHeartbeat(), first);
  let stopped = false;
  const closing = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(writes, 1);
  release();
  await closing;
  assert.equal(stopped, true);
});

test('OPSH-04: daily cleanup yields between batches and stops after twenty full batches', async () => {
  let batches = 0;
  /** @type {any[]} */ const records = [];
  const logger = createSafeLogger({
    service: 'crm-silmer-api',
    sink: (record) => records.push(record),
  });
  const api = createServerApi({
    environment: {},
    logger,
    operationalHealth: createOperationalHealth({ sample: async () => healthy }),
    healthErrors: /** @type {any} */ ({
      cleanup: async () => {
        batches++;
        return { batchFull: true };
      },
      recordApiFailure: async () => {},
    }),
  });
  await api.ready();
  await api.close();
  assert.equal(batches, 20);
  assert.equal(
    records.some(
      (record) => record.error_code === 'OPERATIONAL_CLEANUP_INCOMPLETE',
    ),
    true,
  );
});
