import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  createOlistRepository,
  createOlistQuota,
  createOlistClient,
  identityHash,
  seal,
  open,
} from '../modules/olist/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const ENVELOPE_KEY = Buffer.alloc(32, 41);
const HMAC_KEY = Buffer.alloc(32, 43);
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const DOCUMENT = '12345678000199';
const PRODUCT = {
  garment: 'Camiseta',
  color: 'Azul',
  fabric: 'Algodão',
  application: 'Silk',
  collar: 'Redonda',
  audience: 'Adulto',
};

if (connectionString) {
  test('OLIST-T03/T05: durable PostgreSQL foundation and shared account quotas', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: (
        /** @type {string} */ sql,
        /** @type {unknown[]} */ values = [],
      ) => pool.query(sql, values),
      /** @template T @param {(client:import('pg').PoolClient) => Promise<T>} work */
      transaction: (work) => withTransaction(pool, work),
    };
    const repository = () =>
      createOlistRepository(database, {
        envelopeKey: ENVELOPE_KEY,
        hmacKey: HMAC_KEY,
        clock: () => NOW,
      });
    let sequence = 0;
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      async function fixture() {
        await pool.query('TRUNCATE crm.olist_accounts CASCADE');
        const actorId = `olist-actor-${randomUUID()}`;
        const sessionBinding = hash(randomUUID());
        const accountKey = hash('synthetic-account');
        const contextKey = hash('synthetic-app-context');
        const orderId = `olist-order-${randomUUID()}`;
        const contactId = `olist-contact-${randomUUID()}`;
        sequence += 1;
        await pool.query(
          `INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',true,1)`,
          [actorId, `${actorId}@example.test`],
        );
        await pool.query(
          `INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')`,
          [actorId],
        );
        await pool.query(
          `INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            sessionBinding,
            actorId,
            hash('synthetic-csrf'),
            new Date(NOW.getTime() - 60_000),
            NOW,
            new Date(NOW.getTime() + 86_400_000),
          ],
        );
        await pool.query(
          'INSERT INTO crm.olist_accounts(account_key) VALUES($1)',
          [accountKey],
        );
        await pool.query(
          'INSERT INTO crm.olist_settings(account_key) VALUES($1)',
          [accountKey],
        );
        await pool.query(
          'INSERT INTO crm.olist_connections(context_key,account_key,token_envelope,expires_at) VALUES($1,$2,$3::jsonb,$4)',
          [
            contextKey,
            accountKey,
            JSON.stringify(
              seal(
                {
                  accessToken: 'synthetic-access',
                  refreshToken: 'synthetic-refresh',
                },
                ENVELOPE_KEY,
                'tokens',
                accountKey,
                contextKey,
              ),
            ),
            new Date(NOW.getTime() + 3600_000),
          ],
        );
        await pool.query(
          'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
          [contactId, NOW],
        );
        await pool.query(
          `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,contact_id,manual_owner_id,manual_create_key) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC','{}'::jsonb,'user',$4,$5,$5,$6,$4,$7)`,
          [
            orderId,
            sequence,
            String(sequence).padStart(2, '0') + '-CRM',
            actorId,
            NOW,
            contactId,
            randomUUID(),
          ],
        );
        const base = {
          actor: { id: actorId, kind: 'human' },
          sessionBinding,
          authorizationVersion: 1,
          accountKey,
          contextKey,
          connectionGeneration: 0,
          correlationId: 'synthetic-olist-foundation',
        };
        const exportInput = {
          ...base,
          orderId,
          orderVersion: 1,
          settingsVersion: 0,
          snapshot: {
            buyer: {
              name: 'Synthetic Buyer',
              email: 'buyer@example.test',
              document: DOCUMENT,
            },
            subtotalCents: 300,
          },
        };
        return {
          base,
          exportInput,
          actorId,
          orderId,
          accountKey,
          contextKey,
          repo: repository(),
          enableCreation: () =>
            pool.query(
              'UPDATE crm.olist_accounts SET creation_enabled=true,recovery_required=false WHERE account_key=$1',
              [accountKey],
            ),
        };
      }

      /** @param {Awaited<ReturnType<typeof fixture>>} f @param {unknown} envelope */
      async function insertRawExport(f, envelope) {
        const id = randomUUID();
        return pool.query(
          `INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope) VALUES($1,$2,$3,0,$4,1,0,$5,1,$6,$7::jsonb)`,
          [
            id,
            f.accountKey,
            f.contextKey,
            f.orderId,
            f.actorId,
            'CRM-' + id,
            JSON.stringify(envelope),
          ],
        );
      }

      await t.test(
        'all encrypted columns reject bare objects, JSON scalars and malformed envelopes',
        async () => {
          const f = await fixture();
          await f.enableCreation();
          const resource = await f.repo.ensureResource({
            ...f.base,
            kind: 'customer',
            identity: DOCUMENT,
          });
          const effect = await f.repo.reserveEffect({
            ...f.base,
            resourceId: resource.id,
            expectedVersion: 0,
          });
          const good = seal(
            { synthetic: true },
            ENVELOPE_KEY,
            'test',
            f.accountKey,
            'test',
          );
          for (const invalid of [
            {},
            'bare',
            1,
            null,
            [],
            { ...good, iv: '' },
            { ...good, keyVersion: '1' },
          ]) {
            await assert.rejects(
              pool.query(
                'UPDATE crm.olist_settings SET settings_envelope=$2::jsonb WHERE account_key=$1',
                [f.accountKey, JSON.stringify(invalid)],
              ),
              { code: '23514' },
            );
            await assert.rejects(
              pool.query(
                'UPDATE crm.olist_connections SET token_envelope=$2::jsonb WHERE context_key=$1',
                [f.contextKey, JSON.stringify(invalid)],
              ),
              { code: '23514' },
            );
            await assert.rejects(insertRawExport(f, invalid), {
              code: '23514',
            });
            await assert.rejects(
              pool.query(
                'UPDATE crm.olist_attempts SET response_envelope=$2::jsonb WHERE id=$1',
                [effect.attemptId, JSON.stringify(invalid)],
              ),
              { code: '23514' },
            );
          }
        },
      );

      await t.test(
        'variation parent SQL identity includes both the product kind and the account',
        async () => {
          const f = await fixture();
          const customer = await f.repo.ensureResource({
            ...f.base,
            kind: 'customer',
            identity: DOCUMENT,
          });
          const product = await f.repo.ensureResource({
            ...f.base,
            kind: 'product',
            identity: PRODUCT,
          });
          const otherAccount = hash('different-synthetic-account');
          await pool.query(
            'INSERT INTO crm.olist_accounts(account_key) VALUES($1)',
            [otherAccount],
          );
          for (const [account, parent] of [
            [f.accountKey, customer.id],
            [otherAccount, product.id],
          ]) {
            const id = randomUUID();
            await assert.rejects(
              pool.query(
                `INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id) VALUES($1,$2,'variation',$3,$4,$5)`,
                [id, account, hash(id), 'CRM-' + id, parent],
              ),
              { code: '23503' },
            );
          }
          await assert.rejects(
            f.repo.ensureResource({
              ...f.base,
              kind: 'variation',
              parentId: product.id,
              identity: 'M',
            }),
            { code: 'OLIST_PARENT_UNRESOLVED' },
          );
          await pool.query(
            `UPDATE crm.olist_resources SET state='confirmed',remote_id='700' WHERE id=$1`,
            [product.id],
          );
          const variation = await f.repo.ensureResource({
            ...f.base,
            kind: 'variation',
            parentId: product.id,
            identity: 'M',
          });
          assert.equal(variation.parent_id, product.id);
          assert.equal(variation.parent_kind, 'product');
        },
      );

      await t.test(
        'concurrent fiscal identities share one HMAC reservation and confirmed remote identities stay unique',
        async () => {
          const f = await fixture();
          const outcomes = await Promise.all([
            f.repo.ensureResource({
              ...f.base,
              kind: 'customer',
              identity: '12.345.678/0001-99',
            }),
            repository().ensureResource({
              ...f.base,
              kind: 'customer',
              identity: DOCUMENT,
            }),
          ]);
          assert.equal(outcomes[0].id, outcomes[1].id);
          assert.equal(
            outcomes[0].identity_hash,
            identityHash(HMAC_KEY, 'customer', [f.accountKey, DOCUMENT]),
          );
          assert.notEqual(outcomes[0].identity_hash, hash(DOCUMENT));
          assert.doesNotMatch(
            JSON.stringify(outcomes[0]),
            new RegExp(DOCUMENT),
          );
          const counts = await pool.query(
            `SELECT (SELECT count(*)::integer FROM crm.olist_resources) AS resources,(SELECT count(*)::integer FROM crm.olist_events) AS events`,
          );
          assert.deepEqual(counts.rows[0], { resources: 1, events: 1 });
          const second = await f.repo.ensureResource({
            ...f.base,
            kind: 'customer',
            identity: '98765432000188',
          });
          await pool.query(
            `UPDATE crm.olist_resources SET state='confirmed',remote_id='800' WHERE id=$1`,
            [outcomes[0].id],
          );
          await assert.rejects(
            pool.query(
              `UPDATE crm.olist_resources SET state='confirmed',remote_id='800' WHERE id=$1`,
              [second.id],
            ),
            { code: '23505' },
          );
        },
      );

      await t.test(
        'creation and recovery are closed by default, independently of user authorization',
        async () => {
          const f = await fixture();
          await assert.rejects(f.repo.prepareExport(f.exportInput), {
            code: 'OLIST_CREATION_DISABLED',
          });
          await pool.query(
            'UPDATE crm.olist_accounts SET creation_enabled=true WHERE account_key=$1',
            [f.accountKey],
          );
          await assert.rejects(f.repo.prepareExport(f.exportInput), {
            code: 'OLIST_CREATION_DISABLED',
          });
          const count = await pool.query(
            'SELECT count(*)::integer AS count FROM crm.olist_exports',
          );
          assert.equal(count.rows[0].count, 0);
        },
      );

      await t.test(
        'snapshot, outbox and event roll back together when publishing the job or event fails',
        async () => {
          const f = await fixture();
          await f.enableCreation();
          for (const boundary of [
            'INSERT INTO crm.outbox_jobs',
            'INSERT INTO crm.olist_events',
          ]) {
            const sentinel = new Error(
              'Synthetic transaction boundary failure',
            );
            const failing = createOlistRepository(
              {
                ...database,
                transaction: (/** @type {any} */ work) =>
                  withTransaction(pool, (client) =>
                    work({
                      query: (
                        /** @type {string} */ sql,
                        /** @type {unknown[]} */ values,
                      ) => {
                        if (sql.includes(boundary)) throw sentinel;
                        return client.query(sql, values);
                      },
                    }),
                  ),
              },
              {
                envelopeKey: ENVELOPE_KEY,
                hmacKey: HMAC_KEY,
                clock: () => NOW,
              },
            );
            await assert.rejects(
              failing.prepareExport(f.exportInput),
              sentinel,
            );
            const counts = await pool.query(
              `SELECT (SELECT count(*)::integer FROM crm.olist_exports) AS exports,(SELECT count(*)::integer FROM crm.outbox_jobs) AS jobs,(SELECT count(*)::integer FROM crm.olist_events) AS events`,
            );
            assert.deepEqual(counts.rows[0], {
              exports: 0,
              jobs: 0,
              events: 0,
            });
          }
        },
      );

      await t.test(
        'two requests for one order return one immutable snapshot, one job and one queued event',
        async () => {
          const f = await fixture();
          await f.enableCreation();
          const [first, second] = await Promise.all([
            f.repo.prepareExport(f.exportInput),
            repository().prepareExport(f.exportInput),
          ]);
          assert.equal(first.id, second.id);
          assert.deepEqual(
            open(
              first.snapshot_envelope,
              ENVELOPE_KEY,
              'export-snapshot',
              f.accountKey,
              first.id,
            ),
            f.exportInput.snapshot,
          );
          assert.doesNotMatch(
            JSON.stringify(first),
            /buyer@example.test|Synthetic Buyer|12345678000199/,
          );
          const jobs = await pool.query(
            'SELECT * FROM crm.outbox_jobs WHERE olist_export_id=$1',
            [first.id],
          );
          assert.equal(jobs.rows.length, 1);
          assert.equal(jobs.rows[0].queue, 'olist');
          assert.equal(jobs.rows[0].effect_policy, 'queryable');
          assert.doesNotMatch(
            JSON.stringify(jobs.rows),
            /buyer@example.test|Synthetic Buyer|12345678000199/,
          );
          const events = await pool.query(
            `SELECT * FROM crm.olist_events WHERE export_id=$1 AND event_code='OLIST_EXPORT_QUEUED'`,
            [first.id],
          );
          assert.equal(events.rows.length, 1);
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_exports SET snapshot_envelope=$2::jsonb WHERE id=$1',
              [
                first.id,
                JSON.stringify(
                  seal(
                    {},
                    ENVELOPE_KEY,
                    'export-snapshot',
                    f.accountKey,
                    first.id,
                  ),
                ),
              ],
            ),
            { code: 'P0001' },
          );
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_exports SET authorization_version=authorization_version+1 WHERE id=$1',
              [first.id],
            ),
            { code: 'P0001' },
          );
          await assert.rejects(
            pool.query('DELETE FROM crm.olist_events WHERE id=$1', [
              events.rows[0].id,
            ]),
            { code: 'P0001' },
          );
          await assert.rejects(
            pool.query(
              `UPDATE crm.olist_events SET event_code='OLIST_CHANGED' WHERE id=$1`,
              [events.rows[0].id],
            ),
            { code: 'P0001' },
          );
        },
      );

      await t.test(
        'a resource effect has one concurrent winner and uncertainty never authorizes a new reservation',
        async () => {
          const f = await fixture();
          await f.enableCreation();
          const resource = await f.repo.ensureResource({
            ...f.base,
            kind: 'customer',
            identity: DOCUMENT,
          });
          const input = {
            ...f.base,
            resourceId: resource.id,
            expectedVersion: 0,
          };
          const outcomes = await Promise.allSettled([
            f.repo.reserveEffect(input),
            repository().reserveEffect(input),
          ]);
          assert.equal(
            outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
            1,
          );
          const rejected = outcomes.find(
            (outcome) => outcome.status === 'rejected',
          );
          assert.equal(
            rejected?.status === 'rejected' && rejected.reason.code,
            'VERSION_CONFLICT',
          );
          const winner = outcomes.find(
            (outcome) => outcome.status === 'fulfilled',
          );
          assert.ok(winner?.status === 'fulfilled');
          const effect = winner.value;
          await assert.rejects(
            pool.query('DELETE FROM crm.olist_attempts WHERE id=$1', [
              effect.attemptId,
            ]),
            { code: 'P0001' },
          );
          await assert.rejects(
            pool.query('UPDATE crm.olist_attempts SET fence=$2 WHERE id=$1', [
              effect.attemptId,
              randomUUID(),
            ]),
            { code: 'P0001' },
          );
          await f.repo.recordResult({
            ...f.base,
            ...effect,
            outcome: 'uncertain',
            response: { diagnostic: 'Synthetic unknown outcome' },
          });
          await assert.rejects(
            f.repo.reserveEffect({ ...input, expectedVersion: 2 }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
          const replay = await f.repo.recordResult({
            ...f.base,
            ...effect,
            outcome: 'confirmed',
            remoteId: '999',
          });
          assert.deepEqual(replay, { outcome: 'uncertain', replayed: true });
          await assert.rejects(
            pool.query(
              `UPDATE crm.olist_attempts SET outcome='rejected' WHERE id=$1`,
              [effect.attemptId],
            ),
            { code: 'P0001' },
          );
          const count = await pool.query(
            'SELECT count(*)::integer AS count FROM crm.olist_attempts',
          );
          assert.equal(count.rows[0].count, 1);
        },
      );

      await t.test(
        'already-started effects persist their confirmed ID and encrypted response after user revocation',
        async () => {
          const f = await fixture();
          await f.enableCreation();
          const resource = await f.repo.ensureResource({
            ...f.base,
            kind: 'customer',
            identity: DOCUMENT,
          });
          const effect = await f.repo.reserveEffect({
            ...f.base,
            resourceId: resource.id,
            expectedVersion: 0,
          });
          await pool.query(
            'UPDATE crm.users SET disabled_at=$2,olist_enabled=false,olist_authorization_version=olist_authorization_version+1 WHERE id=$1',
            [f.actorId, NOW],
          );
          await f.repo.recordResult({
            ...f.base,
            ...effect,
            outcome: 'confirmed',
            remoteId: '901',
            response: { customer: { document: DOCUMENT }, id: '901' },
          });
          const saved = (
            await pool.query('SELECT * FROM crm.olist_resources WHERE id=$1', [
              resource.id,
            ])
          ).rows[0];
          assert.equal(saved.state, 'confirmed');
          assert.equal(saved.remote_id, '901');
          const attempt = (
            await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
              effect.attemptId,
            ])
          ).rows[0];
          assert.doesNotMatch(JSON.stringify(attempt), new RegExp(DOCUMENT));
          assert.deepEqual(
            open(
              attempt.response_envelope,
              ENVELOPE_KEY,
              'effect-response',
              f.accountKey,
              effect.attemptId,
            ),
            { customer: { document: DOCUMENT }, id: '901' },
          );
          const replay = await f.repo.recordResult({
            ...f.base,
            ...effect,
            outcome: 'confirmed',
            remoteId: '902',
          });
          assert.equal(replay.replayed, true);
          await assert.rejects(
            f.repo.reserveEffect({
              ...f.base,
              resourceId: resource.id,
              expectedVersion: 2,
            }),
            { code: 'FORBIDDEN' },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT remote_id FROM crm.olist_resources WHERE id=$1',
                [resource.id],
              )
            ).rows[0].remote_id,
            '901',
          );
        },
      );

      await t.test(
        'quota reservations serialize replicas and reset an expired shared window',
        async () => {
          const f = await fixture();
          const first = createOlistQuota(database, f.accountKey, 1);
          const second = createOlistQuota(database, f.accountKey, 1);
          const results = await Promise.allSettled([
            first.reserve(),
            second.reserve(),
          ]);
          assert.equal(
            results.filter((outcome) => outcome.status === 'fulfilled').length,
            1,
          );
          const rejected = results.find(
            (outcome) => outcome.status === 'rejected',
          );
          assert.equal(
            rejected?.status === 'rejected' && rejected.reason.code,
            'OLIST_RATE_LIMITED',
          );
          await pool.query(
            `UPDATE crm.olist_quotas SET window_started_at=now()-interval '2 minutes',remaining=0 WHERE account_key=$1`,
            [f.accountKey],
          );
          await second.reserve();
          const row = (
            await pool.query(
              'SELECT used,remaining FROM crm.olist_quotas WHERE account_key=$1',
              [f.accountKey],
            )
          ).rows[0];
          assert.deepEqual(row, { used: 1, remaining: null });
        },
      );

      await t.test(
        'upstream remaining=0 and Retry-After block prevent every HTTP call across replicas',
        async () => {
          const f = await fixture();
          const quota = createOlistQuota(database, f.accountKey, 30);
          const replica = createOlistQuota(database, f.accountKey, 30);
          await quota.reserve();
          await quota.observe(
            new globalThis.Headers({ 'x-ratelimit-remaining': '0' }),
          );
          await replica.observe(
            new globalThis.Headers({ 'x-ratelimit-remaining': '25' }),
          );
          let calls = 0;
          const client = createOlistClient({
            credentials: async () => ({
              token: 'synthetic-access',
              version: 1,
            }),
            quota: replica,
            fetch: /** @type {typeof fetch} */ (
              async () => {
                calls += 1;
                return new globalThis.Response('{}', {
                  headers: { 'content-type': 'application/json' },
                });
              }
            ),
          });
          await assert.rejects(client.info(), { code: 'OLIST_RATE_LIMITED' });
          await pool.query(
            'UPDATE crm.olist_quotas SET used=0,remaining=NULL WHERE account_key=$1',
            [f.accountKey],
          );
          await quota.block(60_000);
          await assert.rejects(client.info(), { code: 'OLIST_RATE_LIMITED' });
          assert.equal(calls, 0);
        },
      );
    } finally {
      await pool.end();
    }
  });
} else {
  test(
    'OLIST-T03/T05 PostgreSQL foundation tests require TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
