import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresOperationalSignals } from '../modules/database/src/operational-signals.js';

const connectionString = process.env.TEST_DATABASE_URL;
const queues = ['external_effects', 'media-retention', 'chat_media'];
const envelope = { algorithm: 'AES-256-GCM', keyVersion: 1, version: 1 };

/** @param {Pool} pool @param {number} delaySeconds @param {string} [status] */
async function seedJob(pool, delaySeconds, status = 'pending') {
  const suffix = randomUUID();
  const fingerprint = createHash('sha256').update(suffix).digest('hex');
  await pool.query(
    `INSERT INTO crm.webhook_receipts
      (id,provider,payload_sha256,payload_envelope,key_version,received_at,expires_at,correlation_id)
     VALUES ($1,'meta',$2,$3,1,now()-interval '1 hour',now()+interval '1 hour',$1)`,
    [`receipt-${suffix}`, fingerprint, envelope],
  );
  await pool.query(
    `INSERT INTO crm.channel_events
      (id,webhook_receipt_id,provider,channel,provider_account_id,external_event_id,
       external_message_id,message_type,occurred_at,fingerprint,event_envelope,
       event_key_version,received_at,disposition,processing_status,correlation_id)
     VALUES ($1,$2,'meta','whatsapp','synthetic-account',$1,$1,'text',now(),$3,$4,1,
       now(),'process','pending',$1)`,
    [`event-${suffix}`, `receipt-${suffix}`, fingerprint, envelope],
  );
  const id = `job-${suffix}`;
  await pool.query(
    `INSERT INTO crm.outbox_jobs
      (id,job_type,idempotency_key,channel_event_id,status,priority,queue,
       available_at,created_at,updated_at,completed_at)
     VALUES ($1,'channel_event.process',$1,$2,$3,100,'external_effects',
       now()-($4::float8*interval '1 second'),now()-interval '1 hour',now(),
       CASE WHEN $3 IN ('completed','dead_letter') THEN now() ELSE NULL END)`,
    [id, `event-${suffix}`, status, delaySeconds],
  );
  return id;
}

/** @param {Pool} pool */
async function seedCommand(pool) {
  await pool.query(`INSERT INTO crm.contacts(id,provisional,version,created_at,updated_at)
    VALUES ('health-contact',false,1,now(),now())`);
  await pool.query(
    `INSERT INTO crm.contact_identities
      (id,current_contact_id,provider,provider_account_id,channel,
       external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,
       key_version,version,created_at,updated_at)
     VALUES ('health-identity','health-contact','meta','synthetic-account','instagram',
       $1,'handle','pending',$2,1,1,now(),now())`,
    ['c'.repeat(64), envelope],
  );
  await pool.query(`INSERT INTO crm.conversations
    (id,contact_identity_id,provider,provider_account_id,external_conversation_id,
     cycle_number,state,automation_state,automation_epoch,version,opened_at,last_message_at)
    VALUES ('health-conversation','health-identity','meta','synthetic-account',
      'health-external',1,'nova','human',0,1,now(),now())`);
  await pool.query(
    `INSERT INTO crm.n8n_commands
      (command_id,conversation_id,action,actor_id,actor_kind,automation_epoch,
       fingerprint,payload_envelope,status,locked_by,locked_until,created_at,updated_at)
     VALUES ('health-command','health-conversation','take_over','synthetic-human','human',
       0,$1,$2,'processing','synthetic-attempt',now()+interval '1 minute',now(),now())`,
    ['d'.repeat(64), envelope],
  );
}

test(
  'OPSH-01/03 live: durable per-queue progress, actual queue age, stuck commands and indexed bounded queries',
  { skip: !connectionString },
  async (t) => {
    assert.equal(
      new URL(/** @type {string} */ (connectionString)).pathname,
      '/crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 4 });
    /** @type {{sql: string, values?: unknown[]}[]} */
    const selects = [];
    const signals = new PostgresOperationalSignals({
      database: {
        transaction: (/** @type {Function} */ work) =>
          withTransaction(pool, (client) =>
            work({
              query: (
                /** @type {string} */ sql,
                /** @type {unknown[]} */ values,
              ) => {
                if (sql.startsWith('SELECT')) selects.push({ sql, values });
                return client.query(sql, values);
              },
            }),
          ),
      },
    });
    const publishAll = () =>
      Promise.all(
        queues.map((queue) =>
          signals.publish({ queue, pollCompletedAt: new Date() }),
        ),
      );
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      await t.test(
        'all required queues must publish a recent heartbeat and completed poll',
        async () => {
          assert.deepEqual(await signals.sample(queues), {
            worker: false,
            queue: true,
            commands: true,
          });
          const results = await publishAll();
          for (const result of results) {
            assert.ok(result.heartbeat > Date.now() / 1000 - 10);
            assert.equal(result.age, 0);
          }
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS total FROM crm.operational_worker_health WHERE poll_completed_at IS NOT NULL',
              )
            ).rows[0].total,
            3,
          );
          assert.deepEqual(await signals.sample(queues), {
            worker: true,
            queue: true,
            commands: true,
          });
          await signals.publish({ queue: queues[0], pollCompletedAt: null });
          assert.equal((await signals.sample(queues)).worker, false);
          await publishAll();
          await pool.query(
            "UPDATE crm.operational_worker_health SET poll_completed_at=now()-interval '121 seconds' WHERE queue=$1",
            [queues[1]],
          );
          assert.equal((await signals.sample(queues)).worker, false);
          await publishAll();
          await pool.query(
            "UPDATE crm.operational_worker_health SET heartbeat_at=now()-interval '121 seconds' WHERE queue=$1",
            [queues[2]],
          );
          assert.equal((await signals.sample(queues)).worker, false);
          await publishAll();
        },
      );

      await t.test(
        'queue age is measured without failures and excludes future retries and terminal jobs',
        async () => {
          await seedJob(pool, -600, 'retry');
          await seedJob(pool, 600, 'completed');
          await seedJob(pool, 600, 'dead_letter');
          assert.equal((await signals.sample(queues)).queue, true);
          assert.equal(
            (
              await signals.publish({
                queue: queues[0],
                pollCompletedAt: new Date(),
              })
            ).age,
            0,
          );
          const pending = await seedJob(pool, 290);
          let measured = await signals.publish({
            queue: queues[0],
            pollCompletedAt: new Date(),
          });
          assert.ok(
            measured.age >= 290 && measured.age < 300,
            String(measured.age),
          );
          assert.equal((await signals.sample(queues)).queue, true);
          await pool.query(
            "UPDATE crm.outbox_jobs SET available_at=now()-interval '301 seconds' WHERE id=$1",
            [pending],
          );
          assert.equal((await signals.sample(queues)).queue, false);
          await pool.query(
            "UPDATE crm.outbox_jobs SET status='retry' WHERE id=$1",
            [pending],
          );
          measured = await signals.publish({
            queue: queues[0],
            pollCompletedAt: new Date(),
          });
          assert.ok(measured.age >= 301, String(measured.age));
          assert.equal((await signals.sample(queues)).queue, false);
          await pool.query('DELETE FROM crm.outbox_jobs WHERE id=$1', [
            pending,
          ]);
          assert.equal((await signals.sample(queues)).queue, true);
        },
      );

      await t.test(
        'processing commands tolerate transient expiry and degrade beyond the grace period',
        async () => {
          await seedCommand(pool);
          assert.equal((await signals.sample(queues)).commands, true);
          await pool.query(
            "UPDATE crm.n8n_commands SET locked_until=now()-interval '110 seconds' WHERE command_id='health-command'",
          );
          assert.equal((await signals.sample(queues)).commands, true);
          await pool.query(
            "UPDATE crm.n8n_commands SET locked_until=now()-interval '121 seconds' WHERE command_id='health-command'",
          );
          assert.equal((await signals.sample(queues)).commands, false);
        },
      );

      await t.test(
        'actual signal queries use the operational indexes',
        async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SET LOCAL enable_seqscan = off');
            const sample = selects.find(({ sql }) => sql.includes('worker_ok'));
            const age = selects.find(({ sql }) => sql.includes('AS age'));
            assert.ok(sample);
            assert.ok(age);
            const samplePlan = JSON.stringify(
              (
                await client.query(
                  `EXPLAIN (FORMAT JSON) ${sample.sql}`,
                  sample.values,
                )
              ).rows,
            );
            const agePlan = JSON.stringify(
              (
                await client.query(
                  `EXPLAIN (FORMAT JSON) ${age.sql}`,
                  age.values,
                )
              ).rows,
            );
            assert.match(samplePlan, /outbox_jobs_operational_(?:queue_)?due/u);
            assert.match(samplePlan, /n8n_commands_operational_processing/u);
            assert.match(agePlan, /outbox_jobs_operational_(?:queue_)?due/u);
            for (const serialized of [samplePlan, agePlan]) {
              const nodes = /** @type {any[]} */ ([]);
              const visit = (/** @type {any} */ value) => {
                if (!value || typeof value !== 'object') return;
                if (value['Relation Name']) nodes.push(value);
                for (const child of Object.values(value))
                  if (Array.isArray(child)) child.forEach(visit);
                  else visit(child);
              };
              visit(JSON.parse(serialized));
              for (const node of nodes.filter((entry) =>
                ['outbox_jobs', 'n8n_commands'].includes(
                  entry['Relation Name'],
                ),
              )) {
                assert.notEqual(node['Node Type'], 'Seq Scan', serialized);
                assert.match(node['Node Type'], /Index|Bitmap/u);
              }
            }
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      );

      await t.test(
        'lock contention aborts sampling instead of waiting on the CRM',
        async () => {
          const blocker = await pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'LOCK TABLE crm.operational_worker_health IN ACCESS EXCLUSIVE MODE',
            );
            await assert.rejects(signals.sample(queues), { code: '55P03' });
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );

      await t.test(
        'defensive sampling rejects a malformed processing command with no lease',
        async () => {
          // A corrupted source is otherwise prevented by this schema constraint.
          await pool.query(
            'ALTER TABLE crm.n8n_commands DROP CONSTRAINT n8n_commands_lock_check',
          );
          await pool.query(
            "UPDATE crm.n8n_commands SET locked_until=NULL WHERE command_id='health-command'",
          );
          assert.equal((await signals.sample(queues)).commands, false);
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  },
);
