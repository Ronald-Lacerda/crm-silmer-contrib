import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createOrderRuntime } from '../apps/api/src/order-runtime.js';
import { PostgresAuditTrail } from '../modules/audit-privacy/src/index.js';
import { PostgresIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { syntheticItems, syntheticArtwork } from './fixtures/order-items.js';

const connectionString = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 91);
const NOW = new Date('2026-11-05T12:00:00Z');
const OWNER = { id: 'source-owner', kind: 'human', capabilities: [] };
const ADMIN = {
  id: 'source-admin',
  kind: 'human',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const OTHER = { id: 'source-other', kind: 'human', capabilities: [] };

if (!connectionString)
  test(
    'OLIST-T26 source PostgreSQL requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T26 source revisions preserve historical orders and fence every write', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repository = new PostgresOrderRepository({
      database,
      envelopeKey: KEY,
    });
    const runtimeFor = (
      /** @type {any} */ auditTrail = new PostgresAuditTrail(database),
    ) =>
      createOrderRuntime({
        access: {
          authorizeRead: async () => ({ actor: OWNER }),
          authorizeWrite: async () => ({ actor: OWNER }),
        },
        auditTrail,
        repository,
        fabCode: '01',
        clock: () => NOW,
        idempotencyStore: new PostgresIdempotencyRecordStore({
          database,
          envelopeKey: Buffer.alloc(32, 93),
        }),
        conversations: {
          readAssignment: async () => null,
          readAssignments: async () => new Map(),
          readLatestMessageStates: async () => new Map(),
          readOrderContexts: async () => new Map(),
          readContactNames: async (/** @type {string[]} */ ids) =>
            new Map(ids.map((id) => [id, 'Cliente Sintético'])),
          readUserNames: async () => new Map(),
          searchConversationIds: async () => [],
          searchContactIds: async () => [],
        },
      });
    const runtime = runtimeFor();
    let sequence = 0;
    async function fixture() {
      const id = 'source-order-' + randomUUID();
      const contact = 'source-contact-' + randomUUID();
      const ficha = {
        items: syntheticItems(),
        summary: {
          cliente: 'Cliente Sintético',
          nome: null,
          data_entrega_confirmada: '2026-11-20',
        },
        artwork: syntheticArtwork(),
        observations: [],
        serviceData: {},
      };
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contact, NOW],
      );
      sequence++;
      await pool.query(
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
      status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,
      created_by_kind,created_by,paid_on,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,'confirmado','01',$7::jsonb,32,50000,'pix','2026-11-05',$8,$5,'user',$5,'2026-11-05',$8,$8)`,
        [
          id,
          sequence,
          String(sequence).padStart(2, '0') + '-CRM',
          contact,
          OWNER.id,
          randomUUID(),
          JSON.stringify(encryptJson(ficha, 'order-ficha:' + id, KEY)),
          NOW,
        ],
      );
      return { id, ficha };
    }
    /** @param {string} id @param {number} expectedVersion @param {any} value @param {any} actor */
    const command = (id, expectedVersion, value, actor = OWNER) => ({
      actor,
      orderId: id,
      expectedVersion,
      value,
      correlationId: 'source-sql',
      idempotencyKey: randomUUID(),
    });
    /** @param {any} source @param {number} [amount] */
    const lines = (source, amount = 50000) => {
      const flat = source.groups.flatMap((/** @type {any} */ group) =>
        group.lines.map((/** @type {any} */ line) => ({
          groupId: group.id,
          lineId: line.id,
          subtotalCents: 1,
        })),
      );
      flat[0].subtotalCents = amount - flat.length + 1;
      return flat;
    };
    /** @param {string} id */
    const original = async (id) =>
      (
        await pool.query(
          `SELECT ficha_envelope,final_amount_cents,paid_on,confirmed_at,confirmed_by,order_date,payment_condition,total_pieces FROM crm.orders WHERE id=$1`,
          [id],
        )
      ).rows[0];
    /** @param {string} orderId @param {string} state @param {any} [db] */
    async function exportFixture(orderId, state = 'queued', db = pool) {
      const account = 'a'.repeat(64),
        context = 'b'.repeat(64),
        id = randomUUID();
      await db.query(
        'INSERT INTO crm.olist_accounts(account_key) VALUES($1) ON CONFLICT DO NOTHING',
        [account],
      );
      await db.query(
        'INSERT INTO crm.olist_connections(context_key,account_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [context, account],
      );
      await db.query(
        `INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,state,snapshot_envelope)
      VALUES($1,$2,$3,0,$4,1,0,$5,0,$6,$7,$8::jsonb)`,
        [
          id,
          account,
          context,
          orderId,
          OWNER.id,
          'CRM-' + id,
          state,
          JSON.stringify(encryptJson({}, 'synthetic-export', KEY)),
        ],
      );
      return { id, account };
    }
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      for (const actor of [OWNER, ADMIN, OTHER]) {
        await pool.query(
          "INSERT INTO crm.users(id,email,name,password_hash) VALUES($1,$2,'Sintético','$argon2id$synthetic')",
          [actor.id, actor.id + '@example.test'],
        );
        await pool.query(
          "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
          [actor.id],
        );
      }
      await pool.query(
        "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
        [ADMIN.id],
      );

      await t.test(
        'roundtrip, stable IDs, equal composition and original envelope/payment unchanged',
        async () => {
          const f = await fixture(),
            before = await original(f.id);
          await pool.query(
            'INSERT INTO crm.order_finance(order_id,version,completed_at,completed_by) VALUES($1,1,$2,$3)',
            [f.id, NOW, OWNER.id],
          );
          const financeBefore = (
            await pool.query(
              'SELECT * FROM crm.order_finance WHERE order_id=$1',
              [f.id],
            )
          ).rows[0];
          const initCommand = command(f.id, 1, { action: 'initialize' });
          const initialized = await runtime.savePriceBreakdown(initCommand);
          assert.deepEqual(
            await runtime.savePriceBreakdown(initCommand),
            initialized,
          );
          assert.equal(initialized.revision, 1);
          assert.equal(initialized.orderVersion, 2);
          assert.equal(initialized.pricing?.totalCents, null);
          await assert.rejects(
            runtime.savePriceBreakdown(
              command(f.id, 2, {
                action: 'set_subtotals',
                lines: lines(initialized, 49999),
              }),
            ),
            { code: 'SIZE_PRICING_AMOUNT_MISMATCH' },
          );
          const completed = await runtime.savePriceBreakdown(
            command(f.id, 2, {
              action: 'set_subtotals',
              lines: lines(initialized),
            }),
          );
          assert.equal(completed.pricing?.totalCents, 50000);
          assert.equal(completed.revision, 2);
          assert.deepEqual(
            completed.groups.map((/** @type {any} */ g) => g.id),
            initialized.groups.map((/** @type {any} */ g) => g.id),
          );
          assert.deepEqual(await original(f.id), before);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM crm.order_finance WHERE order_id=$1',
                [f.id],
              )
            ).rows[0],
            financeBefore,
          );
          const read = await runtime.priceBreakdown(f.id);
          assert.deepEqual(read, completed);
          const stored = (
            await pool.query(
              'SELECT data_envelope::text AS envelope FROM crm.order_olist_source_revisions WHERE order_id=$1',
              [f.id],
            )
          ).rows;
          assert.equal(stored.length, 2);
          assert.ok(
            stored.every(
              (row) => !row.envelope.includes(completed.groups[0].id),
            ),
          );
          const exposed = (await runtime.get(f.id)).order;
          assert.equal(exposed.ficha.sizePricing, undefined);
          assert.equal(Object.hasOwn(exposed, 'legacySizePricing'), false);
          assert.equal(exposed.pricing?.totalCents, 50000);
          const reopened = await runtime.reopen({
            ...command(f.id, 3, null),
          });
          const confirmed = await runtime.confirm({
            ...command(f.id, reopened.version, null),
            paymentCondition: 'pix',
          });
          assert.equal(confirmed.finalAmountCents, 50000);
          assert.equal(confirmed.ficha.sizePricing, undefined);
          assert.deepEqual(
            (await original(f.id)).ficha_envelope,
            before.ficha_envelope,
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM crm.order_olist_source_revisions WHERE order_id=$1',
              [f.id],
            ),
          );
        },
      );

      await t.test(
        'failed audit rolls back source, order bump, domain event and idempotency receipt together',
        async () => {
          const f = await fixture();
          const failing = runtimeFor({
            append: async () => {
              throw new Error('SYNTHETIC_AUDIT_FAILURE');
            },
          });
          const input = command(f.id, 1, { action: 'initialize' });
          await assert.rejects(
            failing.savePriceBreakdown(input),
            /SYNTHETIC_AUDIT_FAILURE/u,
          );
          assert.equal((await repository.findById(f.id))?.version, 1);
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) FROM crm.order_olist_source_revisions WHERE order_id=$1',
                  [f.id],
                )
              ).rows[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) FROM crm.domain_events WHERE aggregate_id=$1',
                  [f.id],
                )
              ).rows[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) FROM crm.idempotency_records WHERE idempotency_key=$1',
                  [input.idempotencyKey],
                )
              ).rows[0].count,
            ),
            0,
          );
          assert.equal((await runtime.savePriceBreakdown(input)).revision, 1);
        },
      );

      await t.test(
        'version fencing, role/grant revocation, disabled user and ownership changes also guard replay',
        async () => {
          const f = await fixture();
          const inputs = [
            command(f.id, 1, { action: 'initialize' }),
            command(f.id, 1, { action: 'initialize' }),
          ];
          const results = await Promise.allSettled(
            inputs.map((input) => runtime.savePriceBreakdown(input)),
          );
          assert.equal(
            results.filter((r) => r.status === 'fulfilled').length,
            1,
          );
          const failed = results.find((r) => r.status === 'rejected');
          assert.ok(failed && failed.status === 'rejected');
          assert.equal(failed.reason.code, 'VERSION_CONFLICT');
          const winner =
            inputs[results.findIndex((r) => r.status === 'fulfilled')];
          await assert.rejects(
            runtime.savePriceBreakdown({ ...winner, actor: OTHER }),
            { code: 'FORBIDDEN' },
          );
          await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
            OWNER.id,
            NOW,
          ]);
          await assert.rejects(runtime.savePriceBreakdown(winner), {
            code: 'FORBIDDEN',
          });
          await pool.query(
            'UPDATE crm.users SET disabled_at=NULL WHERE id=$1',
            [OWNER.id],
          );
          await pool.query(
            "UPDATE crm.user_functions SET function_name='Financeiro' WHERE user_id=$1",
            [OWNER.id],
          );
          await assert.rejects(runtime.savePriceBreakdown(winner), {
            code: 'FORBIDDEN',
          });
          await pool.query(
            "UPDATE crm.user_functions SET function_name='Vendedor' WHERE user_id=$1",
            [OWNER.id],
          );
          await pool.query(
            'UPDATE crm.orders SET manual_owner_id=$2 WHERE id=$1',
            [f.id, OTHER.id],
          );
          await assert.rejects(runtime.savePriceBreakdown(winner), {
            code: 'FORBIDDEN',
          });
          const a = await fixture();
          const adminCommand = command(
            a.id,
            1,
            { action: 'initialize' },
            ADMIN,
          );
          await runtime.savePriceBreakdown(adminCommand);
          await pool.query(
            "DELETE FROM crm.user_capabilities WHERE user_id=$1 AND capability='COMMERCIAL_ADMIN'",
            [ADMIN.id],
          );
          await assert.rejects(runtime.savePriceBreakdown(adminCommand), {
            code: 'FORBIDDEN',
          });
          await pool.query(
            "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
            [ADMIN.id],
          );
          await pool.query(
            "UPDATE crm.user_functions SET function_name='Financeiro' WHERE user_id=$1",
            [ADMIN.id],
          );
          await assert.rejects(runtime.savePriceBreakdown(adminCommand), {
            code: 'FORBIDDEN',
          });
          await pool.query(
            "UPDATE crm.user_functions SET function_name='Vendedor' WHERE user_id=$1",
            [ADMIN.id],
          );
        },
      );

      await t.test(
        'reserved snapshots and uncertain shared resource effects block enrichment across accounts',
        async () => {
          const f = await fixture();
          await exportFixture(f.id);
          await assert.rejects(
            runtime.savePriceBreakdown(
              command(f.id, 1, { action: 'initialize' }),
            ),
            { code: 'ORDER_SOURCE_LOCKED' },
          );
          const r = await fixture(),
            e = await exportFixture(r.id, 'rejected'),
            resource = randomUUID();
          await pool.query(
            "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,state) VALUES($1,$2,'customer',$3,$4,'uncertain')",
            [resource, e.account, 'c'.repeat(64), 'CRM-' + resource],
          );
          await pool.query(
            'INSERT INTO crm.olist_export_resources(export_id,resource_id,account_key) VALUES($1,$2,$3)',
            [e.id, resource, e.account],
          );
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'customer',$4,0,'uncertain',$5)",
            [randomUUID(), e.account, resource, randomUUID(), NOW],
          );
          await assert.rejects(
            runtime.savePriceBreakdown(
              command(r.id, 1, { action: 'initialize' }),
            ),
            { code: 'ORDER_SOURCE_LOCKED' },
          );
        },
      );

      await t.test(
        'commercial correction invalidates proof, requires explicit rebase and never changes the historical total',
        async () => {
          const f = await fixture();
          let source = await runtime.savePriceBreakdown(
            command(f.id, 1, { action: 'initialize' }),
          );
          source = await runtime.savePriceBreakdown(
            command(f.id, 2, { action: 'set_subtotals', lines: lines(source) }),
          );
          let order = await runtime.reopen(command(f.id, 3, null));
          const items = structuredClone(order.ficha.items);
          items[0].grade[0].quantidade++;
          order = await runtime.patchSection({
            ...command(f.id, order.version, null),
            section: 'items',
            value: items,
          });
          assert.equal(order.finalAmountCents, 50000);
          assert.equal((await runtime.priceBreakdown(f.id)).sourceValid, false);
          await assert.rejects(
            runtime.confirm({
              ...command(f.id, order.version, null),
              paymentCondition: 'pix',
            }),
            { code: 'ORDER_NOT_CONFIRMABLE' },
          );
          const rebased = await runtime.savePriceBreakdown(
            command(f.id, order.version, { action: 'initialize' }),
          );
          assert.notEqual(rebased.groups[0].id, source.groups[0].id);
          assert.equal(rebased.revision, 3);
          const completed = await runtime.savePriceBreakdown(
            command(f.id, rebased.orderVersion, {
              action: 'set_subtotals',
              lines: lines(rebased),
            }),
          );
          assert.equal(completed.pricing?.totalCents, 50000);
          assert.equal((await original(f.id)).final_amount_cents, '50000');
        },
      );

      await t.test(
        'export snapshot reservation and enrichment serialize on the same order lock',
        async () => {
          const f = await fixture();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              'SELECT id FROM crm.orders WHERE id=$1 FOR UPDATE',
              [f.id],
            );
            const blocked = assert.rejects(
              runtime.savePriceBreakdown(
                command(f.id, 1, { action: 'initialize' }),
              ),
              { code: 'ORDER_SOURCE_LOCKED' },
            );
            await exportFixture(f.id, 'queued', client);
            await client.query('COMMIT');
            await blocked;
            assert.equal((await repository.findById(f.id))?.version, 1);
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      );

      await t.test(
        'source fingerprint ignores key order and metadata but detects changed commercial grade',
        async () => {
          const f = await fixture();
          const source = await runtime.savePriceBreakdown(
            command(f.id, 1, { action: 'initialize' }),
          );
          await pool.query(
            'UPDATE crm.orders SET version=version+1,paid_on=NULL WHERE id=$1',
            [f.id],
          );
          assert.equal((await runtime.priceBreakdown(f.id)).sourceValid, true);
          const changed = structuredClone(f.ficha);
          changed.items[0].grade[0].quantidade++;
          await pool.query(
            'UPDATE crm.orders SET ficha_envelope=$2::jsonb,version=version+1 WHERE id=$1',
            [
              f.id,
              JSON.stringify(encryptJson(changed, 'order-ficha:' + f.id, KEY)),
            ],
          );
          const stale = await runtime.priceBreakdown(f.id);
          assert.equal(stale.sourceValid, false);
          assert.equal(stale.pricing, null);
          await assert.rejects(
            runtime.savePriceBreakdown(
              command(f.id, 4, {
                action: 'set_subtotals',
                lines: lines(source),
              }),
            ),
            { code: 'ORDER_SOURCE_STALE' },
          );
          const renewed = await runtime.savePriceBreakdown(
            command(f.id, 4, { action: 'initialize' }),
          );
          assert.equal(renewed.revision, 2);
          assert.notEqual(renewed.groups[0].id, source.groups[0].id);
          const second = await fixture();
          await pool.query(
            `INSERT INTO crm.order_olist_source_revisions(order_id,revision,order_version,source_hmac,data_envelope,updated_by,updated_at)
        SELECT $1,revision,order_version,source_hmac,data_envelope,updated_by,updated_at FROM crm.order_olist_source_revisions WHERE order_id=$2 AND revision=1`,
            [second.id, f.id],
          );
          await assert.rejects(
            runtime.priceBreakdown(second.id),
            /authenticate/u,
          );
        },
      );
    } finally {
      await pool.end();
    }
  });
