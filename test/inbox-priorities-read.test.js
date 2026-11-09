import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresInboxReadRepository } from '../modules/inbox-channels/src/index.js';
import { encryptJson } from '../modules/n8n-integration/src/crypto.js';

const KEY = Buffer.alloc(32, 29);

/** @param {Record<string, any>} [overrides] */
function syntheticRow(overrides = {}) {
  return {
    id: 'conversation-synthetic',
    channel: 'whatsapp',
    external_identity_lookup_hash: 'synthetic-identity',
    identity_envelope: encryptJson(
      { externalIdentityId: 'synthetic-customer' },
      JSON.stringify(['crm.contact_identities', 1, 'synthetic-identity']),
      KEY,
    ),
    contact_id: 'contact-synthetic',
    display_name: 'Cliente sintético',
    automation_state: 'human',
    automation_epoch: 1,
    assigned_user_id: 'seller-synthetic',
    assigned_user_name: 'Vendedora sintética',
    function_name: 'Vendedor',
    state: 'em_atendimento',
    version: 1,
    opened_at: '2026-11-01T08:00:00.000Z',
    last_message_at: '2026-11-03T12:00:00.000Z',
    waiting_since: '2026-11-02T09:00:00.000Z',
    queue_position: '2026-11-02T09:00:00.000Z',
    order_id: 'order-synthetic',
    order_number: '01-CRM',
    order_status: 'pendente',
    order_ready_for_confirmation: true,
    review_order_id: 'order-review-synthetic',
    review_order_number: '02-CRM',
    review_order_status: 'pendente',
    ...overrides,
  };
}

/** @param {Record<string, any>[]} rows */
function harness(rows) {
  const calls = /** @type {{sql:string, values:unknown[]}[]} */ ([]);
  const repository = new PostgresInboxReadRepository({
    contactEnvelopeKey: KEY,
    messageEnvelopeKey: KEY,
    database: {
      async query(/** @type {string} */ sql, /** @type {unknown[]} */ values) {
        calls.push({ sql, values });
        return {
          rows: sql.includes('SELECT count(*)::integer count')
            ? [{ count: 174 }]
            : /^\s*SELECT message\.id|^\s*SELECT id, conversation_id, source_message_id/u.test(
                  sql,
                )
              ? []
              : rows,
        };
      },
    },
  });
  return { repository, calls };
}

test('INBOX-UX-02: projection is minimal and readiness comes from persisted order validation', async () => {
  const { repository } = harness([
    syntheticRow({
      delivery_issue_status: 'outcome_unknown',
      delivery_issue_at: '2026-11-03T10:00:00.000Z',
    }),
  ]);
  const result = await repository.list({
    workQueue: 'closing',
    actorId: 'seller-synthetic',
    limit: 1,
  });
  assert.equal(
    result.totalCount,
    174,
    'the page does not manufacture the global count',
  );
  assert.equal(result.items[0].order.readyForConfirmation, true);
  assert.deepEqual(result.items[0].reviewOrder, {
    id: 'order-review-synthetic',
    number: '02-CRM',
    status: 'pendente',
    readyForConfirmation: true,
  });
  assert.equal(result.items[0].assignedUser.name, 'Vendedora sintética');
  assert.equal(result.items[0].waitingSince, '2026-11-02T09:00:00.000Z');
  assert.equal(result.items[0].queuePosition, '2026-11-02T09:00:00.000Z');
  assert.equal(result.items[0].requiresAttention, true);
  assert.deepEqual(result.items[0].deliveryIssue, {
    status: 'outcome_unknown',
    occurredAt: '2026-11-03T10:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(result), /envelope|ciphertext|ficha/u);

  const incomplete = harness([
    syntheticRow({ order_ready_for_confirmation: false, waiting_since: null }),
  ]);
  const page = await incomplete.repository.list({ limit: 1 });
  assert.equal(page.items[0].order.readyForConfirmation, false);
  assert.equal(page.items[0].waitingSince, null);
  assert.equal(page.items[0].deliveryIssue, null);
});

test('CP-10: closure acknowledgement signal includes subject-only pending orders without replacing the canonical order', async () => {
  /** @type {Array<[Record<string, any>, boolean]>} */
  const cases = [
    [syntheticRow({ has_pending_order: true }), true],
    [
      syntheticRow({
        has_pending_order: true,
        order_id: null,
        review_order_id: null,
      }),
      true,
    ],
    [
      syntheticRow({
        has_pending_order: false,
        order_status: 'confirmado',
        review_order_id: null,
      }),
      false,
    ],
    [
      syntheticRow({
        has_pending_order: false,
        order_id: null,
        review_order_id: null,
      }),
      false,
    ],
  ];
  for (const [row, expected] of cases) {
    const { repository, calls } = harness([row]);
    const page = await repository.list({ limit: 1 });
    const detail = await repository.get(row.id);
    for (const summary of [page.items[0], detail.conversation]) {
      assert.equal(summary.hasPendingOrder, expected);
      assert.equal(summary.order?.id ?? null, row.order_id);
      assert.equal(
        summary.order?.status ?? null,
        row.order_id ? row.order_status : null,
      );
      assert.doesNotMatch(
        JSON.stringify(summary),
        /envelope|ciphertext|ficha/u,
      );
    }
    for (const { sql } of calls.filter(({ sql }) =>
      sql.includes('has_pending_order'),
    )) {
      assert.match(sql, /pending_order\.conversation_id=conversation\.id/u);
      assert.match(sql, /pending_order\.status='pendente'/u);
      assert.match(sql, /pending_subject\.conversation_id=conversation\.id/u);
      assert.match(sql, /linked_order\.id=pending_subject\.order_id/u);
      assert.match(sql, /linked_order\.status='pendente'/u);
    }
  }
});

test('INBOX-UX-02: actor, readiness and waiting predicates apply to page and global count', async () => {
  for (const workQueue of ['attention', 'closing']) {
    const { repository, calls } = harness([]);
    await repository.list({
      workQueue,
      actorId: 'seller-synthetic',
      limit: 1,
      after: { id: 'previous', updatedAt: '2026-11-02T09:00:00.000Z' },
    });
    const [page, count] = calls;
    assert.deepEqual(count.values, ['seller-synthetic']);
    assert.deepEqual(page.values, [
      'seller-synthetic',
      '2026-11-02T09:00:00.000Z',
      'previous',
      2,
    ]);
    for (const { sql } of calls) {
      assert.match(sql, /conversation\.assigned_user_id=\$1/u);
      assert.match(sql, /conversation\.assigned_user_id IS NULL/u);
      assert.match(
        sql,
        /conversation\.state NOT IN \('convertida_em_lead','sem_lead','encerrada'\)/u,
      );
      assert.match(sql, /conversation\.archived_at IS NULL/u);
      assert.match(sql, /reply\.author_kind='human'/u);
      assert.match(
        sql,
        /COALESCE\(reply\.delivery_status,reply\.status\) IN \('sent','delivered','read'\)/u,
      );
      assert.match(sql, /event\.action='conversation\.takeover'/u);
      assert.match(
        sql,
        /failed\.occurred_at,failed\.id\)>\(successful_outbound\.occurred_at,successful_outbound\.id\)/u,
      );
      assert.match(
        sql,
        /order_conversation\.assigned_user_id=conversation\.assigned_user_id/u,
      );
      assert.match(sql, /crm\.conversation_subjects/u);
      assert.doesNotMatch(sql, /ficha_envelope/u);
      if (workQueue === 'closing')
        assert.match(sql, /WHERE[\s\S]*review_order\.id IS NOT NULL/u);
    }
    assert.match(
      page.sql,
      /ORDER BY COALESCE\([\s\S]*ASC, conversation\.id ASC\s+LIMIT \$4/u,
    );
    assert.match(page.sql, /handoff\.status='accepted'/u);
    assert.doesNotMatch(count.sql, /\(.*conversation\.id\) >/u);
  }
});

test('PCX-17: urgency uses rank/position/id before limit, with no implicit actor or active-state filter in page/count', async () => {
  const { repository, calls } = harness([
    syntheticRow({
      urgency_rank: 2,
      urgency_position: '2026-11-02T09:00:00.000Z',
    }),
  ]);
  const result = await repository.list({
    sort: 'urgency',
    actorId: 'reader',
    limit: 1,
    after: { rank: 1, id: 'previous', updatedAt: '2026-11-02T09:00:00.000Z' },
  });
  const [page, count] = calls;
  assert.deepEqual(page.values, [1, '2026-11-02T09:00:00.000Z', 'previous', 2]);
  assert.deepEqual(count.values, []);
  assert.match(
    page.sql,
    /ORDER BY urgency\.rank ASC, urgency\.position ASC, conversation\.id ASC\s+LIMIT \$4/u,
  );
  assert.match(
    page.sql,
    /\(urgency\.rank, urgency\.position, conversation\.id\) > \(\$1::integer, \$2::timestamptz, \$3\)/u,
  );
  assert.equal(
    page.sql.indexOf('conversation.terminal_at IS NOT NULL') <
      page.sql.indexOf('THEN 0'),
    true,
    'terminal/archive guard precedes effective failure',
  );
  assert.match(page.sql, /handoff\.reason_code='urgency'/u);
  assert.match(page.sql, /date_trunc\('milliseconds', COALESCE/u);
  assert.match(page.sql, /review_order\.id IS NOT NULL THEN 3/u);
  assert.match(page.sql, /conversation\.automation_state='human' THEN 4/u);
  assert.doesNotMatch(
    count.sql,
    /assigned_user_id|automation_state|state NOT IN|crm\.orders|crm\.messages|crm\.handoffs/u,
  );
  assert.doesNotMatch(
    page.sql,
    /assigned_user_id=\$|ficha_envelope|summary_envelope/u,
  );
  assert.deepEqual(result.nextPosition, {
    rank: 2,
    updatedAt: '2026-11-02T09:00:00.000Z',
  });
  assert.equal('urgency_rank' in result.items[0], false);
  assert.equal(result.totalCount, 174);
  const filtered = harness([]);
  await filtered.repository.list({
    sort: 'urgency',
    archived: true,
    assignedUserId: 'explicit-owner',
    limit: 2,
  });
  assert.deepEqual(filtered.calls[1].values, ['explicit-owner']);
  assert.match(filtered.calls[1].sql, /conversation\.archived_at IS NOT NULL/u);
  assert.match(filtered.calls[1].sql, /conversation\.assigned_user_id = \$1/u);
});

const NOW = new Date('2026-11-08T15:00:00.000Z');
const READER = { actorId: 'reader-1', now: NOW, stallMinutes: 5 };
const TURN_JOINS_PATTERN =
  /LEFT JOIN LATERAL \(\s*SELECT m\.id, m\.occurred_at FROM crm\.messages m[\s\S]*?\) turn ON true/u;

/** @param {string} sql */
const squash = (sql) => sql.replace(/\s+/gu, ' ');

test('INBOX-VEZ-01: a tab is worked out once and its page and total share predicates and parameters', async () => {
  const expectedOrder = {
    respond: /ORDER BY base\.sort_position DESC, base\.id DESC\s+LIMIT \$6\)/u,
    awaiting: /ORDER BY base\.sort_position DESC, base\.id DESC\s+LIMIT \$6\)/u,
    silent: /ORDER BY base\.sort_position ASC, base\.id ASC\s+LIMIT \$6\)/u,
    lost: /ORDER BY base\.sort_position DESC, base\.id DESC\s+LIMIT \$6\)/u,
  };
  for (const bucket of /** @type {const} */ ([
    'respond',
    'awaiting',
    'silent',
    'lost',
  ])) {
    const { repository, calls } = harness([
      syntheticRow({
        turn_bucket: bucket,
        turn_rank: bucket === 'respond' ? 1 : 0,
        turn_since: '2026-11-07T10:00:00.123Z',
        sort_position:
          bucket === 'respond'
            ? '2026-11-08T14:00:00.456Z'
            : '2026-11-07T10:00:00.123Z',
        turn_business_minutes: 42,
        turn_stalled: false,
        total_count: 174,
      }),
    ]);
    const result = await repository.list(
      {
        bucket,
        actorId: 'reader-1',
        owner: 'all',
        orderReady: false,
        limit: 1,
      },
      READER,
    );
    const [page] = calls;
    assert.equal(calls.length, 1, 'one statement for the page and the total');
    // Thresholds and the instant are parameters, never now().
    const turnValues = [
      '2026-11-08T15:00:00.000Z',
      '2026-11-08T14:55:00.000Z',
      '2026-11-05T15:00:00.000Z',
      'reader-1',
    ];
    assert.deepEqual(page.values, [...turnValues, bucket, 2]);
    assert.match(page.sql, expectedOrder[bucket]);
    assert.match(page.sql, /turn_state\.bucket = \$5/u);
    // One definition of the tab, evaluated once; the total counts those rows.
    assert.equal(
      page.sql.match(new RegExp(TURN_JOINS_PATTERN, 'gu'))?.length,
      1,
    );
    assert.equal(page.sql.split('base AS MATERIALIZED').length, 2);
    assert.match(
      page.sql,
      /\(SELECT count\(\*\)::integer FROM base\) total_count/u,
    );
    assert.match(page.sql, /WITH reminders AS MATERIALIZED/u);
    const tabSql = page.sql.split('ranked AS')[0];
    assert.doesNotMatch(tabSql, /now\(\)/u);
    // The business-minute function runs for the page rows only.
    assert.match(
      page.sql,
      /crm\.business_minutes_v1\(ranked\.turn_since, \$1::timestamptz\)/u,
    );
    assert.doesNotMatch(tabSql, /business_minutes_v1/u);
    // Active loss reuses the shared definition.
    assert.match(page.sql, /lead_outcome\.outcome = 'lost'/u);
    // Reminder: one CTE, own first; no per-row lookup on the decisions table.
    assert.match(
      page.sql,
      /COALESCE\(decision\.user_id=\$4::text, false\) DESC/u,
    );
    assert.doesNotMatch(page.sql, /LATERAL \([^)]*dashboard_action_decisions/u);
    assert.equal(result.items[0].bucket, bucket);
    assert.equal(result.items[0].turnSince, '2026-11-07T10:00:00.123Z');
    assert.equal(result.items[0].turnBusinessMinutes, 42);
    assert.equal(result.items[0].turnAsOf, '2026-11-08T15:00:00.000Z');
    assert.equal(result.items[0].assistantStalled, false);
    assert.deepEqual(result.nextPosition, {
      rank: bucket === 'respond' ? 1 : 0,
      updatedAt:
        bucket === 'respond'
          ? '2026-11-08T14:00:00.456Z'
          : '2026-11-07T10:00:00.123Z',
    });
    assert.equal(result.totalCount, 174);
  }
  // Past the last page no row carries the total: counted from the same base.
  const empty = harness([]);
  await empty.repository.list(
    { bucket: 'lost', actorId: 'reader-1', limit: 1 },
    READER,
  );
  assert.equal(empty.calls.length, 2);
  assert.match(
    empty.calls[1].sql,
    /base AS MATERIALIZED[\s\S]*SELECT count\(\*\)::integer count FROM base/u,
  );
  assert.deepEqual(empty.calls[1].values, empty.calls[0].values.slice(0, 5));
});

test('INBOX-VEZ-01: each tab has its own cursor comparator and precedence', async () => {
  const after = {
    id: 'previous',
    rank: 1,
    updatedAt: '2026-11-07T10:00:00.123Z',
  };
  /** @type {Array<[string, RegExp, unknown[]]>} */
  const cases = [
    [
      'respond',
      /\(base\.sort_position, base\.id\) < \(\$6::timestamptz, \$7\)/u,
      [after.updatedAt, 'previous', 2],
    ],
    [
      'awaiting',
      /\(base\.sort_position, base\.id\) < \(\$6::timestamptz, \$7\)/u,
      [after.updatedAt, 'previous', 2],
    ],
    [
      'silent',
      /\(base\.sort_position, base\.id\) > \(\$6::timestamptz, \$7\)/u,
      [after.updatedAt, 'previous', 2],
    ],
    [
      'lost',
      /\(base\.sort_position, base\.id\) < \(\$6::timestamptz, \$7\)/u,
      [after.updatedAt, 'previous', 2],
    ],
  ];
  for (const [bucket, comparator, tail] of cases) {
    const { repository, calls } = harness([]);
    await repository.list(
      { bucket, actorId: 'reader-1', owner: 'all', limit: 1, after },
      READER,
    );
    assert.match(calls[0].sql, comparator, bucket);
    assert.deepEqual(calls[0].values.slice(5), tail, bucket);
    // An empty page counts its base without the cursor.
    assert.equal(calls[1].values.length, 5, 'the total ignores the cursor');
  }
  // Precedence: failure, loss, pending handoff, customer's turn, 72 h.
  const { repository, calls } = harness([]);
  await repository.list({ bucket: 'respond', actorId: 'r', limit: 1 }, READER);
  const sql = squash(calls[0].sql);
  const order = [
    "WHEN f.failed THEN 'respond'",
    "WHEN f.lost_active THEN 'lost'",
    "WHEN f.handoff_pending THEN 'respond'",
    'WHEN f.customer_turn THEN',
    'effective_reply.occurred_at <= $3::timestamptz',
  ].map((fragment) => sql.indexOf(fragment));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
  // Only a human or (in assistant mode) the assistant's own sent reply counts.
  assert.match(
    sql,
    /m\.author_kind='human' OR \(m\.author_kind='assistant' AND conversation\.automation_state='assistant'\)/u,
  );
  assert.match(
    sql,
    /COALESCE\(m\.delivery_status,m\.status\) IN \('sent','delivered','read'\)/u,
  );
  assert.match(sql, /m\.direction='inbound' AND m\.author_kind='contact'/u);
});

test('INBOX-VEZ-01: owner and the order-ready chip join page and total alike', async () => {
  const { repository, calls } = harness([]);
  await repository.list(
    {
      bucket: 'respond',
      actorId: 'reader-1',
      owner: 'mine',
      orderReady: true,
      limit: 1,
    },
    READER,
  );
  for (const { sql, values } of calls) {
    assert.match(sql, /conversation\.assigned_user_id = \$1/u);
    assert.equal(values[0], 'reader-1');
    assert.match(sql, /review_order\.id IS NOT NULL/u);
    assert.match(sql, /\) review_order ON true/u);
  }
  const unassigned = harness([]);
  await unassigned.repository.list(
    { bucket: 'silent', actorId: 'r', owner: 'unassigned', limit: 1 },
    READER,
  );
  for (const { sql, values } of unassigned.calls) {
    assert.match(sql, /conversation\.assigned_user_id IS NULL/u);
    // The chip is not asked for: the tab itself does not join the order.
    assert.doesNotMatch(sql.split('FROM ranked')[0], /review_order ON true/u);
    assert.equal(values[4], 'silent');
  }
  // No bucket: an older list narrowed by owner and the terminal consultation.
  const consult = harness([]);
  await consult.repository.list({
    terminal: true,
    owner: 'mine',
    actorId: 'r',
    limit: 1,
  });
  for (const { sql, values } of consult.calls) {
    assert.match(sql, /conversation\.archived_at IS NULL/u);
    assert.match(
      sql,
      /conversation\.state IN \('convertida_em_lead','sem_lead','encerrada'\)\s+OR conversation\.terminal_at IS NOT NULL/u,
    );
    assert.match(sql, /conversation\.assigned_user_id = \$1/u);
    assert.deepEqual(values.slice(0, 1), ['r']);
  }
});

test('INBOX-VEZ-01: the four counts are one statement and one tab definition', async () => {
  /** @type {{sql: string, values: unknown[]}[]} */
  const calls = [];
  const repository = new PostgresInboxReadRepository({
    contactEnvelopeKey: KEY,
    messageEnvelopeKey: KEY,
    database: {
      async query(/** @type {string} */ sql, /** @type {unknown[]} */ values) {
        calls.push({ sql, values });
        return { rows: [{ respond: 3, awaiting: 4, silent: 1, lost: 2 }] };
      },
    },
  });
  const counts = await repository.bucketCounts(
    { actorId: 'reader-1', owner: 'mine', orderReady: true },
    READER,
  );
  assert.deepEqual(counts, { respond: 3, awaiting: 4, silent: 1, lost: 2 });
  assert.equal(calls.length, 1, 'one statement, one snapshot');
  const { sql, values } = calls[0];
  for (const bucket of ['respond', 'awaiting', 'silent', 'lost']) {
    assert.match(
      sql,
      new RegExp(
        `count\\(\\*\\) FILTER \\(WHERE turn_state\\.bucket='${bucket}'\\)::integer ${bucket}`,
        'u',
      ),
    );
  }
  assert.ok(TURN_JOINS_PATTERN.test(sql));
  assert.deepEqual(values.slice(0, 1), ['reader-1']);
  assert.equal(values.length, 5);
  assert.match(sql, /review_order\.id IS NOT NULL/u);
  assert.doesNotMatch(sql, /ORDER BY turn|business_minutes_v1|now\(\)/u);
  const seller = await repository.bucketCounts(
    {
      actorId: 'reader-1',
      owner: 'all',
      orderReady: false,
      assignedUserId: 'seller-9',
    },
    READER,
  );
  assert.equal(seller.respond, 3);
  assert.deepEqual(calls[1].values.slice(0, 1), ['seller-9']);
  await assert.rejects(
    repository.bucketCounts({ actorId: 'reader-1' }, {}),
    TypeError,
  );
});

test('INBOX-VEZ-01: older lists keep their query and read the turn for the page rows only', async () => {
  const plain = harness([syntheticRow()]);
  const without = await plain.repository.list({ limit: 1 });
  assert.equal(plain.calls.length, 2, 'no reader, no extra statement');
  assert.equal(without.items[0].bucket, null);
  assert.equal(without.items[0].turnAsOf, null);
  assert.equal(without.items[0].assistantStalled, false);
  assert.equal(without.items[0].lostOutcome, null);
  assert.equal(without.items[0].reminder, null);

  const queued = harness([syntheticRow()]);
  const withReader = await queued.repository.list(
    { workQueue: 'attention', actorId: 'reader-1', limit: 1 },
    READER,
  );
  const [page, count, turn] = queued.calls;
  assert.deepEqual(page.values, ['reader-1', 2], 'the page query is the same');
  assert.deepEqual(count.values, ['reader-1']);
  assert.deepEqual(turn.values.slice(0, 4), [
    '2026-11-08T15:00:00.000Z',
    '2026-11-08T14:55:00.000Z',
    '2026-11-05T15:00:00.000Z',
    'reader-1',
  ]);
  assert.deepEqual(turn.values[4], ['conversation-synthetic']);
  assert.match(turn.sql, /conversation\.id = ANY\(\$5::text\[\]\)/u);
  assert.match(turn.sql, /decision\.target_id = ANY\(\$5::text\[\]\)/u);
  assert.equal(withReader.items.length, 1);

  // The turn fields map without the loss note or any envelope.
  const mapped = harness([
    syntheticRow({
      turn_bucket: 'lost',
      turn_since: '2026-11-07T10:00:00.000Z',
      turn_business_minutes: 0,
      turn_stalled: true,
      lost_reason_code: 'outro',
      lost_occurred_at: '2026-11-07T10:00:00.000Z',
      lost_version: '3',
      reminder_remind_at: '2026-11-09T10:00:00.000Z',
      reminder_mine: false,
    }),
  ]);
  const detail = await mapped.repository.get('conversation-synthetic', READER);
  assert.deepEqual(detail.conversation.lostOutcome, {
    occurredAt: '2026-11-07T10:00:00.000Z',
    reasonCode: 'outro',
    version: 3,
  });
  assert.deepEqual(detail.conversation.reminder, {
    mine: false,
    remindAt: '2026-11-09T10:00:00.000Z',
  });
  assert.equal(detail.conversation.assistantStalled, true);
  assert.equal(detail.conversation.turnBusinessMinutes, 0);
  assert.doesNotMatch(JSON.stringify(detail), /note|envelope|ciphertext/u);
  const bare = harness([syntheticRow()]);
  await bare.repository.get('conversation-synthetic');
  assert.equal(
    bare.calls.some(({ sql }) => sql.includes('reminders AS MATERIALIZED')),
    false,
    'the detail without a reader does not read the turn',
  );
});
