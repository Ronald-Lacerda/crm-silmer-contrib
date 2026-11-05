import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  authorize,
  createPostgresAccessRepository,
  createPostgresIdentityRepository,
} from '../modules/identity-access/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (connectionString) {
  test('OLIST-T19: expansion defaults, concurrent authorization CAS, rollback and disable fencing in PostgreSQL', async () => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 5 });
    /** @template T @param {(repo: ReturnType<typeof createPostgresIdentityRepository>) => Promise<T>} work */
    const transaction = (work) =>
      withTransaction(pool, (client) =>
        work(createPostgresIdentityRepository(client)),
      );
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      await migrate(pool, {
        migrations: migrations.filter((entry) => entry.version < '0063'),
      });
      await pool.query(
        `INSERT INTO crm.users (id, email, name, password_hash) VALUES ('legacy', 'legacy@example.test', 'Sintético', '$argon2id$synthetic')`,
      );
      await pool.query(
        `INSERT INTO crm.user_functions (user_id, function_name) VALUES ('legacy', 'Financeiro')`,
      );
      await migrate(pool, { migrations });
      const before = await transaction((repo) => repo.findUserById('legacy'));
      assert.equal(before?.olistEnabled, false);
      assert.equal(before?.olistAuthorizationVersion, 0);
      assert.equal(before?.passwordHash, '$argon2id$synthetic');
      const outcomes = await Promise.allSettled([
        transaction((repo) =>
          repo.updateUser('legacy', {
            olistEnabled: true,
            expectedOlistAuthorizationVersion: 0,
          }),
        ),
        transaction((repo) =>
          repo.updateUser('legacy', {
            olistEnabled: true,
            expectedOlistAuthorizationVersion: 0,
          }),
        ),
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
      const sentinel = new Error('synthetic rollback');
      await assert.rejects(
        transaction(async (repo) => {
          await repo.updateUser('legacy', {
            olistEnabled: false,
            expectedOlistAuthorizationVersion: 1,
          });
          throw sentinel;
        }),
        sentinel,
      );
      const afterRollback = await transaction((repo) =>
        repo.findUserById('legacy'),
      );
      assert.equal(afterRollback?.olistEnabled, true);
      assert.equal(afterRollback?.olistAuthorizationVersion, 1);
      const principal =
        await createPostgresAccessRepository(pool).findUser('legacy');
      assert.ok(principal);
      assert.equal(principal.olistAuthorizationVersion, 1);
      assert.doesNotThrow(() => authorize(principal, 'olist.export'));
      assert.throws(() => authorize(principal, 'order.edit'), {
        code: 'FORBIDDEN',
      });
      const disabled = await transaction((repo) =>
        repo.setUserDisabled('legacy', '2026-11-05T12:00:00Z'),
      );
      assert.equal(disabled?.olistAuthorizationVersion, 2);
      assert.equal(
        await createPostgresAccessRepository(pool).findUser('legacy'),
        null,
      );
      const reenabled = await transaction((repo) =>
        repo.setUserDisabled('legacy', null),
      );
      assert.equal(reenabled?.olistAuthorizationVersion, 3);
      await assert.rejects(
        transaction((repo) =>
          repo.updateUser('legacy', {
            olistEnabled: false,
            expectedOlistAuthorizationVersion: 1,
          }),
        ),
        { code: 'VERSION_CONFLICT' },
      );
      const unchanged = await transaction((repo) =>
        repo.updateUser('legacy', {
          olistEnabled: true,
          expectedOlistAuthorizationVersion: 3,
        }),
      );
      assert.equal(unchanged?.olistAuthorizationVersion, 3);
    } finally {
      await pool.end();
    }
  });
} else {
  test(
    'OLIST-T19 PostgreSQL concurrency requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
