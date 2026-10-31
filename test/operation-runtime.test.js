import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_STALL_MINUTES,
  createOperationReadService,
} from '../apps/api/src/operation-runtime.js';
import { PostgresInboxReadRepository } from '../modules/inbox-channels/src/index.js';

/** @param {Array<Record<string, unknown>>} rows */
function liveService(rows) {
  /** @type {Array<{sql: string, values: unknown[]}>} */
  const queries = [];
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    database: {
      query: async (
        /** @type {string} */ sql,
        /** @type {unknown[]} */ values,
      ) => {
        queries.push({ sql, values });
        return { rows };
      },
    },
    handoffRepository: {},
    inboxRepository: {},
  });
  return { queries, service };
}

/** @param {Array<Record<string, any>>} items */
function inboxService(items) {
  /** @type {any[]} */
  const lists = [];
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    handoffRepository: {},
    inboxRepository: {
      list: async (/** @type {any} */ input) => {
        lists.push(input);
        return { hasMore: true, items, totalCount: items.length + 1 };
      },
    },
  });
  return { lists, service };
}

test('listInbox passes pendingHandoff and pages it by the waiting time', async () => {
  const waiting = {
    handoff: { createdAt: '2026-09-08T09:00:00.000Z' },
    id: 'conversation-old',
    updatedAt: '2026-09-08T12:00:00.000Z',
  };
  const { lists, service } = inboxService([waiting]);
  const first = await service.listInbox({ limit: 1, pendingHandoff: 'true' });
  assert.equal(lists[0].pendingHandoff, true);
  assert.ok(first.nextCursor);
  const cursorPayload = JSON.parse(
    Buffer.from(first.nextCursor.split('.')[0], 'base64url').toString('utf8'),
  );
  assert.equal(cursorPayload.updatedAt, waiting.handoff.createdAt);

  await service.listInbox({
    cursor: first.nextCursor,
    limit: 1,
    pendingHandoff: true,
  });
  assert.deepEqual(lists[1].after, {
    id: 'conversation-old',
    updatedAt: waiting.handoff.createdAt,
  });
  // A cursor from the waiting list is not valid for the default order.
  await assert.rejects(service.listInbox({ cursor: first.nextCursor }), {
    code: 'INVALID_CURSOR',
  });
  await assert.rejects(service.listInbox({ pendingHandoff: 'sim' }), {
    code: 'INVALID_FILTER',
  });
});

test('listInbox keeps its existing filters and last-message cursor', async () => {
  const { lists, service } = inboxService([
    {
      handoff: null,
      id: 'conversation-1',
      updatedAt: '2026-09-08T12:00:00.000Z',
    },
  ]);
  const page = await service.listInbox({
    archived: 'false',
    assignedUserId: 'seller-1',
    automationState: 'assistant',
    limit: 1,
    unassignedHumanHandoff: 'true',
  });
  assert.deepEqual(
    { ...lists[0], after: undefined },
    {
      after: undefined,
      archived: false,
      assignedUserId: 'seller-1',
      automationState: 'assistant',
      limit: 1,
      unassignedHumanHandoff: true,
    },
  );
  assert.ok(page.nextCursor);
  const cursorPayload = JSON.parse(
    Buffer.from(page.nextCursor.split('.')[0], 'base64url').toString('utf8'),
  );
  assert.equal(cursorPayload.updatedAt, '2026-09-08T12:00:00.000Z');
});

test('live events keep contact and conversation changes as they were', async () => {
  const { queries, service } = liveService([
    {
      aggregate_id: 'contact-1',
      aggregate_type: 'contact',
      payload: { contactId: 'contact-1' },
      stream_cursor: '7',
    },
    {
      aggregate_id: 'conversation-1',
      aggregate_type: 'conversation',
      payload: { anything: 'ignored' },
      stream_cursor: '8',
    },
  ]);
  const batch = await service.readLiveEvents({ after: '6' });
  assert.deepEqual(batch, {
    cursor: 8,
    events: [
      {
        cursor: 7,
        payload: { contactId: 'contact-1' },
        type: 'inbox.contact.changed',
      },
      {
        cursor: 8,
        payload: { conversationId: 'conversation-1' },
        type: 'inbox.conversation.changed',
      },
    ],
    reset: false,
  });
  assert.deepEqual(queries[0].values, [6]);
});

test('an order change streams as inbox.order.changed with its conversation', async () => {
  const { queries, service } = liveService([
    {
      aggregate_id: 'order-1',
      aggregate_type: 'order',
      payload: { conversationId: 'conversation-9', orderId: 'order-1' },
      stream_cursor: '12',
    },
  ]);
  const batch = await service.readLiveEvents({ after: '11' });
  assert.deepEqual(batch.events, [
    {
      cursor: 12,
      payload: { conversationId: 'conversation-9', orderId: 'order-1' },
      type: 'inbox.order.changed',
    },
  ]);
  assert.match(queries[0].sql, /aggregate_type IN \([^)]*'order'[^)]*\)/u);
  assert.match(queries[0].sql, /\bpayload\b/u);
});

test('an order event never forwards more than its identifiers', async () => {
  const { service } = liveService([
    {
      aggregate_id: 'order-2',
      aggregate_type: 'order',
      payload: {
        conversationId: 'conversation-2',
        customer: 'PII-canary',
        orderId: 'order-2',
      },
      stream_cursor: '3',
    },
  ]);
  const batch = await service.readLiveEvents({ after: '2' });
  assert.deepEqual(batch.events[0].payload, {
    conversationId: 'conversation-2',
    orderId: 'order-2',
  });
});

test('a user change streams only its internal identifier', async () => {
  const { queries, service } = liveService([
    {
      aggregate_id: 'user-1',
      aggregate_type: 'user',
      payload: { email: 'PII-canary@example.test' },
      stream_cursor: '13',
    },
  ]);
  const batch = await service.readLiveEvents({ after: '12' });
  assert.deepEqual(batch.events, [
    {
      cursor: 13,
      payload: { userId: 'user-1' },
      type: 'identity.user.changed',
    },
  ]);
  assert.match(queries[0].sql, /aggregate_type IN \([^)]*'user'[^)]*\)/u);
});

test('an event backlog over 100 advances the reset cursor and then resumes', async () => {
  /** @type {Array<{sql:string,values:any[]}>} */
  const queries = [];
  let nextEvent = 1;
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    database: {
      /** @param {string} sql @param {any[]} values */
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.includes('max(stream_cursor)')) {
          return { rows: [{ cursor: '120' }] };
        }
        if (values[0] === 0) {
          return {
            rows: Array.from({ length: 101 }, (_, index) => ({
              aggregate_id: `conversation-${index}`,
              aggregate_type: 'conversation',
              payload: {},
              stream_cursor: String(index + 1),
            })),
          };
        }
        return {
          rows: [
            {
              aggregate_id: `conversation-next-${nextEvent++}`,
              aggregate_type: 'conversation',
              payload: {},
              stream_cursor: '121',
            },
          ],
        };
      },
    },
    handoffRepository: {},
    inboxRepository: {},
  });

  const reset = await service.readLiveEvents({ after: 0 });
  assert.deepEqual(reset, { cursor: 120, events: [], reset: true });
  assert.match(queries[1].sql, /max\(stream_cursor\)/u);
  assert.deepEqual(queries[1].values, [0]);

  const resumed = await service.readLiveEvents({ after: reset.cursor });
  assert.equal(resumed.reset, false);
  assert.equal(resumed.cursor, 121);
  assert.deepEqual(resumed.events[0], {
    cursor: 121,
    payload: { conversationId: 'conversation-next-1' },
    type: 'inbox.conversation.changed',
  });
});

test('a cursor ahead of a restored database resets to its head and resumes', async () => {
  let head = 100;
  /** @type {Array<{sql:string,values:any[]|undefined}>} */
  const queries = [];
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    database: {
      /** @param {string} sql @param {any[]|undefined} values */
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.includes('max(stream_cursor)')) {
          return { rows: [{ cursor: String(head) }] };
        }
        return {
          rows:
            head > (values?.[0] ?? 0)
              ? [
                  {
                    aggregate_id: 'order-1',
                    aggregate_type: 'order',
                    payload: { orderId: 'order-1' },
                    stream_cursor: String(head),
                  },
                ]
              : [],
        };
      },
    },
    handoffRepository: {},
    inboxRepository: {},
  });

  assert.deepEqual(await service.readLiveEvents({ after: 500 }), {
    cursor: 100,
    events: [],
    reset: true,
  });
  assert.match(queries[1].sql, /COALESCE\(max\(stream_cursor\), 0\)/u);
  head = 101;
  assert.deepEqual(await service.readLiveEvents({ after: 100 }), {
    cursor: 101,
    events: [
      {
        cursor: 101,
        payload: { conversationId: '', orderId: 'order-1' },
        type: 'inbox.order.changed',
      },
    ],
    reset: false,
  });
  assert.equal(queries.length, 3);
});

test('an empty restored event stream resets to zero, while a current cursor does not', async () => {
  let head = 0;
  const service = createOperationReadService({
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    database: {
      /** @param {string} sql */
      async query(sql) {
        return {
          rows: sql.includes('max(stream_cursor)')
            ? [{ cursor: String(head) }]
            : [],
        };
      },
    },
    handoffRepository: {},
    inboxRepository: {},
  });
  assert.deepEqual(await service.readLiveEvents({ after: 500 }), {
    cursor: 0,
    events: [],
    reset: true,
  });
  // An unrelated aggregate may be newer than the Inbox projection. That
  // still means this browser cursor belongs to the current database.
  head = 501;
  assert.deepEqual(await service.readLiveEvents({ after: 500 }), {
    cursor: 500,
    events: [],
    reset: false,
  });
});

test('Painel: the Inbox summary reads the server clock and maps counts without envelopes', async () => {
  /** @type {Array<{sql: string, values: unknown[]}>} */
  const queries = [];
  const now = new Date('2026-10-15T15:00:00.000Z');
  const repository = new PostgresInboxReadRepository({
    contactEnvelopeKey: Buffer.alloc(32, 2),
    database: {
      query: async (
        /** @type {string} */ sql,
        /** @type {unknown[]} */ values,
      ) => {
        queries.push({ sql, values });
        if (/pending_count/u.test(sql)) return { rows: [{ pending_count: 2 }] };
        return /failed_conversation_count/u.test(sql)
          ? {
              rows: [
                {
                  failed_conversation_count: 1,
                  last_assistant_reply_at: new Date('2026-10-15T14:58:00Z'),
                },
              ],
            }
          : {
              rows: [
                {
                  assistant_active_count: 7,
                  assistant_stalled_count: 2,
                  mine_awaiting_count: 1,
                  mine_count: 3,
                  mine_oldest_awaiting_since: '2026-10-15T14:20:00.000Z',
                  waiting_count: 4,
                  waiting_oldest_since: new Date('2026-10-15T09:00:00Z'),
                  waiting_overdue_count: 1,
                },
              ],
            };
      },
    },
    messageEnvelopeKey: Buffer.alloc(32, 3),
  });
  const service = createOperationReadService({
    clock: () => now,
    contactRepository: {},
    cursorKey: Buffer.alloc(32, 1),
    handoffRepository: {},
    inboxRepository: repository,
  });
  assert.deepEqual(await service.summarizeInbox({ actorId: 'seller-1' }), {
    assistant: {
      activeCount: 7,
      failedDeliveryCount: 1,
      lastReplyAt: '2026-10-15T14:58:00.000Z',
      stalledCount: 2,
      stallMinutes: ASSISTANT_STALL_MINUTES,
    },
    generatedAt: '2026-10-15T15:00:00.000Z',
    mine: {
      awaitingReplyCount: 1,
      count: 3,
      oldestAwaitingSince: '2026-10-15T14:20:00.000Z',
      pendingOrderCount: 2,
    },
    waitingHandoff: {
      count: 4,
      oldestSince: '2026-10-15T09:00:00.000Z',
      overdueCount: 1,
    },
  });
  const [queue, myOrders, sends] = queries;
  // The seller's orders follow the rule that names the seller.
  assert.deepEqual(myOrders.values, ['seller-1']);
  assert.match(myOrders.sql, /manual_owner_id = \$1/u);
  assert.match(myOrders.sql, /conversation\.assigned_user_id = \$1/u);
  // The reader, "now" and the stall threshold are bound, never inlined.
  // AGENTE-FAIL-01: the default threshold is the sweep's, 5 minutes.
  assert.deepEqual(queue.values, [
    'seller-1',
    '2026-10-15T15:00:00.000Z',
    '2026-10-15T14:55:00.000Z',
  ]);
  assert.match(queue.sql, /handoff\.due_at <= \$2::timestamptz/u);
  assert.match(queue.sql, /conversation\.archived_at IS NULL/u);
  assert.deepEqual(sends.values, [
    '2026-10-14T15:00:00.000Z',
    '2026-10-15T15:00:00.000Z',
  ]);
  // Counts only: no message or contact envelope is selected.
  for (const { sql } of queries) assert.doesNotMatch(sql, /envelope/u);
  await assert.rejects(service.summarizeInbox({ actorId: '' }), {
    statusCode: 400,
  });
});
