import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createPostgresIdentityRepository } from '../modules/identity-access/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
/** @param {string} character */
const hash = (character) => character.repeat(64);

if (connectionString) {
  test('PostgreSQL identity repository preserves concurrency and rollback invariants', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(
      databaseName,
      'crm_silmer_test',
      'live identity test only resets the dedicated crm_silmer_test database',
    );

    const pool = new Pool({ connectionString, max: 8 });
    /**
     * @template T
     * @param {(repository: ReturnType<typeof createPostgresIdentityRepository>) => Promise<T>} work
     */
    const transaction = (work) =>
      withTransaction(pool, (client) =>
        work(createPostgresIdentityRepository(client)),
      );

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      /** @type {Array<{
       *   capabilities: Array<'COMMERCIAL_ADMIN'>,
       *   email: string,
       *   functionName: 'Vendedor',
       *   id: string,
       *   name: string,
       *   passwordHash: string,
       * }>} */
      const bootstrapUsers = [
        {
          capabilities: ['COMMERCIAL_ADMIN'],
          email: 'admin-one@example.test',
          functionName: 'Vendedor',
          id: 'admin-one',
          name: 'Admin Um',
          passwordHash: '$argon2id$v=19$fixture-one',
        },
        {
          capabilities: ['COMMERCIAL_ADMIN'],
          email: 'admin-two@example.test',
          functionName: 'Vendedor',
          id: 'admin-two',
          name: 'Admin Dois',
          passwordHash: '$argon2id$v=19$fixture-two',
        },
      ];
      const bootstrapResults = await Promise.all(
        bootstrapUsers.map((user) =>
          transaction((repository) => repository.insertInitialUser(user)),
        ),
      );
      assert.deepEqual(bootstrapResults.toSorted(), [false, true]);

      const bootstrapState = await pool.query(
        `SELECT u.id, f.function_name, c.capability
         FROM crm.users AS u
         JOIN crm.user_functions AS f ON f.user_id = u.id
         JOIN crm.user_capabilities AS c ON c.user_id = u.id`,
      );
      assert.equal(bootstrapState.rowCount, 1);
      assert.equal(bootstrapState.rows[0].capability, 'COMMERCIAL_ADMIN');
      const adminId = /** @type {string} */ (bootstrapState.rows[0].id);
      const adminEmail =
        adminId === 'admin-one'
          ? 'admin-one@example.test'
          : 'admin-two@example.test';

      const reader = createPostgresIdentityRepository(pool);
      assert.equal((await reader.findUserById(adminId))?.email, adminEmail);
      await pool.query(
        `UPDATE crm.users SET disabled_at = now() WHERE id = $1`,
        [adminId],
      );
      assert.equal(await reader.findUserByEmail(adminEmail), null);
      await pool.query(
        `UPDATE crm.users SET disabled_at = NULL WHERE id = $1`,
        [adminId],
      );

      // Two concurrent creations of the same address: the lower-cased unique
      // index, not the application, is what keeps exactly one.
      const raceResults = await Promise.allSettled(
        ['seller-race-one', 'seller-race-two'].map((id) =>
          transaction((repository) =>
            repository.createUser({
              capabilities: [],
              email: 'Seller-Race@example.test',
              functionName: 'Vendedor',
              id,
              name: 'Vendedor Concorrente',
              passwordHash: '$argon2id$v=19$race-fixture',
            }),
          ),
        ),
      );
      assert.equal(
        raceResults.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        raceResults.filter((result) => result.status === 'rejected').length,
        1,
      );
      // The e-mail comparison ignores case, so the surviving row answers to
      // the address written either way. Which of the two ids won is decided by
      // the database, so the survivor is looked up rather than assumed.
      const survivor = await reader.findUserByEmail('seller-race@example.test');
      assert.ok(survivor);

      const rollbackError = new Error('rollback identity transaction');
      await assert.rejects(
        transaction(async (repository) => {
          await repository.createUser({
            capabilities: [],
            email: 'rollback@example.test',
            functionName: 'Vendedor',
            id: 'rolled-back-user',
            name: 'Conta Descartada',
            passwordHash: '$argon2id$v=19$rollback-fixture',
          });
          throw rollbackError;
        }),
        (error) => error === rollbackError,
      );
      assert.equal(await reader.findUserById('rolled-back-user'), null);

      const renamed = await transaction((repository) =>
        repository.updateUser(survivor.id, { name: 'Nome Corrigido' }),
      );
      assert.equal(renamed?.name ?? null, 'Nome Corrigido');
      const disabled = await transaction((repository) =>
        repository.setUserDisabled(survivor.id, new Date().toISOString()),
      );
      assert.ok(disabled?.disabledAt);
      assert.equal(
        await reader.findUserByEmail('seller-race@example.test'),
        null,
      );

      await transaction((repository) =>
        repository.createSession({
          absoluteExpiresAt: '2026-09-01T22:00:00.000Z',
          createdAt: '2026-09-01T10:00:00.000Z',
          csrfHash: hash('c'),
          lastSeenAt: '2026-09-01T10:00:00.000Z',
          revokedAt: null,
          tokenHash: hash('d'),
          userId: adminId,
        }),
      );
      assert.equal(
        (
          await transaction((repository) =>
            repository.authenticateSession(
              hash('d'),
              '2026-09-01T10:05:00.000Z',
              '2026-09-01T09:35:00.000Z',
            ),
          )
        )?.lastSeenAt,
        '2026-09-01T10:05:00.000Z',
      );
      assert.equal(
        await transaction((repository) =>
          repository.validateCsrfSession(
            hash('d'),
            hash('0'),
            '2026-09-01T10:06:00.000Z',
            '2026-09-01T09:36:00.000Z',
          ),
        ),
        null,
      );
      assert.equal(
        (await reader.findSession(hash('d')))?.lastSeenAt,
        '2026-09-01T10:05:00.000Z',
      );
      assert.equal(
        (
          await transaction((repository) =>
            repository.validateCsrfSession(
              hash('d'),
              hash('c'),
              '2026-09-01T10:06:00.000Z',
              '2026-09-01T09:36:00.000Z',
            ),
          )
        )?.lastSeenAt,
        '2026-09-01T10:06:00.000Z',
      );
      await transaction((repository) =>
        repository.revokeSession(hash('d'), '2026-09-01T10:07:00.000Z'),
      );
      assert.equal(
        await transaction((repository) =>
          repository.authenticateSession(
            hash('d'),
            '2026-09-01T10:08:00.000Z',
            '2026-09-01T09:38:00.000Z',
          ),
        ),
        null,
      );
      assert.equal(
        (await reader.findSession(hash('d')))?.lastSeenAt,
        '2026-09-01T10:06:00.000Z',
      );

      await transaction((repository) =>
        repository.createSession({
          absoluteExpiresAt: '2026-09-01T22:00:00.000Z',
          createdAt: '2026-09-01T10:00:00.000Z',
          csrfHash: hash('e'),
          lastSeenAt: '2026-09-01T10:00:00.000Z',
          revokedAt: null,
          tokenHash: hash('f'),
          userId: adminId,
        }),
      );
      await pool.query(
        `UPDATE crm.users SET disabled_at = now() WHERE id = $1`,
        [adminId],
      );
      assert.equal(
        await transaction((repository) =>
          repository.authenticateSession(
            hash('f'),
            '2026-09-01T10:05:00.000Z',
            '2026-09-01T09:35:00.000Z',
          ),
        ),
        null,
      );
      assert.equal(
        (await reader.findSession(hash('f')))?.lastSeenAt,
        '2026-09-01T10:00:00.000Z',
      );
      await pool.query(
        `UPDATE crm.users SET disabled_at = NULL WHERE id = $1`,
        [adminId],
      );

      // FINQ-T01: the database preserves the three access choices and rejects
      // the forbidden Financeiro + administrative capability combination.
      await transaction((repository) =>
        repository.createUser({
          id: 'finance-live',
          name: 'Financeiro Sintetico',
          email: 'finance@example.test',
          functionName: 'Financeiro',
          capabilities: [],
          passwordHash: '$argon2id$v=19$synthetic',
        }),
      );
      assert.equal(
        (await reader.findUserById('finance-live'))?.functionName,
        'Financeiro',
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO crm.user_capabilities (user_id, capability, granted_by) VALUES ('finance-live', 'COMMERCIAL_ADMIN', $1)`,
          [adminId],
        ),
        { code: '23514' },
      );
      await transaction((repository) =>
        repository.updateUser('finance-live', {
          functionName: 'Vendedor',
          capabilities: ['COMMERCIAL_ADMIN'],
          capabilityGrantedBy: adminId,
          revokeSessionsAt: '2026-10-22T12:00:00.000Z',
        }),
      );
      assert.deepEqual(
        (await reader.findUserById('finance-live'))?.capabilities,
        ['COMMERCIAL_ADMIN'],
      );
      await transaction((repository) =>
        repository.createSession({
          tokenHash: hash('1'),
          userId: 'finance-live',
          csrfHash: hash('2'),
          createdAt: '2026-10-22T12:00:00.000Z',
          lastSeenAt: '2026-10-22T12:00:00.000Z',
          absoluteExpiresAt: '2026-10-22T23:00:00.000Z',
          revokedAt: null,
        }),
      );
      const financeAgain = await transaction((repository) =>
        repository.updateUser('finance-live', {
          functionName: 'Financeiro',
          capabilities: [],
          capabilityGrantedBy: adminId,
          revokeSessionsAt: '2026-10-22T12:01:00.000Z',
        }),
      );
      assert.equal(financeAgain?.functionName, 'Financeiro');
      assert.deepEqual(financeAgain?.capabilities, []);
      assert.equal(
        (await reader.findSession(hash('1')))?.revokedAt,
        '2026-10-22T12:01:00.000Z',
      );
      assert.equal(
        await transaction((repository) =>
          repository.authenticateSession(
            hash('1'),
            '2026-10-22T12:02:00.000Z',
            '2026-10-22T11:32:00.000Z',
          ),
        ),
        null,
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}
