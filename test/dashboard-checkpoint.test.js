import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import {
  CheckpointError,
  checkpointConfiguration,
  checkpointDay,
  formatDailyCheckpoint,
} from '../apps/api/src/dashboard-checkpoint-runtime.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

test('CHK: previous São Paulo civil day and strict private configuration', () => {
  assert.equal(checkpointDay(new Date('2026-11-05T02:59:59Z')), '2026-11-03');
  assert.equal(checkpointDay(new Date('2026-11-05T03:00:00Z')), '2026-11-04');
  assert.equal(checkpointDay(new Date('2027-01-01T12:00:00Z')), '2026-12-31');
  assert.equal(checkpointConfiguration({}).enabled, false);
  assert.throws(() =>
    checkpointConfiguration({ DAILY_CHECKPOINT_ENABLED: 'yes' }),
  );
  assert.throws(() =>
    checkpointConfiguration({ DAILY_CHECKPOINT_ENABLED: 'true' }),
  );
  assert.throws(() =>
    checkpointConfiguration({ DAILY_CHECKPOINT_RECIPIENTS_JSON: 'not-json' }),
  );
  assert.throws(() =>
    checkpointConfiguration({ IDEMPOTENCY_ENVELOPE_KEY: 'invalid' }),
  );
});

test('CHK: report reconciles attributed, store and historical totals without claiming receipt', () => {
  const report = {
    totals: { soldAmountCents: 123456, confirmedCount: 3 },
    rows: [
      {
        name: 'Vendedor\nSintético',
        soldAmountCents: 100000,
        confirmedCount: 1,
      },
    ],
    store: { soldAmountCents: 20000, confirmedCount: 1 },
    unattributed: { soldAmountCents: 3456, confirmedCount: 1 },
  };
  const text = formatDailyCheckpoint(report, '2026-11-04');
  assert.match(text, /04\/11\/2026/u);
  assert.match(text, /1\.234,56/u);
  assert.match(text, /Vendedor Sintético/u);
  assert.match(text, /recebimentos não incluídos/u);
  assert.match(text, /sem evidência/u);
  assert.throws(
    () =>
      formatDailyCheckpoint(
        { rows: [{ name: 'x'.repeat(4000) }] },
        '2026-11-04',
      ),
    { code: 'CHECKPOINT_REPORT_TOO_LARGE' },
  );
});

test('CHK routes: human preview and dedicated technical boundary refuse actor/phone injection', async (t) => {
  /** @type {any[]} */
  const calls = [];
  const technical = {
    actor: { id: 'AUTOMATION_EXECUTOR', kind: 'AUTOMATION_EXECUTOR' },
  };
  const api = createApi(
    {},
    {
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      automationAuth: {
        async authorize(input) {
          assert.equal(input.action, 'dashboard.checkpoint.execute');
          if (input.authorization !== 'Basic synthetic')
            throw new CheckpointError(401, 'INVALID_AUTOMATION_CREDENTIALS');
          return technical;
        },
      },
      dashboardCheckpoint: {
        async authorizeRead() {
          return { actor: { id: 'admin-synthetic', kind: 'human' } };
        },
        async preview(/** @type {any} */ input) {
          calls.push(input);
          return {
            enabled: false,
            recipients: [],
            previewText: 'Resumo sintético',
          };
        },
        async prepare(/** @type {any} */ input) {
          calls.push(input);
          return { checkpointId: 'synthetic' };
        },
        async reserve(/** @type {any} */ input) {
          calls.push(input);
          return { authorized: false };
        },
        async complete(/** @type {any} */ input) {
          calls.push(input);
          return { recorded: false };
        },
      },
    },
  );
  t.after(() => api.close());
  const read = await api.inject({ url: '/api/v1/dashboard/checkpoint' });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal(calls.at(-1).actor.id, 'admin-synthetic');
  assert.equal(
    (await api.inject({ url: '/api/v1/dashboard/checkpoint?actorId=other' }))
      .statusCode,
    400,
  );
  const url = '/api/v1/integrations/n8n/dashboard/checkpoint/prepare';
  assert.equal(
    (await api.inject({ method: 'POST', url, payload: {} })).statusCode,
    401,
  );
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Basic synthetic' },
        payload: { day: '2026-11-04' },
      })
    ).statusCode,
    200,
  );
  assert.equal(calls.at(-1).technical, technical);
  for (const payload of [
    { actor: technical.actor },
    { phone: '+15555550101' },
    { text: 'Injected message' },
  ]) {
    assert.equal(
      (
        await api.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Basic synthetic' },
          payload,
        })
      ).statusCode,
      400,
    );
  }
});
