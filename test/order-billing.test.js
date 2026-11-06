import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  billingPercent,
  billingSplit,
  billingUrl,
} from '../modules/orders/src/domain/billing.js';

test('COB-02: exact cent split for 0, X and 100 percent', () => {
  assert.deepEqual(billingSplit(10001, 30), {
    signalAmountCents: 3000,
    balanceAmountCents: 7001,
  });
  assert.deepEqual(billingSplit(10001, 0), {
    signalAmountCents: 0,
    balanceAmountCents: 10001,
  });
  assert.deepEqual(billingSplit(10001, 100), {
    signalAmountCents: 10001,
    balanceAmountCents: 0,
  });
  assert.deepEqual(billingSplit(Number.MAX_SAFE_INTEGER, 99), {
    signalAmountCents: 8917127262193581,
    balanceAmountCents: 90071992547410,
  });
  for (const value of [-1, 101, 10.5, '30', null])
    assert.throws(() => billingPercent(value), {
      code: 'BILLING_INVALID_PERCENT',
    });
  assert.throws(() => billingSplit(100, 50), {
    code: 'BILLING_MINIMUM_AMOUNT',
  });
  assert.throws(() => billingSplit(99, 100), {
    code: 'BILLING_INVALID_AMOUNT',
  });
});
test('COB-13: private gateway URLs have a closed HTTPS host allowlist', () => {
  assert.equal(
    billingUrl('https://checkout.infinitepay.io/fake'),
    'https://checkout.infinitepay.io/fake',
  );
  assert.equal(billingUrl(null, true), null);
  for (const url of [
    'http://checkout.infinitepay.io/a',
    'https://infinitepay.io.evil.test/a',
    'https://infinitepay.io@evil.test/a',
    'https://u:p@infinitepay.io/a',
    'https://infinitepay.io:8443/a',
    'javascript:alert(1)',
  ])
    assert.throws(() => billingUrl(url), { code: 'BILLING_INVALID_URL' });
});
