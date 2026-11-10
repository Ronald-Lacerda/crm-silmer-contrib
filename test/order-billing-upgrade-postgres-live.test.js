import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { loadMigrations, migrate } from '../modules/database/src/index.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import {
  seed,
  KEY,
  SELLER,
  NOW,
} from './support/order-billing-chat-fixture.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test(
    'Billing release upgrade requires dedicated TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(new URL(url).pathname, /^\/crm_silmer_test(?:_[a-z0-9_]+)?$/u);
  test('COB-REL-01: upgrading the complete master schema preserves Olist jobs and composes the billing payment-check target', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      const master = migrations.filter(
        (migration) => migration.version <= '0072',
      );
      await migrate(pool, { migrations: master });
      const history = (
        await pool.query(
          'SELECT version,name,phase,checksum FROM crm_meta.schema_migrations ORDER BY version',
        )
      ).rows;
      await pool.query(
        "INSERT INTO crm.users(id,email,password_hash,name) VALUES($1,'billing-upgrade@example.test','$argon2id$synthetic','Synthetic upgrade')",
        [SELLER.id],
      );
      const orderId = await seed(pool);
      const accountKey = 'a'.repeat(64),
        contextKey = 'b'.repeat(64),
        exportId = randomUUID();
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key) VALUES($1)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_connections(context_key,account_key) VALUES($1,$2)',
        [contextKey, accountKey],
      );
      await pool.query(
        `INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope)
         VALUES($1,$2,$3,0,$4,1,0,$5,0,'CRM-synthetic-billing-upgrade',$6::jsonb)`,
        [
          exportId,
          accountKey,
          contextKey,
          orderId,
          SELLER.id,
          JSON.stringify(
            encryptJson({ synthetic: true }, 'synthetic-upgrade', KEY),
          ),
        ],
      );
      const exportJob = randomUUID(),
        readJob = randomUUID();
      /** @param {string} id @param {string} type @param {string} queue @param {string} policy @param {string|null} target */
      const job = (id, type, queue, policy, target) =>
        pool.query(
          `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,olist_export_id,status,priority,available_at,created_at,queue,attempt_count,max_attempts,updated_at,effect_policy)
         VALUES($1,$2,$1,$3,'pending',100,$4,$4,$5,0,3,$4,$6)`,
          [id, type, target, NOW, queue, policy],
        );
      await job(exportJob, 'olist.export', 'olist', 'queryable', exportId);
      await job(
        readJob,
        'olist.reconcile',
        'olist_reconcile',
        'internal',
        exportId,
      );
      const upgraded = await migrate(pool, { migrations });
      assert.deepEqual(upgraded.applied, ['0073', '0074', '0075']);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT version,name,phase,checksum FROM crm_meta.schema_migrations WHERE version<='0072' ORDER BY version",
          )
        ).rows,
        history,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,job_type,olist_export_id,queue,effect_policy FROM crm.outbox_jobs WHERE id=ANY($1::text[]) ORDER BY job_type',
            [[exportJob, readJob]],
          )
        ).rows,
        [
          {
            id: exportJob,
            job_type: 'olist.export',
            olist_export_id: exportId,
            queue: 'olist',
            effect_policy: 'queryable',
          },
          {
            id: readJob,
            job_type: 'olist.reconcile',
            olist_export_id: exportId,
            queue: 'olist_reconcile',
            effect_policy: 'internal',
          },
        ],
      );
      const checkJob = randomUUID();
      await job(
        checkJob,
        'billing.payment.check',
        'billing',
        'queryable',
        null,
      );
      assert.equal(
        (
          await pool.query('SELECT job_type FROM crm.outbox_jobs WHERE id=$1', [
            checkJob,
          ])
        ).rows[0].job_type,
        'billing.payment.check',
      );
      await assert.rejects(
        job(
          randomUUID(),
          'billing.payment.check',
          'billing',
          'queryable',
          exportId,
        ),
        { code: '23514' },
      );
      await assert.rejects(
        job(randomUUID(), 'billing.payment.check', 'olist', 'queryable', null),
        { code: '23514' },
      );
      await assert.rejects(
        job(randomUUID(), 'olist.reconcile', 'billing', 'internal', exportId),
        { code: '23514' },
      );
      assert.deepEqual((await migrate(pool, { migrations })).applied, []);
    } finally {
      await pool.end();
    }
  });
}
