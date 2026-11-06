import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import {
  BUSINESS_HOURS,
  createDashboardMetricsRuntime,
  METRICS_STATEMENT_TIMEOUT,
} from '../apps/api/src/dashboard-metrics-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const SELLER = {
  id: 'seller-metrics-synthetic',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: [],
};
const ADMIN = {
  ...SELLER,
  id: 'admin-metrics-synthetic',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const SERVICE_URL = '/api/v1/dashboard/metrics/service';

/** @param {any} [actor] @param {any} [service] */
function apiHarness(actor = SELLER, service) {
  /** @type {any[]} */
  const calls = [];
  const runtime = {
    authorizeRead: async (/** @type {any} */ input) => {
      calls.push(input);
      authorize(actor, input.action);
      return { actor };
    },
    service:
      service ??
      (async (/** @type {any} */ input) => {
        calls.push(input);
        return { days: input.days, scope: 'self', rows: [] };
      }),
  };
  return {
    calls,
    api: createApi(
      {},
      {
        dashboardMetrics: runtime,
        logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      },
    ),
  };
}

test('MET: service metrics accept only days=7|30 and refuse forged scope keys', async (t) => {
  const { api, calls } = apiHarness();
  t.after(() => api.close());
  const ok = await api.inject({
    url: `${SERVICE_URL}?days=30`,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.equal(calls.at(-1).days, 30);
  assert.equal(calls.at(-1).actor.id, SELLER.id);
  assert.equal((await api.inject({ url: SERVICE_URL })).json().days, 7);
  for (const [url, code] of [
    [`${SERVICE_URL}?days=8`, 'INVALID_FILTER'],
    [`${SERVICE_URL}?days=`, 'INVALID_FILTER'],
    [`${SERVICE_URL}?days=7&days=30`, 'INVALID_FILTER'],
    [`${SERVICE_URL}?userId=other`, 'INVALID_REQUEST'],
    [`${SERVICE_URL}?days=7&actorId=other`, 'INVALID_REQUEST'],
    [`${SERVICE_URL}?scope=team`, 'INVALID_REQUEST'],
  ]) {
    const refused = await api.inject({ url });
    assert.equal(refused.statusCode, 400, url);
    assert.match(
      refused.headers['content-type'] ?? '',
      /application\/problem\+json/u,
    );
    assert.equal(refused.json().code, code, url);
  }
});

test('MET: Financeiro is refused and a database failure is a 503 without detail', async (t) => {
  const financial = apiHarness({ ...SELLER, functionName: 'Financeiro' });
  t.after(() => financial.api.close());
  const refused = await financial.api.inject({ url: SERVICE_URL });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'FORBIDDEN');
  const broken = apiHarness(SELLER, async () => {
    throw new Error('connection terminated: synthetic secret detail');
  });
  t.after(() => broken.api.close());
  const failed = await broken.api.inject({ url: SERVICE_URL });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    type: 'about:blank',
    title: 'SERVICE_UNAVAILABLE',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  });
});

/** Fake transactional database: re-reads the actor and records the SQL scope.
 * @param {any} actor @param {{rows?:any[]}} [live]
 */
function fakeDatabase(actor, live = {}) {
  /** @type {any[][]} */
  const metricParams = [];
  /** @type {string[]} */
  const statements = [];
  const client = {
    query: async (/** @type {string} */ sql, /** @type {any[]} */ values) => {
      statements.push(sql);
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('FROM crm.users u JOIN crm.user_functions'))
        return {
          rows: live.rows ?? [
            { id: actor.id, function_name: actor.functionName },
          ],
        };
      if (sql.includes('FROM crm.user_capabilities'))
        return {
          rows: actor.capabilities.map((/** @type {string} */ capability) => ({
            capability,
          })),
        };
      metricParams.push(values);
      return {
        rows: [
          {
            people: [
              {
                user_id: actor.id,
                name: 'Pessoa Sintética',
                active: true,
                claim_samples: 4,
                claim_median: '12.25',
                claim_p90: '30',
                reply_samples: 5,
                reply_median: 7,
                reply_p90: 40.04,
                open_count: 0,
                oldest_open: null,
                closed_without_reply: 1,
                now_count: 0,
                now_oldest: null,
                episode_count: 2,
              },
            ],
            unclaimed: { count: 1, oldest: '16.0000' },
          },
        ],
      };
    },
  };
  return {
    metricParams,
    statements,
    transaction: async (/** @type {any} */ work) => work(client),
  };
}

test('PERF-07: a seller receives only its own row; the admin also receives the team block', async () => {
  const sellerDb = fakeDatabase(SELLER);
  const seller = await createDashboardMetricsRuntime(sellerDb, {
    access: {},
    clock: () => NOW,
  }).service({ actor: { ...SELLER, capabilities: ['COMMERCIAL_ADMIN'] } });
  // The session's cached capabilities never widen the scope.
  assert.equal(seller.scope, 'self');
  assert.equal(seller.team, undefined);
  assert.equal(sellerDb.metricParams[0][2], SELLER.id);
  assert.equal(sellerDb.metricParams[0][3], false);
  // Bounded before anything else runs in the read transaction.
  assert.equal(
    sellerDb.statements[0],
    `SET LOCAL statement_timeout = '${METRICS_STATEMENT_TIMEOUT}'`,
  );
  assert.equal(seller.from, '2026-10-30');
  assert.equal(seller.to, '2026-11-05');
  assert.equal(seller.days, 7);
  assert.deepEqual(seller.businessHours, BUSINESS_HOURS);
  assert.deepEqual(seller.rows[0].claim, {
    samples: 4,
    medianMinutes: 12.3,
    p90Minutes: null,
  });
  assert.equal(seller.rows[0].firstResponse.p90Minutes, 40);
  assert.equal(seller.rows[0].firstResponse.closedWithoutReply, 1);
  assert.equal(seller.rows[0].unansweredNow.oldestWaitingMinutes, null);
  assert.equal(seller.rows[0].unansweredEpisodes.count, 2);

  const adminDb = fakeDatabase(ADMIN);
  const admin = await createDashboardMetricsRuntime(adminDb, {
    access: {},
    clock: () => NOW,
  }).service({ actor: { ...ADMIN, capabilities: [] }, days: 30 });
  assert.equal(admin.scope, 'team');
  assert.equal(adminDb.metricParams[0][3], true);
  assert.equal(admin.from, '2026-10-07');
  assert.deepEqual(admin.team, {
    unclaimedHandoffs: { count: 1, oldestWaitingMinutes: 16 },
  });

  const finance = fakeDatabase({ ...SELLER, functionName: 'Financeiro' });
  await assert.rejects(
    createDashboardMetricsRuntime(finance, {
      access: {},
      clock: () => NOW,
    }).service({ actor: SELLER }),
    { statusCode: 403 },
  );
  assert.equal(finance.metricParams.length, 0);
  const disabled = fakeDatabase(SELLER, { rows: [] });
  await assert.rejects(
    createDashboardMetricsRuntime(disabled, {
      access: {},
      clock: () => NOW,
    }).service({ actor: SELLER }),
    { statusCode: 403, code: 'FORBIDDEN' },
  );
  await assert.rejects(
    createDashboardMetricsRuntime(sellerDb, {
      access: {},
      clock: () => NOW,
    }).service({ actor: SELLER, days: 14 }),
    { statusCode: 400, code: 'INVALID_FILTER' },
  );
});
