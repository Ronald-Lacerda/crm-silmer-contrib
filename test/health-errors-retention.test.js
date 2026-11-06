import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import { createHealthErrorsRuntime } from '../apps/api/src/health-errors-runtime.js';

/** @param {(sql: string) => Promise<any>} query */
function runtimeFor(query) {
  return createHealthErrorsRuntime({
    database: {
      transaction: (/** @type {Function} */ work) => work({ query }),
    },
    identity: {
      allowedOrigins: [],
      authorizeHealthErrors: async () => ({
        actor: { id: 'synthetic-operator' },
      }),
    },
    envelopeKey: Buffer.alloc(32, 7),
  });
}

test('OPSH-04: cleanup skips immediately when incident intake owns the lock', async () => {
  /** @type {string[]} */
  const queries = [];
  const runtime = runtimeFor(async (sql) => {
    queries.push(sql);
    return { rows: [{ acquired: false }] };
  });
  assert.deepEqual(await runtime.cleanup(), {
    skipped: true,
    deleted: 0,
    batchFull: false,
  });
  assert.match(queries.join('\n'), /lock_timeout = '100ms'/u);
  assert.match(queries.join('\n'), /statement_timeout = '1s'/u);
  assert.match(queries.join('\n'), /pg_try_advisory_xact_lock/u);
  assert.equal(
    queries.some((sql) => /DELETE|UPDATE/u.test(sql)),
    false,
  );
});

test('OPSH-04: cleanup bounds deletion to technical incident tables and reports a full batch', async () => {
  /** @type {string[]} */
  const queries = [];
  const runtime = runtimeFor(async (sql) => {
    queries.push(sql);
    if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] };
    return { rows: sql.startsWith('DELETE') ? Array(1000).fill({}) : [] };
  });
  assert.deepEqual(await runtime.cleanup(), {
    skipped: false,
    deleted: 3000,
    batchFull: true,
  });
  const deletes = queries.filter((sql) => sql.startsWith('DELETE'));
  assert.equal(deletes.length, 3);
  for (const sql of deletes) {
    assert.match(sql, /^DELETE FROM crm\.operational_incident/u);
    assert.match(sql, /LIMIT 1000/u);
    assert.match(sql, /< now\(\) - interval '14 days'/u);
  }
  assert.match(deletes[2], /NOT EXISTS.*operational_incident_receipts/u);
  assert.match(deletes[2], /NOT EXISTS.*operational_incident_history/u);
  assert.equal(
    queries.some((sql) => sql.startsWith('UPDATE')),
    false,
  );
});

test('OPSH-04: loading the console collects sources but never invokes cleanup', async () => {
  /** @type {string[]} */
  const queries = [];
  const runtime = runtimeFor(async (sql) => {
    queries.push(sql);
    return { rows: [] };
  });
  const result = await runtime.list({
    cookie: 'crm_session=synthetic',
    secFetchSite: 'same-origin',
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.collectionPending, false);
  assert.equal(
    queries.some((sql) => /DELETE|pg_try_advisory/u.test(sql)),
    false,
  );
  assert.ok(queries.some((sql) => sql.includes('LIMIT 501')));
  const windows = queries.filter((sql) => sql.includes("interval '"));
  assert.ok(windows.length >= 3);
  for (const sql of windows) {
    assert.match(sql, /interval '14 days'/u);
    assert.doesNotMatch(sql, /interval '30 days'/u);
  }
});

test(
  'OPSH-04 live: the 14-day projection is accurate before bounded physical deletion',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Session-local tables isolate this contract test from all CRM schemas.
      await client.query(`CREATE TEMP TABLE operational_incidents (
        id text PRIMARY KEY, source text, code text, status text,
        occurrences bigint, first_seen_at timestamptz, last_seen_at timestamptz,
        updated_at timestamptz, version integer, request_id uuid, correlation_id uuid
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE operational_incident_receipts (
        event_key text PRIMARY KEY, incident_id text REFERENCES operational_incidents(id) ON DELETE CASCADE,
        observed_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE operational_incident_history (
        id text PRIMARY KEY, incident_id text REFERENCES operational_incidents(id) ON DELETE CASCADE,
        status text, occurred_at timestamptz, version integer
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO operational_incidents VALUES
        ('mixed','api','API_5XX','new',999,now()-interval '20 days',now(),now(),7,NULL,NULL),
        ('expired','api','API_NOT_READY','new',1001,now()-interval '15 days',now()-interval '15 days',now(),9,NULL,NULL)`);
      await client.query(`INSERT INTO operational_incident_receipts VALUES
        ('old-mixed','mixed',now()-interval '15 days'),
        ('boundary','mixed',now()-interval '14 days'),
        ('recent','mixed',now())`);
      await client.query(`INSERT INTO operational_incident_receipts
        SELECT 'old-'||n,'expired',now()-interval '16 days' FROM generate_series(1,1001) n`);
      await client.query(`INSERT INTO operational_incident_history VALUES
        ('old-history','mixed','new',now()-interval '15 days',1),
        ('recent-history','mixed','investigating',now(),7)`);
      const runtime = runtimeFor(async (sql) => {
        if (
          sql.includes('WITH sources AS') ||
          sql.startsWith('SELECT c.command_id, extract')
        )
          return { rows: [] };
        return client.query(
          sql.replaceAll('crm.operational_', 'pg_temp.operational_'),
        );
      });
      const input = {
        cookie: 'crm_session=synthetic',
        secFetchSite: 'same-origin',
        view: 'history',
      };
      const before = await runtime.list(input);
      assert.equal(before.items.length, 1);
      assert.equal(before.items[0].occurrences, 2);
      assert.equal(before.items[0].activeCount, 2);
      assert.equal(before.items[0].version, 7);
      assert.equal(before.items[0].history.length, 1);
      assert.equal(before.items[0].history[0].status, 'investigating');
      assert.equal(
        before.items[0].firstSeenAt,
        (
          await client.query("SELECT (now()-interval '14 days') AS boundary")
        ).rows[0].boundary.toISOString(),
      );
      assert.equal((await runtime.cleanup()).batchFull, true);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS total FROM operational_incident_receipts WHERE incident_id='expired'",
          )
        ).rows[0].total,
        1,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS total FROM operational_incidents WHERE id='expired'",
          )
        ).rows[0].total,
        1,
      );
      await runtime.cleanup();
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS total FROM operational_incidents WHERE id='expired'",
          )
        ).rows[0].total,
        0,
      );
      assert.deepEqual((await runtime.list(input)).items, before.items);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  },
);
