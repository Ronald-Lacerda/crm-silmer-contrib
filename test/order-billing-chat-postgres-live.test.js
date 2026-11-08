import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import {
  migrate,
  loadMigrations,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOrderBillingChatRuntime } from '../apps/api/src/order-billing-chat-runtime.js';
import { createOrderBillingRuntime } from '../apps/api/src/order-billing-runtime.js';
import { PostgresN8nCommandOutbox } from '../modules/n8n-integration/src/index.js';
import {
  seed,
  KEY,
  SELLER,
  NOW,
} from './support/order-billing-chat-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const OTHER = { id: 'billing-other', kind: 'human' };
const ADMIN = { id: 'billing-admin', kind: 'human' };
const FINANCE = { id: 'billing-finance', kind: 'human' };
const ENV = {
  ORDER_BILLING_ENABLED: 'true',
  ORDER_BILLING_CHAT_SEND_ENABLED: 'true',
  N8N_INTEGRATION_ENVELOPE_KEY: KEY.toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: KEY.toString('base64'),
  INBOX_MESSAGE_ENVELOPE_KEY: KEY.toString('base64'),
};
let now = NOW;
/** @param {any} pool */
const database = (pool) => ({
  query: pool.query.bind(pool),
  transaction: (/** @type {any} */ work) => withTransaction(pool, work),
});
/** @param {any} pool @param {any} [extra] */
const options = (pool, extra = {}) => ({
  access: {
    authorizeRead: async () => ({ actor: SELLER }),
    authorizeWrite: async () => ({ actor: SELLER }),
  },
  clock: () => now,
  environment: ENV,
  outboundMessageOutbox: new PostgresN8nCommandOutbox({ envelopeKey: KEY }),
  ...extra,
});
/** @param {any} pool @param {any} [extra] */
async function order(pool, extra = {}) {
  const id = await seed(pool, { conversation: true, amount: 120000, ...extra });
  const row = (
    await pool.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [id])
  ).rows[0];
  if (row.conversation_id)
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='em_atendimento' WHERE id=$1",
      [row.conversation_id],
    );
  return id;
}
/** @param {any} pool @param {string} orderId @param {any} [extra] */
async function command(pool, orderId, extra = {}) {
  const row = (
    await pool.query(
      `SELECT o.version,c.id AS conversation_id,c.version AS conversation_version,p.version AS billing_version FROM crm.orders o LEFT JOIN crm.conversations c ON c.id=o.conversation_id LEFT JOIN crm.order_billing_plans p ON p.order_id=o.id WHERE o.id=$1`,
      [orderId],
    )
  ).rows[0];
  return {
    actor: SELLER,
    orderId,
    conversationId: row.conversation_id,
    expectedVersion: Number(row.version),
    expectedBillingVersion: Number(row.billing_version ?? 0),
    expectedConversationVersion: Number(row.conversation_version),
    action: 'issue',
    percent: 30,
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...extra,
  };
}
/** @param {any} pool @param {string} orderId @param {string} action @param {any} [fields] */
async function actionCommand(pool, orderId, action, fields = {}) {
  const c = await command(pool, orderId);
  delete c.percent;
  return { ...c, action, ...fields };
}
/** @param {any} legacy @param {any} intent */
async function ready(legacy, intent) {
  const executionId = randomUUID();
  const reserved = await legacy.reserve({
    chargeId: intent.chargeId,
    executionId,
    correlationId: randomUUID(),
  });
  assert.equal(reserved.allowed, true);
  await legacy.created({
    chargeId: intent.chargeId,
    executionId,
    checkoutUrl: `https://pay.infinitepay.io/synthetic/${intent.chargeId}`,
    correlationId: randomUUID(),
  });
}
/** @param {any} legacy @param {any} intent */
const pay = (legacy, intent) =>
  legacy.payment({
    chargeId: intent.chargeId,
    transactionNsu: randomUUID(),
    invoiceSlug: randomUUID(),
    amountCents: intent.amountCents,
    paidAmountCents: intent.amountCents,
    method: 'pix',
    installments: 1,
    receiptUrl: null,
    correlationId: randomUUID(),
  });
/** @param {any} pool @param {string} id */
async function counts(pool, id) {
  return (
    await pool.query(
      `SELECT
    (SELECT count(*)::int FROM crm.order_billing_send_intents WHERE order_id=$1) AS intents,
    (SELECT count(*)::int FROM crm.order_billing_charges WHERE order_id=$1) AS charges,
    (SELECT count(*)::int FROM crm.order_billing_plans WHERE order_id=$1) AS plans,
    (SELECT count(*)::int FROM crm.order_billing_send_events e JOIN crm.order_billing_send_intents i ON i.id=e.intent_id WHERE i.order_id=$1) AS events,
    (SELECT count(*)::int FROM crm.outbox_jobs j JOIN crm.order_billing_charges c ON j.idempotency_key=c.id::text WHERE c.order_id=$1 AND j.job_type='billing.checkout.create') AS jobs,
    (SELECT count(*)::int FROM crm.idempotency_records WHERE scope='billing.chat:'||$1) AS idem,
    (SELECT count(*)::int FROM crm.audit_events a JOIN crm.order_billing_send_intents i ON a.target_id=i.id::text WHERE i.order_id=$1 AND a.action='billing.send.intent') AS audit`,
      [id],
    )
  ).rows[0];
}

if (!url) {
  test(
    'Billing send persistence requires dedicated TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.equal(
    new URL(url).pathname,
    '/crm_silmer_test',
    'Only dedicated synthetic database may be reset',
  );
  const pool = new Pool({ connectionString: url, max: 10 });
  const runtime = createOrderBillingChatRuntime(database(pool), options(pool));
  const legacy = createOrderBillingRuntime(database(pool), options(pool));
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    const migrations = await loadMigrations();
    const first = await migrate(pool, { migrations });
    assert.ok(first.applied.includes('0063'));
    assert.deepEqual((await migrate(pool, { migrations })).applied, []);
    for (const [actor, role] of /** @type {Array<[any,string]>} */ ([
      [SELLER, 'Vendedor'],
      [OTHER, 'Vendedor'],
      [ADMIN, 'Vendedor'],
      [FINANCE, 'Financeiro'],
    ])) {
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic','Pessoa sintética')",
        [actor.id, `${actor.id}@example.test`],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, role],
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

  test('BAPI-06: concurrent identical submissions persist one intent, charge, job, audit and encrypted replay', async () => {
    const id = await order(pool);
    const input = await command(pool, id);
    const results = await Promise.all([
      runtime.submit(input),
      runtime.submit({ ...input, correlationId: randomUUID() }),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].state, 'waiting_link');
    assert.equal(results[0].amountCents, 36000);
    assert.deepEqual(await counts(pool, id), {
      intents: 1,
      charges: 1,
      plans: 1,
      events: 1,
      jobs: 1,
      idem: 1,
      audit: 1,
    });
    await ready(legacy, results[0]);
    assert.deepEqual(
      await runtime.submit(input),
      results[0],
      'replay ignores versions advanced by own reservation',
    );
    await assert.rejects(runtime.submit({ ...input, percent: 40 }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(runtime.submit({ ...input, actor: ADMIN }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const snapshot = (
      await pool.query(
        'SELECT * FROM crm.order_billing_send_intents WHERE id=$1',
        [results[0].id],
      )
    ).rows[0];
    assert.equal(snapshot.owner_id, SELLER.id);
    assert.equal(snapshot.order_owner_id, SELLER.id);
    assert.equal(Number(snapshot.cycle_number), 1);
    assert.equal(Number(snapshot.conversation_version), 1);
    const replayRow = (
      await pool.query(
        'SELECT response FROM crm.idempotency_records WHERE scope=$1',
        [`billing.chat:${id}`],
      )
    ).rows[0];
    assert.doesNotMatch(
      JSON.stringify(replayRow.response),
      /waiting_link|conversation_id|36000/,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM crm.messages')).rows[0]
        .n,
      0,
    );
  });

  test('BAPI-06: different concurrent keys have a single winner and failed commands leave no idempotency rows', async () => {
    const id = await order(pool),
      input = await command(pool, id);
    const results = await Promise.allSettled([
      runtime.submit(input),
      runtime.submit({ ...input, idempotencyKey: randomUUID() }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.deepEqual(await counts(pool, id), {
      intents: 1,
      charges: 1,
      plans: 1,
      events: 1,
      jobs: 1,
      idem: 1,
      audit: 1,
    });
  });

  test('BAPI-06: replay revalidates ownership, active user and current administrative capability', async () => {
    const id = await order(pool),
      input = await command(pool, id),
      intent = await runtime.submit(input);
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2,version=version+1 WHERE id=$1',
      [input.conversationId, OTHER.id],
    );
    await assert.rejects(runtime.submit(input), { code: 'FORBIDDEN' });
    await assert.rejects(
      runtime.getIntent({ actor: SELLER, orderId: id, intentId: intent.id }),
      { code: 'FORBIDDEN' },
    );
    await pool.query(
      'UPDATE crm.conversations SET assigned_user_id=$2 WHERE id=$1',
      [input.conversationId, SELLER.id],
    );
    await pool.query('UPDATE crm.users SET disabled_at=now() WHERE id=$1', [
      SELLER.id,
    ]);
    await assert.rejects(runtime.submit(input), { code: 'FORBIDDEN' });
    await pool.query('UPDATE crm.users SET disabled_at=NULL WHERE id=$1', [
      SELLER.id,
    ]);
    const adminId = await order(pool),
      adminInput = { ...(await command(pool, adminId)), actor: ADMIN };
    await runtime.submit(adminInput);
    await pool.query(
      "DELETE FROM crm.user_capabilities WHERE user_id=$1 AND capability='COMMERCIAL_ADMIN'",
      [ADMIN.id],
    );
    await assert.rejects(runtime.submit(adminInput), { code: 'FORBIDDEN' });
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability,granted_by) VALUES($1,'COMMERCIAL_ADMIN',$2)",
      [ADMIN.id, SELLER.id],
    );
    assert.equal((await counts(pool, id)).intents, 1);
  });

  test('BAPI-06: audit failure and lost idempotency persistence roll back every write', async () => {
    for (const fail of [
      'INSERT INTO crm.audit_events',
      'UPDATE crm.idempotency_records',
    ]) {
      const id = await order(pool);
      const failing = {
        query: pool.query.bind(pool),
        transaction: (/** @type {any} */ work) =>
          withTransaction(pool, (client) =>
            work({
              query: async (
                /** @type {string} */ sql,
                /** @type {any[]} */ values,
              ) => {
                if (sql.includes(fail))
                  throw new Error('synthetic persistence failure');
                return client.query(sql, values);
              },
            }),
          ),
      };
      const isolated = createOrderBillingChatRuntime(failing, options(pool));
      const input = await command(pool, id);
      await assert.rejects(
        isolated.submit(input),
        /synthetic persistence failure/,
      );
      assert.deepEqual(await counts(pool, id), {
        intents: 0,
        charges: 0,
        plans: 0,
        events: 0,
        jobs: 0,
        idem: 0,
        audit: 0,
      });
      assert.equal(
        (await runtime.submit(input)).state,
        'waiting_link',
        'rolled-back key remains usable',
      );
    }
  });

  test('BAPI-08: partial receipt permits only server-calculated balance and settlement blocks further charges', async () => {
    const id = await order(pool),
      first = await runtime.submit(await command(pool, id));
    await ready(legacy, first);
    await pay(legacy, first);
    const balance = await runtime.submit(
      await actionCommand(pool, id, 'balance'),
    );
    assert.equal(balance.amountCents, 84000);
    assert.equal(balance.action, 'balance');
    await assert.rejects(
      runtime.submit(await actionCommand(pool, id, 'balance')),
      { code: 'BILLING_ACTIVE_CHARGE' },
    );
    const partial = await runtime.getHistory({ actor: SELLER, orderId: id });
    assert.equal(partial.receivedAmountCents, 36000);
    assert.equal(partial.balanceAmountCents, 84000);
    assert.equal(
      (await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [id]))
        .rows[0].paid_on,
      null,
    );
    await ready(legacy, balance);
    await pay(legacy, balance);
    const settled = await runtime.getHistory({ actor: SELLER, orderId: id });
    assert.equal(settled.receivedAmountCents, 120000);
    assert.equal(settled.balanceAmountCents, 0);
    await assert.rejects(
      runtime.submit(await actionCommand(pool, id, 'balance')),
      { code: 'BILLING_ALREADY_PAID' },
    );
    assert.equal(
      (await pool.query('SELECT status FROM crm.orders WHERE id=$1', [id]))
        .rows[0].status,
      'confirmado',
    );
  });

  test('BAPI-08: correction requires expired closed unpaid predecessor and preserves the old link/history', async () => {
    const id = await order(pool),
      first = await runtime.submit(await command(pool, id));
    await ready(legacy, first);
    const fields = {
      chargeId: first.chargeId,
      amountCents: 24000,
      confirmedAgreement: true,
      confirmedProviderReview: true,
    };
    await assert.rejects(
      runtime.submit(await actionCommand(pool, id, 'correct', fields)),
      { code: 'BILLING_ACTIVE_CHARGE' },
    );
    now = new Date(NOW.getTime() + 86400001);
    const data = await legacy.get({ actor: SELLER, orderId: id });
    await legacy.reconcile({
      actor: SELLER,
      orderId: id,
      expectedVersion: data.billing.orderVersion,
      expectedBillingVersion: data.billing.version,
      decision: 'close_unpaid',
      confirmedProviderReview: true,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    await assert.rejects(
      runtime.submit(
        await actionCommand(pool, id, 'correct', {
          ...fields,
          amountCents: 119950,
        }),
      ),
      { code: 'BILLING_INVALID_AMOUNT' },
    );
    const corrected = await runtime.submit(
      await actionCommand(pool, id, 'correct', fields),
    );
    assert.equal(corrected.amountCents, 24000);
    assert.notEqual(corrected.chargeId, first.chargeId);
    const old = (
      await pool.query(
        'SELECT status,checkout_envelope,amount_cents FROM crm.order_billing_charges WHERE id=$1',
        [first.chargeId],
      )
    ).rows[0];
    assert.equal(old.status, 'closed');
    assert.equal(Number(old.amount_cents), 36000);
    assert.ok(old.checkout_envelope);
    assert.equal(
      (
        await pool.query(
          'SELECT final_amount_cents FROM crm.orders WHERE id=$1',
          [id],
        )
      ).rows[0].final_amount_cents,
      '120000',
    );
    const history = await runtime.getHistory({ actor: SELLER, orderId: id });
    assert.ok(
      history.items.some(
        (/** @type {any} */ r) =>
          r.kind === 'correction' && r.amountCents === 24000,
      ),
    );
    await pay(legacy, first);
    assert.equal(
      (
        await pool.query(
          'SELECT status FROM crm.order_billing_charges WHERE id=$1',
          [first.chargeId],
        )
      ).rows[0].status,
      'review',
    );
    await assert.rejects(
      runtime.submit(await actionCommand(pool, id, 'balance')),
      { code: 'BILLING_REVIEW_REQUIRED' },
    );
  });

  test('BAPI-06/09: retry requires proven pre-send failure, reuses charge and reserves a single child', async () => {
    const id = await order(pool),
      first = await runtime.submit(await command(pool, id));
    await ready(legacy, first);
    let input = await actionCommand(pool, id, 'retry', {
      intentId: first.id,
      expectedIntentVersion: 1,
    });
    await assert.rejects(runtime.submit(input), {
      code: 'BILLING_RETRY_UNSAFE',
    });
    await pool.query(
      "UPDATE crm.order_billing_send_intents SET state='unknown',version=version+1 WHERE id=$1",
      [first.id],
    );
    await assert.rejects(
      runtime.submit({ ...input, expectedIntentVersion: 2 }),
      { code: 'BILLING_RETRY_UNSAFE' },
    );
    await pool.query(
      "UPDATE crm.order_billing_send_intents SET state='failed',failure_stage='before_send',version=version+1 WHERE id=$1",
      [first.id],
    );
    input = await actionCommand(pool, id, 'retry', {
      intentId: first.id,
      expectedIntentVersion: 3,
    });
    const results = await Promise.allSettled([
      runtime.submit(input),
      runtime.submit({ ...input, idempotencyKey: randomUUID() }),
    ]);
    const success = results.find((r) => r.status === 'fulfilled');
    assert.ok(success && success.status === 'fulfilled');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(success.value.chargeId, first.chargeId);
    assert.equal((await counts(pool, id)).charges, 1);
    assert.equal((await counts(pool, id)).jobs, 1);
    assert.equal((await counts(pool, id)).intents, 2);
    await assert.rejects(
      runtime.submit(
        await actionCommand(pool, id, 'send_existing', {
          chargeId: first.chargeId,
        }),
      ),
      { code: 'BILLING_ACTIVE_CHARGE' },
    );
  });

  test('BAPI-06/08: existing link is reserved once without emitting another financial job', async () => {
    const id = await order(pool);
    const b = await legacy.get({ actor: SELLER, orderId: id });
    const result = await legacy.issue({
      actor: SELLER,
      orderId: id,
      expectedVersion: b.billing.orderVersion,
      expectedBillingVersion: b.billing.version,
      percent: 30,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const charge = result.billing.charges.at(-1);
    await ready(legacy, { chargeId: charge.id });
    const intent = await runtime.submit(
      await actionCommand(pool, id, 'send_existing', { chargeId: charge.id }),
    );
    assert.equal(intent.chargeId, charge.id);
    assert.equal((await counts(pool, id)).jobs, 1);
    assert.equal((await counts(pool, id)).charges, 1);
    assert.equal((await counts(pool, id)).intents, 1);
  });

  test('BAPI-05: tied timestamps paginate deterministically and cursors cannot target another order', async () => {
    const id = await order(pool),
      first = await runtime.submit(await command(pool, id));
    await ready(legacy, first);
    await pay(legacy, first);
    const full = await runtime.getHistory({ actor: SELLER, orderId: id });
    let cursor = null;
    const items = [];
    do {
      const page = await runtime.getHistory({
        actor: SELLER,
        orderId: id,
        limit: 1,
        cursor,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor) assert.ok(cursor.length <= 255);
    } while (cursor);
    assert.deepEqual(items, full.items);
    assert.equal(new Set(items.map((r) => r.id)).size, items.length);
    assert.ok(items.some((r) => r.kind === 'receipt'));
    assert.doesNotMatch(
      JSON.stringify(full),
      /checkout_envelope|https:|transaction_nsu|phone|receiptUrl/,
    );
    const firstPage = await runtime.getHistory({
      actor: SELLER,
      orderId: id,
      limit: 1,
    });
    await assert.rejects(
      runtime.getHistory({
        actor: SELLER,
        orderId: id,
        cursor: `x${firstPage.nextCursor.slice(1)}`,
      }),
      { code: 'INVALID_REQUEST' },
    );
    await assert.rejects(
      runtime.getHistory({ actor: SELLER, orderId: id, cursor: 'bad' }),
      { code: 'INVALID_REQUEST' },
    );
    const other = await order(pool);
    await assert.rejects(
      runtime.getHistory({
        actor: SELLER,
        orderId: other,
        cursor: firstPage.nextCursor,
      }),
      { code: 'INVALID_REQUEST' },
    );
    await assert.rejects(runtime.getHistory({ actor: OTHER, orderId: id }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(runtime.getHistory({ actor: FINANCE, orderId: id }), {
      code: 'FORBIDDEN',
    });
  });

  test('BAPI-06: DB identity/history guards prevent rewriting value, deleting history and cross-charge retries', async () => {
    const id = await order(pool),
      intent = await runtime.submit(await command(pool, id));
    await assert.rejects(
      pool.query(
        'UPDATE crm.order_billing_send_intents SET amount_cents=100,version=version+1 WHERE id=$1',
        [intent.id],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query('DELETE FROM crm.order_billing_send_intents WHERE id=$1', [
        intent.id,
      ]),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM crm.order_billing_send_events WHERE intent_id=$1',
        [intent.id],
      ),
      { code: '23514' },
    );
    assert.equal((await counts(pool, id)).events, 1);
    const otherOrder = await order(pool),
      otherIntent = await runtime.submit(await command(pool, otherOrder));
    await assert.rejects(
      pool.query(
        `INSERT INTO crm.order_billing_send_intents
      SELECT (jsonb_populate_record(NULL::crm.order_billing_send_intents,to_jsonb(i)||$2::jsonb)).*
      FROM crm.order_billing_send_intents i WHERE id=$1`,
        [
          otherIntent.id,
          JSON.stringify({
            id: randomUUID(),
            action: 'retry',
            retry_of_intent_id: intent.id,
          }),
        ],
      ),
      { code: '23503' },
    );
  });

  test('BAPI-04/06: disabled service refuses admission but retains authorized reads without external effects', async () => {
    const id = await order(pool),
      input = await command(pool, id),
      intent = await runtime.submit(input);
    const disabled = createOrderBillingChatRuntime(
      database(pool),
      options(pool, {
        environment: { ...ENV, ORDER_BILLING_CHAT_SEND_ENABLED: 'false' },
      }),
    );
    await assert.rejects(disabled.submit(input), { code: 'BILLING_DISABLED' });
    const defaultEnvironment = { ...ENV };
    delete (
      /** @type {any} */ (defaultEnvironment).ORDER_BILLING_CHAT_SEND_ENABLED
    );
    const defaultOff = createOrderBillingChatRuntime(
      database(pool),
      options(pool, { environment: defaultEnvironment }),
    );
    await assert.rejects(defaultOff.submit(input), {
      code: 'BILLING_DISABLED',
    });
    assert.equal(
      (
        await disabled.getIntent({
          actor: SELLER,
          orderId: id,
          intentId: intent.id,
        })
      ).id,
      intent.id,
    );
    assert.equal(
      (await disabled.getHistory({ actor: SELLER, orderId: id })).items.length,
      2,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM crm.n8n_commands WHERE conversation_id=$1',
          [input.conversationId],
        )
      ).rows[0].n,
      0,
    );
  });

  test('BAPI-06/07: explicit subject enables manual-order destination; unrelated conversations and owners are denied', async () => {
    const manual = await order(pool, { conversation: false });
    const destinationOrder = await order(pool);
    const target = (await command(pool, destinationOrder)).conversationId;
    const manualInput = {
      ...(await command(pool, manual)),
      conversationId: target,
      expectedConversationVersion: 1,
    };
    await assert.rejects(runtime.submit(manualInput), {
      code: 'BILLING_TARGET_CONFLICT',
    });
    const contact = (
      await pool.query('SELECT contact_id FROM crm.orders WHERE id=$1', [
        manual,
      ])
    ).rows[0].contact_id;
    await pool.query(
      `INSERT INTO crm.conversation_subjects(id,conversation_id,contact_id,order_id,kind,position,created_by,created_by_kind,created_at,updated_at)
      VALUES($1,$2,$3,$4,'pedido',10,$5,'human',$6,$6)`,
      [randomUUID(), target, contact, manual, SELLER.id, now],
    );
    await assert.rejects(
      runtime.submit(manualInput),
      { code: 'BILLING_TARGET_CONFLICT' },
      'subject alone cannot authorize another contact',
    );
    const originalContact = (
      await pool.query('SELECT contact_id FROM crm.orders WHERE id=$1', [
        destinationOrder,
      ])
    ).rows[0].contact_id;
    await pool.query(
      'UPDATE crm.contact_identities SET current_contact_id=$2 WHERE id=(SELECT contact_identity_id FROM crm.conversations WHERE id=$1)',
      [target, contact],
    );
    const intent = await runtime.submit(manualInput);
    assert.equal(intent.conversationId, target);
    assert.equal(
      (
        await pool.query('SELECT manual_owner_id FROM crm.orders WHERE id=$1', [
          manual,
        ])
      ).rows[0].manual_owner_id,
      SELLER.id,
    );
    await pool.query(
      'UPDATE crm.contact_identities SET current_contact_id=$2 WHERE id=(SELECT contact_identity_id FROM crm.conversations WHERE id=$1)',
      [target, originalContact],
    );
    await assert.rejects(runtime.submit(manualInput), {
      code: 'BILLING_TARGET_CONFLICT',
    });
    const foreign = await order(pool, { owner: OTHER.id });
    const foreignInput = await command(pool, foreign);
    await assert.rejects(runtime.submit(foreignInput), { code: 'FORBIDDEN' });
    const adminIntent = await runtime.submit({ ...foreignInput, actor: ADMIN });
    assert.equal(adminIntent.conversationId, foreignInput.conversationId);
    assert.equal(
      (
        await pool.query(
          'SELECT assigned_user_id FROM crm.conversations WHERE id=$1',
          [foreignInput.conversationId],
        )
      ).rows[0].assigned_user_id,
      OTHER.id,
    );
  });

  test('BAPI-06/08: stale revisions, nonhuman/closed targets, pending orders, Financeiro and invalid money have no effects', async () => {
    const id = await order(pool),
      input = await command(pool, id);
    for (const field of [
      'expectedVersion',
      'expectedBillingVersion',
      'expectedConversationVersion',
    ]) {
      await assert.rejects(
        runtime.submit({
          ...input,
          [field]: input[/** @type {'expectedVersion'} */ (field)] + 1,
        }),
        { code: 'VERSION_CONFLICT' },
      );
    }
    await assert.rejects(runtime.submit({ ...input, actor: FINANCE }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      runtime.submit({ ...input, actor: { ...SELLER, kind: 'assistant' } }),
      { code: 'FORBIDDEN' },
    );
    await pool.query(
      "UPDATE crm.conversations SET automation_state='assistant' WHERE id=$1",
      [input.conversationId],
    );
    await assert.rejects(runtime.submit(input), {
      code: 'BILLING_TARGET_CONFLICT',
    });
    await pool.query(
      "UPDATE crm.conversations SET automation_state='human',state='encerrada',closure_outcome='concluido',closed_by='billing-seller',terminal_at=$2 WHERE id=$1",
      [input.conversationId, now],
    );
    await assert.rejects(runtime.submit(input), {
      code: 'BILLING_TARGET_CONFLICT',
    });
    assert.deepEqual(await counts(pool, id), {
      intents: 0,
      charges: 0,
      plans: 0,
      events: 0,
      jobs: 0,
      idem: 0,
      audit: 0,
    });
    const pending = await order(pool, { status: 'pendente' });
    await assert.rejects(runtime.submit(await command(pool, pending)), {
      code: 'ORDER_NOT_CONFIRMED',
    });
    const tiny = await order(pool, { amount: 100 });
    await assert.rejects(
      runtime.submit(await command(pool, tiny, { percent: 50 })),
      { code: 'BILLING_INVALID_AMOUNT', statusCode: 422 },
    );
    assert.equal((await counts(pool, tiny)).charges, 0);
    const noReceipt = await order(pool);
    await assert.rejects(
      runtime.submit(await actionCommand(pool, noReceipt, 'balance')),
      { code: 'BILLING_TARGET_CONFLICT' },
    );
  });

  test('BAPI-08: payment racing a correction conserves receipt and blocks further blind issuance', async () => {
    const id = await order(pool),
      first = await runtime.submit(await command(pool, id));
    await ready(legacy, first);
    now = new Date(NOW.getTime() + 86400001);
    const b = (await legacy.get({ actor: SELLER, orderId: id })).billing;
    await legacy.reconcile({
      actor: SELLER,
      orderId: id,
      expectedVersion: b.orderVersion,
      expectedBillingVersion: b.version,
      decision: 'close_unpaid',
      confirmedProviderReview: true,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const correction = await actionCommand(pool, id, 'correct', {
      chargeId: first.chargeId,
      amountCents: 24000,
      confirmedAgreement: true,
      confirmedProviderReview: true,
    });
    const result = await Promise.allSettled([
      runtime.submit(correction),
      pay(legacy, first),
    ]);
    assert.equal(result[1].status, 'fulfilled');
    const payments = (
      await pool.query(
        'SELECT p.* FROM crm.order_billing_payments p JOIN crm.order_billing_charges c ON c.id=p.charge_id WHERE c.order_id=$1',
        [id],
      )
    ).rows;
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0].principal_amount_cents), 36000);
    assert.equal(payments[0].application_valid, false);
    assert.equal(
      (await pool.query('SELECT paid_on FROM crm.orders WHERE id=$1', [id]))
        .rows[0].paid_on,
      null,
    );
    await assert.rejects(
      runtime.submit(await actionCommand(pool, id, 'balance')),
      { code: 'BILLING_REVIEW_REQUIRED' },
    );
    assert.ok((await counts(pool, id)).charges <= 2);
  });

  test('BAPI-06: commercial mutation under the shared conversation lock wins before a stale admission', async () => {
    const id = await order(pool),
      input = await command(pool, id),
      client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM crm.conversations WHERE id=$1 FOR UPDATE',
        [input.conversationId],
      );
      await client.query(
        'UPDATE crm.orders SET final_amount_cents=final_amount_cents+100,version=version+1 WHERE id=$1',
        [id],
      );
      const submission = runtime.submit(input);
      await client.query('COMMIT');
      await assert.rejects(submission, { code: 'VERSION_CONFLICT' });
      assert.deepEqual(await counts(pool, id), {
        intents: 0,
        charges: 0,
        plans: 0,
        events: 0,
        jobs: 0,
        idem: 0,
        audit: 0,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('BAPI-06/07: admission makes progress beside the existing link-before-identity unmerge lock order', async () => {
    const id = await order(pool),
      sourceOrder = await order(pool);
    const target = (
      await pool.query(
        `SELECT ci.id,ci.current_contact_id FROM crm.orders o JOIN crm.conversations c ON c.id=o.conversation_id JOIN crm.contact_identities ci ON ci.id=c.contact_identity_id WHERE o.id=$1`,
        [id],
      )
    ).rows[0];
    const source = (
      await pool.query('SELECT contact_id FROM crm.orders WHERE id=$1', [
        sourceOrder,
      ])
    ).rows[0].contact_id;
    const linkId = randomUUID();
    await pool.query(
      `INSERT INTO crm.identity_links(id,contact_identity_id,source_contact_id,target_contact_id,merged_by,merge_reason,merge_correlation_id,merge_idempotency_key,merge_fingerprint,merged_at)
      VALUES($1,$2,$3,$4,$5,'synthetic verification',$6,$7,$8,$9)`,
      [
        linkId,
        target.id,
        source,
        target.current_contact_id,
        SELLER.id,
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
        now,
      ],
    );
    const locked = Promise.withResolvers(),
      proceed = Promise.withResolvers();
    const observed = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) =>
        withTransaction(pool, (client) =>
          work({
            query: async (
              /** @type {string} */ sql,
              /** @type {any[]} */ values,
            ) => {
              const result = await client.query(sql, values);
              if (sql.startsWith('SELECT id,current_contact_id')) {
                locked.resolve(undefined);
                await proceed.promise;
              }
              return result;
            },
          }),
        ),
    };
    const isolated = createOrderBillingChatRuntime(observed, options(pool));
    const reverser = await pool.connect();
    try {
      await reverser.query('BEGIN');
      await reverser.query("SET LOCAL lock_timeout='3s'");
      await reverser.query(
        'SELECT id FROM crm.identity_links WHERE id=$1 FOR UPDATE',
        [linkId],
      );
      const input = await command(pool, id);
      const admission = isolated.submit(input);
      await locked.promise;
      const reversal = reverser.query(
        'UPDATE crm.contact_identities SET current_contact_id=$2 WHERE id=$1',
        [target.id, source],
      );
      proceed.resolve(undefined);
      const [intent] = await Promise.all([admission, reversal]);
      assert.equal(intent.state, 'waiting_link');
      assert.equal((await counts(pool, id)).intents, 1);
    } finally {
      proceed.resolve(undefined);
      await reverser.query('ROLLBACK');
      reverser.release();
    }
  });
}
