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

test(
  'OPS-INBOX-ACK-04 live: exact legacy manifest archives operational work without changing effects or history',
  { skip: !connectionString },
  async () => {
    assert.equal(
      new URL(/** @type {string} */ (connectionString)).pathname,
      '/crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const identity = createIdentityApiRuntime(database, environment);
    const runtime = createHealthErrorsRuntime({
      database,
      identity,
      envelopeKey,
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
        'archive-admin',
        'admin@crm-silmer.local',
        'Vendedor',
        true,
      );
      const otherAdmin = await seedUser(
        pool,
        'archive-other',
        'other@example.test',
        'Vendedor',
        true,
      );
      const envelope = JSON.stringify({
        algorithm: 'AES-256-GCM',
        keyVersion: 1,
        version: 1,
      });
      await pool.query(
        "INSERT INTO crm.contacts(id,created_at,updated_at) VALUES('archive-contact',now(),now())",
      );
      await pool.query(
        `INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,
          external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at)
         VALUES('archive-identity','archive-contact','meta','synthetic','instagram',$1,'handle','pending',$2::jsonb,now(),now())`,
        ['b'.repeat(64), envelope],
      );
      for (const id of ['archive-conversation', 'archive-other-conversation'])
        await pool.query(
          `INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,
             external_conversation_id,cycle_number,state,automation_state,automation_epoch,version,opened_at,last_message_at)
           VALUES($1,'archive-identity','meta','synthetic',$1,1,'nova','human',0,1,now(),now())`,
          [id],
        );

      // Twelve retired commands, one current Evolution command and two jobs
      // whose late confirmations were reconciled by the previous correction.
      for (let index = 0; index < 15; index += 1) {
        const known = index >= 13;
        const status = known ? 'sent' : 'outcome_unknown';
        const commandId = `archive-command-${index}`;
        const messageId = `archive-message-${index}`;
        await pool.query(
          `INSERT INTO crm.messages(id,conversation_id,provider,provider_account_id,command_id,direction,
             author_kind,author_id,message_type,content_envelope,key_version,status,occurred_at,created_at,
             delivery_status,delivery_status_at,sent_at,external_message_id)
           VALUES($1,'archive-conversation','meta','synthetic',$2,'outbound','human','archive-admin',
             'text',$3::jsonb,1,$4,now(),now(),$4,now(),CASE WHEN $4='sent' THEN now() END,$5)`,
          [
            messageId,
            commandId,
            envelope,
            status,
            known ? `synthetic-external-${index}` : null,
          ],
        );
        await pool.query(
          `INSERT INTO crm.n8n_commands(command_id,conversation_id,message_id,action,actor_id,actor_kind,
             automation_epoch,fingerprint,payload_envelope,status,last_error_code,retryable,retry_safe,
             created_at,updated_at,completed_at,external_message_id)
           VALUES($1,'archive-conversation',$2,'send_message','archive-admin','human',0,$3,$4::jsonb,$5,
             CASE WHEN $5='sent' THEN NULL ELSE 'N8N_COMMAND_TIMEOUT' END,false,false,now(),now(),now(),$6)`,
          [
            commandId,
            messageId,
            'a'.repeat(64),
            envelope,
            status,
            known ? `synthetic-external-${index}` : null,
          ],
        );
        await pool.query(
          `INSERT INTO crm.n8n_events(id,idempotency_scope,idempotency_key,external_event_id,event_type,
             fingerprint,conversation_id,message_id,correlation_id,occurred_at,processed_at,
             workflow_key,workflow_version,execution_id)
           VALUES($1,'archive-fixture',$1,$1,'message.send.requested',$2,'archive-conversation',$3,$1,
             now(),now(),'whatsapp-mvp',$4,$1)`,
          [
            `archive-event-${index}`,
            'a'.repeat(64),
            messageId,
            index < 12 ? 'waha-webjs-1' : 'evolution-baileys-1',
          ],
        );
        if (index === 0) continue; // The earliest WAHA command has no queue row.
        const jobId = `archive-job-${index}`;
        await pool.query(
          `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,message_id,n8n_command_id,status,
             available_at,created_at,updated_at,completed_at,queue,attempt_count,max_attempts,effect_policy,last_error_code)
           VALUES($1,'n8n.command.deliver',$2,$3,$2,'outcome_unknown',now(),now(),now(),now(),
             'external_effects',1,8,'manual','N8N_COMMAND_TIMEOUT')`,
          [jobId, commandId, messageId],
        );
        await pool.query(
          `INSERT INTO crm.processing_attempts(id,job_id,attempt_no,worker_id,state,provider,started_at,
             effect_started_at,heartbeat_at,finished_at,error_code,retry_safe)
           VALUES($1,$2,1,'synthetic-worker','outcome_unknown','n8n',now(),now(),now(),now(),'N8N_COMMAND_TIMEOUT',false)`,
          [`archive-attempt-${index}`, jobId],
        );
        await pool.query(
          `INSERT INTO crm.reconciliation_items(id,job_id,status,reason,created_at)
           VALUES($1,$2,'open','external_outcome_unknown',now())`,
          [`archive-reconciliation-${index}`, jobId],
        );
      }
      // An unrelated conversation's WAHA receipt cannot reclassify Evolution.
      await pool.query(
        `INSERT INTO crm.n8n_events(id,idempotency_scope,idempotency_key,external_event_id,event_type,
           fingerprint,conversation_id,message_id,correlation_id,occurred_at,processed_at,
           workflow_key,workflow_version,execution_id)
         VALUES('archive-wrong-scope','archive-fixture','wrong-scope','wrong-scope','message.send.requested',
           $1,'archive-other-conversation','archive-message-12','synthetic-correlation',now(),now(),
           'whatsapp-mvp','waha-webjs-1','wrong-execution')`,
        ['c'.repeat(64)],
      );
      const read = (view = 'active') =>
        api.inject({
          url: `/api/v1/admin/health-errors?view=${view}`,
          headers: admin,
        });
      let answer = await read('history');
      assert.equal(answer.statusCode, 200, answer.body);
      assert.equal(answer.json().legacyArchive.count, 12);
      assert.equal(
        answer
          .json()
          .items.find(
            (/** @type {any} */ item) => item.code === 'WORKER_OUTCOME_UNKNOWN',
          ).occurrences,
        14,
      );
      assert.equal(
        answer
          .json()
          .items.find(
            (/** @type {any} */ item) => item.code === 'N8N_OUTCOME_UNKNOWN',
          ).occurrences,
        13,
      );
      await pool.query(
        "UPDATE crm.outbox_jobs SET status='completed',last_error_code=NULL WHERE id IN('archive-job-13','archive-job-14')",
      );
      await pool.query(
        "UPDATE crm.reconciliation_items SET status='resolved',resolved_at=now() WHERE job_id IN('archive-job-13','archive-job-14')",
      );
      answer = await read();
      const manifest = answer.json().legacyArchive;
      assert.deepEqual(
        answer
          .json()
          .items.map((/** @type {any} */ item) => item.activeCount)
          .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b),
        [12, 13],
      );

      const archive = (
        key = 'archive-exact',
        body = manifest,
        headers = admin,
      ) =>
        api.inject({
          url: '/api/v1/admin/health-errors/legacy/archive',
          method: 'POST',
          headers: { ...headers, 'idempotency-key': key },
          payload: body,
        });
      const originalEffects = async () => {
        const snapshots = [];
        for (const table of [
          'n8n_commands',
          'messages',
          'outbox_jobs',
          'processing_attempts',
          'reconciliation_items',
          'n8n_events',
          'operational_incidents',
          'operational_incident_receipts',
          'operational_incident_history',
        ])
          snapshots.push(
            (
              await pool.query(
                `SELECT to_jsonb(t) AS row FROM crm.${table} t ORDER BY to_jsonb(t)::text`,
              )
            ).rows,
          );
        return snapshots;
      };
      const original = await originalEffects();

      // PostgreSQL revisions retain microseconds. Two changes within the same
      // JavaScript millisecond must invalidate the reviewed manifest too.
      const originalRevision = (
        await pool.query(
          "SELECT created_at::text AS created_at,updated_at::text AS updated_at FROM crm.n8n_commands WHERE command_id='archive-command-0'",
        )
      ).rows[0];
      try {
        // Keep this temporary fixture revision outside the diagnostics window
        // so the comparison itself cannot manufacture historical occurrences.
        await pool.query(
          `UPDATE crm.n8n_commands SET created_at=now()-interval '32 days',
             updated_at=date_trunc('milliseconds',now()-interval '31 days')+interval '100 microseconds'
           WHERE command_id='archive-command-0'`,
        );
        const microsecondManifest = (await read()).json().legacyArchive;
        await pool.query(
          "UPDATE crm.n8n_commands SET updated_at=updated_at+interval '100 microseconds' WHERE command_id='archive-command-0'",
        );
        const nextRevision = (await read()).json().legacyArchive;
        assert.equal(nextRevision.count, microsecondManifest.count);
        assert.notEqual(
          nextRevision.fingerprint,
          microsecondManifest.fingerprint,
        );
        assert.equal(
          (await archive('stale-microsecond-revision', microsecondManifest))
            .statusCode,
          409,
        );
      } finally {
        await pool.query(
          'UPDATE crm.n8n_commands SET created_at=$1::timestamptz,updated_at=$2::timestamptz WHERE command_id=$3',
          [
            originalRevision.created_at,
            originalRevision.updated_at,
            'archive-command-0',
          ],
        );
      }
      assert.deepEqual(await originalEffects(), original);
      for (const headers of [
        otherAdmin,
        { ...admin, authorization: 'Basic synthetic' },
        { ...admin, origin: 'https://other.example.test' },
        { ...admin, 'x-csrf-token': 'wrong' },
      ])
        assert.equal(
          (await archive('denied-archive', manifest, headers)).statusCode,
          403,
        );
      assert.equal(
        (
          await archive('invalid-archive', {
            ...manifest,
            commandIds: ['archive-command-12'],
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await archive('stale-archive', {
            ...manifest,
            fingerprint: '0'.repeat(64),
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await archive('wrong-count', { ...manifest, count: 11 })).statusCode,
        409,
      );
      assert.deepEqual(await originalEffects(), original);

      // A command outcome committed after the operator's GET invalidates the
      // entire manifest; no partial archive is allowed while it changes.
      const callbackTransaction = await pool.connect();
      try {
        await callbackTransaction.query('BEGIN');
        await callbackTransaction.query(
          "UPDATE crm.n8n_commands SET status='sent' WHERE command_id='archive-command-0'",
        );
        const concurrentArchive = archive('concurrent-command-outcome');
        await callbackTransaction.query('COMMIT');
        assert.equal((await concurrentArchive).statusCode, 409);
      } finally {
        await callbackTransaction.query('ROLLBACK');
        callbackTransaction.release();
      }
      assert.equal(
        (await pool.query('SELECT * FROM crm.n8n_command_operational_archives'))
          .rows.length,
        0,
      );
      await pool.query(
        "UPDATE crm.n8n_commands SET status='outcome_unknown' WHERE command_id='archive-command-0'",
      );
      assert.deepEqual(await originalEffects(), original);

      await pool.query(`CREATE FUNCTION crm.reject_synthetic_archive_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='health.errors.legacy_archive' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
      await pool.query(
        'CREATE TRIGGER reject_synthetic_archive_audit BEFORE INSERT ON crm.audit_events FOR EACH ROW EXECUTE FUNCTION crm.reject_synthetic_archive_audit()',
      );
      assert.equal((await archive('rollback-archive')).statusCode, 503);
      assert.equal(
        (await pool.query('SELECT * FROM crm.n8n_command_operational_archives'))
          .rows.length,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM crm.idempotency_records WHERE idempotency_key='rollback-archive'",
          )
        ).rows.length,
        0,
      );
      await pool.query(
        'DROP TRIGGER reject_synthetic_archive_audit ON crm.audit_events',
      );
      await pool.query('DROP FUNCTION crm.reject_synthetic_archive_audit()');

      const results = await Promise.all([
        archive('archive-race-a'),
        archive('archive-race-b'),
      ]);
      assert.deepEqual(
        results.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      const winnerIndex = results.findIndex(
        (result) => result.statusCode === 200,
      );
      const winner = results[winnerIndex];
      const winnerKey = winnerIndex === 0 ? 'archive-race-a' : 'archive-race-b';
      assert.equal(winner.json().archivedCount, 12);
      assert.deepEqual((await archive(winnerKey)).json(), winner.json());
      assert.equal((await archive('stale-after-archive')).statusCode, 409);
      assert.equal(
        (await archive(winnerKey, { ...manifest, count: 11 })).statusCode,
        409,
      );
      assert.deepEqual(await originalEffects(), original);
      const markers = (
        await pool.query(
          'SELECT command_id,archived_by,reason_code,version FROM crm.n8n_command_operational_archives ORDER BY command_id',
        )
      ).rows;
      assert.equal(markers.length, 12);
      assert.equal(
        markers.some((row) => row.command_id === 'archive-command-12'),
        false,
      );
      assert.equal(
        markers.every(
          (row) => row.archived_by === 'archive-admin' && row.version === 1,
        ),
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM crm.audit_events WHERE action='health.errors.legacy_archive'",
          )
        ).rows.length,
        12,
      );
      answer = await read();
      assert.equal(answer.json().legacyArchive.count, 0);
      assert.equal(answer.json().items.length, 2);
      assert.equal(answer.json().activeSummary.new, 2);
      assert.equal(
        answer
          .json()
          .items.every((/** @type {any} */ item) => item.activeCount === 1),
        true,
      );
      assert.deepEqual(
        (await read('history'))
          .json()
          .items.map((/** @type {any} */ item) => item.occurrences)
          .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b),
        [13, 14],
      );
      assert.doesNotMatch(
        answer.body,
        /archive-command|archive-message|archive-contact|archive-admin|N8N_COMMAND_TIMEOUT/u,
      );

      await pool.query(
        "UPDATE crm.users SET disabled_at=now() WHERE id='archive-admin'",
      );
      assert.equal((await archive(winnerKey)).statusCode, 403);
      await pool.query(
        "UPDATE crm.users SET disabled_at=NULL WHERE id='archive-admin'",
      );

      // Archival is not a delivery gate: an authenticated late callback remains
      // valid and preserves the marker instead of granting another send.
      const { PostgresN8nIntegrationRepository } =
        await import('../modules/n8n-integration/src/postgres-repository.js');
      const { createN8nIntegrationService } =
        await import('../modules/n8n-integration/src/service.js');
      const integration = createN8nIntegrationService({
        repository: new PostgresN8nIntegrationRepository({
          database,
          envelopeKey,
        }),
      });
      await integration.recordEvent({
        schema_version: '1.0',
        event_id: 'archive-late-confirmation',
        event_type: 'message.sent',
        command_id: 'archive-command-0',
        conversation_id: 'archive-conversation',
        external_message_id: 'synthetic-late-confirmation',
        occurred_at: new Date().toISOString(),
        technical: {
          actor: 'AUTOMATION_EXECUTOR',
          correlationId: 'synthetic-late-correlation',
          credentialVersion: 'current',
          executionId: 'archive-event-0',
          idempotencyKey: 'archive-late-confirmation',
          requestId: 'synthetic-late-request',
          workflowKey: 'whatsapp-mvp',
          workflowVersion: 'waha-webjs-1',
        },
      });
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM crm.n8n_commands WHERE command_id='archive-command-0'",
          )
        ).rows[0].status,
        'sent',
      );
      assert.equal(
        (await pool.query('SELECT * FROM crm.n8n_command_operational_archives'))
          .rows.length,
        12,
      );
      assert.equal(
        (await pool.query('SELECT * FROM crm.n8n_commands')).rows.length,
        15,
      );

      // Diagnostic retention cannot erase the independent operational marker.
      await pool.query(
        "UPDATE crm.operational_incident_receipts SET observed_at=now()-interval '31 days'",
      );
      await pool.query(
        "UPDATE crm.operational_incidents SET first_seen_at=now()-interval '31 days',last_seen_at=now()-interval '31 days'",
      );
      await runtime.cleanup();
      assert.equal(
        (await pool.query('SELECT * FROM crm.operational_incidents')).rows
          .length,
        0,
      );
      assert.equal(
        (await pool.query('SELECT * FROM crm.n8n_command_operational_archives'))
          .rows.length,
        12,
      );
      const afterRetention = await read();
      assert.equal(afterRetention.json().legacyArchive.count, 0);
      assert.equal(
        afterRetention
          .json()
          .items.every((/** @type {any} */ item) => item.activeCount === 1),
        true,
      );
    } finally {
      await api.close();
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  },
);
