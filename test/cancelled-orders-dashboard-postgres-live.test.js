import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import {
  createDashboardRuntime,
  readDashboardPerformance,
} from '../apps/api/src/dashboard-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { formatOrderNumber } from '../modules/orders/src/domain/order.js';

const connectionString = process.env.TEST_DATABASE_URL;
const ORDER_KEY = Buffer.alloc(32, 141);
const IDEMPOTENCY_KEY = Buffer.alloc(32, 142);
/** São Paulo wall clock (UTC-03:00). Thursday 05/11/2026 15:00. */
const NOW = new Date('2026-11-05T15:00:00-03:00');
const DAY = '2026-11-05';

test(
  'OLIST-19/45 PostgreSQL: a cancelled order leaves sales, the performance panel and the action queue, but stays readable by id',
  { skip: !connectionString },
  async (t) => {
    assert.match(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      /^crm_silmer_test(?:_[a-z0-9]+)?$/u,
    );
    const pool = new Pool({ connectionString, max: 4 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });

    const runId = randomUUID().slice(0, 8);
    /** @param {string} label @param {string} functionName @param {string[]} [capabilities] */
    async function user(label, functionName, capabilities = []) {
      const actor = {
        id: `${label}-cdash-${runId}`,
        kind: /** @type {const} */ ('human'),
        functionName,
        capabilities,
      };
      await pool.query(
        `INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,$2,'$argon2id$synthetic',$3)`,
        [actor.id, `${actor.id}@example.test`, `Pessoa ${label}`],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [actor.id, functionName],
      );
      for (const capability of capabilities)
        await pool.query(
          'INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,$2)',
          [actor.id, capability],
        );
      return actor;
    }
    const seller = await user('seller', 'Vendedor');
    const admin = await user('admin', 'Vendedor', ['COMMERCIAL_ADMIN']);

    const contactId = `contact-cdash-${runId}`;
    await pool.query(
      `INSERT INTO crm.contacts(id,provisional,display_name,display_name_source,created_at,updated_at)
       VALUES($1,false,'Contato Sintético','manual',$2,$2)`,
      [contactId, NOW],
    );

    /** A manual atendimento order owned by the seller (no conversation).
     * @param {{confirmed:boolean,amount?:number,paid?:boolean}} options */
    async function order(options) {
      const id = `order-cdash-${randomUUID()}`;
      const seq = Number(
        (await pool.query(`SELECT nextval('crm.order_number_seq') AS n`))
          .rows[0].n,
      );
      const ficha = {
        summary: {
          cliente: 'Contato Sintético',
          data_entrega_confirmada: '2026-11-20',
        },
        items: [],
        artwork: {},
      };
      await pool.query(
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
           status,fab_code,ficha_envelope,total_pieces,missing_fields,final_amount_cents,payment_condition,order_date,
           confirmed_at,confirmed_by,paid_on,created_by_kind,created_by,created_at,updated_at,origin,is_test)
         VALUES($1,$2,$3,NULL,$4,$5,$6,$7,'01',$8::jsonb,20,'{}',$9,$10,$11,$12,$13,$14,'user',$15,$16,$16,'atendimento',false)`,
        [
          id,
          seq,
          formatOrderNumber(seq),
          contactId,
          seller.id,
          `create-${id}`,
          options.confirmed ? 'confirmado' : 'pendente',
          JSON.stringify(encryptJson(ficha, `order-ficha:${id}`, ORDER_KEY)),
          options.confirmed ? (options.amount ?? 100000) : null,
          options.confirmed ? 'pix' : null,
          options.confirmed ? DAY : null,
          options.confirmed ? NOW : null,
          options.confirmed ? admin.id : null,
          options.paid ? DAY : null,
          seller.id,
          NOW,
        ],
      );
      return id;
    }
    /** Local cancellation exactly as the order repository writes it.
     * @param {string} id */
    async function cancel(id) {
      await pool.query(
        `UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,
           version=version+1,updated_at=$2 WHERE id=$1`,
        [
          id,
          NOW,
          admin.id,
          JSON.stringify(
            encryptJson(
              'Duplicidade sintética',
              `order-cancellation:${id}`,
              ORDER_KEY,
            ),
          ),
        ],
      );
    }
    /** @param {string} id */
    const version = async (id) =>
      Number(
        (await pool.query('SELECT version FROM crm.orders WHERE id=$1', [id]))
          .rows[0].version,
      );

    const dashboard = createDashboardRuntime(database, {
      access: {},
      orderEnvelopeKey: ORDER_KEY,
      idempotencyEnvelopeKey: IDEMPOTENCY_KEY,
      clock: () => NOW,
    });
    /** @param {any} actor */
    const actionIds = async (actor) =>
      (await dashboard.actions({ actor })).items.map(
        (/** @type {any} */ item) => item.id,
      );
    const performance = () =>
      readDashboardPerformance(database, { from: DAY, to: DAY, manager: true });

    // Active sales and chores: one confirmed unpaid, one pending, one sale
    // that will be cancelled, one pending that will be cancelled, one confirmed
    // unpaid that will be cancelled.
    const activeSale = await order({ confirmed: true, amount: 50000 });
    const activePending = await order({ confirmed: false });
    const soldThenCancelled = await order({ confirmed: true, amount: 70000 });
    const pendingThenCancelled = await order({ confirmed: false });
    const choreThenCancelled = await order({ confirmed: true, amount: 30000 });

    // Before cancellation everything counts and is an action.
    let report = await performance();
    assert.equal(report.totals.soldAmountCents, 150000);
    assert.equal(report.totals.confirmedCount, 3);
    assert.deepEqual(
      new Set(await actionIds(seller)),
      new Set(
        [
          activeSale,
          activePending,
          soldThenCancelled,
          pendingThenCancelled,
          choreThenCancelled,
        ].map((id) => `order:${id}`),
      ),
    );
    // A control: the live order accepts a snooze decision.
    const sellerRow = (/** @type {string} */ id) =>
      /** @type {Promise<any>} */ (
        version(id).then((expectedVersion) => ({
          actor: seller,
          actionId: `order:${id}`,
          decision: 'snooze',
          expectedVersion,
          sourceRevision: `order:${expectedVersion}`,
          expectedDecisionVersion: 0,
          remindAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
          idempotencyKey: `snooze-${randomUUID()}`,
          correlationId: `correlation-${runId}`,
        }))
      );
    assert.equal(
      (await dashboard.decide(await sellerRow(activePending))).decision,
      'snooze',
    );

    for (const id of [
      soldThenCancelled,
      pendingThenCancelled,
      choreThenCancelled,
    ])
      await cancel(id);

    // The cancelled sales leave revenue, count and attribution in every cut.
    report = await performance();
    assert.equal(report.totals.soldAmountCents, 50000);
    assert.equal(report.totals.confirmedCount, 1);
    assert.equal(report.unattributed.confirmedCount, 0);
    const sellerRowReport = report.rows.find(
      (/** @type {any} */ row) => row.userId === seller.id,
    );
    assert.equal(sellerRowReport.soldAmountCents, 50000);
    assert.equal(sellerRowReport.confirmedCount, 1);
    assert.equal(sellerRowReport.averageTicketCents, 50000);
    const selfReport = await readDashboardPerformance(database, {
      from: DAY,
      to: DAY,
      actorId: seller.id,
    });
    assert.equal(selfReport.totals.soldAmountCents, 50000);
    assert.equal(selfReport.totals.confirmedCount, 1);
    const viaRuntime = await dashboard.performance({ actor: admin, days: 7 });
    assert.equal(viaRuntime.totals.soldAmountCents, 50000);
    assert.equal(viaRuntime.totals.confirmedCount, 1);

    // The cancelled orders generate no chore; the live ones still do.
    assert.deepEqual(
      new Set(await actionIds(seller)),
      new Set([`order:${activeSale}`, `order:${activePending}`]),
    );

    // Deciding on a cancelled order is refused (409) and leaves no trace,
    // even with the current version.
    for (const id of [pendingThenCancelled, choreThenCancelled]) {
      await assert.rejects(dashboard.decide(await sellerRow(id)), {
        statusCode: 409,
        code: 'ACTION_NOT_AVAILABLE',
      });
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) AS n FROM crm.dashboard_action_decisions WHERE action_id=$1',
              [`order:${id}`],
            )
          ).rows[0].n,
        ),
        0,
      );
    }
    // The live order still accepts the decision.
    const snoozed = await dashboard.decide({
      ...(await sellerRow(activeSale)),
    });
    assert.equal(snoozed.decision, 'snooze');

    // History stays readable by id: the status is preserved, the marker and
    // reason are decryptable, and the row is untouched by the panel.
    const orders = new PostgresOrderRepository({
      database,
      envelopeKey: ORDER_KEY,
    });
    for (const [id, status] of /** @type {Array<[string,string]>} */ ([
      [soldThenCancelled, 'confirmado'],
      [pendingThenCancelled, 'pendente'],
      [choreThenCancelled, 'confirmado'],
    ])) {
      const found = await orders.findById(id);
      assert.equal(found?.status, status);
      assert.ok(found?.cancelledAt);
      assert.equal(found?.cancelledBy, admin.id);
      assert.equal(found?.cancellationReason, 'Duplicidade sintética');
    }
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT final_amount_cents FROM crm.orders WHERE id=$1',
            [soldThenCancelled],
          )
        ).rows[0].final_amount_cents,
      ),
      70000,
    );
  },
);
