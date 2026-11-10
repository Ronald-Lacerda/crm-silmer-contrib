import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOrderBillingRuntime } from '../apps/api/src/order-billing-runtime.js';
import { createOrderBillingChatRuntime } from '../apps/api/src/order-billing-chat-runtime.js';
import { PostgresN8nCommandOutbox } from '../modules/n8n-integration/src/index.js';
import { scheduleBillingPaymentChecks } from '../modules/integration-reliability/src/billing-payment-check-worker.js';
import {
  seed,
  KEY,
  SELLER,
  NOW,
  cancelOrder,
} from './support/order-billing-chat-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const ENV = {
  ORDER_BILLING_ENABLED: 'true',
  ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
  ORDER_BILLING_CHECK_N8N_URL: 'https://automation.example.test/check',
  N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
  INBOX_MESSAGE_ENVELOPE_KEY: KEY.toString('base64'),
};
const OTHER = { id: 'billing-other', kind: 'human' },
  ADMIN = { id: 'billing-admin', kind: 'human' },
  FINANCE = { id: 'billing-finance', kind: 'human' };
if (!url) {
  test(
    'Billing completion requires dedicated TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(new URL(url).pathname, /^\/crm_silmer_test(?:_[a-z0-9_]+)?$/u);
  const pool = new Pool({ connectionString: url, max: 8 });
  const database = {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
  let now = NOW;
  const options = {
    clock: () => now,
    environment: ENV,
    access: {
      authorizeRead: async () => ({ actor: SELLER }),
      authorizeWrite: async () => ({ actor: SELLER }),
    },
    outboundMessageOutbox: new PostgresN8nCommandOutbox({ envelopeKey: KEY }),
  };
  const chat = createOrderBillingChatRuntime(database, options);
  const runtime = createOrderBillingRuntime(database, {
    ...options,
    billingChat: chat,
  });
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    for (const [actor, role] of [
      [SELLER, 'Vendedor'],
      [OTHER, 'Vendedor'],
      [ADMIN, 'Vendedor'],
      [FINANCE, 'Financeiro'],
    ]) {
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic','Synthetic seller')",
        [
          /** @type {any} */ (actor).id,
          `${/** @type {any} */ (actor).id}@example.test`,
        ],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [/** @type {any} */ (actor).id, role],
      );
    }
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability,granted_by) VALUES($1,'COMMERCIAL_ADMIN',$2)",
      [ADMIN.id, SELLER.id],
    );
  });
  beforeEach(() => {
    now = NOW;
  });
  after(() => pool.end());
  /** @param {string} id @param {any} [extra] */
  async function command(id, extra = {}) {
    const { billing } = await runtime.get({ actor: SELLER, orderId: id });
    return {
      actor: SELLER,
      orderId: id,
      expectedVersion: billing.orderVersion,
      expectedBillingVersion: billing.version,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      ...extra,
    };
  }
  /** @param {string} id @param {any} [extra] */
  async function external(id, extra = {}) {
    return runtime.recordExternal(
      await command(id, {
        amountCents: 7000,
        receivedOn: '2026-11-04',
        method: 'cash',
        note: 'private-note-canary',
        ...extra,
      }),
    );
  }
  /** @param {string} id @param {number} [percent] */
  async function issue(id, percent = 30) {
    const result = await runtime.issue(await command(id, { percent }));
    const charge = result.billing.charges.at(-1);
    const executionId = randomUUID();
    await runtime.reserve({
      chargeId: charge.id,
      executionId,
      correlationId: randomUUID(),
    });
    await runtime.created({
      chargeId: charge.id,
      executionId,
      checkoutUrl: `https://checkout.infinitepay.io/synthetic-${charge.id}`,
      correlationId: randomUUID(),
    });
    return charge;
  }
  /** @param {any} charge @param {any} [extra] */
  const pay = (charge, extra = {}) =>
    runtime.payment({
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

  test('COB-REL-01: cancelled orders reject new chat intents, external receipts/reversals and payment checks without effects', async () => {
    const id = await seed(pool, { conversation: true });
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='em_atendimento' WHERE id=(SELECT conversation_id FROM crm.orders WHERE id=$1)",
      [id],
    );
    const charge = await issue(id);
    const recorded = await external(id, { amountCents: 1000 });
    const receiptId = recorded.billing.externalReceipts[0].id;
    await cancelOrder(pool, id);
    const before = (
      await pool.query('SELECT * FROM crm.orders WHERE id=$1', [id])
    ).rows[0];
    const conversation = (
      await pool.query('SELECT * FROM crm.conversations WHERE id=$1', [
        before.conversation_id,
      ])
    ).rows[0];
    await assert.rejects(
      chat.submit(
        await command(id, {
          action: 'issue',
          percent: 30,
          conversationId: conversation.id,
          expectedConversationVersion: Number(conversation.version),
        }),
      ),
      { code: 'ORDER_CANCELLED' },
    );
    await assert.rejects(external(id, { amountCents: 1 }), {
      code: 'ORDER_CANCELLED',
    });
    await assert.rejects(
      runtime.reverseExternal(
        await command(id, { receiptId, reason: 'Synthetic correction' }),
      ),
      { code: 'ORDER_CANCELLED' },
    );
    await assert.rejects(
      runtime.checkPayment(
        await command(id, {
          chargeId: charge.id,
          invoiceSlug: 'synthetic-invoice',
          transactionNsu: 'synthetic-transaction',
        }),
      ),
      { code: 'ORDER_CANCELLED' },
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM crm.orders WHERE id=$1', [id])).rows[0],
      before,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_send_intents WHERE order_id=$1',
          [id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_external_receipts WHERE order_id=$1',
          [id],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_external_reversals WHERE receipt_id=$1',
          [receiptId],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_payment_checks WHERE charge_id=$1',
          [charge.id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId: id })).billing.blockedReason,
      'ORDER_CANCELLED',
    );
  });

  test('BFIN-02: mixed InfinitePay and external receipts settle once, preserve sources and never fabricate a provider transaction', async () => {
    const id = await seed(pool),
      charge = await issue(id);
    await pay(charge);
    const result = await external(id);
    assert.equal(result.billing.receivedAmountCents, 10000);
    assert.equal(result.billing.balanceAmountCents, 0);
    assert.equal(result.billing.payments.length, 2);
    assert.deepEqual(
      result.billing.payments.map((/** @type {any} */ p) => p.source).sort(),
      ['external', 'infinitepay'],
    );
    assert.equal(result.billing.externalReceipts[0].recordedBy, SELLER.id);
    assert.equal(
      result.billing.externalReceipts[0].recordedByName,
      'Synthetic seller',
    );
    assert.equal(result.billing.externalReceipts[0].receivedOn, '2026-11-04');
    assert.equal(
      result.billing.externalReceipts[0].recordedAt,
      NOW.toISOString(),
    );
    assert.equal(
      (
        await pool.query('SELECT paid_on::text FROM crm.orders WHERE id=$1', [
          id,
        ])
      ).rows[0].paid_on,
      '2026-11-05',
    );
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM crm.infinitepay_transactions WHERE owner_id=$1',
            [charge.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    const history = await chat.getHistory({ actor: SELLER, orderId: id });
    assert.equal(
      history.items.find(
        (/** @type {any} */ e) => e.kind === 'external_receipt',
      ).externalReceiptId,
      result.billing.externalReceipts[0].id,
    );
    assert.equal(history.balanceAmountCents, 0);
    assert.equal(history.receivedAmountCents, 10000);
  });
  test('BFIN-01/03: ACL, dates, amounts and strict methods fail without creating receipts', async () => {
    const id = await seed(pool);
    for (const extra of [
      { actor: OTHER },
      { actor: FINANCE },
      { actor: { id: 'bot', kind: 'automation' } },
      { amountCents: 10001 },
      { amountCents: 0 },
      { amountCents: '7000' },
      { receivedOn: '2026-11-06' },
      { receivedOn: '2026-02-31' },
      { receivedOn: '0000-01-01' },
      { method: 'infinitepay' },
    ])
      await assert.rejects(external(id, extra));
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId: id })).billing
        .externalReceipts.length,
      0,
    );
    const pending = await seed(pool, { status: 'pendente' }),
      store = await seed(pool, { origin: 'loja' });
    await assert.rejects(external(pending), {
      code: 'BILLING_ORDER_NOT_CONFIRMED',
    });
    await assert.rejects(external(store, { actor: ADMIN }), {
      code: 'BILLING_STORE_ORDER',
    });
    const result = await external(id, { actor: ADMIN, amountCents: 1 });
    assert.equal(result.billing.receivedAmountCents, 1);
  });
  test('BFIN-02/03: effective payment date is independent from registration; replay/concurrent requests credit once', async () => {
    const id = await seed(pool),
      input = await command(id, {
        amountCents: 10000,
        receivedOn: '2026-11-04',
        method: 'pix_external',
        note: '',
      });
    const results = await Promise.all([
      runtime.recordExternal(input),
      runtime.recordExternal(input),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].billing.receivedAmountCents, 10000);
    assert.equal(
      (
        await pool.query('SELECT paid_on::text FROM crm.orders WHERE id=$1', [
          id,
        ])
      ).rows[0].paid_on,
      '2026-11-04',
    );
    await assert.rejects(
      runtime.recordExternal({ ...input, note: 'different' }),
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM crm.order_billing_external_receipts WHERE order_id=$1',
            [id],
          )
        ).rows[0].count,
      ),
      1,
    );
  });
  test('BFIN-04: full reversal preserves original receipt and private reason, removes settlement and is idempotent', async () => {
    const id = await seed(pool),
      result = await external(id, { amountCents: 10000 }),
      receipt = result.billing.externalReceipts[0];
    const input = await command(id, {
      receiptId: receipt.id,
      reason: 'private-reversal-canary',
    });
    await pool.query(
      'INSERT INTO crm.order_finance(order_id,version,completed_at,completed_by) VALUES($1,1,$2,$3)',
      [id, now, FINANCE.id],
    );
    const first = await runtime.reverseExternal(input),
      replay = await runtime.reverseExternal(input);
    assert.deepEqual(first, replay);
    assert.equal(first.billing.receivedAmountCents, 0);
    assert.equal(first.billing.balanceAmountCents, 10000);
    assert.equal(first.billing.externalReceipts[0].amountCents, 10000);
    assert.equal(first.billing.externalReceipts[0].reversedBy, SELLER.id);
    assert.equal(
      first.billing.externalReceipts[0].reversalReason,
      'private-reversal-canary',
    );
    assert.equal(
      (await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [id]))
        .rows[0].paid_on,
      null,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT completed_at FROM crm.order_finance WHERE order_id=$1',
          [id],
        )
      ).rows[0].completed_at,
      null,
    );
    assert.equal(
      (await chat.getHistory({ actor: SELLER, orderId: id })).items.filter(
        (/** @type {any} */ e) => e.kind === 'external_reversal',
      ).length,
      1,
    );
    await assert.rejects(
      runtime.reverseExternal(
        await command(id, { receiptId: receipt.id, reason: 'again' }),
      ),
      { code: 'BILLING_RECEIPT_REVERSED' },
    );
    const saved = (
      await pool.query(
        'SELECT note_envelope FROM crm.order_billing_external_receipts WHERE id=$1',
        [receipt.id],
      )
    ).rows[0];
    assert.doesNotMatch(JSON.stringify(saved), /private-note-canary/u);
    assert.doesNotMatch(
      JSON.stringify(
        (
          await pool.query(
            'SELECT * FROM crm.audit_events WHERE target_id=$1',
            [id],
          )
        ).rows,
      ),
      /private-note-canary|private-reversal-canary/u,
    );
    await assert.rejects(
      pool.query(
        'UPDATE crm.order_billing_external_receipts SET amount_cents=1 WHERE id=$1',
        [receipt.id],
      ),
      { code: '23514' },
    );
  });
  test('BFIN-05: late gateway payment after external settlement is preserved for review, not double-applied', async () => {
    const id = await seed(pool),
      charge = await issue(id, 100);
    await external(id, { amountCents: 10000 });
    const received = await pay(charge);
    assert.equal(received.reviewRequired, true);
    const result = await runtime.get({ actor: SELLER, orderId: id });
    assert.equal(result.billing.receivedAmountCents, 10000);
    assert.equal(result.billing.balanceAmountCents, 0);
    assert.equal(result.billing.reviewRequired, true);
    assert.equal(result.billing.payments.length, 2);
    assert.equal(
      (await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [id]))
        .rows[0].paid_on,
      null,
    );
  });
  test('BFIN-03: competing keys cannot over-credit; audit failure rolls back receipt, plan, settlement and replay row', async () => {
    const id = await seed(pool),
      input = await command(id, {
        amountCents: 7000,
        receivedOn: '2026-11-04',
        method: 'cash',
        note: '',
      });
    const competing = await Promise.allSettled([
      runtime.recordExternal(input),
      runtime.recordExternal({ ...input, idempotencyKey: randomUUID() }),
    ]);
    assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId: id })).billing
        .receivedAmountCents,
      7000,
    );
    const second = await seed(pool),
      broken = createOrderBillingRuntime(
        {
          query: database.query,
          transaction: (/** @type {any} */ work) =>
            database.transaction((/** @type {any} */ client) =>
              work({
                query: async (
                  /** @type {string} */ sql,
                  /** @type {any[]} */ params,
                ) => {
                  if (/INSERT INTO crm.audit_events/iu.test(sql))
                    throw new Error('synthetic-audit-failure');
                  return client.query(sql, params);
                },
              }),
            ),
        },
        { ...options, billingChat: chat },
      );
    const retry = await command(second, {
      amountCents: 10000,
      receivedOn: '2026-11-04',
      method: 'cash',
      note: '',
    });
    await assert.rejects(
      broken.recordExternal(retry),
      /synthetic-audit-failure/u,
    );
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId: second })).billing
        .receivedAmountCents,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_external_receipts WHERE order_id=$1',
          [second],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (await runtime.recordExternal(retry)).billing.receivedAmountCents,
      10000,
    );
  });
  test('BFIN-03: external settlement blocks a queued billing message in the same transaction and prevents new charges', async () => {
    const id = await seed(pool, { conversation: true });
    const conversation = (
      await pool.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
        id,
      ])
    ).rows[0].conversation_id;
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='em_atendimento' WHERE id=$1",
      [conversation],
    );
    const versions = (
      await pool.query('SELECT version FROM crm.conversations WHERE id=$1', [
        conversation,
      ])
    ).rows[0];
    const intent = await chat.submit(
      await command(id, {
        conversationId: conversation,
        expectedConversationVersion: Number(versions.version),
        action: 'issue',
        percent: 30,
      }),
    );
    const executionId = randomUUID();
    await runtime.reserve({
      chargeId: intent.chargeId,
      executionId,
      correlationId: randomUUID(),
    });
    await runtime.created({
      chargeId: intent.chargeId,
      executionId,
      checkoutUrl: `https://checkout.infinitepay.io/synthetic-${intent.chargeId}`,
      correlationId: randomUUID(),
    });
    assert.equal(
      (
        await chat.getIntent({
          actor: SELLER,
          orderId: id,
          intentId: intent.id,
        })
      ).state,
      'queued',
    );
    await external(id, { amountCents: 10000 });
    const blocked = await chat.getIntent({
      actor: SELLER,
      orderId: id,
      intentId: intent.id,
    });
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blockedReason, 'PAYMENT_CONFIRMED');
    assert.equal(
      (
        await pool.query('SELECT status FROM crm.messages WHERE id=$1', [
          blocked.messageId,
        ])
      ).rows[0].status,
      'failed',
    );
    await assert.rejects(runtime.issue(await command(id, { percent: 100 })), {
      code: 'BILLING_ACTIVE_CHARGE',
    });
  });
  test('BFIN-05: changed agreement invalidates external application; explicit reconciliation reuses existing money', async () => {
    const id = await seed(pool);
    await external(id);
    await pool.query(
      'UPDATE crm.orders SET final_amount_cents=11000,version=version+1,updated_at=$2 WHERE id=$1',
      [id, now],
    );
    const before = await runtime.get({ actor: SELLER, orderId: id });
    assert.equal(before.billing.receivedAmountCents, 0);
    assert.equal(before.billing.reviewRequired, true);
    await assert.rejects(external(id, { amountCents: 1 }), {
      code: 'BILLING_REVIEW_REQUIRED',
    });
    const result = await runtime.reconcile(
      await command(id, {
        decision: 'apply_current',
        confirmedProviderReview: true,
      }),
    );
    assert.equal(result.billing.receivedAmountCents, 7000);
    assert.equal(result.billing.balanceAmountCents, 4000);
  });
  test('BFIN-06/08: checking persists encrypted identifiers and bounded query jobs; scheduler never creates a checkout', async () => {
    const id = await seed(pool),
      charge = await issue(id),
      input = await command(id, {
        chargeId: charge.id,
        invoiceSlug: 'private-invoice-canary',
        transactionNsu: 'private-transaction-canary',
      });
    const result = await runtime.checkPayment(input);
    assert.equal(result.state, 'queued');
    assert.equal((await runtime.checkPayment(input)).checkId, result.checkId);
    const saved = (
      await pool.query(
        'SELECT * FROM crm.order_billing_payment_checks WHERE id=$1',
        [result.checkId],
      )
    ).rows[0];
    assert.doesNotMatch(
      JSON.stringify(saved),
      /private-invoice-canary|private-transaction-canary/u,
    );
    const candidate = await runtime.paymentCheckLookup({
      checkId: result.checkId,
    });
    assert.equal(candidate.chargeId, charge.id);
    assert.equal(candidate.invoiceSlug, 'private-invoice-canary');
    assert.equal(candidate.transactionNsu, 'private-transaction-canary');
    await assert.rejects(
      runtime.paymentCheckResult({ checkId: result.checkId, status: 'paid' }),
      { code: 'BILLING_PAYMENT_NOT_RECORDED' },
    );
    await runtime.paymentCheckResult({
      checkId: result.checkId,
      status: 'not_paid',
    });
    for (let attempt = 2; attempt <= 6; attempt++) {
      now = new Date(now.getTime() + 600001);
      assert.equal(await scheduleBillingPaymentChecks(database, now), 1);
      await runtime.paymentCheckResult({
        checkId: result.checkId,
        status: 'not_paid',
      });
    }
    now = new Date(now.getTime() + 600001);
    assert.equal(await scheduleBillingPaymentChecks(database, now), 0);
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM crm.outbox_jobs WHERE job_type='billing.payment.check' AND idempotency_key LIKE $1",
            [result.checkId + ':%'],
          )
        ).rows[0].count,
      ),
      6,
    );
    assert.equal(
      (await runtime.get({ actor: SELLER, orderId: id })).billing
        .receivedAmountCents,
      0,
    );
  });
  test('BFIN-07/08: verified recovery reuses payment deduplication and later not_paid cannot regress paid; receiving survives emission-off', async () => {
    const id = await seed(pool),
      charge = await issue(id),
      invoiceSlug = randomUUID(),
      transactionNsu = randomUUID();
    const result = await runtime.checkPayment(
      await command(id, { chargeId: charge.id, invoiceSlug, transactionNsu }),
    );
    await pay(charge, { invoiceSlug, transactionNsu });
    assert.equal(
      (
        await runtime.paymentCheckResult({
          checkId: result.checkId,
          status: 'paid',
        })
      ).status,
      'paid',
    );
    assert.equal(
      (
        await runtime.paymentCheckResult({
          checkId: result.checkId,
          status: 'not_paid',
        })
      ).status,
      'paid',
    );
    const receiving = createOrderBillingRuntime(database, {
      ...options,
      environment: {
        ...ENV,
        ORDER_BILLING_ENABLED: 'false',
        ORDER_BILLING_RECEIVE_ENABLED: 'true',
      },
    });
    assert.equal(
      (await receiving.paymentCheckLookup({ checkId: result.checkId })).state,
      'paid',
    );
    assert.equal(
      (await receiving.get({ actor: SELLER, orderId: id })).billing
        .receivedAmountCents,
      3000,
    );
  });
  test('BFIN-03/05: racing external and gateway receipts preserve money without applying more than the order total', async () => {
    const id = await seed(pool),
      charge = await issue(id, 100);
    const results = await Promise.allSettled([
      external(id, { amountCents: 10000 }),
      pay(charge),
    ]);
    assert.equal(results[1].status, 'fulfilled');
    const state = await runtime.get({ actor: SELLER, orderId: id });
    assert.equal(state.billing.receivedAmountCents, 10000);
    assert.equal(state.billing.balanceAmountCents, 0);
    assert.equal(
      state.billing.payments.filter(
        (/** @type {any} */ p) => p.source === 'infinitepay',
      ).length,
      1,
    );
    if (results[0].status === 'fulfilled') {
      assert.equal(state.billing.reviewRequired, true);
      assert.equal(state.billing.payments.length, 2);
    } else {
      assert.equal(state.billing.payments.length, 1);
    }
  });
  test('BFIN-06/08: consultation result, history and audit roll back together; duplicate acknowledgements do not duplicate events', async () => {
    const id = await seed(pool),
      charge = await issue(id),
      check = await runtime.checkPayment(
        await command(id, {
          chargeId: charge.id,
          invoiceSlug: 'synthetic-invoice',
          transactionNsu: 'synthetic-transaction',
        }),
      );
    const broken = createOrderBillingRuntime(
      {
        query: database.query,
        transaction: (/** @type {any} */ work) =>
          database.transaction((/** @type {any} */ client) =>
            work({
              query: async (
                /** @type {string} */ sql,
                /** @type {any[]} */ params,
              ) => {
                if (/INSERT INTO crm.audit_events/iu.test(sql))
                  throw new Error('synthetic-check-audit-failure');
                return client.query(sql, params);
              },
            }),
          ),
      },
      { ...options, billingChat: chat },
    );
    await assert.rejects(
      broken.paymentCheckResult({
        checkId: check.checkId,
        status: 'not_paid',
        correlationId: randomUUID(),
      }),
      /synthetic-check-audit-failure/u,
    );
    assert.equal(
      (await runtime.paymentCheckLookup({ checkId: check.checkId })).state,
      'queued',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM crm.order_billing_payment_check_events WHERE check_id=$1',
          [check.checkId],
        )
      ).rows.length,
      0,
    );
    await runtime.paymentCheckResult({
      checkId: check.checkId,
      status: 'not_paid',
      correlationId: randomUUID(),
    });
    await runtime.paymentCheckResult({
      checkId: check.checkId,
      status: 'not_paid',
      correlationId: randomUUID(),
    });
    const history = await chat.getHistory({ actor: SELLER, orderId: id });
    const events = history.items.filter(
      (/** @type {any} */ e) => e.kind === 'payment_check',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'not_paid');
    assert.equal(history.receivedAmountCents, 0);
  });
  test('BFIN-08: missing consultation endpoint is projected disabled and refuses queueing while external receiving remains available', async () => {
    const environment = {
      ...ENV,
      ORDER_BILLING_ENABLED: 'false',
      ORDER_BILLING_RECEIVE_ENABLED: 'true',
    };
    delete (/** @type {any} */ (environment).ORDER_BILLING_CHECK_N8N_URL);
    const receive = createOrderBillingRuntime(database, {
      ...options,
      environment,
    });
    const id = await seed(pool),
      charge = await issue(id);
    assert.equal(
      (await receive.get({ actor: SELLER, orderId: id })).billing
        .paymentCheckEnabled,
      false,
    );
    await assert.rejects(
      receive.checkPayment(
        await command(id, {
          chargeId: charge.id,
          invoiceSlug: 'invoice',
          transactionNsu: 'transaction',
        }),
      ),
      { code: 'BILLING_CHECK_DISABLED' },
    );
    const result = await receive.recordExternal(
      await command(id, {
        amountCents: 1,
        receivedOn: '2026-11-04',
        method: 'cash',
        note: '',
      }),
    );
    assert.equal(result.billing.receivedAmountCents, 1);
  });
}
