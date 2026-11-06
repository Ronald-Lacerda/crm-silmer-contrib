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
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { reopenOrder } from '../modules/orders/src/domain/order.js';

const connectionString = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 91);
const SELLER = { id: 'billing-seller', kind: 'human' };
const OTHER = { id: 'billing-other', kind: 'human' };
const ADMIN = { id: 'billing-admin', kind: 'human' };
const FINANCE = { id: 'billing-finance', kind: 'human' };
let current = new Date('2026-11-05T15:00:00.000Z');
/** @param {any} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}
/** @param {any} pool @param {any} [overrides] */
function runtimeFor(pool, overrides = {}) {
  return createOrderBillingRuntime(overrides.database ?? databaseFor(pool), {
    access: {
      authorizeRead: async () => ({ actor: SELLER }),
      authorizeWrite: async () => ({ actor: SELLER }),
    },
    clock: () => current,
    environment: {
      ORDER_BILLING_ENABLED: 'true',
      N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
      IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
      ...overrides.environment,
    },
  });
}
/** @param {any} pool @param {any} [options] */
async function seed(pool, options = {}) {
  const id = `billing-order-${randomUUID()}`;
  const store = options.origin === 'loja';
  const contact = store ? null : `contact-${id}`;
  if (contact)
    await pool.query(
      'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES ($1,$2,$2)',
      [contact, current],
    );
  const conversationId = options.conversation ? `conversation-${id}` : null;
  if (conversationId) {
    const identityId = `identity-${id}`;
    await pool.query(
      `INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at)
      VALUES ($1,$2,'meta','synthetic-billing','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)`,
      [
        identityId,
        contact,
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
        JSON.stringify(
          encryptJson({ phone: 'synthetic-contact' }, identityId, KEY),
        ),
        current,
      ],
    );
    await pool.query(
      `INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,external_conversation_id,cycle_number,assigned_user_id,opened_at,last_message_at)
      VALUES ($1,$2,'meta','synthetic-billing',$1,1,$3,$4,$4)`,
      [conversationId, identityId, options.owner ?? SELLER.id, current],
    );
  }
  const sequence = Number(
    (await pool.query("SELECT nextval('crm.order_number_seq') AS n")).rows[0].n,
  );
  const nsu = options.nsu ?? randomUUID();
  await pool.query(
    `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,origin,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,paid_on,is_test,store_number,lead_time_business_days,payment_source,payment_confirmed_at,paid_amount_cents,payment_transaction_nsu,payment_invoice_slug)
    VALUES ($1,$2,$3,$21,$4,$5,$6,$7,$8,'01',$9::jsonb,2,$10,'pix','2026-11-05',$11,$12,'user',$12,$11,$11,$13::date,false,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id,
      sequence,
      `${String(sequence).padStart(2, '0')}-CRM`,
      contact,
      store || conversationId ? null : (options.owner ?? SELLER.id),
      store || conversationId ? null : randomUUID(),
      store ? 'loja' : 'atendimento',
      options.status ?? 'confirmado',
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
      options.amount ?? 10000,
      current,
      SELLER.id,
      store ? '2026-11-05' : (options.paidOn ?? null),
      store ? 'LJ-A1B2C3D4' : null,
      store ? 10 : null,
      store ? 'infinitepay' : null,
      store ? current : null,
      store ? (options.amount ?? 10000) : null,
      store ? nsu : null,
      store ? 'synthetic-invoice' : null,
      conversationId,
    ],
  );
  return id;
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
/** @param {any} runtime @param {string} orderId @param {number} [percent] */
async function charge(runtime, orderId, percent = 100) {
  const result = await runtime.issue(
    await command(runtime, orderId, { percent }),
  );
  return result.billing.charges.at(-1);
}
/** @param {any} runtime @param {any} c */
async function reserve(runtime, c) {
  const executionId = randomUUID();
  const result = await runtime.reserve({
    chargeId: c.id,
    executionId,
    correlationId: randomUUID(),
  });
  assert.equal(result.allowed, true);
  return executionId;
}
/** @param {any} runtime @param {any} c @param {any} [extra] */
async function payment(runtime, c, extra = {}) {
  return runtime.payment({
    chargeId: c.id,
    transactionNsu: randomUUID(),
    invoiceSlug: randomUUID(),
    amountCents: c.amountCents,
    paidAmountCents: c.amountCents,
    method: 'pix',
    installments: 1,
    receiptUrl: null,
    correlationId: randomUUID(),
    ...extra,
  });
}
if (!connectionString) {
  test(
    'Order billing PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.equal(
    new URL(connectionString).pathname,
    '/crm_silmer_test',
    'Only the dedicated synthetic database may be reset',
  );
  const pool = new Pool({ connectionString, max: 8 });
  const runtime = runtimeFor(pool);
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    /** @type {[any,string][]} */
    const users = [
      [SELLER, 'Vendedor'],
      [OTHER, 'Vendedor'],
      [ADMIN, 'Vendedor'],
      [FINANCE, 'Financeiro'],
    ];
    for (const [actor, role] of users) {
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES ($1,$2,'$argon2id$synthetic','Pessoa sintética')",
        [actor.id, `${actor.id}@example.test`],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES ($1,$2)',
        [actor.id, role],
      );
    }
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability,granted_by) VALUES ($1,'COMMERCIAL_ADMIN',$2)",
      [ADMIN.id, SELLER.id],
    );
  });
  after(async () => pool.end());
  test('COB-02/09: 0% creates no checkout; signal then balance alone settle the order', async () => {
    const orderId = await seed(pool, { amount: 10001 });
    const zero = await runtime.configure(
      await command(runtime, orderId, { percent: 0 }),
    );
    assert.equal(zero.billing.charges.length, 0);
    assert.equal(zero.billing.receivedAmountCents, 0);
    const c = await charge(runtime, orderId, 30);
    assert.equal(c.amountCents, 3000);
    await reserve(runtime, c);
    await payment(runtime, c, {
      method: 'credit_card',
      installments: 3,
      paidAmountCents: 3300,
    });
    const partial = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(partial.receivedAmountCents, 3000);
    assert.equal(partial.balanceAmountCents, 7001);
    assert.equal(
      (
        await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [
          orderId,
        ])
      ).rows[0].paid_on,
      null,
    );
    const balance = await charge(runtime, orderId, 30);
    assert.equal(balance.amountCents, 7001);
    await reserve(runtime, balance);
    await payment(runtime, balance);
    const settled = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(settled.receivedAmountCents, 10001);
    assert.equal(settled.balanceAmountCents, 0);
    assert.ok(
      (
        await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [
          orderId,
        ])
      ).rows[0].paid_on,
    );
  });
  test('COB-04/05: concurrent human commands create one charge/job and replay the original result', async () => {
    const orderId = await seed(pool);
    const cmd = await command(runtime, orderId, { percent: 50 });
    const [a, b] = await Promise.all([runtime.issue(cmd), runtime.issue(cmd)]);
    assert.equal(a.billing.charges[0].id, b.billing.charges[0].id);
    await assert.rejects(runtime.issue({ ...cmd, percent: 100 }), {
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const stats = (
      await pool.query(
        "SELECT (SELECT count(*) FROM crm.order_billing_charges WHERE order_id=$1) AS charges,(SELECT count(*) FROM crm.outbox_jobs WHERE job_type='billing.checkout.create' AND idempotency_key=$2) AS jobs",
        [orderId, a.billing.charges[0].id],
      )
    ).rows[0];
    assert.equal(stats.charges, '1');
    assert.equal(stats.jobs, '1');
    const next = await command(runtime, orderId, { percent: 50 });
    await assert.rejects(runtime.issue(next), {
      code: 'BILLING_ACTIVE_CHARGE',
    });
  });
  test('COB-01/13: active owner or administrator only; other readers do not receive private links', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    const executionId = await reserve(runtime, c);
    await runtime.created({
      chargeId: c.id,
      executionId,
      checkoutUrl: 'https://checkout.infinitepay.io/private-synthetic',
      correlationId: randomUUID(),
    });
    const other = await runtime.get({ actor: OTHER, orderId });
    assert.equal(other.billing.canManage, false);
    assert.equal(other.billing.charges[0].checkoutUrl, null);
    await assert.rejects(
      runtime.configure(await command(runtime, orderId, { actor: OTHER })),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(runtime.get({ actor: FINANCE, orderId }), {
      code: 'FORBIDDEN',
    });
    await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
      SELLER.id,
      current,
    ]);
    await assert.rejects(runtime.get({ actor: SELLER, orderId }), {
      code: 'FORBIDDEN',
    });
    await pool.query('UPDATE crm.users SET disabled_at=NULL WHERE id=$1', [
      SELLER.id,
    ]);
    const adminOrder = await seed(pool);
    const admin = await runtime.issue(
      await command(runtime, adminOrder, { actor: ADMIN }),
    );
    assert.equal(admin.billing.charges.length, 1);
    assert.equal(
      (
        await pool.query(
          'SELECT checkout_envelope::text FROM crm.order_billing_charges WHERE id=$1',
          [c.id],
        )
      ).rows[0].checkout_envelope.includes('private-synthetic'),
      false,
    );
  });
  test('COB-02/11: pending, store, minimum and legacy paid records cannot start billing', async () => {
    /** @type {[any,string][]} */
    const cases = [
      [{ status: 'pendente' }, 'BILLING_ORDER_NOT_CONFIRMED'],
      [{ origin: 'loja' }, 'BILLING_STORE_ORDER'],
      [{ paidOn: '2026-11-05' }, 'BILLING_LEGACY_PAYMENT'],
    ];
    for (const [options, code] of cases) {
      const orderId = await seed(pool, options);
      await assert.rejects(
        runtime.issue(
          await command(
            runtime,
            orderId,
            options.origin === 'loja' ? { actor: ADMIN } : {},
          ),
        ),
        {
          code,
        },
      );
    }
    const minimum = await seed(pool, { amount: 100 });
    await assert.rejects(
      runtime.issue(await command(runtime, minimum, { percent: 50 })),
      { code: 'BILLING_MINIMUM_AMOUNT' },
    );
    const managed = await seed(pool);
    await runtime.configure(await command(runtime, managed, { percent: 0 }));
    await assert.rejects(
      pool.query("UPDATE crm.orders SET paid_on='2026-11-05' WHERE id=$1", [
        managed,
      ]),
      { code: '23514' },
    );
  });
  test('COB-05/07: reserve is one use, payment may precede created, duplicate callbacks and late receipt do not duplicate credit', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    const executionId = await reserve(runtime, c);
    assert.equal(
      (
        await runtime.reserve({
          chargeId: c.id,
          executionId,
          correlationId: randomUUID(),
        })
      ).allowed,
      false,
    );
    const details = { transactionNsu: randomUUID(), invoiceSlug: randomUUID() };
    await Promise.all([
      payment(runtime, c, details),
      payment(runtime, c, details),
    ]);
    await runtime.created({
      chargeId: c.id,
      executionId,
      checkoutUrl: 'https://checkout.infinitepay.io/private-callback',
      correlationId: randomUUID(),
    });
    await payment(runtime, c, {
      ...details,
      receiptUrl: 'https://infinitepay.io/private-receipt',
    });
    const result = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(result.charges[0].status, 'paid');
    assert.equal(result.receivedAmountCents, 10000);
    assert.equal(
      result.charges[0].receiptUrl,
      'https://infinitepay.io/private-receipt',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM crm.order_billing_payments WHERE charge_id=$1',
          [c.id],
        )
      ).rows[0].count,
      '1',
    );
    await assert.rejects(
      payment(runtime, c, { ...details, paidAmountCents: 11000 }),
      { code: 'BILLING_TRANSACTION_CONFLICT' },
    );
  });
  test('COB-06/08: mismatch rejected and gateway transaction cannot pay store and CRM', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    await assert.rejects(payment(runtime, c, { amountCents: 100 }), {
      code: 'BILLING_PAYMENT_MISMATCH',
    });
    const nsu = randomUUID();
    await seed(pool, { origin: 'loja', nsu });
    await assert.rejects(payment(runtime, c, { transactionNsu: nsu }), {
      code: 'BILLING_TRANSACTION_CONFLICT',
    });
    const other = await charge(runtime, await seed(pool));
    await reserve(runtime, other);
    const shared = randomUUID();
    const results = await Promise.allSettled([
      payment(runtime, c, { transactionNsu: shared }),
      payment(runtime, other, { transactionNsu: shared }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const inverse = randomUUID();
    await payment(runtime, other, { transactionNsu: inverse });
    await assert.rejects(seed(pool, { origin: 'loja', nsu: inverse }), {
      code: '23505',
    });
  });
  test('COB-10: price change invalidates settlement; current agreement requires explicit audited reconciliation', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    await payment(runtime, c);
    await pool.query(
      'UPDATE crm.orders SET final_amount_cents=12000,version=version+1,updated_at=$2 WHERE id=$1',
      [orderId, current],
    );
    let result = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(result.reviewRequired, true);
    assert.equal(result.receivedAmountCents, 0);
    assert.equal(
      (
        await pool.query(
          'SELECT finance_payment_review_required FROM crm.orders WHERE id=$1',
          [orderId],
        )
      ).rows[0].finance_payment_review_required,
      true,
    );
    assert.equal(
      (
        await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [
          orderId,
        ])
      ).rows[0].paid_on,
      null,
    );
    await assert.rejects(runtime.issue(await command(runtime, orderId)), {
      code: 'BILLING_REVIEW_REQUIRED',
    });
    result = (
      await runtime.reconcile(
        await command(runtime, orderId, {
          decision: 'apply_current',
          confirmedProviderReview: true,
        }),
      )
    ).billing;
    assert.equal(result.reviewRequired, false);
    assert.equal(result.receivedAmountCents, 10000);
    assert.equal(result.balanceAmountCents, 2000);
  });
  test('COB-14/15: unknown emissions stay blocked; after expiry operator may close, late payment is preserved in review', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    const executionId = await reserve(runtime, c);
    const receiveOnly = runtimeFor(pool, {
      environment: {
        ORDER_BILLING_ENABLED: 'false',
        ORDER_BILLING_RECEIVE_ENABLED: 'true',
      },
    });
    assert.equal(
      (
        await receiveOnly.reserve({
          chargeId: c.id,
          executionId: randomUUID(),
          correlationId: randomUUID(),
        })
      ).allowed,
      false,
    );
    await assert.rejects(
      receiveOnly.issue(await command(receiveOnly, orderId)),
      { code: 'BILLING_DISABLED' },
    );
    await receiveOnly.created({
      chargeId: c.id,
      executionId,
      checkoutUrl: 'https://checkout.infinitepay.io/rollback',
      correlationId: randomUUID(),
    });
    await assert.rejects(
      runtime.reconcile(
        await command(runtime, orderId, {
          decision: 'close_unpaid',
          confirmedProviderReview: true,
        }),
      ),
      { code: 'BILLING_LINK_STILL_VALID' },
    );
    const previous = current;
    current = new Date(current.getTime() + 86401000);
    try {
      await runtime.reconcile(
        await command(runtime, orderId, {
          decision: 'close_unpaid',
          confirmedProviderReview: true,
        }),
      );
      assert.equal(
        (await runtime.get({ actor: SELLER, orderId })).billing.charges[0]
          .status,
        'closed',
      );
      await payment(receiveOnly, c);
      const late = (await runtime.get({ actor: SELLER, orderId })).billing;
      assert.equal(late.reviewRequired, true);
      assert.equal(late.receivedAmountCents, 0);
      assert.equal(late.charges[0].status, 'review');
    } finally {
      current = previous;
    }
  });
  test('COB-16: partial refund preserves original receipt and invalidates finance check exactly once', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    await payment(runtime, c);
    await pool.query(
      'INSERT INTO crm.order_finance(order_id,version,completed_at,completed_by) VALUES ($1,1,$2,$3)',
      [orderId, current, FINANCE.id],
    );
    const cmd = await command(runtime, orderId, {
      chargeId: c.id,
      amountCents: 1000,
    });
    await runtime.refund(cmd);
    await runtime.refund(cmd);
    const result = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(result.charges[0].refundedAmountCents, 1000);
    assert.equal(result.receivedAmountCents, 9000);
    assert.equal(result.reviewRequired, true);
    assert.equal(
      (
        await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [
          orderId,
        ])
      ).rows[0].paid_on,
      null,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT completed_at FROM crm.order_finance WHERE order_id=$1',
          [orderId],
        )
      ).rows[0].completed_at,
      null,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM crm.order_billing_refunds r JOIN crm.order_billing_payments p ON p.id=r.payment_id WHERE p.charge_id=$1',
          [c.id],
        )
      ).rows[0].count,
      '1',
    );
  });
  test('COB-14: audit failure rolls back charge and outbox in the same transaction', async () => {
    const orderId = await seed(pool);
    const raw = databaseFor(pool);
    const faulty = runtimeFor(pool, {
      database: {
        query: raw.query,
        transaction: (/** @type {any} */ work) =>
          raw.transaction((/** @type {any} */ client) =>
            work({
              query: (
                /** @type {string} */ sql,
                /** @type {any[]} */ values,
              ) => {
                if (sql.includes('INSERT INTO crm.audit_events'))
                  throw new Error('synthetic-audit-failure');
                return client.query(sql, values);
              },
            }),
          ),
      },
    });
    await assert.rejects(
      faulty.issue(await command(runtime, orderId)),
      /synthetic-audit-failure/u,
    );
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId })).billing.charges.length,
      0,
    );
  });
  test('COB-01: replay reauthorizes the live owner after conversation transfer and account disable', async () => {
    const orderId = await seed(pool, { conversation: true });
    const original = await command(runtime, orderId);
    await runtime.issue(original);
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)',
      [orderId, OTHER.id],
    );
    await assert.rejects(runtime.issue(original), { code: 'FORBIDDEN' });
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)',
      [orderId, SELLER.id],
    );
    await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
      SELLER.id,
      current,
    ]);
    await assert.rejects(runtime.issue(original), { code: 'FORBIDDEN' });
    await pool.query('UPDATE crm.users SET disabled_at=NULL WHERE id=$1', [
      SELLER.id,
    ]);
    assert.equal((await runtime.issue(original)).billing.charges.length, 1);
  });
  test('COB-10/14: callback racing the real commercial repository reopen has no silently stale settlement', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    const repository = new PostgresOrderRepository({
      database: databaseFor(pool),
      envelopeKey: KEY,
    });
    const original = await repository.findById(orderId);
    assert.ok(original);
    const reopened = reopenOrder(original, {
      actorId: SELLER.id,
      now: current,
    });
    const result = await Promise.allSettled([
      payment(runtime, c),
      repository.saveStatus(reopened, {
        actor: SELLER,
        expectedVersion: original.version,
        correlationId: randomUUID(),
      }),
    ]);
    assert.equal(result[0].status, 'fulfilled');
    if (result[1].status === 'rejected') {
      assert.equal(result[1].reason.code, 'VERSION_CONFLICT');
      const latest = await repository.findById(orderId);
      assert.ok(latest);
      await repository.saveStatus(
        reopenOrder(latest, { actorId: SELLER.id, now: current }),
        {
          actor: SELLER,
          expectedVersion: latest.version,
          correlationId: randomUUID(),
        },
      );
    }
    const final = (
      await pool.query('SELECT status,paid_on FROM crm.orders WHERE id=$1', [
        orderId,
      ])
    ).rows[0];
    assert.equal(final.status, 'pendente');
    assert.equal(final.paid_on, null);
    const receipt = (
      await pool.query(
        'SELECT p.application_valid FROM crm.order_billing_payments p WHERE p.charge_id=$1',
        [c.id],
      )
    ).rows;
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0].application_valid, false);
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId })).billing.reviewRequired,
      true,
    );
  });
  test('COB-14: callback audit failure rolls back receipt, global NSU and settlement; retry can still apply', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    const raw = databaseFor(pool);
    const faulty = runtimeFor(pool, {
      database: {
        query: raw.query,
        transaction: (/** @type {any} */ work) =>
          raw.transaction((/** @type {any} */ client) =>
            work({
              query: (
                /** @type {string} */ sql,
                /** @type {any[]} */ values,
              ) => {
                if (sql.includes('INSERT INTO crm.audit_events'))
                  throw new Error('synthetic-payment-audit-failure');
                return client.query(sql, values);
              },
            }),
          ),
      },
    });
    const nsu = randomUUID();
    const invoiceSlug = randomUUID();
    await assert.rejects(
      payment(faulty, c, { transactionNsu: nsu, invoiceSlug }),
      /synthetic-payment-audit-failure/u,
    );
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*) FROM crm.order_billing_payments WHERE transaction_nsu=$1) AS payments,(SELECT count(*) FROM crm.infinitepay_transactions WHERE transaction_nsu=$1) AS claims,(SELECT paid_on FROM crm.orders WHERE id=$2) AS paid_on`,
        [nsu, orderId],
      )
    ).rows[0];
    assert.deepEqual(counts, { payments: '0', claims: '0', paid_on: null });
    await payment(runtime, c, { transactionNsu: nsu, invoiceSlug });
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId })).billing
        .receivedAmountCents,
      10000,
    );
  });
  test('COB-08: concurrent site insert and CRM callback have one winner for the same NSU', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    const transactionNsu = randomUUID();
    const results = await Promise.allSettled([
      seed(pool, { origin: 'loja', nsu: transactionNsu.toUpperCase() }),
      payment(runtime, c, { transactionNsu }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const consumed = (
      await pool.query(
        `SELECT (SELECT count(*) FROM crm.orders WHERE crm.infinitepay_transaction_key(payment_transaction_nsu)=crm.infinitepay_transaction_key($1)) AS store,(SELECT count(*) FROM crm.order_billing_payments WHERE crm.infinitepay_transaction_key(transaction_nsu)=crm.infinitepay_transaction_key($1)) AS billing,(SELECT count(*) FROM crm.infinitepay_transactions WHERE crm.infinitepay_transaction_key(transaction_nsu)=crm.infinitepay_transaction_key($1)) AS claims`,
        [transactionNsu],
      )
    ).rows[0];
    assert.equal(Number(consumed.store) + Number(consumed.billing), 1);
    assert.equal(consumed.claims, '1');
  });
  test('COB-07/08: UUID case preserves one receipt and original AAD, while opaque IDs remain case sensitive', async () => {
    const orderId = await seed(pool);
    const c = await charge(runtime, orderId);
    await reserve(runtime, c);
    const nsu = randomUUID();
    const invoiceSlug = randomUUID();
    await payment(runtime, c, { transactionNsu: nsu, invoiceSlug });
    const original = (await runtime.get({ actor: SELLER, orderId })).billing;
    const replay = await payment(runtime, c, {
      transactionNsu: nsu.toUpperCase(),
      invoiceSlug,
      receiptUrl: 'https://infinitepay.io/synthetic-case-receipt',
    });
    assert.equal(replay.duplicate, true);
    const result = (await runtime.get({ actor: SELLER, orderId })).billing;
    assert.equal(result.reviewRequired, false);
    assert.equal(result.receivedAmountCents, original.receivedAmountCents);
    assert.equal(result.charges[0].paidAt, original.charges[0].paidAt);
    assert.equal(result.charges[0].transactionNsu, nsu);
    assert.equal(
      result.charges[0].receiptUrl,
      'https://infinitepay.io/synthetic-case-receipt',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM crm.order_billing_payments WHERE charge_id=$1',
          [c.id],
        )
      ).rows[0].count,
      '1',
    );
    await assert.rejects(
      seed(pool, { origin: 'loja', nsu: nsu.toUpperCase() }),
      { code: '23505' },
    );
    const storeNsu = randomUUID();
    await seed(pool, { origin: 'loja', nsu: storeNsu.toUpperCase() });
    const other = await charge(runtime, await seed(pool));
    await reserve(runtime, other);
    await assert.rejects(
      payment(runtime, other, { transactionNsu: storeNsu }),
      { code: 'BILLING_TRANSACTION_CONFLICT' },
    );
    for (const transactionNsu of ['Legacy-Case-ABC', 'legacy-case-abc']) {
      const opaque = await charge(runtime, await seed(pool));
      await reserve(runtime, opaque);
      await payment(runtime, opaque, { transactionNsu });
    }
  });
}
