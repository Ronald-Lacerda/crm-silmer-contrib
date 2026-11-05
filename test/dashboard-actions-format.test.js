import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionGroup,
  actionInitials,
  defaultReminder,
  filterActions,
  performanceCount,
  performanceMoney,
  reminderInstant,
} from '../apps/edge-web/src/lib/dashboard-actions.js';

test('reminders convert São Paulo wall time independently of the browser timezone', () => {
  assert.equal(reminderInstant('2026-11-05T09:00'), '2026-11-05T12:00:00.000Z');
  assert.equal(reminderInstant('2026-11-05T23:45'), '2026-11-06T02:45:00.000Z');
  for (const invalid of [
    '2026-02-30T09:00',
    '2026-11-05T25:00',
    'not-a-day',
    '',
  ]) {
    assert.equal(reminderInstant(invalid), null);
  }
});

test('reminder defaults never suggest a past 15h or use a phone clock', () => {
  assert.equal(
    defaultReminder('2026-11-05', '2026-11-05T16:00:00Z'),
    '2026-11-05T15:00',
  );
  assert.equal(
    defaultReminder('2026-11-05', '2026-11-05T19:00:00Z'),
    '2026-11-06T09:00',
  );
});

test('the action filters count objects once and keep a deferred obligation separate', () => {
  const rows = [
    {
      id: 'order:1',
      targetType: 'order',
      kind: 'order_followup',
      order: { paidOn: null, deliveredOn: null },
    },
    { id: 'conversation:1', targetType: 'conversation', kind: 'reply' },
    {
      id: 'conversation:2',
      targetType: 'conversation',
      kind: 'followup',
      deferred: true,
    },
  ];
  assert.equal(filterActions(rows, 'all').length, 2);
  assert.equal(filterActions(rows, 'order').length, 1);
  assert.equal(filterActions(rows, 'conversation').length, 1);
  assert.equal(filterActions(rows, 'deferred').length, 1);
  assert.equal(actionGroup(rows[0]), 'orders');
  assert.equal(actionGroup(rows[2]), 'followup');
  assert.equal(actionInitials('Equipe Sintética'), 'ES');
});

test('performance keeps a real zero apart from a missing or invalid value', () => {
  assert.equal(performanceCount(0), '0');
  assert.equal(performanceMoney(0), 'R$\u00a00,00');
  for (const missing of [undefined, null, NaN, '0', -1]) {
    assert.equal(performanceCount(missing), '—');
    assert.equal(performanceMoney(missing), '—');
  }
});
