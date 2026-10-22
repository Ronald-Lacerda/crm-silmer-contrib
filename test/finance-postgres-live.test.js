import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { createFinanceApiRuntime } from '../apps/api/src/finance-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';

// FINQ-T02/T05: real migrations, projection, ACL and transactional commands.
// Every value below is synthetic. This suite destroys its dedicated database.
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-10-22T15:00:00.000Z');
const ENVELOPE_KEY = Buffer.alloc(32, 71);
const FINANCE = { id: 'finance-live', kind: 'human' };
const SELLER = { id: 'seller-live', kind: 'human' };
const ADMIN = { id: 'admin-live', kind: 'human' };

/** @param {Pool} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

/** @param {Pool} pool @param {any} [database] @param {Date} [now] */
function runtimeFor(pool, database = databaseFor(pool), now = NOW) {
  return createFinanceApiRuntime(database, {
    access: {
      authorizeRead: async () => FINANCE,
      authorizeWrite: async () => FINANCE,
    },
    clock: () => now,
    environment: {
      N8N_INTEGRATION_ENVELOPE_KEY: ENVELOPE_KEY.toString('base64'),
      IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 72).toString('base64'),
    },
  });
}

/** @param {Pool} pool @param {string} id @param {'Financeiro'|'Vendedor'} functionName */
async function seedUser(pool, id, functionName) {
  await pool.query(
    `INSERT INTO crm.users (id,email,password_hash,name)
     VALUES ($1,$2,'$argon2id$synthetic',$3)`,
    [id, `${id}@example.test`, `Pessoa ${id}`],
  );
  await pool.query(
    'INSERT INTO crm.user_functions (user_id,function_name) VALUES ($1,$2)',
    [id, functionName],
  );
}

/** @param {Pool} pool @param {any} [options] */
async function seedOrder(pool, options = {}) {
  const id = options.id ?? `finance-order-${randomUUID()}`;
  const store = options.origin === 'loja';
  const conversationId = options.conversation ? `conversation-${id}` : null;
  const contactId = store ? null : `contact-${id}`;
  if (contactId) {
    await pool.query(
      `INSERT INTO crm.contacts (id,created_at,updated_at) VALUES ($1,$2,$2)`,
      [contactId, NOW],
    );
  }
  if (conversationId) {
    const identityId = `identity-${id}`;
    await pool.query(
      `INSERT INTO crm.contact_identities
       (id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,
        identity_kind,phone_status,identity_envelope,created_at,updated_at)
       VALUES ($1,$2,'meta','synthetic-finance','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)`,
      [
        identityId,
        contactId,
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
        JSON.stringify(
          encryptJson({ phone: 'synthetic-contact' }, identityId, ENVELOPE_KEY),
        ),
        NOW,
      ],
    );
    await pool.query(
      `INSERT INTO crm.conversations
       (id,contact_identity_id,provider,provider_account_id,external_conversation_id,
        cycle_number,assigned_user_id,opened_at,last_message_at)
       VALUES ($1,$2,'meta','synthetic-finance',$1,1,$3,$4,$4)`,
      [conversationId, identityId, options.owner ?? SELLER.id, NOW],
    );
  }
  const sequence = Number(
    (await pool.query("SELECT nextval('crm.order_number_seq') AS value"))
      .rows[0].value,
  );
  const ficha = {
    summary: {
      cliente: `Cliente sintético ${id}`,
      data_entrega_confirmada: '2026-11-10',
      cpf: 'private-canary-cpf',
    },
    serviceData: {
      delivery_address: 'private-canary-address',
      phone: 'private-canary-phone',
    },
    items: [
      {
        tipo: 'camiseta',
        cor: 'azul',
        grade: [{ tamanho: 'M', quantidade: 2 }],
        malhas: ['algodao'],
        tipo_servico: 'serigrafia',
        gola: 'redonda',
        publico: 'adulto',
        privateNote: 'private-canary-item',
      },
    ],
    artwork: { url: 'private-canary-artwork' },
  };
  await pool.query(
    `INSERT INTO crm.orders
     (id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
      origin,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,
      order_date,confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at,
      paid_on,is_test,store_number,lead_time_business_days,payment_source,payment_confirmed_at,
      paid_amount_cents,payment_transaction_nsu,payment_invoice_slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'01',$10::jsonb,2,$11,'pix',
       '2026-10-20',$12,$13,'user',$13,$12,$12,$14::date,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      id,
      sequence,
      `${String(sequence).padStart(2, '0')}-CRM`,
      conversationId,
      contactId,
      store || conversationId ? null : (options.owner ?? SELLER.id),
      store || conversationId ? null : `create-${id}`,
      store ? 'loja' : 'atendimento',
      options.status ?? 'confirmado',
      JSON.stringify(encryptJson(ficha, `order-ficha:${id}`, ENVELOPE_KEY)),
      options.amount ?? 10000,
      NOW,
      SELLER.id,
      Object.hasOwn(options, 'paidOn') ? options.paidOn : '2026-10-20',
      options.isTest ?? false,
      store ? 'LJ-A1B2C3D4' : null,
      store ? 10 : null,
      store ? 'infinitepay' : null,
      store ? NOW : null,
      store ? (options.amount ?? 10000) : null,
      store ? `nsu-${id}` : null,
      store ? `invoice-${id}` : null,
    ],
  );
  if (options.reviewRequired) {
    await pool.query(
      'UPDATE crm.orders SET finance_payment_review_required=true WHERE id=$1',
      [id],
    );
  }
  return id;
}

/** @param {Pool} pool @param {string} id @param {any} [overrides] */
async function commandFor(pool, id, overrides = {}) {
  const { rows } = await pool.query(
    `SELECT o.version,coalesce(f.version,0) AS finance_version FROM crm.orders o
     LEFT JOIN crm.order_finance f ON f.order_id=o.id WHERE o.id=$1`,
    [id],
  );
  return {
    action: /** @type {'complete'|'reopen'} */ ('complete'),
    actor: FINANCE,
    orderId: id,
    expectedVersion: Number(rows[0].version),
    expectedFinanceVersion: Number(rows[0].finance_version),
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
    ...overrides,
  };
}

/** @param {Pool} pool @param {string} id */
async function effects(pool, id) {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::integer FROM crm.order_finance WHERE order_id=$1) AS states,
       (SELECT count(*)::integer FROM crm.order_finance_events WHERE order_id=$1) AS events,
       (SELECT count(*)::integer FROM crm.audit_events WHERE target_id=$1 AND action LIKE 'finance.%') AS audits,
       (SELECT count(*)::integer FROM crm.idempotency_records WHERE target_id=$1) AS receipts`,
      [id],
    )
  ).rows[0];
}

if (!connectionString) {
  test(
    'Financeiro PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.equal(
    decodeURIComponent(new URL(connectionString).pathname.slice(1)),
    'crm_silmer_test',
    'Financeiro live tests only reset the dedicated crm_silmer_test database',
  );
  const pool = new Pool({ connectionString, max: 8 });
  const runtime = runtimeFor(pool);
  const legacyId = 'finance-legacy-payment';

  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    const migrations = await loadMigrations();
    await migrate(pool, {
      migrations: migrations.filter((row) => row.version < '0043'),
    });
    await seedUser(pool, SELLER.id, 'Vendedor');
    await seedUser(pool, ADMIN.id, 'Vendedor');
    await seedUser(pool, FINANCE.id, 'Financeiro');
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability,granted_by) VALUES ($1,'COMMERCIAL_ADMIN',$2)",
      [ADMIN.id, SELLER.id],
    );
    await seedOrder(pool, { id: legacyId });
    await migrate(pool, { migrations });
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  test('FINQ-04–07: filters all origins, uses stable pagination and exposes only the financial projection', async () => {
    const manual = await seedOrder(pool, { paidOn: '2026-10-01' });
    const attendance = await seedOrder(pool, {
      conversation: true,
      owner: ADMIN.id,
      paidOn: '2026-10-01',
    });
    const store = await seedOrder(pool, {
      origin: 'loja',
      paidOn: '2026-10-02',
    });
    const excluded = [
      await seedOrder(pool, { status: 'pendente' }),
      await seedOrder(pool, { paidOn: null }),
      await seedOrder(pool, { origin: 'loja', isTest: true }),
      await seedOrder(pool, { reviewRequired: true }),
      legacyId,
    ];
    const page = await runtime.list({ actor: FINANCE, query: { limit: 2 } });
    assert.deepEqual(
      page.items.map((/** @type {any} */ row) => row.id),
      [manual, attendance],
    );
    assert.deepEqual(page.counts, { waiting: 3, completed: 0 });
    assert.ok(page.nextCursor);
    const next = await runtime.list({
      actor: FINANCE,
      query: { limit: 2, cursor: page.nextCursor },
    });
    assert.deepEqual(
      next.items.map((/** @type {any} */ row) => row.id),
      [store],
    );
    assert.equal(next.nextCursor, null);
    const detail = (await runtime.get({ actor: FINANCE, orderId: manual }))
      .order;
    assert.equal(detail.canManage, true);
    assert.equal(detail.ownerName, `Pessoa ${SELLER.id}`);
    assert.deepEqual(
      Object.keys(detail).sort(),
      [
        'id',
        'number',
        'clientName',
        'origin',
        'isManual',
        'ownerName',
        'totalPieces',
        'finalAmountCents',
        'paidOn',
        'deliveryOn',
        'version',
        'financeVersion',
        'completedAt',
        'completedByName',
        'canManage',
        'items',
        'history',
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(detail.items[0]).sort(),
      [
        'tipo',
        'cor',
        'grade',
        'malhas',
        'tipo_servico',
        'gola',
        'publico',
      ].sort(),
    );
    assert.doesNotMatch(
      JSON.stringify({ page, next, detail }),
      /private-canary/u,
    );
    assert.equal(
      (await runtime.get({ actor: FINANCE, orderId: store })).order.ownerName,
      'Loja do site',
    );
    for (const id of excluded) {
      await assert.rejects(runtime.get({ actor: FINANCE, orderId: id }), {
        code: 'FINANCE_ORDER_NOT_FOUND',
      });
    }
    const before = (
      await pool.query('SELECT * FROM crm.orders WHERE id=$1', [manual])
    ).rows[0];
    const completed = await runtime.change(await commandFor(pool, manual));
    assert.equal(completed.order.completedAt, NOW.toISOString());
    assert.equal(completed.order.completedByName, `Pessoa ${FINANCE.id}`);
    const after = (
      await pool.query('SELECT * FROM crm.orders WHERE id=$1', [manual])
    ).rows[0];
    assert.deepEqual(
      after,
      before,
      'financial commands preserve all commercial columns',
    );
    const finished = await runtime.list({
      actor: ADMIN,
      query: { status: 'completed' },
    });
    assert.deepEqual(
      finished.items.map((/** @type {any} */ row) => row.id),
      [manual],
    );
    assert.deepEqual(finished.counts, { waiting: 2, completed: 1 });
    const administrative = (
      await runtime.get({ actor: ADMIN, orderId: manual })
    ).order;
    assert.equal(administrative.canManage, false);
    assert.equal(administrative.history.length, 1);
    // Remove these fixtures from the eligible universe for independent following cases.
    await pool.query(
      'UPDATE crm.orders SET finance_payment_review_required=true WHERE id=ANY($1::text[])',
      [[manual, attendance, store]],
    );
  });

  test('FINQ-03/11/16: live roles reject admin writes, seller access, disabled accounts and stale-role replay', async () => {
    const id = await seedOrder(pool);
    for (const actor of [ADMIN, SELLER]) {
      for (const action of ['complete', 'reopen']) {
        await assert.rejects(
          runtime.change(await commandFor(pool, id, { actor, action })),
          { code: 'FORBIDDEN' },
        );
      }
    }
    await assert.rejects(
      runtime.list({ actor: { ...FINANCE, id: SELLER.id } }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(runtime.get({ actor: SELLER, orderId: id }), {
      code: 'FORBIDDEN',
    });
    await seedUser(pool, 'finance-disabled', 'Financeiro');
    await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
      'finance-disabled',
      NOW,
    ]);
    const disabled = { id: 'finance-disabled' };
    await assert.rejects(runtime.list({ actor: disabled }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(runtime.get({ actor: disabled, orderId: id }), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      runtime.change(await commandFor(pool, id, { actor: disabled })),
      { code: 'FORBIDDEN' },
    );
    await seedUser(pool, 'finance-demoted', 'Financeiro');
    const command = await commandFor(pool, id, {
      actor: { id: 'finance-demoted' },
    });
    await runtime.change(command);
    await pool.query(
      "UPDATE crm.user_functions SET function_name='Vendedor' WHERE user_id='finance-demoted'",
    );
    await assert.rejects(runtime.change(command), { code: 'FORBIDDEN' });
    assert.deepEqual(await effects(pool, id), {
      states: 1,
      events: 1,
      audits: 1,
      receipts: 1,
    });
  });

  test('FINQ-08–11: concurrent distinct commands have one winner; same-key replay has one effect and one transaction', async () => {
    const id = await seedOrder(pool);
    const first = await commandFor(pool, id);
    const outcomes = await Promise.allSettled([
      runtime.change(first),
      runtime.change({ ...first, idempotencyKey: randomUUID() }),
    ]);
    assert.equal(
      outcomes.filter((row) => row.status === 'fulfilled').length,
      1,
    );
    const rejected = outcomes.find((row) => row.status === 'rejected');
    assert.equal(
      rejected?.status === 'rejected' && rejected.reason.code,
      'VERSION_CONFLICT',
    );
    assert.deepEqual(await effects(pool, id), {
      states: 1,
      events: 1,
      audits: 1,
      receipts: 1,
    });
    const another = await seedOrder(pool);
    const replay = await commandFor(pool, another);
    const [left, right] = await Promise.all([
      runtime.change(replay),
      runtime.change(replay),
    ]);
    assert.deepEqual(left, right);
    assert.deepEqual(await effects(pool, another), {
      states: 1,
      events: 1,
      audits: 1,
      receipts: 1,
    });
    const transactions = (
      await pool.query(
        `SELECT xmin::text AS xid FROM crm.order_finance WHERE order_id=$1
       UNION ALL SELECT xmin::text FROM crm.order_finance_events WHERE order_id=$1
       UNION ALL SELECT xmin::text FROM crm.audit_events WHERE target_id=$1 AND action='finance.complete'
       UNION ALL SELECT xmin::text FROM crm.idempotency_records WHERE target_id=$1`,
        [another],
      )
    ).rows;
    assert.equal(transactions.length, 4);
    assert.equal(new Set(transactions.map((row) => row.xid)).size, 1);
    await assert.rejects(
      runtime.change({ ...replay, expectedFinanceVersion: 1 }),
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    await assert.rejects(
      runtime.change(
        await commandFor(pool, another, {
          action: 'reopen',
          expectedVersion: 999,
        }),
      ),
      { code: 'VERSION_CONFLICT' },
    );
    const reopened = await runtime.change(
      await commandFor(pool, another, { action: 'reopen' }),
    );
    assert.equal(reopened.order.completedAt, null);
    assert.equal(reopened.order.financeVersion, 2);
    assert.deepEqual(
      reopened.order.history.map((/** @type {any} */ row) => row.action),
      ['reopened', 'completed'],
    );
  });

  test('FINQ-06: completed pagination follows most recent completion and the order number tie-breaker', async () => {
    const older = await seedOrder(pool);
    const newer = await seedOrder(pool);
    const tied = await seedOrder(pool);
    const earlierRuntime = runtimeFor(
      pool,
      databaseFor(pool),
      new Date('2026-10-23T15:00:00.000Z'),
    );
    const laterRuntime = runtimeFor(
      pool,
      databaseFor(pool),
      new Date('2026-10-24T15:00:00.000Z'),
    );
    await earlierRuntime.change(await commandFor(pool, older));
    await laterRuntime.change(await commandFor(pool, newer));
    await laterRuntime.change(await commandFor(pool, tied));
    const first = await runtime.list({
      actor: FINANCE,
      query: { status: 'completed', limit: 1 },
    });
    assert.equal(first.items[0].id, newer);
    const second = await runtime.list({
      actor: FINANCE,
      query: { status: 'completed', limit: 1, cursor: first.nextCursor },
    });
    assert.equal(second.items[0].id, tied);
    const third = await runtime.list({
      actor: FINANCE,
      query: { status: 'completed', limit: 1, cursor: second.nextCursor },
    });
    assert.equal(third.items[0].id, older);
  });

  test('FINQ-11: an audit failure rolls back state, history and the idempotency reservation', async () => {
    const id = await seedOrder(pool);
    const command = await commandFor(pool, id, {
      correlationId: 'finance-rollback',
    });
    await pool.query(`CREATE FUNCTION crm.finance_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.correlation_id='finance-rollback' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER finance_test_audit_failure BEFORE INSERT ON crm.audit_events
      FOR EACH ROW EXECUTE FUNCTION crm.finance_test_reject_audit()`);
    try {
      await assert.rejects(runtime.change(command), /synthetic audit failure/u);
      assert.deepEqual(await effects(pool, id), {
        states: 0,
        events: 0,
        audits: 0,
        receipts: 0,
      });
    } finally {
      await pool.query(
        'DROP TRIGGER finance_test_audit_failure ON crm.audit_events',
      );
      await pool.query('DROP FUNCTION crm.finance_test_reject_audit()');
    }
    const result = await runtime.change(command);
    assert.equal(result.order.financeVersion, 1);
  });

  test('FINQ-04: migration preserves legacy dates while requiring an explicit settlement review', async () => {
    const legacy = (
      await pool.query(
        'SELECT paid_on::text,finance_payment_review_required FROM crm.orders WHERE id=$1',
        [legacyId],
      )
    ).rows[0];
    assert.deepEqual(legacy, {
      paid_on: '2026-10-20',
      finance_payment_review_required: true,
    });
    await assert.rejects(runtime.change(await commandFor(pool, legacyId)), {
      code: 'FINANCE_ORDER_NOT_FOUND',
    });
    const repository = new PostgresOrderRepository({
      database: databaseFor(pool),
      envelopeKey: ENVELOPE_KEY,
    });
    const order = await repository.findById(legacyId);
    assert.ok(order);
    const options = {
      actor: { id: SELLER.id, kind: /** @type {const} */ ('human') },
      correlationId: 'finance-legacy-review',
      expectedVersion: order.version,
    };
    // Saving a delivery/date change without explicitly reviewing payment must not clear the flag.
    const unreviewed = await repository.saveMilestones(
      { ...order, deliveredOn: '2026-10-22' },
      options,
    );
    assert.equal(unreviewed.paymentReviewRequired, true);
    await assert.rejects(runtime.get({ actor: FINANCE, orderId: legacyId }), {
      code: 'FINANCE_ORDER_NOT_FOUND',
    });
    const reviewed = await repository.saveMilestones(
      { ...unreviewed, paidOn: '2026-10-20' },
      {
        ...options,
        expectedVersion: unreviewed.version,
        paymentReviewed: true,
      },
    );
    assert.equal(reviewed.paymentReviewRequired, false);
    assert.equal(
      (await runtime.get({ actor: FINANCE, orderId: legacyId })).order.paidOn,
      '2026-10-20',
    );
  });

  test('FINQ-06/11: reconfirming another amount requires fresh payment and a fresh check, preserving history', async () => {
    const id = await seedOrder(pool);
    await runtime.change(await commandFor(pool, id));
    await pool.query(
      "UPDATE crm.orders SET status='pendente',version=version+1 WHERE id=$1",
      [id],
    );
    await assert.rejects(runtime.get({ actor: FINANCE, orderId: id }), {
      code: 'FINANCE_ORDER_NOT_FOUND',
    });
    await pool.query(
      `UPDATE crm.orders SET status='confirmado', final_amount_cents=15000,
      version=version+1,updated_at=$2 WHERE id=$1`,
      [id, NOW],
    );
    const state = (
      await pool.query(
        `SELECT o.paid_on,f.completed_at,f.version FROM crm.orders o
      JOIN crm.order_finance f ON f.order_id=o.id WHERE o.id=$1`,
        [id],
      )
    ).rows[0];
    assert.equal(state.paid_on, null);
    assert.equal(state.completed_at, null);
    assert.equal(Number(state.version), 2);
    await assert.rejects(runtime.change(await commandFor(pool, id)), {
      code: 'FINANCE_ORDER_NOT_FOUND',
    });
    const repository = new PostgresOrderRepository({
      database: databaseFor(pool),
      envelopeKey: ENVELOPE_KEY,
    });
    const order = await repository.findById(id);
    assert.ok(order);
    await repository.saveMilestones(
      { ...order, paidOn: '2026-10-22' },
      {
        actor: { id: SELLER.id, kind: 'human' },
        correlationId: 'finance-fresh-payment',
        expectedVersion: order.version,
        paymentReviewed: true,
      },
    );
    const returned = (await runtime.get({ actor: FINANCE, orderId: id })).order;
    assert.equal(returned.completedAt, null);
    assert.equal(returned.finalAmountCents, 15000);
    const result = await runtime.change(await commandFor(pool, id));
    assert.equal(result.order.financeVersion, 3);
    assert.deepEqual(
      result.order.history.map((/** @type {any} */ row) => row.action),
      ['completed', 'invalidated', 'completed'],
    );
    assert.equal(result.order.history[1].actorName, 'Sistema');
    assert.deepEqual(await effects(pool, id), {
      states: 1,
      events: 3,
      audits: 3,
      receipts: 2,
    });
  });

  test('FINQ-05/10: store amount corrections preserve gateway settlement but invalidate the financial check', async () => {
    const id = await seedOrder(pool, { origin: 'loja' });
    await runtime.change(await commandFor(pool, id));
    await pool.query(
      'UPDATE crm.orders SET final_amount_cents=9000,version=version+1 WHERE id=$1',
      [id],
    );
    const detail = (await runtime.get({ actor: FINANCE, orderId: id })).order;
    assert.equal(detail.paidOn, '2026-10-20');
    assert.equal(detail.completedAt, null);
    assert.equal(detail.financeVersion, 2);
    await runtime.change(await commandFor(pool, id));
    assert.equal(
      (
        await pool.query(
          'SELECT paid_amount_cents FROM crm.orders WHERE id=$1',
          [id],
        )
      ).rows[0].paid_amount_cents,
      '10000',
    );
  });

  test('FINQ-11: a competing commercial payment removal blocks a stale financial command', async () => {
    const id = await seedOrder(pool);
    const command = await commandFor(pool, id);
    const commercial = await pool.connect();
    await commercial.query('BEGIN');
    try {
      await commercial.query(
        'UPDATE crm.orders SET paid_on=NULL,version=version+1 WHERE id=$1',
        [id],
      );
      // Observe the real runtime reaching its lock while the commercial writer holds it.
      /** @type {() => void} */
      let signalLock = () => {};
      const reachedLock = new Promise((resolve) => {
        signalLock = () => resolve(undefined);
      });
      const observed = runtimeFor(pool, {
        query: pool.query.bind(pool),
        transaction: (/** @type {any} */ work) =>
          withTransaction(pool, (client) =>
            work({
              query: (
                /** @type {string} */ sql,
                /** @type {unknown[]} */ values,
              ) => {
                if (
                  sql.includes('SELECT id FROM crm.orders') &&
                  sql.includes('FOR UPDATE')
                )
                  signalLock();
                return client.query(sql, values);
              },
            }),
          ),
      });
      const pending = observed.change(command).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await reachedLock;
      await commercial.query('COMMIT');
      const outcome = await pending;
      assert.ok('error' in outcome);
      assert.equal(outcome.error.code, 'FINANCE_ORDER_NOT_FOUND');
      assert.deepEqual(await effects(pool, id), {
        states: 0,
        events: 0,
        audits: 0,
        receipts: 0,
      });
    } finally {
      await commercial.query('ROLLBACK');
      commercial.release();
    }
  });

  test('FINQ-01/09: historical authors cannot be deleted after undo; financial events are immutable', async () => {
    const actor = { id: 'finance-history-author' };
    await seedUser(pool, actor.id, 'Financeiro');
    const id = await seedOrder(pool);
    await runtime.change(await commandFor(pool, id, { actor }));
    await runtime.change(
      await commandFor(pool, id, { actor, action: 'reopen' }),
    );
    const state = (
      await pool.query(
        'SELECT completed_by FROM crm.order_finance WHERE order_id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(state.completed_by, null);
    assert.equal(
      (
        await pool.query(
          'SELECT crm.identity_has_finance_history($1) AS retained',
          [actor.id],
        )
      ).rows[0].retained,
      true,
    );
    await assert.rejects(
      pool.query('DELETE FROM crm.users WHERE id=$1', [actor.id]),
      { code: '23503' },
    );
    await assert.rejects(
      pool.query(
        "UPDATE crm.order_finance_events SET reason='rewritten' WHERE order_id=$1",
        [id],
      ),
    );
    await assert.rejects(
      pool.query('DELETE FROM crm.order_finance_events WHERE order_id=$1', [
        id,
      ]),
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS count FROM crm.order_finance_events WHERE order_id=$1',
          [id],
        )
      ).rows[0].count,
      2,
    );
  });
}
