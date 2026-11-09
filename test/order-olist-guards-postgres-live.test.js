import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { PostgresOrderFileRepository } from '../modules/orders/src/adapters/postgres-order-file-repository.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { createOrderService } from '../modules/orders/src/application/order-service.js';
import { confirmOrder } from '../modules/orders/src/domain/order.js';
import { createOlistRepository } from '../modules/olist/src/repository.js';
import { seal } from '../modules/olist/src/crypto.js';
import { createStoreOrderService } from '../modules/orders/src/application/store-order-service.js';
import { storeOrderBody, STORE_NOW } from './fixtures/store-order.js';
import { fixturePricing } from './fixtures/size-pricing.js';
import { syntheticItems, syntheticArtwork } from './fixtures/order-items.js';

const connectionString = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 111),
  NOW = new Date('2026-11-06T15:00:00Z');
const OWNER = { id: 't10-guard-owner', kind: 'human', capabilities: [] };
const hash = (/** @type {string} */ s) =>
  createHash('sha256').update(s).digest('hex');
const isLocked = (/** @type {any} */ e) => e.code === 'ORDER_OLIST_LOCKED';
if (!connectionString)
  test('OLIST-T10 guards require TEST_DATABASE_URL', { skip: true }, () => {});
else
  test('OLIST-T10 frozen commercial content and serialized Orders/Olist writers', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({
      connectionString,
      max: 10,
      options: '-c statement_timeout=15000 -c lock_timeout=10000',
    });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repo = new PostgresOrderRepository({ database, envelopeKey: KEY });
    const olistFor = (/** @type {any} */ db = database) =>
      createOlistRepository(db, {
        envelopeKey: KEY,
        hmacKey: KEY,
        clock: () => NOW,
      });
    const options = {
      actor: OWNER,
      expectedVersion: 1,
      correlationId: 't10-guards',
    };
    const service = createOrderService({
      repository: repo,
      fabCode: '01',
      clock: () => NOW,
      authorizeOwnership: async () => {},
      authorizeManualOwnership: async () => {},
      conversations: {
        readOrderContexts: async () => new Map(),
        searchConversationIds: async () => [],
        readContactNames: async (ids) =>
          new Map(ids.map((id) => [id, 'Nome alterado depois do snapshot'])),
      },
    });
    /** @param {boolean} [exported] @param {string} [state] @returns {Promise<any>} */
    async function fixture(exported = true, state = 'confirmed') {
      const id = 't10-order-' + randomUUID(),
        contactId = 't10-contact-' + randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') n")).rows[0]
          .n,
      );
      const ficha = fixturePricing(
        {
          items: syntheticItems(),
          summary: {
            cliente: 'Nome congelado',
            nome: 'Pedido sintético',
            data_entrega_confirmada: '2026-11-20',
          },
          artwork: syntheticArtwork(),
          observations: [],
          serviceData: {},
        },
        32000,
      );
      await pool.query(
        `INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,status,fab_code,ficha_envelope,total_pieces,final_amount_cents,payment_condition,created_by_kind,created_by,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,'pendente','01',$7::jsonb,32,32000,'pix','user',$5,$8,$8)`,
        [
          id,
          n,
          String(n).padStart(2, '0') + '-CRM',
          contactId,
          OWNER.id,
          randomUUID(),
          JSON.stringify(encryptJson(ficha, 'order-ficha:' + id, KEY)),
          NOW,
        ],
      );
      const accountKey = hash(randomUUID()),
        contextKey = hash(randomUUID());
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,0)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_connections(account_key,context_key,token_envelope,expires_at) VALUES($1,$2,$3::jsonb,$4)',
        [
          accountKey,
          contextKey,
          JSON.stringify(
            seal(
              { accessToken: 'synthetic', refreshToken: 'synthetic' },
              KEY,
              'tokens',
              accountKey,
              contextKey,
            ),
          ),
          new Date(NOW.getTime() + 3600000),
        ],
      );
      const input = {
        orderId: id,
        accountKey,
        contextKey,
        orderVersion: 1,
        settingsVersion: 0,
        authorizationVersion: 1,
        connectionGeneration: 0,
        connectionVersion: 0,
        actor: OWNER,
        correlationId: 't10-guards',
        snapshot: {
          commercial: { totalCents: 32000 },
          customer: { nome: 'Nome fiscal congelado' },
        },
      };
      let operation;
      if (exported) {
        operation = await olistFor().prepareExport(input);
        await pool.query(
          'UPDATE crm.olist_exports SET state=$2,remote_id=$3 WHERE id=$1',
          [
            operation.id,
            state,
            ['confirmed', 'linked'].includes(state) ? '9100' : null,
          ],
        );
      }
      return { id, input, operation, order: await repo.findById(id) };
    }
    /** @param {string} id */
    async function persisted(id) {
      return (
        await pool.query(
          'SELECT to_jsonb(o) row FROM crm.orders o WHERE id=$1',
          [id],
        )
      ).rows[0].row;
    }
    /** Hold an actual repository order lock while the second connection races.
     * @returns {{database:any,locked:Promise<void>,release:()=>void}} */
    function pausedDatabase() {
      let notify = () => {},
        release = () => {},
        paused = false;
      const locked = new Promise(
        /** @param {(value?:any)=>void} resolve */ (resolve) => {
          notify = resolve;
        },
      );
      const gate = new Promise(
        /** @param {(value?:any)=>void} resolve */ (resolve) => {
          release = resolve;
        },
      );
      return {
        locked,
        release,
        database: {
          query: database.query,
          transaction: (/** @type {any} */ work) =>
            database.transaction((/** @type {any} */ tx) =>
              work({
                query: async (
                  /** @type {string} */ sql,
                  /** @type {any[]} */ values,
                ) => {
                  const result = await tx.query(sql, values);
                  if (
                    !paused &&
                    sql.includes('FROM crm.orders') &&
                    sql.includes('FOR UPDATE')
                  ) {
                    paused = true;
                    notify();
                    await gate;
                  }
                  return result;
                },
              }),
            ),
        },
      };
    }
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await pool.query(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,'t10-owner@example.test','Sintético','$argon2id$synthetic',true,1)",
        [OWNER.id],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
        [OWNER.id],
      );
      await t.test(
        'all reserved, uncertain, sent and linked operations block edits, reopening and agent projection',
        async () => {
          for (const state of [
            'queued',
            'resolving',
            'ready',
            'reserved',
            'uncertain',
            'confirmed',
            'linked',
          ]) {
            const f = await fixture(true, state),
              before = await persisted(f.id);
            for (const write of [
              () =>
                repo.saveSection(
                  {
                    ...f.order,
                    ficha: { ...f.order.ficha, observations: ['Mudança'] },
                  },
                  options,
                ),
              () => repo.projectBriefing(f.order, options),
              () =>
                repo.saveStatus(
                  {
                    ...f.order,
                    status: 'confirmado',
                    paymentCondition: /** @type {const} */ ('cartao_credito'),
                  },
                  options,
                ),
            ]) {
              await assert.rejects(
                write(),
                (/** @type {any} */ e) =>
                  isLocked(e) || e.code === 'ORDER_OLIST_SNAPSHOT_MISMATCH',
              );
            }
            assert.deepEqual(await persisted(f.id), before);
          }
        },
      );
      await t.test(
        'completed pending exports confirm with frozen client, ficha bytes, ERP snapshot and money intact',
        async () => {
          for (const state of ['confirmed', 'linked']) {
            const f = await fixture(true, state),
              before = await persisted(f.id);
            const exportBefore = (
              await pool.query(
                'SELECT to_jsonb(e) row FROM crm.olist_exports e WHERE id=$1',
                [f.operation.id],
              )
            ).rows[0].row;
            await pool.query(
              'UPDATE crm.contacts SET display_name=$2,version=version+1 WHERE id=$1',
              [f.order.contactId, 'Cadastro alterado após exportação'],
            );
            const result = await service.confirm({
              ...options,
              orderId: f.id,
              paymentCondition: 'pix',
            });
            assert.equal(result.status, 'confirmado');
            assert.equal(result.ficha.summary.cliente, 'Nome congelado');
            const after = await persisted(f.id);
            for (const field of [
              'ficha_envelope',
              'final_amount_cents',
              'payment_condition',
              'paid_on',
              'delivered_on',
              'total_pieces',
            ])
              assert.deepEqual(after[field], before[field], field);
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT to_jsonb(e) row FROM crm.olist_exports e WHERE id=$1',
                  [f.operation.id],
                )
              ).rows[0].row,
              exportBefore,
            );
            await assert.rejects(
              service.reopen({ ...options, orderId: f.id, expectedVersion: 2 }),
              isLocked,
            );
            assert.equal((await repo.findById(f.id))?.version, 2);
          }
        },
      );
      await t.test(
        'even direct confirmation cannot change any ficha field, client, subtotal or payment condition',
        async () => {
          const f = await fixture(),
            before = await persisted(f.id);
          const candidate = confirmOrder(f.order, {
            actorId: OWNER.id,
            now: NOW,
            paymentCondition: 'pix',
          });
          for (const change of [
            { paymentCondition: /** @type {const} */ ('cartao_credito') },
            { finalAmountCents: 31999 },
            { totalPieces: 31 },
            {
              ficha: {
                ...candidate.ficha,
                summary: { ...candidate.ficha.summary, cliente: 'Outro' },
              },
            },
            {
              ficha: { ...candidate.ficha, observations: ['Outra observação'] },
            },
          ])
            await assert.rejects(
              repo.saveStatus({ ...candidate, ...change }, options),
              (/** @type {any} */ e) =>
                e.code === 'ORDER_OLIST_SNAPSHOT_MISMATCH',
            );
          assert.deepEqual(await persisted(f.id), before);
        },
      );
      await t.test(
        'milestones remain independent after export and do not rewrite commercial envelopes',
        async () => {
          const f = await fixture(),
            before = await persisted(f.id);
          const result = await service.recordMilestones({
            ...options,
            orderId: f.id,
            paidOn: '2026-11-06',
            paymentReviewed: true,
          });
          assert.equal(result.paidOn, '2026-11-06');
          assert.deepEqual(
            (await persisted(f.id)).ficha_envelope,
            before.ficha_envelope,
          );
        },
      );
      await t.test(
        'rejected/invalidated operations unlock only when no effect or remote identity survives',
        async () => {
          for (const state of ['invalidated', 'rejected']) {
            const f = await fixture(true, state);
            await repo.saveSection(f.order, options);
            const g = await fixture(true, state);
            await pool.query(
              'UPDATE crm.olist_exports SET observed_sale_id=$2 WHERE id=$1',
              [g.operation.id, '9102'],
            );
            await assert.rejects(repo.saveSection(g.order, options), isLocked);
            // Migration 0071 forbids a NEW sale attempt on an invalidated export,
            // so the surviving attempt is recorded before the row is archived.
            const h = await fixture(true, 'queued');
            await pool.query(
              "INSERT INTO crm.olist_attempts(id,account_key,export_id,stage,fence,generation) VALUES($1,$2,$3,'sale',$4,0)",
              [randomUUID(), h.input.accountKey, h.operation.id, randomUUID()],
            );
            await pool.query(
              'UPDATE crm.olist_exports SET state=$2 WHERE id=$1',
              [h.operation.id, state],
            );
            await assert.rejects(repo.saveSection(h.order, options), isLocked);
          }
        },
      );
      await t.test(
        'art uploads/deletions are denied by the locked row before changing catalog rows',
        async () => {
          const f = await fixture(),
            files = new PostgresOrderFileRepository({
              database,
              envelopeKey: KEY,
            });
          await assert.rejects(
            files.remove(f.id, 'missing', { actor: OWNER }),
            isLocked,
          );
          await assert.rejects(
            files.add(
              {
                id: 'synthetic-art',
                orderId: f.id,
                slot: 'reference',
                objectKey: 'synthetic-art',
                thumbnailKey: null,
                name: 'arte.pdf',
                extension: 'pdf',
                contentType: 'application/pdf',
                sizeBytes: 10,
                contentSha256: 'a'.repeat(64),
                uploadedBy: OWNER.id,
                uploadedAt: NOW.toISOString(),
              },
              { actor: OWNER },
            ),
            isLocked,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) n FROM crm.order_files WHERE order_id=$1',
                  [f.id],
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
      await t.test(
        'exported store quantity correction is blocked while gateway and original checkout remain unchanged',
        async () => {
          const actor = {
            id: 't10-store-admin',
            kind: 'human',
            capabilities: ['COMMERCIAL_ADMIN'],
          };
          await pool.query(
            "INSERT INTO crm.users(id,email,name,password_hash) VALUES($1,'t10-store-admin@example.test','Admin Sintético','$argon2id$synthetic')",
            [actor.id],
          );
          await pool.query(
            "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
            [actor.id],
          );
          await pool.query(
            "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
            [actor.id],
          );
          const store = createStoreOrderService({
            repository: repo,
            fabCode: '01',
            hmacKey: KEY,
            acceptTest: false,
            clock: () => STORE_NOW,
          });
          const { order } = await store.record({
            actor: 'AUTOMATION_EXECUTOR',
            correlationId: 't10-store',
            record: store.parse(storeOrderBody()),
          });
          const f = await fixture(false);
          await olistFor().prepareExport({
            ...f.input,
            orderId: order.id,
            orderVersion: order.version,
          });
          const before = await persisted(order.id);
          const receipt = (
            await pool.query(
              'SELECT to_jsonb(r) row FROM crm.store_order_receipts r WHERE order_id=$1',
              [order.id],
            )
          ).rows[0];
          assert.ok(order.finalAmountCents !== null);
          await assert.rejects(
            repo.correctStoreOrder({
              actor,
              orderId: order.id,
              expectedVersion: order.version,
              expectedQuantity: order.totalPieces,
              correlationId: 't10-store-correction',
              expectedAmountCents: order.finalAmountCents,
              quantity: 2,
              amountCents: 100,
              marker: randomUUID(),
              now: NOW,
            }),
            isLocked,
          );
          assert.deepEqual(await persisted(order.id), before);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(r) row FROM crm.store_order_receipts r WHERE order_id=$1',
                [order.id],
              )
            ).rows[0],
            receipt,
          );
        },
      );
      await t.test(
        'supplemental sources cannot bypass the commercial lock',
        async () => {
          const f = await fixture();
          await assert.rejects(
            repo.savePriceBreakdown(
              {
                ...options,
                orderId: f.id,
                now: NOW,
                value: { action: 'initialize' },
              },
              undefined,
            ),
            { code: 'ORDER_SOURCE_LOCKED' },
          );
        },
      );
      await t.test(
        'milestones during queued dispatch conservatively stop the next effect by version',
        async () => {
          const f = await fixture(true, 'queued');
          const before = (
            await pool.query(
              'SELECT snapshot_envelope FROM crm.olist_exports WHERE id=$1',
              [f.operation.id],
            )
          ).rows[0];
          await service.recordMilestones({
            ...options,
            orderId: f.id,
            paidOn: '2026-11-06',
            paymentReviewed: true,
          });
          await assert.rejects(
            olistFor().validateDispatch({
              ...f.input,
              exportId: f.operation.id,
            }),
            { code: 'VERSION_CONFLICT' },
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT snapshot_envelope FROM crm.olist_exports WHERE id=$1',
                [f.operation.id],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) n FROM crm.olist_attempts WHERE export_id=$1',
                  [f.operation.id],
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
      await t.test(
        'export acceptance beats an incompatible concurrent edit on an independent connection',
        async () => {
          const f = await fixture(false),
            pause = pausedDatabase();
          const first = olistFor(pause.database).prepareExport(f.input);
          await pause.locked;
          const second = repo.saveSection(f.order, options);
          const resultPromise = Promise.allSettled([first, second]);
          pause.release();
          const result = await resultPromise;
          assert.equal(result[0].status, 'fulfilled');
          assert.equal(result[1].status, 'rejected');
          if (result[1].status === 'rejected')
            assert.ok(isLocked(result[1].reason));
        },
      );
      await t.test(
        'an incompatible edit beats acceptance and the stale snapshot is never queued',
        async () => {
          const f = await fixture(false),
            pause = pausedDatabase(),
            writer = new PostgresOrderRepository({
              database: pause.database,
              envelopeKey: KEY,
            });
          const first = writer.saveSection(f.order, options);
          await pause.locked;
          const second = olistFor().prepareExport(f.input);
          const resultPromise = Promise.allSettled([first, second]);
          pause.release();
          const result = await resultPromise;
          assert.equal(result[0].status, 'fulfilled');
          assert.equal(result[1].status, 'rejected');
          if (result[1].status === 'rejected')
            assert.equal(result[1].reason.code, 'VERSION_CONFLICT');
          assert.equal(
            Number(
              (
                await pool.query(
                  'SELECT count(*) n FROM crm.olist_exports WHERE order_id=$1',
                  [f.id],
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
    } finally {
      await pool.end();
    }
  });
