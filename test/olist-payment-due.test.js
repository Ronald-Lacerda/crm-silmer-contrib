import assert from 'node:assert/strict';
import test from 'node:test';
import {
  olistSettings,
  EMPTY_OLIST_SETTINGS,
} from '../modules/olist/src/configuration.js';

test('T17 per-order due policy is explicit, rejects ambiguity and preserves fixed legacy settings', () => {
  const fixed = { ...EMPTY_OLIST_SETTINGS, paymentDueOn: '2028-02-29' };
  assert.deepEqual(olistSettings(fixed), fixed);
  assert.deepEqual(
    olistSettings({ ...fixed, paymentDuePolicy: 'fixed_date' }),
    {
      ...fixed,
      paymentDuePolicy: 'fixed_date',
    },
  );
  const perOrder = {
    ...EMPTY_OLIST_SETTINGS,
    paymentDuePolicy: 'per_order',
    paymentDueOn: null,
  };
  assert.deepEqual(olistSettings(perOrder), perOrder);
  const erp = {
    ...EMPTY_OLIST_SETTINGS,
    paymentDuePolicy: 'erp',
    paymentDueOn: null,
  };
  assert.deepEqual(olistSettings(erp), erp);
  assert.throws(() => olistSettings({ ...fixed, paymentDuePolicy: 'erp' }), {
    code: 'INVALID_REQUEST',
  });
  for (const paymentDuePolicy of [
    null,
    '',
    '30 dias',
    'fixed',
    'unknown',
    true,
  ])
    assert.throws(
      () => olistSettings({ ...EMPTY_OLIST_SETTINGS, paymentDuePolicy }),
      { code: 'INVALID_REQUEST' },
    );
  assert.throws(
    () => olistSettings({ ...fixed, paymentDuePolicy: 'per_order' }),
    { code: 'INVALID_REQUEST' },
  );
  for (const paymentDueOn of [
    '2027-02-29',
    '2026-11-31',
    '2026-11-30T00:00:00Z',
    'amanhã',
  ])
    assert.throws(() => olistSettings({ ...fixed, paymentDueOn }), {
      code: 'INVALID_REQUEST',
    });
});
