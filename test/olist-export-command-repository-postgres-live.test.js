import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import {
  createOlistRepository,
  open,
  seal,
} from '../modules/olist/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 61),
  HMAC = Buffer.alloc(32, 62),
  IDEM = Buffer.alloc(32, 63);
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
if (!connectionString)
  test(
    'OLIST-T07 command repository requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T07 immutable export command, outer transaction and shared logical identity', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repoFor = (/** @type {any} */ db = database) =>
      createOlistRepository(db, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    const accountKey = hash('synthetic-command-account'),
      contextKey = hash('synthetic-command-context');
    async function actor() {
      const id = 't07-user-' + randomUUID(),
        sessionBinding = hash(randomUUID());
      await pool.query(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',true,1)",
        [id, id + '@example.test'],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Financeiro')",
        [id],
      );
      await pool.query(
        'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
        [
          sessionBinding,
          id,
          hash('synthetic-csrf'),
          NOW,
          new Date(NOW.getTime() + 3600000),
        ],
      );
      return {
        actor: { id, kind: 'human' },
        sessionBinding,
        authorizationVersion: 1,
      };
    }
    async function fixture() {
      await pool.query('TRUNCATE crm.olist_accounts CASCADE');
      const authority = await actor();
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,4)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_connections(context_key,account_key,generation,version,token_envelope,expires_at) VALUES($1,$2,3,2,$3::jsonb,$4)',
        [
          contextKey,
          accountKey,
          JSON.stringify(
            seal(
              {
                accessToken: 'synthetic-access',
                refreshToken: 'synthetic-refresh',
              },
              KEY,
              'tokens',
              accountKey,
              contextKey,
            ),
          ),
          new Date(NOW.getTime() + 3600000),
        ],
      );
      const orderId = 't07-order-' + randomUUID(),
        contactId = 't07-contact-' + randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const number = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') AS n"))
          .rows[0].n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,contact_id,manual_owner_id,manual_create_key) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC','{}'::jsonb,'user',$4,$5,$5,$6,$4,$7)",
        [
          orderId,
          number,
          String(number).padStart(2, '0') + '-CRM',
          authority.actor.id,
          NOW,
          contactId,
          randomUUID(),
        ],
      );
      const snapshot = {
        policy: 'exact-cent-v1',
        customer: { nome: 'Synthetic Private Buyer', cpfCnpj: '52998224725' },
        commercial: { orderDate: '2026-11-06', totalCents: 300, groups: [] },
        sourceVersions: { contactId, contactVersion: 1, sourceRevision: 0 },
      };
      const input = {
        ...authority,
        accountKey,
        contextKey,
        connectionGeneration: 3,
        connectionVersion: 2,
        orderId,
        orderVersion: 1,
        settingsVersion: 4,
        snapshot,
        snapshotFingerprint: hash('synthetic-semantic-command'),
        correlationId: 'synthetic-t07-command',
      };
      return { input, repo: repoFor(), authority, orderId };
    }
    async function counts() {
      return (
        await pool.query(
          "SELECT (SELECT count(*)::integer FROM crm.olist_exports) exports,(SELECT count(*)::integer FROM crm.outbox_jobs WHERE job_type='olist.export') jobs,(SELECT count(*)::integer FROM crm.olist_events WHERE event_code='OLIST_EXPORT_QUEUED') events,(SELECT count(*)::integer FROM crm.audit_events WHERE action='olist.export.request') audits",
        )
      ).rows[0];
    }
    async function transactionalCommand(
      /** @type {any} */ db,
      /** @type {any} */ input,
      /** @type {string} */ key,
    ) {
      return new PostgresIdempotencyRecordStore({
        database: db,
        envelopeKey: IDEM,
      }).execute(
        {
          scope: 'olist-command:' + input.orderId,
          key,
          fingerprint: hash('request:' + key),
          actor: input.actor.id,
          action: 'olist.export.request',
          target: { type: 'order', id: input.orderId },
          version: input.orderVersion,
          reason: 'OLIST_EXPORT_QUEUED',
          correlationId: input.correlationId,
        },
        async (tx) => {
          const row = await repoFor({
            query: db.query,
            transaction: () => {
              throw new Error('Nested transaction is forbidden');
            },
          }).prepareExport({ ...input, transaction: tx });
          return { exportId: row.id, state: row.state };
        },
      );
    }
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await t.test(
        'two independent connections freeze one snapshot/job/event/audit and keep the order untouched',
        async () => {
          const f = await fixture(),
            auditsBefore = (await counts()).audits;
          const [a, b] = await Promise.all([
            f.repo.prepareExport(f.input),
            repoFor().prepareExport(f.input),
          ]);
          assert.equal(a.id, b.id);
          assert.match(a.command_fingerprint, /^[a-f0-9]{64}$/u);
          assert.deepEqual(
            open(a.snapshot_envelope, KEY, 'export-snapshot', accountKey, a.id),
            f.input.snapshot,
          );
          assert.doesNotMatch(
            JSON.stringify(a),
            /Synthetic Private Buyer|52998224725/u,
          );
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: auditsBefore + 1,
          });
          const row = (
            await pool.query(
              'SELECT status,version,order_date FROM crm.orders WHERE id=$1',
              [f.orderId],
            )
          ).rows[0];
          assert.deepEqual(row, {
            status: 'pendente',
            version: 1,
            order_date: null,
          });
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_exports SET command_fingerprint=$2 WHERE id=$1',
              [a.id, hash('changed')],
            ),
            { code: 'P0001' },
          );
        },
      );
      await t.test(
        'divergent concurrent semantic commands have one winner and no second publication',
        async () => {
          const f = await fixture(),
            before = (await counts()).audits;
          const results = await Promise.allSettled([
            f.repo.prepareExport(f.input),
            repoFor().prepareExport({
              ...f.input,
              snapshotFingerprint: hash('different-command'),
              snapshot: {
                ...f.input.snapshot,
                commercial: { ...f.input.snapshot.commercial, totalCents: 600 },
              },
            }),
          ]);
          assert.equal(
            results.filter((x) => x.status === 'fulfilled').length,
            1,
          );
          const failure = /** @type {PromiseRejectedResult} */ (
            results.find((x) => x.status === 'rejected')
          );
          assert.equal(failure.reason.code, 'OLIST_EXPORT_CONFLICT');
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: before + 1,
          });
        },
      );
      await t.test(
        'a second enabled actor sees the same logical operation without replacing the original executor or date',
        async () => {
          const f = await fixture();
          const first = await f.repo.prepareExport(f.input);
          const second = await actor();
          const found = await f.repo.findExport({ ...f.input, ...second });
          assert.equal(found.id, first.id);
          assert.equal(found.snapshot.commercial.orderDate, '2026-11-06');
          const replay = await f.repo.prepareExport({
            ...f.input,
            ...second,
            orderVersion: 99,
            settingsVersion: 99,
            snapshot: {
              ...f.input.snapshot,
              commercial: {
                ...f.input.snapshot.commercial,
                orderDate: '2026-11-07',
              },
            },
          });
          assert.equal(replay.id, first.id);
          assert.equal(replay.actor_id, f.authority.actor.id);
          assert.deepEqual(replay.snapshot_envelope, first.snapshot_envelope);
        },
      );
      await t.test(
        'distinct idempotency keys share one operation inside the exact outer transaction',
        async () => {
          const f = await fixture(),
            before = (await counts()).audits;
          const results = await Promise.all([
            transactionalCommand(database, f.input, 'command-a'),
            transactionalCommand(database, f.input, 'command-b'),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.deepEqual(await counts(), {
            exports: 1,
            jobs: 1,
            events: 1,
            audits: before + 1,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM crm.idempotency_records WHERE target_id=$1',
                [f.orderId],
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        'failure of job, event, audit or idempotency completion rolls back every command artifact',
        async () => {
          for (const expression of [
            /INSERT INTO crm\.outbox_jobs/u,
            /INSERT INTO crm\.olist_events/u,
            /INSERT INTO crm\.audit_events/u,
            /UPDATE crm\.idempotency_records/u,
          ]) {
            const f = await fixture(),
              before = await counts(),
              sentinel = new Error('Synthetic local commit failure');
            const failing = {
              query: database.query,
              transaction: (/** @type {any} */ work) =>
                withTransaction(pool, (tx) =>
                  work({
                    query: async (
                      /** @type {string} */ sql,
                      /** @type {unknown[]} */ args = [],
                    ) => {
                      if (expression.test(sql)) throw sentinel;
                      return tx.query(sql, args);
                    },
                  }),
                ),
            };
            await assert.rejects(
              transactionalCommand(failing, f.input, 'fail-' + randomUUID()),
              sentinel,
            );
            assert.deepEqual(await counts(), before);
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::integer n FROM crm.idempotency_records WHERE target_id=$1',
                  [f.orderId],
                )
              ).rows[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        'current account, recovery, connection and checkbox guards deny even matching logical replays',
        async () => {
          for (const change of [
            'UPDATE crm.olist_accounts SET creation_enabled=false',
            'UPDATE crm.olist_accounts SET recovery_required=true',
            'UPDATE crm.olist_connections SET reconnect_required=true',
            'UPDATE crm.olist_connections SET generation=generation+1',
            'UPDATE crm.olist_connections SET version=version+1',
            "UPDATE crm.olist_connections SET expires_at='2026-11-06T11:59:59Z'",
            "UPDATE crm.olist_connections SET refresh_nonce='11111111-1111-4111-8111-111111111111',refresh_started_at='2026-11-06T12:00:00Z'",
            "UPDATE crm.olist_connections SET exchange_nonce='11111111-1111-4111-8111-111111111111'",
          ]) {
            const f = await fixture();
            await f.repo.prepareExport(f.input);
            await pool.query(change);
            const before = await counts();
            await assert.rejects(
              f.repo.prepareExport(f.input),
              /** @param {any} error */ (error) =>
                [
                  'OLIST_CREATION_DISABLED',
                  'OLIST_CONNECTION_CHANGED',
                ].includes(error.code),
            );
            assert.deepEqual(await counts(), before);
          }
          const f = await fixture();
          await f.repo.prepareExport(f.input);
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false WHERE id=$1',
            [f.authority.actor.id],
          );
          await assert.rejects(f.repo.findExport(f.input), {
            code: 'FORBIDDEN',
          });
          await assert.rejects(f.repo.prepareExport(f.input), {
            code: 'FORBIDDEN',
          });
        },
      );
      await t.test(
        'legacy snapshots with null command fingerprints cannot be guessed or replaced',
        async () => {
          const f = await fixture(),
            id = randomUUID();
          await pool.query(
            'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope) VALUES($1,$2,$3,3,$4,1,4,$5,1,$6,$7::jsonb)',
            [
              id,
              accountKey,
              contextKey,
              f.orderId,
              f.authority.actor.id,
              'CRM-' + id,
              JSON.stringify(
                seal(f.input.snapshot, KEY, 'export-snapshot', accountKey, id),
              ),
            ],
          );
          await assert.rejects(f.repo.prepareExport(f.input), {
            code: 'OLIST_EXPORT_CONFLICT',
          });
          assert.equal(
            (await f.repo.findExport(f.input)).command_fingerprint,
            null,
          );
          assert.equal((await counts()).jobs, 0);
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
