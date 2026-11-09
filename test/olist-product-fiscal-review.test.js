import assert from 'node:assert/strict';
import test from 'node:test';
import { olistProductFiscal } from '../modules/olist/src/configuration.js';
import { createOlistExportCommand } from '../apps/api/src/olist-export-command.js';

test('T17 fiscal review requires all explicit canonical fields and never infers an origin or unit', () => {
  const chosen = { ncm: '61091000', origin: 0, unit: 'UN' };
  assert.deepEqual(olistProductFiscal(chosen), chosen);
  assert.notEqual(olistProductFiscal(chosen), chosen);
  for (const value of [
    undefined,
    null,
    {},
    { ncm: '61091000', unit: 'UN' },
    { ...chosen, origin: '' },
    { ...chosen, origin: '0' },
    { ...chosen, origin: 9 },
    { ...chosen, ncm: '6109.10.00' },
    { ...chosen, unit: '' },
    { ...chosen, unit: 'un' },
    { ...chosen, draft: true },
  ])
    assert.throws(
      () => olistProductFiscal(value),
      (/** @type {any} */ error) =>
        error.statusCode === 400 &&
        ['INVALID_REQUEST', 'OLIST_PRODUCT_FISCAL_REQUIRED'].includes(
          error.code,
        ),
    );
});

test('T17 export rejects supplied fiscal overrides before SQL or idempotency replay', async () => {
  const command = createOlistExportCommand(
    {},
    {
      config: {},
      preview: {},
      environment: {},
      clock: () => new Date('2026-11-09T12:00:00Z'),
    },
  );
  for (const productFiscal of [
    undefined,
    null,
    { ncm: '61091000', origin: 0, unit: 'UN' },
  ])
    await assert.rejects(
      command.exportOrder({
        productFiscal,
        idempotencyKey: 'already-completed',
      }),
      { code: 'INVALID_REQUEST', statusCode: 400 },
    );
});
