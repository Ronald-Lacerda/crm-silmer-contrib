import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOMATION_STALL_SWEEP_JOB,
  AutomationStallScheduler,
  loadAutomationStallSweeper,
} from '../apps/worker/src/worker.js';
import {
  ASSISTANT_STALL_MINUTES,
  PostgresAutomationStallSweeper,
  createPostgresAutomationStallSweeper,
  readAssistantStallMinutes,
} from '../modules/n8n-integration/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';
import {
  ASSISTANT_STALL_MINUTES as OPERATION_STALL_MINUTES,
  createOperationReadService,
} from '../apps/api/src/operation-runtime.js';

const database = /** @type {any} */ ({
  query: async () => ({ rows: [] }),
  transaction: async () => {},
});

test('AGENTE-FAIL-01: ASSISTANT_STALL_MINUTES defaults to 5 and is clamped to 2..60', () => {
  assert.equal(readAssistantStallMinutes(undefined), 5);
  assert.equal(readAssistantStallMinutes(''), 5);
  assert.equal(readAssistantStallMinutes('7'), 7);
  assert.equal(readAssistantStallMinutes('1'), 2);
  assert.equal(readAssistantStallMinutes('0'), 2);
  assert.equal(readAssistantStallMinutes('90'), 60);
  for (const invalid of ['abc', '-3', '2.5', '5m']) {
    assert.throws(() => readAssistantStallMinutes(invalid), {
      code: 'ASSISTANT_STALL_MINUTES_INVALID',
    });
  }
  assert.deepEqual(ASSISTANT_STALL_MINUTES, { default: 5, max: 60, min: 2 });
});

test('AGENTE-FAIL-01: the sweeper refuses a missing key or an out-of-range window', () => {
  assert.throws(
    () =>
      new PostgresAutomationStallSweeper({
        database,
        envelopeKey: Buffer.alloc(16),
      }),
    /32-byte/u,
  );
  assert.throws(
    () =>
      new PostgresAutomationStallSweeper({
        database,
        envelopeKey: Buffer.alloc(32),
        stallMinutes: 1,
      }),
    /between 2 and 60/u,
  );
  assert.throws(
    () => createPostgresAutomationStallSweeper({ database, environment: {} }),
    /N8N_INTEGRATION_ENVELOPE_KEY/u,
  );
  const sweeper = createPostgresAutomationStallSweeper({
    database,
    environment: {
      ASSISTANT_STALL_MINUTES: '3',
      N8N_INTEGRATION_ENVELOPE_KEY: Buffer.alloc(32, 9).toString('base64url'),
    },
  });
  assert.equal(sweeper.stallMinutes, 3);
});

test('AGENTE-FAIL-01: a failed sweep logs only a bounded code and the next poll still runs', async () => {
  const records = /** @type {any[]} */ ([]);
  const logger = createSafeLogger({
    service: 'crm-silmer-worker',
    sink: (record) => records.push(record),
  });
  let calls = 0;
  const scheduler = new AutomationStallScheduler({
    logger,
    sweeper: {
      async sweep() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('Cliente 5527999999999 sem resposta'), {
            code: 'LOCK_TIMEOUT',
          });
        }
        return { candidates: 0, handedOff: 0 };
      },
    },
  });
  await scheduler.poll();
  await scheduler.poll();
  assert.equal(calls, 2);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'worker_job_failed');
  assert.equal(records[0].job_type, AUTOMATION_STALL_SWEEP_JOB);
  assert.equal(records[1].event, 'automation_stall_sweep_completed');
  assert.doesNotMatch(JSON.stringify(records), /5527999999999|Cliente/u);
  await scheduler.stop();
});

test('AGENTE-FAIL-01: the scheduler does not overlap sweeps and stops cleanly', async () => {
  let running = 0;
  let maximum = 0;
  /** @type {() => void} */
  let release = () => {};
  const scheduler = new AutomationStallScheduler({
    intervalMs: 1_000,
    sweeper: {
      async sweep() {
        running += 1;
        maximum = Math.max(maximum, running);
        await new Promise((resolve) => {
          release = () => resolve(undefined);
        });
        running -= 1;
      },
    },
  });
  const first = scheduler.poll();
  const second = scheduler.poll();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(maximum, 1);
  assert.throws(
    () =>
      new AutomationStallScheduler({
        intervalMs: 10,
        sweeper: { sweep: async () => {} },
      }),
    /at least 1000ms/u,
  );
  assert.throws(() => new AutomationStallScheduler(/** @type {any} */ ({})));
});

test('AGENTE-FAIL-01: the worker loads the sweep from the domain module at its boundary', async () => {
  const sweeper = { sweep: async () => ({ candidates: 0, handedOff: 0 }) };
  const loaded = await loadAutomationStallSweeper(
    database,
    {},
    async (specifier) => {
      assert.equal(specifier, '@crm-silmer/n8n-integration');
      return { createPostgresAutomationStallSweeper: () => sweeper };
    },
  );
  assert.equal(loaded, sweeper);
  await assert.rejects(
    loadAutomationStallSweeper(database, {}, async () => ({})),
    { code: 'AUTOMATION_STALL_SWEEPER_UNAVAILABLE' },
  );
});

test('AGENTE-FAIL-01: each sweep logs its counts and the codes of the conversations that failed', async () => {
  const records = /** @type {any[]} */ ([]);
  const scheduler = new AutomationStallScheduler({
    logger: createSafeLogger({
      service: 'crm-silmer-worker',
      sink: (record) => records.push(record),
    }),
    sweeper: {
      sweep: async () => ({
        candidates: 4,
        errorCodes: ['55P03', '55P03', 'conversa 5527999999999'],
        failed: 3,
        handedOff: 1,
      }),
    },
  });
  await scheduler.poll();
  assert.deepEqual(
    {
      candidates: records[0].candidates,
      event: records[0].event,
      failed: records[0].failed,
      handed_off: records[0].handed_off,
      job_type: records[0].job_type,
    },
    {
      candidates: 4,
      event: 'automation_stall_sweep_completed',
      failed: 3,
      handed_off: 1,
      job_type: AUTOMATION_STALL_SWEEP_JOB,
    },
  );
  assert.equal(records[0].redacted_field_count, undefined);
  const failures = records.filter(
    (record) => record.event === 'worker_job_failed',
  );
  assert.equal(failures.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /5527999999999|conversa/u);
});

test('AGENTE-FAIL-01: the Painel counts stalled conversations with the sweep rule and window', async () => {
  const seen = /** @type {any[]} */ ([]);
  const service = createOperationReadService({
    clock: () => new Date('2026-10-30T12:00:00.000Z'),
    contactRepository: {},
    countStalled: async (now) => {
      seen.push(now.toISOString());
      return 3;
    },
    cursorKey: Buffer.alloc(32, 1),
    handoffRepository: {},
    inboxRepository: {
      async summary(/** @type {any} */ input) {
        seen.push(input.stallMinutes);
        return {
          assistant: { stallMinutes: input.stallMinutes, stalledCount: 9 },
        };
      },
    },
    stallMinutes: 7,
  });
  const summary = await service.summarizeInbox({ actorId: 'user-1' });
  assert.deepEqual(summary.assistant, { stallMinutes: 7, stalledCount: 3 });
  assert.deepEqual(seen, [7, '2026-10-30T12:00:00.000Z']);
  assert.equal(ASSISTANT_STALL_MINUTES.default, OPERATION_STALL_MINUTES);
});
