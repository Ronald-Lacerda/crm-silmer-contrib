import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import {
  createDashboardRuntime,
  dashboardPeriod,
  projectDashboardConversation,
  readDashboardPerformance,
} from '../apps/api/src/dashboard-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const SELLER = {
  id: 'seller-synthetic',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: [],
};

/** @param {Record<string,any>} [extra] */
function conversation(extra = {}) {
  return {
    id: 'conversation-synthetic',
    version: 4,
    assigned_user_id: SELLER.id,
    automation_state: 'human',
    display_name: 'Cliente Sintético',
    message_id: 'message-synthetic',
    last_direction: 'inbound',
    last_status: 'received',
    last_delivery_status: null,
    last_occurred_at: '2026-11-05T14:00:00.000Z',
    ...extra,
  };
}

test('ACT: unresolved sends remain actionable without pretending the customer owes a reply', () => {
  assert.equal(
    projectDashboardConversation(conversation(), NOW)?.reason,
    'awaiting_reply',
  );
  for (const [status, reason] of [
    ['queued', 'send_pending'],
    ['sending', 'send_pending'],
    ['failed', 'send_failure'],
    ['outcome_unknown', 'send_unknown'],
  ]) {
    const item = projectDashboardConversation(
      conversation({
        last_direction: 'outbound',
        last_author_kind: 'human',
        last_status: status,
      }),
      NOW,
    );
    assert.equal(item?.kind, 'reply');
    assert.equal(item?.reason, reason);
    assert.doesNotMatch(item?.subtitle ?? '', /Cliente espera/u);
  }
  const receiptFailure = projectDashboardConversation(
    conversation({
      last_direction: 'outbound',
      last_author_kind: 'human',
      last_status: 'sent',
      last_delivery_status: 'failed',
    }),
    NOW,
  );
  assert.equal(receiptFailure?.reason, 'send_failure');
});

test('ACT: follow-up is a 72h suggestion only after an effective human send', () => {
  const sent = conversation({
    last_direction: 'outbound',
    last_author_kind: 'human',
    last_status: 'sent',
    last_occurred_at: '2026-11-02T15:00:00.000Z',
  });
  assert.equal(projectDashboardConversation(sent, NOW)?.kind, 'followup');
  assert.match(
    projectDashboardConversation(sent, NOW)?.subtitle ?? '',
    /há 3 dias ou mais/u,
  );
  assert.equal(
    projectDashboardConversation(
      { ...sent, last_occurred_at: '2026-11-02T15:00:01.000Z' },
      NOW,
    ),
    null,
  );
  assert.equal(
    projectDashboardConversation(
      { ...sent, last_author_kind: 'assistant' },
      NOW,
    ),
    null,
  );
  assert.equal(
    projectDashboardConversation({ ...sent, last_author_kind: 'system' }, NOW),
    null,
  );
  assert.notEqual(
    projectDashboardConversation(
      { ...sent, last_status: 'outcome_unknown' },
      NOW,
    )?.kind,
    'followup',
  );
});

test('ACT: reminder source and target fences survive only the unchanged object', () => {
  const row = conversation({
    decision_version: 2,
    decision_target_version: 4,
    decision_source_revision: 'message:message-synthetic:received:none',
    decision_kind: 'snooze',
    decision_remind_at: '2026-11-06T12:00:00Z',
  });
  assert.equal(projectDashboardConversation(row, NOW)?.deferred, true);
  assert.equal(
    projectDashboardConversation({ ...row, version: 5 }, NOW)?.deferred,
    false,
  );
  assert.equal(
    projectDashboardConversation({ ...row, message_id: 'new-message' }, NOW)
      ?.deferred,
    false,
  );
  assert.equal(
    projectDashboardConversation(
      { ...row, decision_remind_at: '2026-11-05T12:00:00Z' },
      NOW,
    )?.deferred,
    false,
  );
  const scheduled = projectDashboardConversation(
    { ...row, decision_kind: 'schedule' },
    NOW,
  );
  assert.equal(scheduled?.kind, 'reminder');
  assert.equal(scheduled?.dueAt, '2026-11-06T12:00:00.000Z');
});

test('ACT: only a pending seller handoff in human mode appears as available', () => {
  const row = conversation({
    assigned_user_id: null,
    handoff_id: 'handoff-synthetic',
    handoff_status: 'pending',
    handoff_version: 1,
    handoff_target_role: 'Vendedor',
    handoff_created_at: '2026-11-05T14:00:00Z',
    handoff_due_at: '2026-11-05T14:30:00Z',
  });
  assert.equal(projectDashboardConversation(row, NOW)?.kind, 'handoff');
  assert.notEqual(
    projectDashboardConversation(
      { ...row, handoff_target_role: 'Financeiro' },
      NOW,
    )?.kind,
    'handoff',
  );
  assert.notEqual(
    projectDashboardConversation({ ...row, automation_state: 'assistant' }, NOW)
      ?.kind,
    'handoff',
  );
});

test('PERF: seven/thirty-day windows use the São Paulo day, not the UTC date', () => {
  assert.deepEqual(dashboardPeriod(new Date('2026-11-01T01:00:00Z'), 7), {
    from: '2026-10-25',
    to: '2026-10-31',
    days: 7,
    timeZone: 'America/Sao_Paulo',
  });
  assert.equal(dashboardPeriod(NOW, 30).from, '2026-10-07');
  assert.throws(() => dashboardPeriod(NOW, 8), { code: 'INVALID_FILTER' });
});

test('PERF: the shared report keeps unattributed sales explicit and passes the caller scope to SQL', async () => {
  /** @type {unknown[][]} */
  const parameters = [];
  const database = {
    query: async (
      /** @type {string} */ _sql,
      /** @type {unknown[]} */ values = [],
    ) => {
      parameters.push(values);
      return {
        rows: [
          {
            people: [
              {
                user_id: SELLER.id,
                name: 'Vendedor Sintético',
                active: false,
                sold_amount_cents: '120000',
                confirmed_count: 2,
                attended_count: 3,
                assumed_count: 2,
                closed_count: 1,
                conversations_with_sale_count: 1,
              },
            ],
            totals: { soldAmountCents: 150000, confirmedCount: 3 },
            store: { soldAmountCents: 0, confirmedCount: 0 },
            unattributed: { soldAmountCents: 30000, confirmedCount: 1 },
          },
        ],
      };
    },
  };
  const report = await readDashboardPerformance(database, {
    from: '2026-11-04',
    to: '2026-11-04',
    manager: true,
  });
  assert.equal(report.rows[0].averageTicketCents, 60000);
  assert.equal(report.rows[0].active, false);
  assert.equal(report.coverage.unattributedConfirmedCount, 1);
  assert.deepEqual(parameters[0], ['2026-11-04', '2026-11-04', null, true]);
  await readDashboardPerformance(database, {
    from: '2026-11-04',
    to: '2026-11-04',
    actorId: SELLER.id,
  });
  assert.deepEqual(parameters[1], [
    '2026-11-04',
    '2026-11-04',
    SELLER.id,
    false,
  ]);
  await assert.rejects(
    readDashboardPerformance(database, {
      from: '2026-11-31',
      to: '2026-12-01',
      manager: true,
    }),
    { code: 'INVALID_FILTER' },
  );
});

test('ACT: reminder instants require a real calendar day and an explicit timezone', async () => {
  let queried = false;
  const runtime = createDashboardRuntime(
    {
      transaction: async () => {
        queried = true;
      },
    },
    {
      access: {},
      orderEnvelopeKey: Buffer.alloc(32, 1),
      idempotencyEnvelopeKey: Buffer.alloc(32, 2),
      clock: () => NOW,
    },
  );
  for (const remindAt of [
    '2026-11-06T09:00',
    '2026-11-06T09:00:00',
    '2026-11-31T09:00:00Z',
    '2026-11-06T24:00:00Z',
    '2026-11-05T12:00:00Z',
    '2027-11-06T09:00:00Z',
  ]) {
    await assert.rejects(
      runtime.decide({
        actor: SELLER,
        actionId: 'conversation:synthetic',
        decision: 'snooze',
        expectedVersion: 1,
        sourceRevision: 'message:one:received:none',
        expectedDecisionVersion: 0,
        remindAt,
        idempotencyKey: 'command-synthetic',
        correlationId: 'correlation-synthetic',
      }),
      { code: 'INVALID_REMINDER_DATE' },
      remindAt,
    );
  }
  assert.equal(queried, false);
});

/** @param {any} [actor] */
function apiHarness(actor = SELLER) {
  /** @type {any[]} */
  const calls = [];
  const runtime = {
    authorizeRead: async (/** @type {any} */ input) => {
      calls.push(input);
      authorize(actor, input.action);
      return { actor };
    },
    authorizeWrite: async (/** @type {any} */ input) => {
      calls.push(input);
      authorize(actor, input.action);
      if (
        input.origin !== 'https://crm.example.test' ||
        input.csrfToken !== 'synthetic-csrf'
      )
        throw Object.assign(new Error('forbidden'), {
          statusCode: 403,
          code: 'CSRF_INVALID',
        });
      return { actor };
    },
    actions: async (/** @type {any} */ input) => {
      calls.push(input);
      return {
        generatedAt: NOW.toISOString(),
        today: '2026-11-05',
        items: [],
        hasMore: false,
      };
    },
    performance: async (/** @type {any} */ input) => {
      calls.push(input);
      return { rows: [], days: input.days };
    },
    decide: async (/** @type {any} */ input) => {
      calls.push(input);
      return {
        id: input.actionId,
        decisionVersion: 1,
        decision: input.decision,
        remindAt: input.remindAt,
      };
    },
  };
  return {
    calls,
    api: createApi(
      {},
      {
        dashboard: runtime,
        logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      },
    ),
  };
}

test('dashboard reads are private and reject scope/actor injection instead of trusting the browser', async (t) => {
  const { api, calls } = apiHarness();
  t.after(() => api.close());
  const response = await api.inject({
    url: '/api/v1/dashboard/actions',
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(calls.at(-1).actor.id, SELLER.id);
  for (const url of [
    '/api/v1/dashboard/actions?actorId=someone-else',
    '/api/v1/dashboard/performance?scope=team',
    '/api/v1/dashboard/performance?days=8',
  ]) {
    const refused = await api.inject({ url });
    assert.equal(refused.statusCode, 400, url);
  }
  const performance = await api.inject({
    url: '/api/v1/dashboard/performance?days=30',
  });
  assert.equal(performance.statusCode, 200);
  assert.equal(performance.json().days, 30);
});

test('dashboard rejects Financeiro and requires write guards plus idempotency', async (t) => {
  const financial = apiHarness({ ...SELLER, functionName: 'Financeiro' });
  t.after(() => financial.api.close());
  for (const url of [
    '/api/v1/dashboard/actions',
    '/api/v1/dashboard/performance',
  ])
    assert.equal((await financial.api.inject({ url })).statusCode, 403);
  const { api, calls } = apiHarness();
  t.after(() => api.close());
  const request = {
    method: /** @type {const} */ ('POST'),
    url: '/api/v1/dashboard/actions/conversation%3Asynthetic/decision',
    payload: {
      decision: 'snooze',
      expectedVersion: 2,
      sourceRevision: 'message:one:received:none',
      expectedDecisionVersion: 0,
      remindAt: '2026-11-06T12:00:00Z',
    },
  };
  assert.equal(
    (
      await api.inject({
        ...request,
        headers: { origin: 'https://crm.example.test' },
      })
    ).statusCode,
    403,
  );
  const headers = {
    origin: 'https://crm.example.test',
    'x-csrf-token': 'synthetic-csrf',
    'idempotency-key': 'decision-synthetic',
  };
  const ok = await api.inject({ ...request, headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(calls.at(-1).actor.id, SELLER.id);
  assert.equal(calls.at(-1).actionId, 'conversation:synthetic');
  const extra = await api.inject({
    ...request,
    headers,
    payload: { ...request.payload, actorId: 'other' },
  });
  assert.equal(extra.statusCode, 400);
  const missingKey = await api.inject({
    ...request,
    headers: {
      origin: headers.origin,
      'x-csrf-token': headers['x-csrf-token'],
    },
  });
  assert.equal(missingKey.statusCode, 400);
});
