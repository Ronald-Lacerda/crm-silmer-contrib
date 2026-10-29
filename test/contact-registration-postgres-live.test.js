import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import { createOperationReadRuntime } from '../apps/api/src/operation-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 21);
const ENVIRONMENT = Object.freeze({
  CONTACT_IDENTITY_ENVELOPE_KEY: KEY.toString('base64url'),
  CONTACT_IDENTITY_LOOKUP_KEY: Buffer.alloc(32, 22).toString('base64url'),
  HANDOFF_ENVELOPE_KEY: Buffer.alloc(32, 23).toString('base64url'),
  INBOX_MESSAGE_ENVELOPE_KEY: Buffer.alloc(32, 24).toString('base64url'),
  IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 25).toString('base64url'),
  OPERATION_CURSOR_HMAC_KEY: Buffer.alloc(32, 26).toString('base64url'),
});
const REGISTRATION = Object.freeze({
  personType: 'individual',
  document: '529.982.247-25',
  legalName: 'Nome Completo Sintetico',
  instagram: '@cliente.sintetico',
  stateRegistration: null,
  postalCode: '01310-100',
  city: 'Cidade Sintetica',
  state: 'SP',
  street: 'Rua Sintetica',
  district: 'Bairro Sintetico',
  number: 's/n',
  complement: null,
});

if (connectionString) {
  test('PostgreSQL live: 0044 registration is encrypted, versioned, idempotent and private in the list', async () => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(`INSERT INTO crm.users (id, email, password_hash, name)
        VALUES ('seller-1', 'seller-1@example.test', '$argon2id$synthetic', 'Vendedor Sintetico')`);
      const operations = createOperationReadRuntime(database, {
        environment: ENVIRONMENT,
      });
      const actor = { id: 'seller-1' };
      const created = await operations.createContact({
        actor,
        correlationId: 'correlation-create',
        displayName: 'Cliente Sintetico',
        email: 'cliente@example.test',
        idempotencyKey: 'registration-live-create',
        phone: '(11) 98765-4321',
      });
      const contactId = created.contact.id;

      const before = await operations.getContact({ contactId });
      assert.equal(before.contact.registration, null);
      assert.equal(before.contact.registrationStatus, 'incomplete');

      // The completeness flag cannot exist without its envelope.
      await assert.rejects(
        pool.query(
          'UPDATE crm.contacts SET registration_fields_complete = true WHERE id = $1',
          [contactId],
        ),
        { code: '23514' },
      );
      await assert.rejects(
        pool.query(
          `UPDATE crm.contacts SET registration_envelope = '{"algorithm":"none"}'::jsonb WHERE id = $1`,
          [contactId],
        ),
        { code: '23514' },
      );

      const base = {
        actor,
        contactId,
        correlationId: 'correlation-registration',
        expectedVersion: 1,
        registration: REGISTRATION,
      };
      // Two operators save the same version at once: exactly one wins.
      const keys = ['registration-live-1', 'registration-live-concurrent'];
      const settled = await Promise.allSettled(
        keys.map((idempotencyKey) =>
          operations.setContactRegistration({ ...base, idempotencyKey }),
        ),
      );
      const winner = settled.findIndex(
        (outcome) => outcome.status === 'fulfilled',
      );
      assert.notEqual(winner, -1);
      const loser = /** @type {PromiseRejectedResult} */ (settled[1 - winner]);
      assert.equal(loser.status, 'rejected');
      assert.equal(loser.reason.code, 'CONTACT_CONFLICT');
      const command = { ...base, idempotencyKey: keys[winner] };
      const result = /** @type {PromiseFulfilledResult<any>} */ (
        settled[winner]
      ).value;
      assert.equal(result.version, 2);
      assert.equal(result.registrationStatus, 'complete');
      assert.equal(result.registration.document, '52998224725');
      assert.equal(result.registration.number, 'S/N');

      assert.deepEqual(
        await operations.setContactRegistration(command),
        result,
      );
      await assert.rejects(
        operations.setContactRegistration({
          ...command,
          registration: { ...REGISTRATION, number: '10' },
        }),
        { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 },
      );

      const stored = await pool.query(
        `SELECT registration_envelope, registration_fields_complete, version
         FROM crm.contacts WHERE id = $1`,
        [contactId],
      );
      assert.equal(stored.rows[0].registration_fields_complete, true);
      assert.equal(Number(stored.rows[0].version), 2);
      const privateValues =
        /52998224725|529\.982|Nome Completo Sintetico|cliente\.sintetico|Rua Sintetica|01310/u;
      assert.doesNotMatch(
        JSON.stringify(stored.rows[0].registration_envelope),
        privateValues,
      );
      const trail = await pool.query(
        `SELECT
           (SELECT json_agg(audit) FROM crm.audit_events audit
            WHERE action = 'contact.registration.updated') audits,
           (SELECT json_agg(event) FROM crm.domain_events event
            WHERE event_type = 'contact.registration.updated') events,
           (SELECT json_agg(record) FROM crm.idempotency_records record
            WHERE scope = 'contact.registration.update') records`,
      );
      const { audits, events, records } = trail.rows[0];
      assert.equal(audits.length, 1);
      assert.equal(audits[0].reason, 'CONTACT_REGISTRATION');
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].payload, { contactId });
      assert.equal(records.length, 1);
      // The immutable record keeps only id, version and status (ADR 047).
      const kept = await new PostgresIdempotencyRecordStore({
        database,
        envelopeKey: Buffer.alloc(32, 25),
      }).get({
        key: command.idempotencyKey,
        scope: 'contact.registration.update',
      });
      assert.deepEqual(kept?.response, {
        id: contactId,
        registrationStatus: 'complete',
        version: 2,
      });
      assert.doesNotMatch(
        JSON.stringify({ audits, events, records }),
        privateValues,
      );

      const detail = await operations.getContact({ contactId });
      assert.deepEqual(detail.contact.registration, result.registration);
      assert.equal(detail.contact.registrationStatus, 'complete');
      const page = await operations.listContacts({ limit: 10 });
      const item = page.items.find(
        (/** @type {any} */ contact) => contact.id === contactId,
      );
      assert.equal(item.registrationStatus, 'complete');
      assert.equal('registration' in item, false);
      assert.doesNotMatch(JSON.stringify(page), privateValues);

      const cleared = await operations.setContactRegistration({
        ...command,
        expectedVersion: 2,
        idempotencyKey: 'registration-live-2',
        registration: { personType: 'company' },
      });
      assert.equal(cleared.version, 3);
      assert.equal(cleared.registrationStatus, 'incomplete');
      const after = await operations.listContacts({ limit: 10 });
      assert.equal(
        after.items.find(
          (/** @type {any} */ contact) => contact.id === contactId,
        ).registrationStatus,
        'incomplete',
      );
    } finally {
      await pool.end();
    }
  });
}
