import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadMigrations, migrate } from '../modules/database/src/index.js';

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async acquire() {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = next;
    await previous;
    return release;
  }
}

class MigrationPool {
  constructor() {
    this.applied = new Map();
    /** @type {string[]} */
    this.executed = [];
    this.mutex = new Mutex();
  }

  async connect() {
    return new MigrationClient(this);
  }
}

class MigrationClient {
  /** @param {MigrationPool} pool */
  constructor(pool) {
    this.pool = pool;
    /** @type {(() => void) | undefined} */
    this.releaseLock = undefined;
  }

  /**
   * @param {string} sql
   * @param {unknown[]} values
   */
  async query(sql, values = []) {
    if (sql.includes('pg_advisory_lock')) {
      this.releaseLock = await this.pool.mutex.acquire();
      return { rows: [] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      this.releaseLock?.();
      this.releaseLock = undefined;
      return { rows: [{ unlocked: true }] };
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS crm_meta.schema_migrations')) {
      return { rows: [] };
    }
    if (sql.startsWith('SELECT version,')) {
      return { rows: [...this.pool.applied.values()] };
    }
    if (sql.startsWith('INSERT INTO crm_meta.schema_migrations')) {
      const [version, name, phase, checksum] = values;
      this.pool.applied.set(version, { checksum, name, phase, version });
      return { rows: [] };
    }
    if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
      this.pool.executed.push(sql);
    }
    return { rows: [] };
  }

  release() {
    this.releaseLock?.();
  }
}

const expandOne = {
  checksum: 'checksum-1',
  name: 'foundation',
  phase: /** @type {const} */ ('expand'),
  sql: 'CREATE TABLE foundation (id integer)',
  version: '0001',
};
const expandTwo = {
  checksum: 'checksum-2',
  name: 'upgrade',
  phase: /** @type {const} */ ('expand'),
  sql: 'ALTER TABLE foundation ADD COLUMN name text',
  version: '0002',
};
const contractThree = {
  checksum: 'checksum-3',
  name: 'retire_legacy',
  phase: /** @type {const} */ ('contract'),
  sql: 'DROP VIEW legacy_foundation',
  version: '0003',
};

test('migrates an empty database, upgrades once, and is idempotent', async () => {
  const pool = new MigrationPool();

  assert.deepEqual(await migrate(pool, { migrations: [expandOne] }), {
    applied: ['0001'],
    phase: 'expand',
  });
  assert.deepEqual(
    await migrate(pool, { migrations: [expandOne, expandTwo] }),
    { applied: ['0002'], phase: 'expand' },
  );
  assert.deepEqual(
    await migrate(pool, { migrations: [expandOne, expandTwo] }),
    { applied: [], phase: 'expand' },
  );
  assert.deepEqual(pool.executed, [expandOne.sql, expandTwo.sql]);
});

test('serializes concurrent migration runs with a session advisory lock', async () => {
  const pool = new MigrationPool();

  const results = await Promise.all([
    migrate(pool, { migrations: [expandOne, expandTwo] }),
    migrate(pool, { migrations: [expandOne, expandTwo] }),
  ]);

  assert.equal(results.flatMap(({ applied }) => applied).length, 2);
  assert.deepEqual(pool.executed, [expandOne.sql, expandTwo.sql]);
});

test('keeps contract migrations explicit and rejects changed history', async () => {
  const pool = new MigrationPool();
  await migrate(pool, { migrations: [expandOne, contractThree] });
  assert.deepEqual(pool.executed, [expandOne.sql]);

  await migrate(pool, {
    migrations: [expandOne, contractThree],
    phase: 'contract',
  });
  assert.deepEqual(pool.executed, [expandOne.sql, contractThree.sql]);

  await assert.rejects(
    migrate(pool, {
      migrations: [{ ...expandOne, checksum: 'changed' }],
    }),
    /checksum/iu,
  );
});

test('ships the orders table as an expand migration that never touches deals (ADR 004)', async () => {
  const orders = (await loadMigrations()).find(
    ({ version }) => version === '0023',
  );
  assert.ok(orders, 'migration 0023 is present');
  assert.equal(orders.name, 'orders');
  assert.equal(orders.phase, 'expand');
  assert.match(orders.sql, /CREATE TABLE crm\.orders\b/u);
  assert.match(orders.sql, /CREATE SEQUENCE crm\.order_number_seq\b/u);
  assert.doesNotMatch(orders.sql, /crm\.deals/iu);
});

test('moves new valid-file receipts to RustFS and keeps old ones (ADR 023)', async () => {
  const handoff = (await loadMigrations()).find(
    ({ version }) => version === '0028',
  );
  assert.ok(handoff, 'migration 0028 is present');
  assert.equal(handoff.name, 'media_handoff_rustfs');
  assert.equal(handoff.phase, 'expand');
  assert.match(handoff.sql, /DROP CONSTRAINT media_handoff_destination_check/u);
  assert.match(handoff.sql, /CHECK \(destination = 'rustfs'\) NOT VALID;/u);
});

test('ships paid store orders as an expand migration with locked rows (ADRs 027 and 028)', async () => {
  const store = (await loadMigrations()).find(
    ({ version }) => version === '0029',
  );
  assert.ok(store, 'migration 0029 is present');
  assert.equal(store.name, 'store_orders');
  assert.equal(store.phase, 'expand');
  assert.match(
    store.sql,
    /ADD COLUMN origin text NOT NULL DEFAULT 'atendimento'/u,
  );
  assert.match(store.sql, /ALTER COLUMN conversation_id DROP NOT NULL/u);
  assert.match(
    store.sql,
    /CHECK \(\(origin = 'loja'\) = \(conversation_id IS NULL\)\)/u,
  );
  // ADR 028: paid as InfinitePay confirmed it, in full, by Pix.
  assert.match(store.sql, /ADD CONSTRAINT orders_store_paid_by_gateway\b/u);
  assert.match(store.sql, /paid_amount_cents >= final_amount_cents/u);
  assert.match(store.sql, /payment_condition = 'pix'/u);
  assert.match(
    store.sql,
    /CREATE UNIQUE INDEX orders_payment_transaction_nsu\b/u,
  );
  // The shop's number is a label, not a key.
  assert.doesNotMatch(store.sql, /UNIQUE INDEX orders_store_number\b/u);
  assert.doesNotMatch(store.sql, /payment_declared_at/u);
  assert.match(store.sql, /CREATE TABLE crm\.store_order_receipts\b/u);
  // The receipt never stores an IP, an Origin, a phone or a receipt link in
  // the clear.
  assert.doesNotMatch(
    store.sql,
    /\b(?:ip_address|client_ip|ip_digest|request_origin|phone|telefone|receipt_url)\s+text\b/u,
  );
  assert.doesNotMatch(store.sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
});

test('records the first print of a store ficha as an expand migration (ADR 031)', async () => {
  const migration = (await loadMigrations()).find(
    ({ version }) => version === '0034',
  );
  assert.ok(migration, 'migration 0034 is present');
  assert.equal(migration.name, 'store_order_first_print');
  assert.equal(migration.phase, 'expand');
  assert.match(
    migration.sql,
    /ADD COLUMN ficha_first_printed_at timestamptz,/u,
  );
  assert.match(
    migration.sql,
    /ADD COLUMN ficha_first_printed_by text\s+REFERENCES crm\.users \(id\) ON DELETE RESTRICT/u,
  );
  assert.match(migration.sql, /orders_ficha_first_print_pair\b/u);
  assert.match(
    migration.sql,
    /CHECK \(origin = 'loja' OR ficha_first_printed_at IS NULL\)/u,
  );
  // Nullable columns only: the release before keeps working.
  assert.doesNotMatch(migration.sql, /NOT NULL DEFAULT|SET NOT NULL/u);
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
});

test('loads versioned forward-only migrations in deterministic order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-migrations-'));
  try {
    await writeFile(
      join(directory, '0002_upgrade.expand.sql'),
      expandTwo.sql,
      'utf8',
    );
    await writeFile(
      join(directory, '0001_foundation.expand.sql'),
      expandOne.sql,
      'utf8',
    );

    const migrations = await loadMigrations(directory);
    assert.deepEqual(
      migrations.map(({ name, phase, version }) => ({ name, phase, version })),
      [
        { name: 'foundation', phase: 'expand', version: '0001' },
        { name: 'upgrade', phase: 'expand', version: '0002' },
      ],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('adds the automation_failure and partnership handoff reasons and the preferred seller as an expand migration (INBOX-HANDOFF-02)', async () => {
  const migration = (await loadMigrations()).find(
    ({ version }) => version === '0046',
  );
  assert.ok(migration, 'migration 0046 is present');
  assert.equal(migration.name, 'handoff_reasons_preferred_seller');
  assert.equal(migration.phase, 'expand');
  assert.match(migration.sql, /'automation_failure', 'partnership'/u);
  // Every reason the previous release writes stays valid.
  for (const reason of [
    'customer_requested_human',
    'price_before_quote',
    'briefing_complete',
    'low_confidence',
    'iteration_limit',
  ]) {
    assert.match(migration.sql, new RegExp(`'${reason}'`, 'u'));
  }
  assert.match(
    migration.sql,
    /ADD COLUMN preferred_user_id text REFERENCES crm\.users \(id\)/u,
  );
  assert.doesNotMatch(migration.sql, /NOT NULL DEFAULT|SET NOT NULL/u);
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
});

test('ships the assistant turn telemetry as an expand migration without free text (AGENTE-OBS-01)', async () => {
  const migration = (await loadMigrations()).find(
    ({ version }) => version === '0047',
  );
  assert.ok(migration, 'migration 0047 is present');
  assert.equal(migration.name, 'automation_turns');
  assert.equal(migration.phase, 'expand');
  assert.match(migration.sql, /CREATE TABLE crm\.automation_turns\b/u);
  assert.match(
    migration.sql,
    /n8n_event_id text NOT NULL UNIQUE\s+REFERENCES crm\.n8n_events \(id\)/u,
  );
  assert.match(migration.sql, /asked_field text CHECK \(asked_field ~ /u);
  assert.match(migration.sql, /CREATE INDEX automation_turns_occurred\b/u);
  assert.match(migration.sql, /CREATE INDEX automation_turns_conversation\b/u);
  // Codes, counts and times only.
  assert.doesNotMatch(
    migration.sql,
    /\b(?:text_envelope|summary|content|phone|name|message_text)\s+(?:text|jsonb)\b/u,
  );
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
});

test('ships the audio transcript and the assistant delivery code as an expand migration (INBOX-AUDIO-TRANSCRIPT-01, INBOX-DELIVERY-02)', async () => {
  const migration = (await loadMigrations()).find(
    ({ version }) => version === '0048',
  );
  assert.ok(migration, 'migration 0048 is present');
  assert.equal(migration.name, 'message_transcript_delivery_code');
  assert.equal(migration.phase, 'expand');
  // The transcript is customer content: an envelope, never plain text.
  assert.match(migration.sql, /ADD COLUMN transcript_envelope jsonb/u);
  assert.doesNotMatch(migration.sql, /ADD COLUMN transcript_text\b/u);
  assert.match(
    migration.sql,
    /delivery_failure_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'/u,
  );
  assert.match(
    migration.sql,
    /'message\.send\.unknown', 'message\.transcribed'/u,
  );
  assert.doesNotMatch(migration.sql, /NOT NULL DEFAULT|SET NOT NULL/u);
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
});
