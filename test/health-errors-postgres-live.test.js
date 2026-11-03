import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import { createHealthErrorsRuntime } from '../apps/api/src/health-errors-runtime.js';
import { createServerApi } from '../apps/api/src/server.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const origin = 'https://crm.example.test';
const envelopeKey = Buffer.alloc(32, 13);
const environment = {
  APP_ORIGIN: origin,
  AUTH_THROTTLE_HMAC_KEY: envelopeKey.toString('base64url'),
  IDEMPOTENCY_ENVELOPE_KEY: envelopeKey.toString('base64url'),
  IDENTITY_BOOTSTRAP_TOKEN: 'synthetic-bootstrap-secret-at-least-32-characters',
};

/** @param {Pool} pool @param {string} id @param {string} email @param {string} role @param {boolean} admin */
async function seedUser(pool, id, email, role, admin) {
  await pool.query(
    "INSERT INTO crm.users (id, email, password_hash, name) VALUES ($1, $2, '$argon2id$synthetic', 'Conta sintética')",
    [id, email],
  );
  await pool.query(
    'INSERT INTO crm.user_functions (user_id, function_name) VALUES ($1, $2)',
    [id, role],
  );
  if (admin)
    await pool.query(
      "INSERT INTO crm.user_capabilities (user_id, capability) VALUES ($1, 'COMMERCIAL_ADMIN')",
      [id],
    );
  const sessionToken = `synthetic-session-${id}`;
  const csrf = `synthetic-csrf-${id}`;
  await pool.query(
    `INSERT INTO crm.sessions (token_hash, user_id, csrf_hash, absolute_expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [
      createHash('sha256').update(sessionToken).digest('hex'),
      id,
      createHash('sha256').update(csrf).digest('hex'),
    ],
  );
  return {
    cookie: `crm_session=${sessionToken}; crm_csrf=${csrf}`,
    origin,
    'x-csrf-token': csrf,
  };
}

test(
  'OPS-ERR live: identity restriction, durable intake, triage/replay/races, recurrence, privacy and retention',
  { skip: !connectionString },
  async () => {
    // This suite drops only the explicitly named disposable CI database schemas.
    assert.equal(
      new URL(/** @type {string} */ (connectionString)).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {(client: any) => Promise<any>} */ work) =>
        withTransaction(pool, work),
    };
    const identity = createIdentityApiRuntime(database, environment);
    let observedAt = new Date();
    const runtime = createHealthErrorsRuntime({
      database,
      identity,
      envelopeKey,
      clock: () => observedAt,
    });
    const api = createServerApi({
      environment: {},
      identity,
      healthErrors: runtime,
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
    });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      const admin = await seedUser(
        pool,
        'console-admin',
        'admin@crm-silmer.local',
        'Vendedor',
        true,
      );
      const otherAdmin = await seedUser(
        pool,
        'other-admin',
        'other-admin@example.test',
        'Vendedor',
        true,
      );
      const seller = await seedUser(
        pool,
        'console-seller',
        'seller@example.test',
        'Vendedor',
        false,
      );
      const finance = await seedUser(
        pool,
        'console-finance',
        'finance@example.test',
        'Financeiro',
        false,
      );

      await runtime.recordApiFailure({
        statusCode: 500,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      await runtime.recordApiFailure({
        statusCode: 503,
        requestId: randomUUID(),
      });
      const read = () =>
        api.inject({ url: '/api/v1/admin/health-errors', headers: admin });
      let response = await read();
      assert.equal(response.statusCode, 200, response.body);
      const initial = response
        .json()
        .items.find((/** @type {any} */ item) => item.code === 'API_5XX');
      assert.equal(initial.occurrences, 2);
      assert.equal(initial.status, 'new');
      assert.equal(response.headers['cache-control'], 'private, no-store');
      for (const headers of [
        otherAdmin,
        seller,
        finance,
        { ...admin, authorization: 'Basic synthetic' },
        { ...admin, origin: 'https://other.example.test' },
        { origin },
      ]) {
        const denied = await api.inject({
          url: '/api/v1/admin/health-errors',
          headers,
        });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.doesNotMatch(denied.body, /API_5XX|occurrences/u);
        const deniedWrite = await api.inject({
          url: `/api/v1/admin/health-errors/${initial.id}`,
          method: 'PATCH',
          headers: { ...headers, 'idempotency-key': 'denied' },
          payload: { status: 'resolved', version: initial.version },
        });
        assert.equal(deniedWrite.statusCode, 403, deniedWrite.body);
      }
      const patch = (
        /** @type {string} */ status,
        /** @type {number} */ version,
        /** @type {string} */ key,
      ) =>
        api.inject({
          url: `/api/v1/admin/health-errors/${initial.id}`,
          method: 'PATCH',
          headers: { ...admin, 'idempotency-key': key },
          payload: { status, version },
        });
      const investigated = await patch(
        'investigating',
        initial.version,
        'triage-1',
      );
      assert.equal(investigated.statusCode, 200, investigated.body);
      const replay = await patch('investigating', initial.version, 'triage-1');
      assert.deepEqual(replay.json(), investigated.json());
      assert.equal(
        (await patch('resolved', initial.version, 'triage-1')).statusCode,
        409,
      );
      assert.equal(
        (await patch('resolved', initial.version, 'stale')).statusCode,
        409,
      );
      const races = await Promise.all([
        patch('new', investigated.json().version, 'race-a'),
        patch('resolved', investigated.json().version, 'race-b'),
      ]);
      assert.deepEqual(races.map((item) => item.statusCode).sort(), [200, 409]);
      response = await read();
      let item = response
        .json()
        .items.find((/** @type {any} */ value) => value.id === initial.id);
      const resolved = await patch('resolved', item.version, 'resolve-final');
      assert.equal(resolved.statusCode, 200, resolved.body);
      observedAt = new Date(Date.now() + 1000);
      await runtime.recordApiFailure({ statusCode: 500 });
      item = (await read())
        .json()
        .items.find((/** @type {any} */ value) => value.id === initial.id);
      assert.equal(item.status, 'new');
      assert.equal(item.occurrences, 3);
      assert.equal(item.history.at(-1).status, 'new');
      assert.ok(Number(item.version) > Number(resolved.json().version));

      // A failed audit append must roll back status, history and the receipt.
      const beforeRollback = item;
      await pool.query(`CREATE FUNCTION crm.reject_synthetic_incident_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action = 'health.errors.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
      await pool.query(
        'CREATE TRIGGER reject_synthetic_incident_audit BEFORE INSERT ON crm.audit_events FOR EACH ROW EXECUTE FUNCTION crm.reject_synthetic_incident_audit()',
      );
      assert.equal(
        (await patch('investigating', item.version, 'rollback-proof'))
          .statusCode,
        503,
      );
      await pool.query(
        'DROP TRIGGER reject_synthetic_incident_audit ON crm.audit_events',
      );
      await pool.query('DROP FUNCTION crm.reject_synthetic_incident_audit()');
      const afterRollback = (await read())
        .json()
        .items.find((/** @type {any} */ value) => value.id === initial.id);
      assert.deepEqual(afterRollback, beforeRollback);
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM crm.idempotency_records WHERE idempotency_key='rollback-proof'",
          )
        ).rows.length,
        0,
      );

      // A current DB email/capability/disabled flag defeats both reads and replay.
      await pool.query(
        "UPDATE crm.users SET email = 'changed@example.test' WHERE id = 'console-admin'",
      );
      assert.equal((await read()).statusCode, 403);
      assert.equal(
        (await patch('investigating', initial.version, 'triage-1')).statusCode,
        403,
      );
      await pool.query(
        "UPDATE crm.users SET email = 'admin@crm-silmer.local', disabled_at = now() WHERE id = 'console-admin'",
      );
      assert.equal((await read()).statusCode, 403);
      await pool.query(
        "UPDATE crm.users SET disabled_at = NULL WHERE id = 'console-admin'",
      );
      await pool.query(
        "DELETE FROM crm.user_capabilities WHERE user_id = 'console-admin'",
      );
      assert.equal((await read()).statusCode, 403);
      await pool.query(
        "INSERT INTO crm.user_capabilities(user_id,capability) VALUES ('console-admin', 'COMMERCIAL_ADMIN')",
      );

      // An existing command remains untouched; its raw code never enters intake.
      const envelope = JSON.stringify({
        algorithm: 'AES-256-GCM',
        keyVersion: 1,
        version: 1,
      });
      await pool.query(
        "INSERT INTO crm.contacts(id, provisional, version, created_at, updated_at) VALUES ('contact-errors', false, 1, now(), now())",
      );
      await pool.query(
        `INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,key_version,version,created_at,updated_at)
      VALUES ('identity-errors','contact-errors','meta','synthetic','instagram',$1,'handle','pending',$2::jsonb,1,1,now(),now())`,
        ['1'.repeat(64), envelope],
      );
      await pool.query(`INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,external_conversation_id,cycle_number,state,automation_state,automation_epoch,version,opened_at,last_message_at)
      VALUES ('conversation-errors','identity-errors','meta','synthetic','external-errors',1,'nova','human',0,1,now(),now())`);
      await pool.query(
        `INSERT INTO crm.n8n_commands(command_id,conversation_id,action,actor_id,actor_kind,automation_epoch,fingerprint,payload_envelope,status,last_error_code,created_at,updated_at,completed_at)
      VALUES ('command-errors','conversation-errors','take_over','console-admin','human',0,$1,$2::jsonb,'failed','private@example.test',now(),now(),now())`,
        ['0'.repeat(64), envelope],
      );
      response = await read();
      assert.equal(response.statusCode, 200, response.body);
      const n8n = response
        .json()
        .items.find((/** @type {any} */ value) => value.code === 'N8N_FAILED');
      assert.equal(n8n.occurrences, 1);
      assert.equal(
        (await read())
          .json()
          .items.find((/** @type {any} */ value) => value.code === 'N8N_FAILED')
          .occurrences,
        1,
      );
      assert.doesNotMatch(
        response.body,
        /private@example|command-errors|contact-errors|payload/u,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT status, last_error_code FROM crm.n8n_commands WHERE command_id = 'command-errors'",
          )
        ).rows[0].last_error_code,
        'private@example.test',
      );
      const audits = await pool.query(
        "SELECT count(*)::int AS total FROM crm.audit_events WHERE action = 'health.errors.update'",
      );
      assert.ok(audits.rows[0].total >= 2);

      await pool.query(`INSERT INTO crm.operational_incidents(id,source,code,first_seen_at,last_seen_at,updated_at)
      VALUES ('incident-expired','worker','WORKER_RETRY',now()-interval '31 days',now()-interval '31 days',now()-interval '31 days')`);
      await pool.query(
        `INSERT INTO crm.operational_incident_receipts(event_key,incident_id,observed_at)
      VALUES ($1,'incident-expired',now()-interval '31 days')`,
        ['c'.repeat(64)],
      );
      await runtime.cleanup();
      assert.equal(
        (
          await pool.query(
            "SELECT id FROM crm.operational_incidents WHERE id='incident-expired'",
          )
        ).rows.length,
        0,
      );

      // Deletion/recreation keeps a globally fresh version for the same group.
      await pool.query(
        "UPDATE crm.operational_incident_receipts SET observed_at=now()-interval '31 days' WHERE incident_id=$1",
        [initial.id],
      );
      await pool.query(
        "UPDATE crm.operational_incidents SET first_seen_at=now()-interval '31 days',last_seen_at=now()-interval '31 days' WHERE id=$1",
        [initial.id],
      );
      await runtime.cleanup();
      await runtime.recordApiFailure({ statusCode: 500 });
      const recreated = (await read())
        .json()
        .items.find((/** @type {any} */ value) => value.id === initial.id);
      assert.ok(recreated.version > item.version);
      assert.equal(recreated.occurrences, 1);
      assert.equal(
        (await patch('resolved', initial.version, 'expired-tab')).statusCode,
        409,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT event_key FROM crm.operational_incident_receipts WHERE event_key=$1',
            ['c'.repeat(64)],
          )
        ).rows.length,
        0,
      );
    } finally {
      await api.close();
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  },
);
