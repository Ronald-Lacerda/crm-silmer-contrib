import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresAccessRepository } from '../modules/identity-access/src/postgres-access.js';

class RecordingDatabase {
  /** @type {Array<{sql: string, values: unknown[]}>} */
  queries = [];

  /** @param {string} sql @param {unknown[]} [values] */
  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (sql.includes('FROM crm.users AS u')) {
      return {
        rows: [
          {
            capabilities: ['COMMERCIAL_ADMIN'],
            function_name: 'Vendedor',
            id: 'admin-1',
          },
        ],
      };
    }
    return { rows: [], rowCount: 1 };
  }
}

test('maps ACL users and records the grant authority', async () => {
  const database = new RecordingDatabase();
  const repository = createPostgresAccessRepository(database);

  assert.deepEqual(await repository.findUser('admin-1'), {
    capabilities: ['COMMERCIAL_ADMIN'],
    functionName: 'Vendedor',
    id: 'admin-1',
  });
  await repository.grant('seller-1', 'COMMERCIAL_ADMIN', 'admin-1');

  const grant = database.queries.find(({ sql }) =>
    sql.includes('INSERT INTO crm.user_capabilities'),
  );
  assert.deepEqual(grant?.values, ['seller-1', 'COMMERCIAL_ADMIN', 'admin-1']);
});

test('revokes a capability and every active session at the supplied instant', async () => {
  const database = new RecordingDatabase();
  const repository = createPostgresAccessRepository(database);

  await repository.revoke('seller-1', 'COMMERCIAL_ADMIN');
  await repository.revokePrivilegedSessions(
    'seller-1',
    '2026-09-01T12:00:00.000Z',
  );

  assert.match(
    database.queries[0].sql,
    /SELECT id FROM crm\.users.*FOR UPDATE/isu,
  );
  assert.deepEqual(database.queries[0].values, ['seller-1']);
  assert.match(database.queries[1].sql, /DELETE FROM crm\.user_capabilities/iu);
  assert.deepEqual(database.queries[1].values, [
    'seller-1',
    'COMMERCIAL_ADMIN',
  ]);
  assert.match(database.queries[2].sql, /UPDATE crm\.sessions/iu);
  assert.match(database.queries[2].sql, /revoked_at IS NULL/iu);
  assert.deepEqual(database.queries[2].values, [
    'seller-1',
    '2026-09-01T12:00:00.000Z',
  ]);
});
