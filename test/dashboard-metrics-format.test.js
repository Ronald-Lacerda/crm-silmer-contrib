import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessHoursLabel,
  joinPeople,
  minutesLabel,
  peopleBreakdown,
  reasonBreakdown,
  salesReconciliation,
  unansweredNow,
} from '../apps/edge-web/src/lib/dashboard-metrics.js';
import {
  lossTable,
  salesTable,
  serviceTable,
} from '../apps/edge-web/src/lib/team-performance.js';

test('MET-04: business minutes read as text and null stays a dash', () => {
  assert.equal(minutesLabel(null), '—');
  assert.equal(minutesLabel(undefined), '—');
  assert.equal(minutesLabel(0.4), 'menos de 1 min');
  assert.equal(minutesLabel(3.5), '4 min');
  assert.equal(minutesLabel(60), '1 h');
  assert.equal(minutesLabel(135.2), '2 h 15 min');
});

test('MET-01: the schedule is told from the policy the API returns', () => {
  assert.equal(
    businessHoursLabel({
      weekdays: [1, 2, 3, 4, 5],
      blocks: [
        ['09:00', '12:00'],
        ['13:00', '18:00'],
      ],
    }),
    'de segunda a sexta, 9h–12h e 13h–18h, horário de São Paulo',
  );
  assert.equal(businessHoursLabel(null), 'no horário de expediente da empresa');
});

test('MET-05: "sem resposta agora" sums people and never invents zero', () => {
  assert.equal(unansweredNow(null), null);
  const now = unansweredNow({
    rows: [
      { userId: 'a', name: 'Pedro M.', unansweredNow: { count: 1 } },
      { userId: 'b', name: 'Bruno T.', unansweredNow: { count: 3 } },
      { userId: 'c', name: 'Júlia S.', unansweredNow: { count: 0 } },
    ],
  });
  assert.equal(now?.count, 4);
  assert.equal(
    peopleBreakdown(now?.people ?? []),
    '3 de Bruno T. · 1 de Pedro M.',
  );
  assert.equal(
    peopleBreakdown(
      [
        { name: 'A', count: 3 },
        { name: 'B', count: 2 },
        { name: 'C', count: 1 },
      ],
      2,
    ),
    '3 de A · 2 de B · mais 1 pessoa',
  );
});

test('PERF-05: people, store and unattributed reconcile with the total', () => {
  const performance = {
    rows: [
      { userId: 'a', name: 'A', soldAmountCents: 1000, confirmedCount: 1 },
      { userId: 'b', name: 'B', soldAmountCents: 500, confirmedCount: 2 },
    ],
    store: { soldAmountCents: 200, confirmedCount: 1 },
    unattributed: { soldAmountCents: 0, confirmedCount: 0 },
    totals: { soldAmountCents: 1700, confirmedCount: 4 },
  };
  assert.deepEqual(salesReconciliation(performance), {
    difference: 0,
    orderDifference: 0,
  });
  const table = salesTable(performance);
  assert.deepEqual(
    table.extraRows.map((row) => row.name),
    ['Loja do site', 'Sem atribuição'],
  );
  assert.equal(table.totalRow?.cells.sold.value, 1700);
  assert.equal(table.extraRows[1].cells.ticket.text, '—');
  assert.equal(table.rows[1].cells.ticket.value, 250);
  assert.deepEqual(
    salesReconciliation({ ...performance, totals: { soldAmountCents: 1800 } })
      .difference,
    100,
  );
});

test('PERF-04/MET-03: service joins people by id and a failed read is a dash', () => {
  const performance = {
    rows: [{ userId: 'a', name: 'A', active: true, attendedCount: 4 }],
  };
  const service = {
    rows: [
      {
        userId: 'a',
        name: 'A',
        active: true,
        firstResponse: {
          samples: 6,
          medianMinutes: 3,
          p90Minutes: 9,
          openCount: 1,
        },
        claim: { samples: 0, medianMinutes: null, p90Minutes: null },
        unansweredEpisodes: { count: 2 },
      },
      {
        userId: 'b',
        name: null,
        active: false,
        firstResponse: { samples: 0, medianMinutes: null, p90Minutes: null },
        claim: { samples: 0, medianMinutes: null, p90Minutes: null },
        unansweredEpisodes: { count: 0 },
      },
    ],
  };
  const table = serviceTable(performance, service);
  assert.equal(table.episodes, 2);
  assert.deepEqual(
    table.rows.map((row) => [row.name, row.note]),
    [
      ['A', ''],
      ['Pessoa sem nome', 'Inativo'],
    ],
  );
  assert.equal(table.rows[0].cells.firstResponse.text, '3 min');
  assert.equal(
    table.rows[0].cells.firstResponse.note,
    '6 amostras · p90 9 min · 1 em aberto',
  );
  assert.equal(table.rows[0].cells.claim.text, '—');
  const failed = serviceTable(performance, null);
  assert.equal(failed.episodes, null);
  assert.equal(failed.rows[0].cells.unanswered.text, '—');
  assert.equal(failed.rows[0].cells.attended.text, '4');
  assert.equal(joinPeople(null, undefined).length, 0);
});

test('MET-08: losses group by reason without free text', () => {
  const byReason = {
    preco: 5,
    prazo: 3,
    concorrente: 0,
    silencio: 2,
    indisponivel: 0,
    outro: 1,
  };
  assert.deepEqual(
    reasonBreakdown(byReason).map((reason) => [reason.code, reason.share]),
    [
      ['preco', 100],
      ['prazo', 60],
      ['silencio', 40],
      ['outro', 20],
    ],
  );
  const table = lossTable({
    rows: [
      {
        userId: 'a',
        name: 'A',
        active: true,
        lostCount: 11,
        reopenedByCustomerCount: 1,
        byReason,
      },
    ],
    totals: { lostCount: 11, reopenedByCustomerCount: 1, byReason },
  });
  assert.equal(table.rows[0].cells.reason.text, 'Preço (5)');
  assert.equal(table.totalRow?.cells.lost.text, '11');
  assert.deepEqual(lossTable(null).rows, []);
});
