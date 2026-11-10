/* global Response */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getOrderPdf } from '../apps/edge-web/src/lib/order-pdf.js';

/** @param {() => Response} respond @param {() => Promise<void>} run */
async function withFetch(respond, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => respond();
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('FPI-10: the PDF client exposes the API error code to the screen', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          error: { code: 'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED' },
        }),
        { headers: { 'content-type': 'application/json' }, status: 422 },
      ),
    async () => {
      await assert.rejects(getOrderPdf('order-1'), {
        code: 'PRINT_FINANCIAL_TEXT_REVIEW_REQUIRED',
        status: 422,
      });
    },
  );
});

test('FPI-10: a failure without a JSON body still reports its status', async () => {
  await withFetch(
    () => new Response('<html>gateway</html>', { status: 502 }),
    async () => {
      await assert.rejects(getOrderPdf('order-1'), (error) => {
        const failure = /** @type {any} */ (error);
        assert.equal(failure.status, 502);
        assert.equal(failure.code, undefined);
        return true;
      });
    },
  );
});
