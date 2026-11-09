import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import {
  encryptJson,
  decryptJson,
} from '../modules/orders/src/adapters/envelope.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import {
  createOlistRepository,
  olistResourceIdentityHash,
} from '../modules/olist/src/repository.js';
import { createOlistAdminRepository } from '../modules/olist/src/admin-repository.js';
import { createOlistDispatcher } from '../modules/olist/src/dispatcher.js';
import { seal, identityHash } from '../modules/olist/src/crypto.js';
import { storeOrderBody, STORE_NOW } from './fixtures/store-order.js';
import { syntheticItems, syntheticArtwork } from './fixtures/order-items.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T15:00:00Z');
const KEY = Buffer.alloc(32, 101);
const OWNER = { id: 'cancel-owner', kind: 'human', capabilities: [] };
const OTHER = { id: 'cancel-other', kind: 'human', capabilities: [] };
const FINANCE = { id: 'cancel-finance', kind: 'human', capabilities: [] };
const ADMIN = {
  id: 'cancel-admin',
  kind: 'human',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const REASON = 'Duplicidade confirmada pelo cliente sintético';
/** @param {any} error */
const conflict = (error) => error.statusCode === 409;
/** @param {any} error */
const forbidden = (error) => error.statusCode === 403;

if (!connectionString)
  test(
    'OLIST-T23 cancellation SQL requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T23 terminal cancellation, current ACL, preserved history and sale races', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({
      connectionString,
      max: 10,
      options: '-c statement_timeout=12000 -c lock_timeout=8000',
    });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repository = new PostgresOrderRepository({
      database,
      envelopeKey: KEY,
    });
    /** @param {any} [auditTrail] @param {any} [storeOverride] @param {any} [conversationOverrides] */
    const runtimeFor = (
      auditTrail = new PostgresAuditTrail(database),
      storeOverride = undefined,
      conversationOverrides = {},
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
        idempotencyStore:
          storeOverride ??
          new PostgresIdempotencyRecordStore({
            database,
            envelopeKey: Buffer.alloc(32, 102),
          }),
        conversations: {
          readAssignment: async () => null,
          readAssignments: async () => new Map(),
          readLatestMessageStates: async () => new Map(),
          readOrderContexts: async () => new Map(),
          readContactNames: async () => new Map(),
          readUserNames: async () => new Map(),
          searchConversationIds: async () => [],
          searchContactIds: async () => [],
          ...conversationOverrides,
        },
      });
    const runtime = runtimeFor();
    /** @param {string} id @param {any} [overrides] */
    const command = (id, overrides = {}) => ({
      actor: OWNER,
      orderId: id,
      expectedVersion: 1,
      reason: REASON,
      idempotencyKey: randomUUID(),
      correlationId: 'cancellation-synthetic',
      ...overrides,
    });
    /** @param {'pendente'|'confirmado'} [status] */
    async function fixture(status = 'confirmado') {
      const id = 'cancel-order-' + randomUUID(),
        contact = 'cancel-contact-' + randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contact, NOW],
      );
      const sequence = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') AS n"))
          .rows[0].n,
      );
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
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
      status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,order_date,confirmed_at,confirmed_by,
      created_by_kind,created_by,paid_on,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,$7,'01',$8::jsonb,32,$9,$10,$11,$12,$13,'user',$5,$11,$14,$14)`,
        [
          id,
          sequence,
          String(sequence).padStart(2, '0') + '-CRM',
          contact,
          OWNER.id,
          randomUUID(),
          status,
          JSON.stringify(encryptJson(ficha, 'order-ficha:' + id, KEY)),
          status === 'confirmado' ? 50000 : null,
          status === 'confirmado' ? 'pix' : null,
          status === 'confirmado' ? '2026-11-06' : null,
          status === 'confirmado' ? NOW : null,
          status === 'confirmado' ? OWNER.id : null,
          NOW,
        ],
      );
      return id;
    }
    /** @param {string} id */
    async function preserved(id) {
      return (
        await pool.query(
          `SELECT to_jsonb(o)-ARRAY['cancelled_at','cancelled_by','cancellation_reason_envelope','version','updated_at'] AS row FROM crm.orders o WHERE id=$1`,
          [id],
        )
      ).rows[0].row;
    }
    /** @param {string} orderId @param {string} [state] @param {any} [extra] */
    async function exportFixture(orderId, state = 'ready', extra = {}) {
      const accountKey = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const contextKey = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const id = randomUUID();
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,0)',
        [accountKey],
      );
      await pool.query(
        `INSERT INTO crm.olist_connections(context_key,account_key,token_envelope,expires_at) VALUES($1,$2,$3::jsonb,$4)`,
        [
          contextKey,
          accountKey,
          JSON.stringify(
            seal(
              {
                accessToken: 'synthetic-access',
                refreshToken: 'synthetic-refresh',
              },
              KEY,
              'tokens',
              accountKey,
              contextKey,
            ),
          ),
          new Date(NOW.getTime() + 3600000),
        ],
      );
      await pool.query(
        `INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,
      actor_id,authorization_version,reference,state,stage,snapshot_envelope,remote_id,observed_sale_id)
      VALUES($1,$2,$3,0,$4,1,0,$5,1,$6,$7,'sale',$8::jsonb,$9,$10)`,
        [
          id,
          accountKey,
          contextKey,
          orderId,
          OWNER.id,
          'CRM-' + id,
          state,
          JSON.stringify(
            seal(extra.snapshot ?? {}, KEY, 'export-snapshot', accountKey, id),
          ),
          ['confirmed', 'linked'].includes(state) ? '9001' : null,
          extra.observedId ?? null,
        ],
      );
      return {
        exportId: id,
        accountKey,
        contextKey,
        actor: OWNER,
        authorizationVersion: 1,
        connectionGeneration: 0,
        connectionVersion: 0,
        settingsVersion: 0,
        correlationId: 'cancel-race-synthetic',
        expectedVersion: 1,
      };
    }
    /** @param {string} id */
    const ledger = async (id) =>
      (
        await pool.query(
          `SELECT
    (SELECT count(*)::integer FROM crm.domain_events WHERE aggregate_id=$1 AND event_type='order.cancelled') AS events,
    (SELECT count(*)::integer FROM crm.audit_events WHERE target_id=$1 AND action='order.cancel') AS audits,
    (SELECT count(*)::integer FROM crm.idempotency_records WHERE target_id=$1 AND action='order.cancel') AS receipts`,
          [id],
        )
      ).rows[0];
    const olist = createOlistRepository(database, {
      envelopeKey: KEY,
      hmacKey: Buffer.alloc(32, 103),
      clock: () => NOW,
    });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      for (const actor of [OWNER, OTHER, FINANCE, ADMIN]) {
        await pool.query(
          `INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Pessoa Sintética','$argon2id$synthetic',true,1)`,
          [actor.id, actor.id + '@example.test'],
        );
        await pool.query(
          'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
          [actor.id, actor.id === FINANCE.id ? 'Financeiro' : 'Vendedor'],
        );
      }
      await pool.query(
        "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
        [ADMIN.id],
      );

      await t.test(
        'pending and paid confirmed cancellations preserve every commercial/payment column',
        async () => {
          for (const status of ['pendente', 'confirmado']) {
            const id = await fixture(
                /** @type {'pendente'|'confirmado'} */ (status),
              ),
              before = await preserved(id);
            const result = await runtime.cancel(command(id));
            assert.equal(result.status, status);
            assert.equal(result.version, 2);
            assert.equal(result.cancelledAt, NOW.toISOString());
            assert.deepEqual(await preserved(id), before);
            const row = (
              await pool.query(
                'SELECT cancelled_by,cancellation_reason_envelope FROM crm.orders WHERE id=$1',
                [id],
              )
            ).rows[0];
            assert.equal(row.cancelled_by, OWNER.id);
            assert.equal(
              decryptJson(
                row.cancellation_reason_envelope,
                'order-cancellation:' + id,
                KEY,
              ),
              REASON,
            );
            assert.ok(
              !JSON.stringify(row.cancellation_reason_envelope).includes(
                REASON,
              ),
            );
            assert.deepEqual(await ledger(id), {
              events: 1,
              audits: 1,
              receipts: 1,
            });
            assert.equal(
              (await runtime.get(id)).order.cancelledAt,
              NOW.toISOString(),
            );
          }
        },
      );
      await t.test(
        'same key replays once; divergent payload, new key and stale version cannot cancel twice',
        async () => {
          const id = await fixture(),
            input = command(id);
          const results = await Promise.all([
            runtime.cancel(input),
            runtime.cancel(input),
          ]);
          assert.deepEqual(results[0], results[1]);
          await assert.rejects(
            runtime.cancel({ ...input, reason: 'Outro motivo sintético' }),
            conflict,
          );
          await assert.rejects(
            runtime.cancel(command(id, { expectedVersion: 2 })),
            conflict,
          );
          assert.deepEqual(await ledger(id), {
            events: 1,
            audits: 1,
            receipts: 1,
          });
          const stale = await fixture();
          await assert.rejects(
            runtime.cancel(command(stale, { expectedVersion: 2 })),
            conflict,
          );
          assert.deepEqual(await ledger(stale), {
            events: 0,
            audits: 0,
            receipts: 0,
          });
        },
      );
      await t.test(
        'Olist checkbox is never commercial authority; revoked ACL is checked before replay',
        async () => {
          const id = await fixture();
          for (const actor of [
            OTHER,
            FINANCE,
            { ...OWNER, kind: 'automation' },
          ])
            await assert.rejects(
              runtime.cancel(command(id, { actor })),
              forbidden,
            );
          const input = command(id);
          await runtime.cancel(input);
          await pool.query('UPDATE crm.users SET disabled_at=$2 WHERE id=$1', [
            OWNER.id,
            NOW,
          ]);
          try {
            await assert.rejects(runtime.cancel(input), forbidden);
          } finally {
            await pool.query(
              'UPDATE crm.users SET disabled_at=NULL WHERE id=$1',
              [OWNER.id],
            );
          }
          const adminId = await fixture(),
            adminCommand = command(adminId, { actor: ADMIN });
          await runtime.cancel(adminCommand);
          await pool.query(
            'DELETE FROM crm.user_capabilities WHERE user_id=$1',
            [ADMIN.id],
          );
          try {
            await assert.rejects(runtime.cancel(adminCommand), forbidden);
          } finally {
            await pool.query(
              "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
              [ADMIN.id],
            );
          }
        },
      );
      await t.test('invalid reasons have no effect or receipt', async () => {
        for (const reason of [
          '',
          ' ',
          'x'.repeat(1001),
          'motivo\ncontrole',
          null,
        ]) {
          const id = await fixture();
          await assert.rejects(
            runtime.cancel(command(id, { reason })),
            (/** @type {any} */ error) =>
              error.statusCode >= 400 && error.statusCode < 500,
          );
          assert.equal((await repository.findById(id))?.cancelledAt, null);
          assert.deepEqual(await ledger(id), {
            events: 0,
            audits: 0,
            receipts: 0,
          });
        }
      });
      await t.test(
        'a failed audit rolls cancellation, operation invalidation and idempotency back together',
        async () => {
          const id = await fixture(),
            operation = await exportFixture(id, 'queued');
          const failed = runtimeFor({
            append: async () => {
              throw new Error('synthetic audit failure');
            },
          });
          await assert.rejects(
            failed.cancel(command(id)),
            /synthetic audit failure/u,
          );
          assert.equal((await repository.findById(id))?.cancelledAt, null);
          assert.equal(
            (
              await pool.query(
                'SELECT state FROM crm.olist_exports WHERE id=$1',
                [operation.exportId],
              )
            ).rows[0].state,
            'queued',
          );
          assert.deepEqual(await ledger(id), {
            events: 0,
            audits: 0,
            receipts: 0,
          });
        },
      );
      await t.test(
        'paid store checkout, gateway receipt and completed financial history remain byte-for-byte',
        async () => {
          const store = createStoreOrderService({
            repository,
            fabCode: '01',
            hmacKey: Buffer.alloc(32, 104),
            acceptTest: true,
            clock: () => STORE_NOW,
          });
          const run = randomUUID();
          const body = storeOrderBody((value) => {
            value.pedido_id = run;
            value.numero_loja = 'LJ-' + run.slice(0, 8).toUpperCase();
            value.pagamento.transaction_nsu = 'synthetic-cancel-' + run;
            value.pagamento.invoice_slug = 'synthetic-invoice-' + run;
          });
          const { order } = await store.record({
            actor: 'AUTOMATION_EXECUTOR',
            correlationId: 'synthetic-store-cancel',
            record: store.parse(body),
          });
          await pool.query(
            'INSERT INTO crm.order_finance(order_id,version,completed_at,completed_by) VALUES($1,1,$2,$3)',
            [order.id, NOW, FINANCE.id],
          );
          await pool.query(
            "INSERT INTO crm.order_finance_events(id,order_id,version,order_version,action,actor_id,reason,occurred_at,correlation_id) VALUES($1,$2,1,1,'completed',$3,'SYNTHETIC_NOTE_CREATED',$4,'synthetic-finance-cancel')",
            [randomUUID(), order.id, FINANCE.id, NOW],
          );
          const before = await preserved(order.id);
          const history = async () =>
            (
              await pool.query(
                `SELECT (SELECT to_jsonb(f) FROM crm.order_finance f WHERE order_id=$1) AS finance,
        (SELECT jsonb_agg(e) FROM crm.order_finance_events e WHERE order_id=$1) AS events,
        (SELECT to_jsonb(r) FROM crm.store_order_receipts r WHERE order_id=$1) AS receipt`,
                [order.id],
              )
            ).rows[0];
          const original = await history();
          await assert.rejects(runtime.cancel(command(order.id)), forbidden);
          await runtime.cancel(
            command(order.id, { actor: ADMIN, expectedVersion: order.version }),
          );
          assert.deepEqual(await preserved(order.id), before);
          assert.deepEqual(await history(), original);
        },
      );
      await t.test(
        'reserved, uncertain, confirmed, linked, observed sale and non-rejected sale tickets block cancellation',
        async () => {
          for (const state of [
            'reserved',
            'uncertain',
            'confirmed',
            'linked',
          ]) {
            const id = await fixture();
            await exportFixture(id, state);
            await assert.rejects(runtime.cancel(command(id)), conflict);
            assert.equal((await repository.findById(id))?.cancelledAt, null);
          }
          const observed = await fixture();
          await exportFixture(observed, 'ready', { observedId: '9003' });
          await assert.rejects(runtime.cancel(command(observed)), conflict);
          const ticketed = await fixture(),
            operation = await exportFixture(ticketed, 'ready');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,export_id,stage,fence,generation) VALUES($1,$2,$3,'sale',$4,0)",
            [
              randomUUID(),
              operation.accountKey,
              operation.exportId,
              randomUUID(),
            ],
          );
          await assert.rejects(runtime.cancel(command(ticketed)), conflict);
        },
      );
      await t.test(
        'cancellation and legacy sale reservation have one winner under concurrent SQL clients',
        async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const id = await fixture(),
              operation = await exportFixture(id);
            const results = await Promise.allSettled([
              runtime.cancel(command(id)),
              olist.reserveEffect(operation),
            ]);
            assert.equal(
              results.filter((result) => result.status === 'fulfilled').length,
              1,
            );
            assert.equal(
              results.filter((result) => result.status === 'rejected').length,
              1,
            );
            const cancelled = Boolean(
              (await repository.findById(id))?.cancelledAt,
            );
            const count = Number(
              (
                await pool.query(
                  'SELECT count(*) AS n FROM crm.olist_attempts WHERE export_id=$1',
                  [operation.exportId],
                )
              ).rows[0].n,
            );
            assert.equal(count, cancelled ? 0 : 1);
            assert.equal(
              (
                await pool.query(
                  'SELECT state FROM crm.olist_exports WHERE id=$1',
                  [operation.exportId],
                )
              ).rows[0].state,
              cancelled ? 'invalidated' : 'reserved',
            );
          }
        },
      );
      await t.test(
        'cancelled order rejects old and fresh generation before any new effect',
        async () => {
          const id = await fixture(),
            operation = await exportFixture(id, 'queued');
          await runtime.cancel(command(id));
          await assert.rejects(
            olist.prepareExport({
              ...operation,
              orderId: id,
              orderVersion: 2,
              snapshot: {},
              snapshotFingerprint: 'a'.repeat(64),
            }),
            conflict,
          );
          await assert.rejects(
            olist.reserveEffect({ ...operation, expectedVersion: 2 }),
            conflict,
          );
          await assert.rejects(
            olist.reserveSaleEffect({
              ...operation,
              requestPayload: { encoded: '{}' },
            }),
            conflict,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) AS n FROM crm.olist_attempts WHERE export_id=$1',
                  [operation.exportId],
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
      await t.test(
        'previous resource ticket accepts its late result without reviving cancelled operation',
        async () => {
          const id = await fixture(),
            operation = await exportFixture(id, 'resolving'),
            resourceId = randomUUID(),
            attemptId = randomUUID(),
            fence = randomUUID();
          await pool.query(
            "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,state) VALUES($1,$2,'customer',$3,$4,'reserved')",
            [
              resourceId,
              operation.accountKey,
              'c'.repeat(64),
              'CRM-' + resourceId,
            ],
          );
          await pool.query(
            'INSERT INTO crm.olist_export_resources(export_id,resource_id,account_key) VALUES($1,$2,$3)',
            [operation.exportId, resourceId, operation.accountKey],
          );
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation) VALUES($1,$2,$3,'customer',$4,0)",
            [attemptId, operation.accountKey, resourceId, fence],
          );
          await runtime.cancel(command(id));
          await olist.recordResult({
            ...operation,
            attemptId,
            fence,
            outcome: 'confirmed',
            remoteId: '9101',
            response: { id: '9101' },
          });
          const resource = (
            await pool.query(
              'SELECT state,remote_id FROM crm.olist_resources WHERE id=$1',
              [resourceId],
            )
          ).rows[0];
          assert.deepEqual(resource, { state: 'confirmed', remote_id: '9101' });
          assert.equal(
            (
              await pool.query(
                'SELECT state FROM crm.olist_exports WHERE id=$1',
                [operation.exportId],
              )
            ).rows[0].state,
            'invalidated',
          );
          await assert.rejects(
            olist.reserveResourceEffect({
              ...operation,
              resourceId,
              expectedVersion: 1,
              requestPayload: { encoded: '{}' },
            }),
          );
        },
      );
      await t.test(
        'ACL revocation in the precheck-to-replay window is rejected inside the receipt transaction',
        async () => {
          const id = await fixture(),
            input = command(id);
          await runtime.cancel(input);
          const baseStore = new PostgresIdempotencyRecordStore({
            database,
            envelopeKey: Buffer.alloc(32, 102),
          });
          const guarded = runtimeFor(undefined, {
            execute: async (
              /** @type {any} */ identity,
              /** @type {any} */ effect,
              /** @type {any} */ beforeExecute,
            ) => {
              await pool.query(
                'UPDATE crm.users SET disabled_at=$2 WHERE id=$1',
                [OWNER.id, NOW],
              );
              return baseStore.execute(identity, effect, beforeExecute);
            },
          });
          try {
            await assert.rejects(guarded.cancel(input), forbidden);
          } finally {
            await pool.query(
              'UPDATE crm.users SET disabled_at=NULL WHERE id=$1',
              [OWNER.id],
            );
          }
          assert.deepEqual(await ledger(id), {
            events: 1,
            audits: 1,
            receipts: 1,
          });
        },
      );
      await t.test(
        'SQL cancellation filters page and count the same universe and subtract sales exactly once',
        async () => {
          const ids = [await fixture(), await fixture(), await fixture()];
          await pool.query(
            'UPDATE crm.orders SET manual_owner_id=$2 WHERE id=ANY($1::text[])',
            [ids, OTHER.id],
          );
          const query = {
            owner: { userId: OTHER.id, conversationIds: [] },
            limit: 1,
          };
          const before = await repository.summary({
            from: '2026-11-06',
            to: '2026-11-06',
            dailyFrom: '2026-11-06',
            dailyTo: '2026-11-06',
          });
          await runtime.cancel(command(ids[1], { actor: OTHER }));
          const first = await repository.list(query);
          assert.deepEqual(first.counts, { confirmado: 2, pendente: 0 });
          assert.equal(first.items.length, 1);
          assert.ok(first.nextCursor);
          const second = await repository.list({
            ...query,
            cursor: first.nextCursor,
          });
          assert.equal(second.items.length, 1);
          assert.equal(second.nextCursor, null);
          assert.deepEqual(
            new Set([...first.items, ...second.items].map((order) => order.id)),
            new Set([ids[0], ids[2]]),
          );
          const cancelled = await repository.list({
            ...query,
            cancellation: 'cancelled',
          });
          assert.deepEqual(cancelled.counts, { confirmado: 1, pendente: 0 });
          assert.equal(cancelled.items[0].id, ids[1]);
          const all = await repository.list({ ...query, cancellation: 'all' });
          assert.deepEqual(all.counts, { confirmado: 3, pendente: 0 });
          const after = await repository.summary({
            from: '2026-11-06',
            to: '2026-11-06',
            dailyFrom: '2026-11-06',
            dailyTo: '2026-11-06',
          });
          assert.equal(before.confirmedCount - after.confirmedCount, 1);
          assert.equal(before.soldAmountCents - after.soldAmountCents, 50000);
          assert.equal(
            before.period.soldAmountCents - after.period.soldAmountCents,
            50000,
          );
        },
      );
      await t.test(
        'T08 sale reservation and cancellation serialize with one durable winner',
        async () => {
          for (let round = 0; round < 3; round++) {
            const id = await fixture(),
              groupId = randomUUID(),
              lineId = randomUUID();
            const attributes = {
              garment: 'Camisa',
              color: 'Azul',
              fabric: '["Algodão"]',
              application: 'Silk',
              collar: 'Polo',
              audience: '',
            };
            const snapshot = {
              customer: { cpfCnpj: '52998224725' },
              commercial: {
                groups: [
                  { groupId, attributes, lines: [{ lineId, size: 'M' }] },
                ],
              },
            };
            const operation = await exportFixture(id, 'ready', { snapshot });
            const mapping = {
              resolved: true,
              customerId: '101',
              groups: [
                {
                  groupId,
                  productId: '201',
                  lines: [{ lineId, productId: '301' }],
                },
              ],
            };
            const parentId = randomUUID();
            for (const row of [
              {
                kind: 'customer',
                identity: snapshot.customer.cpfCnpj,
                id: randomUUID(),
                remoteId: '101',
                parentId: null,
              },
              {
                kind: 'product',
                identity: attributes,
                id: parentId,
                remoteId: '201',
                parentId: null,
              },
              {
                kind: 'variation',
                identity: 'M',
                id: randomUUID(),
                remoteId: '301',
                parentId,
              },
            ]) {
              const hash = olistResourceIdentityHash(Buffer.alloc(32, 103), {
                ...row,
                accountKey: operation.accountKey,
              });
              await pool.query(
                "INSERT INTO crm.olist_resources(id,account_key,kind,identity_hash,reference,parent_id,state,remote_id) VALUES($1,$2,$3,$4,$5,$6,'confirmed',$7)",
                [
                  row.id,
                  operation.accountKey,
                  row.kind,
                  hash,
                  'CRM-' + row.id,
                  row.parentId,
                  row.remoteId,
                ],
              );
              await pool.query(
                'INSERT INTO crm.olist_export_resources(export_id,resource_id,account_key) VALUES($1,$2,$3)',
                [operation.exportId, row.id, operation.accountKey],
              );
            }
            await pool.query(
              'UPDATE crm.olist_exports SET resource_mapping_hash=$2,resource_mapping_envelope=$3::jsonb WHERE id=$1',
              [
                operation.exportId,
                identityHash(Buffer.alloc(32, 103), 'sale-resources', [
                  operation.accountKey,
                  operation.exportId,
                  mapping,
                ]),
                JSON.stringify(
                  seal(
                    mapping,
                    KEY,
                    'sale-resources',
                    operation.accountKey,
                    operation.exportId,
                  ),
                ),
              ],
            );
            const reserve = () =>
              olist.reserveSaleEffect({
                ...operation,
                requestPayload: { encoded: '{"synthetic":true}' },
              });
            let results;
            if (round === 0) {
              const ticket = await reserve();
              results = [
                { status: 'fulfilled', value: ticket },
                ...(await Promise.allSettled([runtime.cancel(command(id))])),
              ];
            } else if (round === 1) {
              const cancellation = await runtime.cancel(command(id));
              results = [
                { status: 'fulfilled', value: cancellation },
                ...(await Promise.allSettled([reserve()])),
              ];
            } else
              results = await Promise.allSettled([
                runtime.cancel(command(id)),
                reserve(),
              ]);
            assert.equal(
              results.filter((result) => result.status === 'fulfilled').length,
              1,
            );
            const cancelled = Boolean(
              (await repository.findById(id))?.cancelledAt,
            );
            const count = Number(
              (
                await pool.query(
                  'SELECT count(*) AS n FROM crm.olist_attempts WHERE export_id=$1',
                  [operation.exportId],
                )
              ).rows[0].n,
            );
            assert.equal(count, cancelled ? 0 : 1);
          }
        },
      );
      await t.test(
        'administrative linking of an existing ERP sale races local cancellation with one winner',
        async () => {
          const admin = createOlistAdminRepository(database, {
            envelopeKey: KEY,
            hmacKey: Buffer.alloc(32, 103),
            clock: () => NOW,
          });
          const session = createHash('sha256')
            .update(randomUUID())
            .digest('hex');
          await pool.query(
            'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$1,$3,$3,$4)',
            [session, ADMIN.id, NOW, new Date(NOW.getTime() + 86400000)],
          );
          for (let round = 0; round < 3; round++) {
            const id = await fixture(),
              groupId = randomUUID(),
              lineId = randomUUID();
            const snapshot = {
              policy: 'exact-cent-v1',
              customer: {
                tipoPessoa: 'F',
                cpfCnpj: '52998224725',
                nome: 'Comprador Sintético',
                celular: '5511999990000',
                situacao: 'B',
                endereco: {
                  cep: '29010000',
                  municipio: 'Vitória',
                  uf: 'ES',
                  endereco: 'Rua Sintética',
                  bairro: 'Centro',
                  numero: '10',
                },
              },
              productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
              commercial: {
                totalCents: 50000,
                groups: [
                  {
                    groupId,
                    attributes: {
                      garment: 'Camisa',
                      color: 'Azul',
                      fabric: '["Algodão"]',
                      application: 'Silk',
                      collar: 'Polo',
                      audience: '',
                    },
                    lines: [
                      { lineId, size: 'M', quantity: 1, subtotalCents: 50000 },
                    ],
                  },
                ],
              },
            };
            const operation = await exportFixture(id, 'queued', { snapshot });
            const link = {
              ...operation,
              actor: ADMIN,
              sessionBinding: session,
              authorizationVersion: 1,
              orderId: id,
              expectedOrderVersion: 1,
              expectedOperationVersion: 1,
              expectedSettingsVersion: 0,
              remoteId: '9901',
              number: '701',
              reason: 'Venda existente sintética conferida',
              snapshot,
              proof: { matched: true, lineCount: 1, totalCents: 50000 },
              resources: {
                resolved: true,
                customerId: '101',
                groups: [
                  {
                    groupId,
                    productId: '201',
                    lines: [{ lineId, productId: '301' }],
                  },
                ],
              },
            };
            let results;
            if (round === 0) {
              const linked = await admin.commitLink(link);
              results = [
                { status: 'fulfilled', value: linked },
                ...(await Promise.allSettled([runtime.cancel(command(id))])),
              ];
            } else if (round === 1) {
              const cancellation = await runtime.cancel(command(id));
              results = [
                { status: 'fulfilled', value: cancellation },
                ...(await Promise.allSettled([admin.commitLink(link)])),
              ];
            } else
              results = await Promise.allSettled([
                runtime.cancel(command(id)),
                admin.commitLink(link),
              ]);
            assert.equal(
              results.filter((result) => result.status === 'fulfilled').length,
              1,
            );
            const order = await repository.findById(id);
            const state = (
              await pool.query(
                'SELECT state FROM crm.olist_exports WHERE id=$1',
                [operation.exportId],
              )
            ).rows[0].state;
            assert.equal(state, order?.cancelledAt ? 'invalidated' : 'linked');
          }
        },
      );
      await t.test(
        'an old cancelled job stops definitively with no network and preserves its terminal marker',
        async () => {
          const id = await fixture(),
            operation = await exportFixture(id, 'queued');
          await runtime.cancel(command(id));
          let calls = 0;
          const fail = async () => {
            calls++;
            throw new Error('synthetic unexpected network/effect');
          };
          const dispatcher = createOlistDispatcher({
            repository: olist,
            client: { findOrder: fail, orderRaw: fail },
            resourceResolver: { resolve: fail },
            saleWriter: { dispatch: fail },
            config: {
              accountKey: operation.accountKey,
              contextKey: operation.contextKey,
            },
          });
          const response = await dispatcher.dispatch({
            exportId: operation.exportId,
          });
          assert.deepEqual(response, {
            outcome: 'failed',
            errorCode: 'ORDER_CANCELLED',
            retryable: false,
            retrySafe: false,
          });
          assert.equal(calls, 0);
          const before = (
            await pool.query(
              'SELECT state,last_error_code,version FROM crm.olist_exports WHERE id=$1',
              [operation.exportId],
            )
          ).rows[0];
          await olist.recordDispatchStop({
            ...operation,
            code: 'OLIST_DISPATCH_FAILED',
          });
          const after = (
            await pool.query(
              'SELECT state,last_error_code,version FROM crm.olist_exports WHERE id=$1',
              [operation.exportId],
            )
          ).rows[0];
          assert.deepEqual(after, before);
          assert.equal(after.state, 'invalidated');
          assert.equal(after.last_error_code, 'ORDER_CANCELLED');
        },
      );
      await t.test(
        'cancelled conversation draft creates no replacement until an explicit human command',
        async () => {
          const contactId = 'cancel-conversation-contact-' + randomUUID(),
            identityId = 'cancel-identity-' + randomUUID(),
            conversationId = 'cancel-conversation-' + randomUUID();
          await pool.query(
            'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
            [contactId, NOW],
          );
          await pool.query(
            "INSERT INTO crm.contact_identities(id,current_contact_id,provider,provider_account_id,channel,external_identity_lookup_hash,identity_kind,phone_status,identity_envelope,created_at,updated_at) VALUES($1,$2,'meta','synthetic-cancel','whatsapp',$3,'phone','confirmed',$4::jsonb,$5,$5)",
            [
              identityId,
              contactId,
              createHash('sha256').update(randomUUID()).digest('hex'),
              JSON.stringify(
                encryptJson({ phone: '5527900000001' }, identityId, KEY),
              ),
              NOW,
            ],
          );
          await pool.query(
            "INSERT INTO crm.contact_phone_lookup(contact_id,phone_hash,source) VALUES($1,$2,'manual')",
            [
              contactId,
              createHash('sha256').update(randomUUID()).digest('hex'),
            ],
          );
          await pool.query(
            "INSERT INTO crm.conversations(id,contact_identity_id,provider,provider_account_id,external_conversation_id,cycle_number,assigned_user_id,opened_at,last_message_at) VALUES($1,$2,'meta','synthetic-cancel',$1,1,$3,$4,$4)",
            [conversationId, identityId, OWNER.id, NOW],
          );
          const conversationRuntime = runtimeFor(undefined, undefined, {
            readAssignment: async () => ({
              assignedUserId: OWNER.id,
              version: 1,
            }),
            readOrderContexts: async () =>
              new Map([
                [
                  conversationId,
                  {
                    briefing: null,
                    customerName: 'Cliente Sint�tico',
                    openedAt: NOW.toISOString(),
                  },
                ],
              ]),
          });
          const create = () =>
            conversationRuntime.createManual({
              actor: OWNER,
              conversationId,
              expectedVersion: 1,
              idempotencyKey: randomUUID(),
              correlationId: 'synthetic-explicit-replacement',
            });
          const initial = await create();
          await conversationRuntime.cancel(
            command(initial.order.id, {
              expectedVersion: initial.order.version,
            }),
          );
          const retained = await repository.listByConversation(conversationId);
          assert.equal(retained.length, 1);
          assert.ok(retained[0].cancelledAt);
          assert.equal(
            await repository.findPendingByConversation(conversationId),
            null,
          );
          const replacement = await create();
          assert.equal(replacement.created, true);
          assert.notEqual(replacement.order.id, initial.order.id);
          assert.equal(replacement.order.status, 'pendente');
          assert.equal(replacement.order.cancelledAt, null);
          const history = await repository.listByConversation(conversationId);
          assert.equal(history.length, 2);
          assert.equal(
            history.filter((order) => Boolean(order.cancelledAt)).length,
            1,
          );
          assert.equal(
            (await repository.findPendingByConversation(conversationId))?.id,
            replacement.order.id,
          );
        },
      );
      await t.test(
        'terminal cancellation cannot be undone or have its payment/snapshot edited in SQL',
        async () => {
          const id = await fixture();
          await runtime.cancel(command(id));
          await assert.rejects(
            pool.query(
              'UPDATE crm.orders SET cancelled_at=NULL,cancelled_by=NULL,cancellation_reason_envelope=NULL WHERE id=$1',
              [id],
            ),
          );
          await assert.rejects(
            pool.query('UPDATE crm.orders SET paid_on=NULL WHERE id=$1', [id]),
          );
          await assert.rejects(
            pool.query('DELETE FROM crm.orders WHERE id=$1', [id]),
          );
        },
      );
    } finally {
      await pool.end();
    }
  });
