import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createBillingDevelopmentSimulator,
  startBillingDevelopmentService,
} from '../scripts/billing-development-service.mjs';

/** @param {string} id */
const checkout = (id) => ({
  handle: 'synthetic-billing',
  order_nsu: id,
  options: {
    single_payment: true,
    payment_methods_enabled: ['pix', 'credit_card'],
  },
  items: [{ price: 3000, quantity: 1 }],
});

test('synthetic gateway starts unpaid and confirms Pix or card only by explicit test action', () => {
  const gateway = createBillingDevelopmentSimulator();
  const id = randomUUID();
  const link = gateway.create(checkout(id));
  assert.equal(link.url, `https://checkout.infinitepay.io/synthetic-${id}`);
  const query = {
    handle: 'synthetic-billing',
    slug: `synthetic-${id}`,
    order_nsu: id,
    transaction_nsu: `synthetic-transaction-${id}`,
  };
  assert.equal(gateway.check(query).paid, false);
  gateway.confirm(id);
  assert.deepEqual(gateway.check(query), {
    success: true,
    paid: true,
    amount: 3000,
    paid_amount: 3000,
    capture_method: 'pix',
    installments: 1,
  });
  gateway.confirm(id, { method: 'credit_card', installments: 3 });
  assert.equal(gateway.check(query).installments, 3);
  assert.equal(gateway.check(query).capture_method, 'credit_card');
  assert.equal(
    gateway.check({ ...query, order_nsu: randomUUID() }).paid,
    false,
  );
  assert.equal(
    gateway.check({ ...query, transaction_nsu: 'forged' }).paid,
    false,
  );
});

test('duplicate gateway creation fails loudly so reservation regressions are detected', () => {
  const gateway = createBillingDevelopmentSimulator();
  const id = randomUUID();
  gateway.create(checkout(id));
  assert.throws(() => gateway.create(checkout(id)), /second gateway effect/u);
  assert.equal(gateway.counts.links, 1);
  assert.throws(() => gateway.confirm(randomUUID()), /previously created/u);
  assert.equal(
    gateway.check({ handle: 'synthetic-billing', slug: 'unknown' }).paid,
    false,
  );
});

test('synthetic fault controls preserve insufficient amounts and unconfirmed state for adversarial checks', () => {
  const gateway = createBillingDevelopmentSimulator();
  const id = randomUUID();
  gateway.create(checkout(id));
  gateway.confirm(id, { paid: false, amount: 2999 });
  assert.deepEqual(
    gateway.check({
      handle: 'synthetic-billing',
      slug: `synthetic-${id}`,
      order_nsu: id,
      transaction_nsu: `synthetic-transaction-${id}`,
    }),
    {
      success: true,
      paid: false,
      amount: 2999,
      paid_amount: 2999,
      capture_method: 'pix',
      installments: 1,
    },
  );
});

test('development service refuses startup without explicit isolated development opt-in', async () => {
  const before = process.env.RUN_BILLING_LOCAL_SMOKE;
  delete process.env.RUN_BILLING_LOCAL_SMOKE;
  try {
    await assert.rejects(
      startBillingDevelopmentService(),
      /EXPLICIT_SYNTHETIC_DEVELOPMENT_REQUIRED/u,
    );
  } finally {
    if (before === undefined) delete process.env.RUN_BILLING_LOCAL_SMOKE;
    else process.env.RUN_BILLING_LOCAL_SMOKE = before;
  }
});
