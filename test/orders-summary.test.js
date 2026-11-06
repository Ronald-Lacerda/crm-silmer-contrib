import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryOrderRepository } from '../modules/orders/src/adapters/in-memory-order-repository.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';

test('Postgres sales summary aggregates all orders before any list pagination', async () => {
  /** @type {string[]} */
  const queries = [];
  /** @type {unknown[]} */
  const values = [];
  const repository = new PostgresOrderRepository({
    envelopeKey: Buffer.alloc(32, 1),
    database: {
      query: async (
        /** @type {string} */ sql,
        /** @type {unknown} */ parameters,
      ) => {
        queries.push(sql);
        values.push(parameters);
        return {
          rows: [
            {
              period_confirmed_count: '1',
              period_sold_amount_cents: '60000',
              confirmed_count: '3',
              sold_amount_cents: '150000',
              pending_count: '4',
              total_pieces_sold: '27',
              store_new_count: '2',
              store_new_oldest_paid_at: new Date('2026-10-08T02:15:55.000Z'),
              daily: [
                {
                  confirmedCount: 1,
                  day: '2026-10-11',
                  soldAmountCents: 20000,
                },
                {
                  confirmedCount: 2,
                  day: '2026-10-15',
                  soldAmountCents: 60000,
                },
              ],
            },
          ],
        };
      },
      transaction: async () => {
        throw new Error('not used');
      },
    },
  });
  assert.deepEqual(
    await repository.summary({
      dailyFrom: '2026-10-09',
      dailyTo: '2026-10-15',
      from: '2026-10-01',
      to: '2026-10-15',
    }),
    {
      confirmedCount: 3,
      soldAmountCents: 150000,
      averageTicketCents: 50000,
      pendingCount: 4,
      totalPiecesSold: 27,
      storeNewCount: 2,
      storeNewOldestPaidAt: '2026-10-08T02:15:55.000Z',
      period: { confirmedCount: 1, soldAmountCents: 60000 },
      daily: [
        { confirmedCount: 1, day: '2026-10-11', soldAmountCents: 20000 },
        { confirmedCount: 2, day: '2026-10-15', soldAmountCents: 60000 },
      ],
    },
  );
  // PNL-05: the days are grouped in the same statement, not one per day.
  assert.equal(queries.length, 1);
  // Painel: the period is a pair of São Paulo days bound as parameters.
  assert.deepEqual(values[0], [
    '2026-10-01',
    '2026-10-15',
    '2026-10-09',
    '2026-10-15',
  ]);
  assert.match(queries[0], /order_date BETWEEN \$1::date AND \$2::date/u);
  assert.match(queries[0], /order_date BETWEEN \$3::date AND \$4::date/u);
  assert.match(queries[0], /GROUP BY order_date/u);
  assert.match(queries[0], /NOT is_test AND status = 'confirmado'/u);
  assert.match(queries[0], /FROM crm\.orders/u);
  assert.doesNotMatch(queries[0], /LIMIT|OFFSET/u);
  // ADR 031: the notice counts unprinted store orders, never a test order.
  assert.match(queries[0], /WHERE NOT is_test/u);
  assert.match(
    queries[0],
    /origin = 'loja' AND ficha_first_printed_at IS NULL/u,
  );
});

test('PNL-05: "Vendido por dia" is the last seven São Paulo days, today last, whatever the period', async () => {
  /** @type {any[]} */
  const queries = [];
  const repository = new InMemoryOrderRepository();
  // Only the days that sold come back; the service fills the others.
  repository.summary = async (query) => {
    queries.push(query);
    return {
      averageTicketCents: 0,
      confirmedCount: 3,
      daily: [
        { confirmedCount: 1, day: '2026-10-09', soldAmountCents: 20000 },
        { confirmedCount: 2, day: '2026-10-15', soldAmountCents: 60000 },
      ],
      pendingCount: 0,
      period: { confirmedCount: 0, soldAmountCents: 0 },
      soldAmountCents: 80000,
      storeNewCount: 0,
      storeNewOldestPaidAt: null,
      totalPiecesSold: 0,
    };
  };
  const orders = createOrderService({
    authorizeOwnership: async () => undefined,
    // 01:30 UTC on 16/10 is still 15/10 in São Paulo.
    clock: () => new Date('2026-10-16T01:30:00.000Z'),
    conversations: {
      readOrderContexts: async () => new Map(),
      searchConversationIds: async () => [],
    },
    fabCode: '01',
    repository,
  });
  const expected = [
    { confirmedCount: 1, day: '2026-10-09', soldAmountCents: 20000 },
    { confirmedCount: 0, day: '2026-10-10', soldAmountCents: 0 },
    { confirmedCount: 0, day: '2026-10-11', soldAmountCents: 0 },
    { confirmedCount: 0, day: '2026-10-12', soldAmountCents: 0 },
    { confirmedCount: 0, day: '2026-10-13', soldAmountCents: 0 },
    { confirmedCount: 0, day: '2026-10-14', soldAmountCents: 0 },
    { confirmedCount: 2, day: '2026-10-15', soldAmountCents: 60000 },
  ];
  const today = await orders.summary();
  assert.equal(today.today, '2026-10-15');
  assert.deepEqual(today.daily, expected);
  for (const period of ['7dias', 'mes']) {
    const other = await orders.summary({ period });
    assert.deepEqual(other.daily, expected);
  }
  // The period moves only `from`/`to`; the seven days never move.
  assert.deepEqual(
    queries.map((query) => [query.dailyFrom, query.dailyTo]),
    [
      ['2026-10-09', '2026-10-15'],
      ['2026-10-09', '2026-10-15'],
      ['2026-10-09', '2026-10-15'],
    ],
  );
  assert.deepEqual(
    queries.map((query) => query.from),
    ['2026-10-15', '2026-10-09', '2026-10-01'],
  );
  // A repository without days still answers seven empty days.
  repository.summary = async () => ({
    averageTicketCents: 0,
    confirmedCount: 0,
    daily: [],
    pendingCount: 0,
    period: { confirmedCount: 0, soldAmountCents: 0 },
    soldAmountCents: 0,
    storeNewCount: 0,
    storeNewOldestPaidAt: null,
    totalPiecesSold: 0,
  });
  const empty = await orders.summary();
  assert.equal(empty.daily.length, 7);
  assert.ok(
    empty.daily.every(
      (day) => day.confirmedCount === 0 && day.soldAmountCents === 0,
    ),
  );
  assert.equal(empty.daily[6].day, '2026-10-15');
});
