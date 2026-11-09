import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { loadMigrations, migrate } from '../modules/database/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (connectionString) {
  test('OLIST-T03: expansion preserves already installed outbox types and target contracts', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 3 });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      // The state before the first Olist migration is exactly the master's
      // production schema (upgrade path: master -> Olist, RFC 050 integration).
      const foundation = migrations.find(
        (entry) => entry.name === 'olist_user_authorization',
      );
      assert.ok(foundation);
      await migrate(pool, {
        migrations: migrations.filter(
          (entry) => entry.version < foundation.version,
        ),
      });

      /** Read the installed predicate, including changes from independent features. */
      async function predicates() {
        const { rows } = await pool.query(
          `SELECT conname,pg_get_expr(conbin,conrelid) AS expression
           FROM pg_constraint WHERE conrelid='crm.outbox_jobs'::regclass
             AND conname IN ('outbox_jobs_type_check','outbox_jobs_target_check')`,
        );
        return Object.fromEntries(
          rows.map((row) => [row.conname, row.expression]),
        );
      }

      // Compose only the outbox portion of COB-DEL-01/0055, not the billing
      // feature. Its existing rows carry no channel/media/n8n target.
      // The setup is additive too, so it remains valid if billing joins baseline.
      const original = await predicates();
      await pool.query(`ALTER TABLE crm.outbox_jobs
        DROP CONSTRAINT outbox_jobs_type_check,
        DROP CONSTRAINT outbox_jobs_target_check,
        ADD CONSTRAINT outbox_jobs_type_check CHECK ((${original.outbox_jobs_type_check}) OR job_type='billing.checkout.create'),
        ADD CONSTRAINT outbox_jobs_target_check CHECK ((${original.outbox_jobs_target_check})
          OR (job_type='billing.checkout.create' AND channel_event_id IS NULL
            AND transient_media_id IS NULL AND message_id IS NULL
            AND n8n_command_id IS NULL AND chat_media_id IS NULL AND deletion_reason IS NULL))`);
      const previous = await predicates();

      /** @param {string} id @param {string} jobType @param {string|null} [messageId] */
      const insertJob = (id, jobType, messageId = null) =>
        pool.query(
          `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,message_id,queue,effect_policy,available_at,created_at)
           VALUES($1,$2,$1,$3,
             CASE WHEN $2='chat_media.process' THEN 'chat_media' ELSE 'billing' END,
             CASE WHEN $2='chat_media.process' THEN 'internal' ELSE 'queryable' END,
             now(),now())`,
          [id, jobType, messageId],
        );
      const beforeId = `synthetic-billing-before-${randomUUID()}`;
      await insertJob(beforeId, 'billing.checkout.create');

      await t.test(
        'migration accepts existing billing jobs and preserves both preexisting and new billing inserts',
        async () => {
          const result = await migrate(pool, { migrations });
          // Supplemental source expansion follows the Olist foundation without
          // changing any preexisting outbox row or target predicate.
          assert.deepEqual(
            result.applied,
            migrations
              .filter((entry) => entry.version >= foundation.version)
              .map((entry) => entry.version),
          );
          const before = await pool.query(
            'SELECT job_type,status,olist_export_id FROM crm.outbox_jobs WHERE id=$1',
            [beforeId],
          );
          assert.deepEqual(before.rows, [
            {
              job_type: 'billing.checkout.create',
              status: 'pending',
              olist_export_id: null,
            },
          ]);
          await insertJob(
            `synthetic-billing-after-${randomUUID()}`,
            'billing.checkout.create',
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM crm.outbox_jobs WHERE job_type='billing.checkout.create'",
              )
            ).rows[0].count,
            2,
          );
        },
      );

      await t.test(
        'billing target restrictions and unrecognized job types remain enforced by real CHECK constraints',
        async () => {
          await assert.rejects(
            insertJob(
              randomUUID(),
              'billing.checkout.create',
              'synthetic-forbidden-message',
            ),
            { code: '23514', constraint: 'outbox_jobs_target_check' },
          );
          await assert.rejects(
            insertJob(randomUUID(), 'unapproved.future.operation'),
            { code: '23514' },
          );
          for (const jobType of [
            'channel_event.process',
            'media.delete',
            'channel_message.send',
            'n8n.command.deliver',
            'chat_media.process',
          ])
            await assert.rejects(insertJob(randomUUID(), jobType), {
              code: '23514',
              constraint: 'outbox_jobs_target_check',
            });
        },
      );

      await t.test(
        'the complete installed target predicates are unchanged for previous jobs and Olist requires its exact target/queue/policy',
        async () => {
          const current = await predicates();
          /** Evaluate trusted catalog expressions in PostgreSQL independently of
           * foreign-key fixtures; actual insert rejection is covered above.
           * @param {Record<string,string|null>} values */
          async function evaluate(values) {
            const row = {
              job_type: 'billing.checkout.create',
              channel_event_id: null,
              transient_media_id: null,
              message_id: null,
              n8n_command_id: null,
              chat_media_id: null,
              deletion_reason: null,
              queue: 'default',
              effect_policy: 'internal',
              olist_export_id: null,
              ...values,
            };
            const entries = Object.entries(row);
            const fields = entries
              .map(([name], index) => `$${index + 1}::text AS ${name}`)
              .join(',');
            const { rows } = await pool.query(
              `SELECT (${previous.outbox_jobs_target_check}) AS old_target,
                    (${current.outbox_jobs_target_check}) AS new_target,
                    (${current.outbox_jobs_type_check}) AS accepted_type
             FROM (SELECT ${fields}) AS synthetic_job`,
              entries.map(([, value]) => value),
            );
            return rows[0];
          }
          /** @type {Array<Record<string,string|null>>} */
          const cases = [
            { job_type: 'billing.checkout.create' },
            { job_type: 'billing.checkout.create', message_id: 'unexpected' },
            { job_type: 'n8n.command.deliver', n8n_command_id: randomUUID() },
            {
              job_type: 'n8n.command.deliver',
              n8n_command_id: randomUUID(),
              chat_media_id: randomUUID(),
            },
            {
              job_type: 'media.delete',
              transient_media_id: 'synthetic-media',
              deletion_reason: 'expired',
            },
            {
              job_type: 'media.delete',
              transient_media_id: 'synthetic-media',
              deletion_reason: 'not-approved',
            },
            {
              job_type: 'channel_event.process',
              channel_event_id: 'synthetic-channel-event',
            },
            {
              job_type: 'channel_message.send',
              message_id: 'synthetic-message',
            },
            { job_type: 'chat_media.process', chat_media_id: randomUUID() },
          ];
          for (const values of cases) {
            const result = await evaluate(values);
            assert.equal(
              result.new_target,
              result.old_target,
              JSON.stringify(values),
            );
            assert.equal(result.accepted_type, true);
          }
          const olist = {
            job_type: 'olist.export',
            olist_export_id: randomUUID(),
            queue: 'olist',
            effect_policy: 'queryable',
          };
          assert.equal((await evaluate(olist)).new_target, true);
          assert.equal(
            (await evaluate({ job_type: 'unapproved.future.operation' }))
              .accepted_type,
            false,
          );
          assert.equal(
            (await evaluate({ ...olist, queue: 'default' })).new_target,
            false,
          );
          assert.equal(
            (await evaluate({ ...olist, effect_policy: 'internal' }))
              .new_target,
            false,
          );
          assert.equal(
            (await evaluate({ ...olist, olist_export_id: null })).new_target,
            false,
          );
          assert.equal(
            (await evaluate({ ...olist, message_id: 'unexpected' })).new_target,
            false,
          );
          assert.equal(
            (
              await evaluate({
                job_type: 'billing.checkout.create',
                olist_export_id: randomUUID(),
              })
            ).new_target,
            false,
          );
        },
      );

      await t.test(
        'OLIST-LIVENESS 0071 relaxes one uniqueness rule and installs the invalidation guards over the master upgrade path',
        async () => {
          const unique = (
            await pool.query(
              "SELECT conname FROM pg_constraint WHERE conrelid='crm.olist_exports'::regclass AND contype='u' ORDER BY conname",
            )
          ).rows.map((row) => row.conname);
          // One operation per order is now one ACTIVE operation (partial index);
          // the reference stays unique and the remote ID index is untouched.
          assert.deepEqual(unique, [
            'olist_exports_account_key_reference_key',
            'olist_exports_id_account_key_key',
          ]);
          const indexes = Object.fromEntries(
            (
              await pool.query(
                "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='crm' AND tablename='olist_exports'",
              )
            ).rows.map((row) => [row.indexname, row.indexdef]),
          );
          assert.match(indexes.olist_exports_active_order_key, /UNIQUE/);
          assert.match(
            indexes.olist_exports_active_order_key,
            /\(account_key, order_id\).*state <> 'invalidated'/,
          );
          assert.match(indexes.olist_exports_remote_key, /UNIQUE.*remote_id/);
          const triggers = (
            await pool.query(
              "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('crm.olist_exports'::regclass,'crm.olist_attempts'::regclass,'crm.olist_export_invalidations'::regclass)",
            )
          ).rows.map((row) => row.tgname);
          for (const name of [
            'olist_export_invalidations_append_only',
            'olist_export_invalidations_guard',
            'olist_exports_invalidated_terminal',
            'olist_attempts_no_sale_after_invalidation',
            'olist_exports_snapshot_immutable',
            'olist_sale_evidence_immutable',
            'olist_attempts_durable',
          ])
            assert.ok(triggers.includes(name), name);
        },
      );

      await t.test(
        'the composed migration is applied once without changing preserved jobs on replay',
        async () => {
          assert.deepEqual((await migrate(pool, { migrations })).applied, []);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM crm.outbox_jobs WHERE job_type='billing.checkout.create'",
              )
            ).rows[0].count,
            2,
          );
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
} else {
  test(
    'Olist upgrade compatibility requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
