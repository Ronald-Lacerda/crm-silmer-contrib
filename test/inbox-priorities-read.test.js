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
