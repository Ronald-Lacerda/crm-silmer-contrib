import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createOrderBillingRuntime } from '../apps/api/src/order-billing-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';

// OLIST-45/46, ADR 068: a locally cancelled order is terminal. No new
// InfinitePay charge may be issued or reserved for it, but history stays
// readable and a receipt for a charge issued before the cancellation is
// kept as unapplied evidence instead of being lost.
const connectionString = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 92);
const SELLER = { id: 'cancelled-billing-seller', kind: 'human' };
const current = new Date('2026-11-08T15:00:00.000Z');

/** @param {any} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

/** @param {any} pool */
function runtimeFor(pool) {
  return createOrderBillingRuntime(databaseFor(pool), {
    access: {
      authorizeRead: async () => ({ actor: SELLER }),
      authorizeWrite: async () => ({ actor: SELLER }),
    },
    clock: () => current,
    environment: {
      ORDER_BILLING_ENABLED: 'true',
      N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
      IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
    },
  });
}

/** An atendimento order owned manually by the seller, confirmed. @param {any} pool */
async function seed(pool) {
  const id = `cancelled-billing-order-${randomUUID()}`;
  const contact = `contact-${id}`;
  await pool.query(
    'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES ($1,$2,$2)',
    [contact, current],
  );
  const sequence = Number(
    (await pool.query("SELECT nextval('crm.order_number_seq') AS n")).rows[0].n,
  );
  await pool.query(
    `INSERT INTO crm.orders(id,number_sequence,number,contact_id,manual_owner_id,manual_create_key,origin,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,is_test)
    VALUES ($1,$2,$3,$4,$5,$6,'atendimento','confirmado','01',$7::jsonb,2,10000,'pix','2026-11-08',$8,$5,'user',$5,$8,$8,false)`,
    [
      id,
      sequence,
      `${String(sequence).padStart(2, '0')}-CRM`,
      contact,
      SELLER.id,
      randomUUID(),
      JSON.stringify(
        encryptJson(
          {
            summary: { cliente: 'Cliente sintético' },
            items: [],
            artwork: {},
            serviceData: {},
          },
          `order-ficha:${id}`,
          KEY,
        ),
      ),
      current,
    ],
  );
  return id;
}

/** Terminal local cancellation exactly as the repository writes it. @param {any} pool @param {string} orderId */
async function cancel(pool, orderId) {
  await pool.query(
    `UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,version=version+1,updated_at=$2 WHERE id=$1`,
    [
      orderId,
      current,
      SELLER.id,
      JSON.stringify(
        encryptJson('Motivo sintético', `order-cancellation:${orderId}`, KEY),
      ),
    ],
  );
}

/** @param {any} pool @param {string} orderId */
async function orderRow(pool, orderId) {
  return (await pool.query('SELECT * FROM crm.orders WHERE id=$1', [orderId]))
    .rows[0];
}

/** @param {any} runtime @param {string} orderId @param {any} [extra] */
async function command(runtime, orderId, extra = {}) {
  const { billing } = await runtime.get({ actor: SELLER, orderId });
  return {
    actor: SELLER,
    orderId,
    expectedVersion: billing.orderVersion,
    expectedBillingVersion: billing.version,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    percent: 100,
    ...extra,
  };
}

/** @param {any} runtime @param {string} orderId */
async function issue(runtime, orderId) {
  const result = await runtime.issue(await command(runtime, orderId));
  return result.billing.charges.at(-1);
}

/** @param {any} runtime @param {any} charge */
async function reserve(runtime, charge) {
  const executionId = randomUUID();
  const result = await runtime.reserve({
    chargeId: charge.id,
    executionId,
    correlationId: randomUUID(),
  });
  assert.equal(result.allowed, true);
  return executionId;
}

/** @param {any} runtime @param {any} charge @param {string} executionId */
async function created(runtime, charge, executionId) {
  await runtime.created({
    chargeId: charge.id,
    executionId,
    checkoutUrl: 'https://checkout.infinitepay.io/synthetic-cancelled',
    correlationId: randomUUID(),
  });
}

/** @param {any} runtime @param {any} charge @param {any} [extra] */
function payment(runtime, charge, extra = {}) {
  return runtime.payment({
    chargeId: charge.id,
    transactionNsu: randomUUID(),
    invoiceSlug: randomUUID(),
    amountCents: charge.amountCents,
    paidAmountCents: charge.amountCents,
    method: 'pix',
    installments: 1,
    receiptUrl: null,
    correlationId: randomUUID(),
    ...extra,
  });
}

if (!connectionString) {
  test(
    'Cancelled order billing PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(
    new URL(connectionString).pathname.slice(1),
    /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    'Only a dedicated synthetic database may be reset',
  );
  const pool = new Pool({ connectionString, max: 6 });
  const runtime = runtimeFor(pool);
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      "INSERT INTO crm.users(id,email,password_hash,name) VALUES ($1,$2,'$argon2id$synthetic','Pessoa sintética')",
      [SELLER.id, `${SELLER.id}@example.test`],
    );
    await pool.query(
      "INSERT INTO crm.user_functions(user_id,function_name) VALUES ($1,'Vendedor')",
      [SELLER.id],
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  test('an active confirmed order can be billed; once cancelled every human command is refused with 409 ORDER_CANCELLED', async () => {
    const active = await seed(pool);
    const charge = await issue(runtime, active);
    assert.equal(charge.status, 'queued');

    const cancelled = await seed(pool);
    // Prepared before the cancellation so the stale-version path cannot mask the guard.
    const configureCommand = await command(runtime, cancelled, {
      percent: 50,
    });
    const issueCommand = await command(runtime, cancelled);
    const refundCommand = await command(runtime, cancelled, {
      chargeId: randomUUID(),
      amountCents: 100,
    });
    const reconcileCommand = await command(runtime, cancelled, {
      confirmedProviderReview: true,
      decision: 'close_unpaid',
    });
    await cancel(pool, cancelled);
    const before = await orderRow(pool, cancelled);
    const rejected = { statusCode: 409, code: 'ORDER_CANCELLED' };
    await assert.rejects(runtime.configure(configureCommand), rejected);
    await assert.rejects(runtime.issue(issueCommand), rejected);
    await assert.rejects(runtime.refund(refundCommand), rejected);
    await assert.rejects(runtime.reconcile(reconcileCommand), rejected);
    // The expected version is not what refuses it: a fresh command is refused too.
    await assert.rejects(
      runtime.issue(await command(runtime, cancelled)),
      rejected,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS n FROM crm.order_billing_charges WHERE order_id=$1',
          [cancelled],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS n FROM crm.order_billing_plans WHERE order_id=$1',
          [cancelled],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await orderRow(pool, cancelled), before);
  });

  test('billing is read by order id after cancellation, reporting ORDER_CANCELLED as the block', async () => {
    const orderId = await seed(pool);
    const charge = await issue(runtime, orderId);
    await cancel(pool, orderId);
    const { billing } = await runtime.get({ actor: SELLER, orderId });
    assert.equal(billing.blockedReason, 'ORDER_CANCELLED');
    assert.equal(billing.charges.length, 1);
    assert.equal(billing.charges[0].id, charge.id);
    assert.equal(billing.receivedAmountCents, 0);
    // n8n consults the charge by id; that is history, not a new effect.
    const lookup = await runtime.lookup({ chargeId: charge.id });
    assert.equal(lookup.chargeId, charge.id);
    assert.equal(lookup.status, 'queued');
  });

  test('a queued charge of an order cancelled meanwhile is never reserved for checkout creation', async () => {
    const orderId = await seed(pool);
    const charge = await issue(runtime, orderId);
    await cancel(pool, orderId);
    const result = await runtime.reserve({
      chargeId: charge.id,
      executionId: randomUUID(),
      correlationId: randomUUID(),
    });
    assert.deepEqual(result, { allowed: false, chargeId: charge.id });
    const row = (
      await pool.query(
        'SELECT status,execution_id FROM crm.order_billing_charges WHERE id=$1',
        [charge.id],
      )
    ).rows[0];
    assert.equal(row.status, 'queued');
    assert.equal(row.execution_id, null);
  });

  test('a receipt for a charge issued before the cancellation is kept as unapplied evidence, without touching the order', async () => {
    const orderId = await seed(pool);
    const charge = await issue(runtime, orderId);
    const executionId = await reserve(runtime, charge);
    await created(runtime, charge, executionId);
    await cancel(pool, orderId);
    const before = await orderRow(pool, orderId);

    const paid = await payment(runtime, charge, {
      receiptUrl: 'https://recibo.infinitepay.io/synthetic-cancelled',
    });
    assert.equal(paid.recorded, true);
    assert.equal(paid.reviewRequired, true);

    const stored = (
      await pool.query(
        'SELECT application_valid,applied_amount_cents,principal_amount_cents,transaction_nsu FROM crm.order_billing_payments WHERE charge_id=$1',
        [charge.id],
      )
    ).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].application_valid, false);
    assert.equal(Number(stored[0].applied_amount_cents), 0);
    assert.equal(Number(stored[0].principal_amount_cents), charge.amountCents);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM crm.infinitepay_transactions WHERE owner_kind='billing' AND owner_id=$1",
          [charge.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT status FROM crm.order_billing_charges WHERE id=$1',
          [charge.id],
        )
      ).rows[0].status,
      'review',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT review_required FROM crm.order_billing_plans WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].review_required,
      true,
    );
    // The cancelled order is immutable: nothing was settled or versioned.
    assert.deepEqual(await orderRow(pool, orderId), before);

    // History is still consultable by id and shows the review state.
    const { billing } = await runtime.get({ actor: SELLER, orderId });
    assert.equal(billing.charges[0].status, 'review');
    assert.equal(billing.receivedAmountCents, 0);

    // The provider retries the same transaction: idempotent, still one receipt.
    const again = await runtime.payment({
      chargeId: charge.id,
      transactionNsu: stored[0].transaction_nsu,
      invoiceSlug: (
        await pool.query(
          'SELECT invoice_slug FROM crm.order_billing_payments WHERE charge_id=$1',
          [charge.id],
        )
      ).rows[0].invoice_slug,
      amountCents: charge.amountCents,
      paidAmountCents: charge.amountCents,
      method: 'pix',
      installments: 1,
      receiptUrl: 'https://recibo.infinitepay.io/synthetic-cancelled',
      correlationId: randomUUID(),
    });
    assert.equal(again.duplicate, true);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS n FROM crm.order_billing_payments WHERE charge_id=$1',
          [charge.id],
        )
      ).rows[0].n,
      1,
    );
  });

  test('control: the same receipt on a not cancelled order is applied and settles it', async () => {
    const orderId = await seed(pool);
    const charge = await issue(runtime, orderId);
    const executionId = await reserve(runtime, charge);
    await created(runtime, charge, executionId);
    const paid = await payment(runtime, charge);
    assert.equal(paid.reviewRequired, false);
    assert.ok((await orderRow(pool, orderId)).paid_on);
    const { billing } = await runtime.get({ actor: SELLER, orderId });
    assert.equal(billing.receivedAmountCents, charge.amountCents);
  });
}
