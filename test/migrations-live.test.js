import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import { createServerApi } from '../apps/api/src/server.js';
import {
  checkDatabaseReadiness,
  loadMigrations,
  migrate,
} from '../modules/database/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

/**
 * One contact, identity and first-cycle conversation, written in SQL so a
 * test can seed rows between two migrations.
 *
 * @param {Pool} pool @param {string} id @param {number} index @param {Date} openedAt
 */
async function seedLiveConversation(pool, id, index, openedAt) {
  await pool.query(
    `INSERT INTO crm.contacts (id, provisional, version, created_at, updated_at)
     VALUES ($1, false, 1, $2, $2)`,
    [`contact-${id}`, openedAt],
  );
  await pool.query(
    `INSERT INTO crm.contact_identities
       (id, current_contact_id, provider, provider_account_id, channel,
        external_identity_lookup_hash, identity_kind, phone_status,
        identity_envelope, key_version, version, created_at, updated_at)
     VALUES ($1, $2, 'meta', 'account-orders', 'instagram', $3, 'handle',
             'pending', $4::jsonb, 1, 1, $5, $5)`,
    [
      `identity-${id}`,
      `contact-${id}`,
      String(index).padStart(64, '0'),
      JSON.stringify({ algorithm: 'AES-256-GCM', keyVersion: 1, version: 1 }),
      openedAt,
    ],
  );
  await pool.query(
    `INSERT INTO crm.conversations
       (id, contact_identity_id, provider, provider_account_id,
        external_conversation_id, cycle_number, state, automation_state,
        automation_epoch, version, opened_at, last_message_at)
     VALUES ($1, $2, 'meta', 'account-orders', $3, 1, 'nova',
             'assistant', 0, 1, $4, $4)`,
    [id, `identity-${id}`, `external-${id}`, openedAt],
  );
}

if (connectionString) {
  test('PostgreSQL live: zero, upgrade, concurrency, readiness and app rollback', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(
      databaseName,
      'crm_silmer_test',
      'live migration test only resets the dedicated crm_silmer_test database',
    );

    const pool = new Pool({ connectionString, max: 6 });
    const builtIn = (await loadMigrations()).filter(
      ({ version }) => version === '0001',
    );
    const concurrent = {
      checksum: 'live-concurrent-v1',
      name: 'live_concurrent',
      phase: /** @type {const} */ ('expand'),
      sql: 'CREATE TABLE crm.live_concurrent (id integer PRIMARY KEY)',
      version: '9001',
    };
    const upgrade = {
      checksum: 'live-upgrade-v1',
      name: 'live_upgrade',
      phase: /** @type {const} */ ('expand'),
      sql: 'ALTER TABLE crm.live_concurrent ADD COLUMN label text',
      version: '9002',
    };

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');

      assert.deepEqual(await migrate(pool, { migrations: builtIn }), {
        applied: ['0001'],
        phase: 'expand',
      });
      assert.deepEqual(await migrate(pool, { migrations: builtIn }), {
        applied: [],
        phase: 'expand',
      });

      const concurrentResults = await Promise.all([
        migrate(pool, { migrations: [...builtIn, concurrent] }),
        migrate(pool, { migrations: [...builtIn, concurrent] }),
      ]);
      assert.deepEqual(
        concurrentResults.flatMap(({ applied }) => applied),
        ['9001'],
      );

      assert.deepEqual(
        await migrate(pool, {
          migrations: [...builtIn, concurrent, upgrade],
        }),
        { applied: ['9002'], phase: 'expand' },
      );
      assert.equal(
        await checkDatabaseReadiness(pool, builtIn),
        true,
        'the previous app remains compatible after a later expand migration',
      );

      const api = createServerApi({
        logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
        readiness: () => checkDatabaseReadiness(pool, builtIn),
      });
      const response = await api.inject({ url: '/api/health/ready' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'ready');
      await api.close();
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL live: orders keep one pending per conversation and complete confirmations', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(
      databaseName,
      'crm_silmer_test',
      'live migration test only resets the dedicated crm_silmer_test database',
    );

    const pool = new Pool({ connectionString, max: 2 });
    const now = new Date('2026-09-12T12:00:00.000Z');
    /** @param {string} conversationId @param {Record<string, unknown>} [overrides] */
    const insertOrder = async (conversationId, overrides = {}) => {
      const values = {
        confirmed_at: null,
        confirmed_by: null,
        final_amount_cents: null,
        order_date: null,
        payment_condition: null,
        status: 'pendente',
        ...overrides,
      };
      const sequence = Number(
        (await pool.query(`SELECT nextval('crm.order_number_seq') AS n`))
          .rows[0].n,
      );
      await pool.query(
        `INSERT INTO crm.orders
           (id, number_sequence, number, conversation_id, contact_id, status, fab_code,
            ficha_envelope, final_amount_cents, payment_condition, order_date,
            confirmed_at, confirmed_by, created_by_kind, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, '01', '{}'::jsonb, $7, $8, $9, $10, $11,
                 'automation', $12, $12)`,
        [
          `order-${sequence}`,
          sequence,
          `${String(sequence).padStart(2, '0')}-CRM`,
          conversationId,
          `contact-${conversationId}`,
          values.status,
          values.final_amount_cents,
          values.payment_condition,
          values.order_date,
          values.confirmed_at,
          values.confirmed_by,
          now,
        ],
      );
      return sequence;
    };

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      let seeded = 0;
      const seedConversation = async (/** @type {string} */ id) => {
        seeded += 1;
        await seedLiveConversation(pool, id, seeded, now);
      };
      for (const id of [
        'conversation-a',
        'conversation-b',
        'conversation-c',
        'conversation-d',
        'conversation-e',
        'conversation-f',
      ]) {
        await seedConversation(id);
      }

      const first = await insertOrder('conversation-a');
      await assert.rejects(insertOrder('conversation-a'), {
        code: '23505',
        constraint: 'orders_one_pending_per_conversation',
      });
      await insertOrder('conversation-b');

      await assert.rejects(
        pool.query(
          `UPDATE crm.orders SET status = 'confirmado' WHERE number_sequence = $1`,
          [first],
        ),
        { code: '23514', constraint: 'orders_confirmed_fields' },
      );
      await pool.query(
        `UPDATE crm.orders
         SET status = 'confirmado', final_amount_cents = 482000,
             payment_condition = 'pix', order_date = '2026-09-12',
             confirmed_at = $2, confirmed_by = 'seller-orders'
         WHERE number_sequence = $1`,
        [first, now],
      );
      await insertOrder('conversation-a');

      for (const [
        conversation,
        overrides,
        constraint,
      ] of /** @type {const} */ ([
        ['conversation-c', { status: 'cancelado' }, 'orders_status_check'],
        [
          'conversation-d',
          { final_amount_cents: 0 },
          'orders_final_amount_cents_check',
        ],
        [
          'conversation-e',
          { payment_condition: 'boleto' },
          'orders_payment_condition_check',
        ],
      ])) {
        await assert.rejects(insertOrder(conversation, overrides), {
          code: '23514',
          constraint,
        });
      }
      await assert.rejects(
        pool.query(
          `INSERT INTO crm.orders
             (id, number_sequence, number, conversation_id, contact_id, status, fab_code,
              ficha_envelope, created_by_kind, created_at, updated_at)
           VALUES ('order-wrong-number', 999, '12-CRM', 'conversation-f',
                   'contact-conversation-f',
                   'pendente', '01', '{}'::jsonb, 'user', $1, $1)`,
          [now],
        ),
        { code: '23514', constraint: 'orders_number_format' },
      );
      await assert.rejects(
        insertOrder('conversation-missing'),
        { code: '23503' },
        'orders belong to an existing conversation',
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });

  test('PostgreSQL live: 0024 gives existing orders the first contact of their conversation', async () => {
    const databaseName = new URL(connectionString).pathname.slice(1);
    assert.equal(
      databaseName,
      'crm_silmer_test',
      'live migration test only resets the dedicated crm_silmer_test database',
    );

    const pool = new Pool({ connectionString, max: 2 });
    const openedAt = new Date('2026-09-01T13:05:00.000Z');
    const createdAt = new Date('2026-09-12T12:00:00.000Z');
    const migrations = await loadMigrations();
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, {
        migrations: migrations.filter(({ version }) => version < '0024'),
      });
      await seedLiveConversation(pool, 'conversation-old', 1, openedAt);
      await pool.query(
        `INSERT INTO crm.orders
           (id, number_sequence, number, conversation_id, status, fab_code,
            ficha_envelope, created_by_kind, created_at, updated_at)
         VALUES ('order-old', 1, '01-CRM', 'conversation-old', 'pendente',
                 '01', '{}'::jsonb, 'automation', $1, $1)`,
        [createdAt],
      );

      assert.deepEqual(
        await migrate(pool, {
          migrations: migrations.filter(({ version }) => version <= '0024'),
        }),
        { applied: ['0024'], phase: 'expand' },
      );
      const { rows } = await pool.query(
        `SELECT first_contact_at, paid_on, delivered_on, version, updated_at
         FROM crm.orders WHERE id = 'order-old'`,
      );
      assert.deepEqual(rows, [
        {
          delivered_on: null,
          first_contact_at: openedAt,
          paid_on: null,
          updated_at: createdAt,
          version: 1,
        },
      ]);
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}

if (connectionString) {
  test('PostgreSQL live: 0041 fills only missing manual first contact and preserves the ficha', async () => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 2 });
    const migrations = (await loadMigrations()).filter(
      ({ version }) => version <= '0041',
    );
    const createdAt = new Date('2026-10-21T14:00:00.000Z');
    const recordedAt = new Date('2026-10-20T12:00:00.000Z');
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, {
        migrations: migrations.filter(({ version }) => version < '0041'),
      });
      await seedLiveConversation(pool, 'manual-first-contact', 1, recordedAt);
      await pool.query(`INSERT INTO crm.users (id, email, password_hash, name)
        VALUES ('manual-owner', 'manual-owner@example.test', '$argon2id$synthetic', 'Vendedor Sintetico')`);
      for (let index = 1; index <= 3; index += 1) {
        await pool.query(
          `INSERT INTO crm.orders
          (id, number_sequence, number, conversation_id, contact_id, manual_owner_id,
           manual_create_key, status, fab_code, ficha_envelope, created_by_kind,
           created_by, created_at, updated_at, first_contact_at)
          VALUES ($1, $2, $3, $4, 'contact-manual-first-contact', $5, $6,
            'pendente', '01', '{"snapshot":"synthetic"}'::jsonb, 'user', 'manual-owner', $7, $7, $8)`,
          [
            `manual-date-${index}`,
            index,
            `0${index}-CRM`,
            index === 3 ? 'manual-first-contact' : null,
            index === 3 ? null : 'manual-owner',
            index === 3 ? null : `manual-key-${index}`,
            createdAt,
            index === 2 ? recordedAt : null,
          ],
        );
      }
      assert.deepEqual(await migrate(pool, { migrations }), {
        applied: ['0041'],
        phase: 'expand',
      });
      const result =
        await pool.query(`SELECT id, first_contact_at, ficha_envelope, version, updated_at
        FROM crm.orders ORDER BY id`);
      assert.deepEqual(
        result.rows.map((row) => row.first_contact_at),
        [createdAt, recordedAt, null],
      );
      for (const row of result.rows) {
        assert.deepEqual(row.ficha_envelope, { snapshot: 'synthetic' });
        assert.equal(row.version, 1);
        assert.deepEqual(row.updated_at, createdAt);
      }
      assert.deepEqual(await migrate(pool, { migrations }), {
        applied: [],
        phase: 'expand',
      });
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
}
