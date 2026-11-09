import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  migrate,
  loadMigrations,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOlistAdminRepository } from '../modules/olist/src/admin-repository.js';
import { createOlistRepository } from '../modules/olist/src/repository.js';
import { buildOlistSalePayload } from '../modules/olist/src/sale-payload.js';
import { seal, open } from '../modules/olist/src/crypto.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { readOlistCommercialLocks } from '../modules/orders/src/adapters/olist-commercial-lock.js';

const URL = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 71),
  HMAC = Buffer.alloc(32, 72);
const CANARY = 'PRIVATE_INVALIDATION_CANARY';
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const sleep = (/** @type {number} */ ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const ATTR = {
  garment: 'camisa',
  color: 'azul',
  fabric: '["algodão"]',
  application: 'silk',
  collar: 'polo',
  audience: '',
};

if (!URL)
  test(
    'OLIST-LIVENESS L1 invalidation SQL requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-LIVENESS L1 administrative export invalidation is local, atomic, race-free and terminal', async (t) => {
    assert.equal(new globalThis.URL(URL).pathname.slice(1), 'crm_silmer_test');
    const pool = new Pool({
      connectionString: URL,
      max: 12,
      options: '-c statement_timeout=20000 -c lock_timeout=12000',
    });
    const db = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    /** @param {any} [database] */
    const adminFor = (database = db) =>
      createOlistAdminRepository(database, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    /** @param {any} [database] */
    const repoFor = (database = db) =>
      createOlistRepository(database, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    const repo = repoFor();
    const orders = new PostgresOrderRepository({
      database: db,
      envelopeKey: KEY,
    });
    const accountKey = hash('synthetic-liveness-account'),
      contextKey = hash('synthetic-liveness-context');

    /** @param {string} id @param {string} fn @param {boolean} olist @param {string[]} [caps] */
    async function user(id, fn, olist, caps = []) {
      const session = hash(randomUUID());
      await pool.query(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',$3,$4)",
        [id, id + '@example.test', olist, olist ? 1 : 0],
      );
      await pool.query(
        'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
        [id, fn],
      );
      for (const capability of caps)
        await pool.query(
          'INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,$2)',
          [id, capability],
        );
      await pool.query(
        'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
        [
          session,
          id,
          hash('synthetic-csrf'),
          NOW,
          new Date(NOW.getTime() + 86400000),
        ],
      );
      return session;
    }
    /** Base rows only (account, settings, connection, users, order), no export.
     * @returns {Promise<any>} */
    async function seed() {
      await pool.query('TRUNCATE crm.olist_accounts CASCADE');
      const owner = 'owner-' + randomUUID(),
        admin = 'admin-' + randomUUID(),
        seller = 'seller-' + randomUUID(),
        finance = 'finance-' + randomUUID();
      await user(owner, 'Vendedor', true);
      const session = await user(admin, 'Vendedor', false, [
        'COMMERCIAL_ADMIN',
      ]);
      const sellerSession = await user(seller, 'Vendedor', true);
      const financeSession = await user(finance, 'Financeiro', true);
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,4)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_connections(context_key,account_key,generation,version,token_envelope,expires_at) VALUES($1,$2,3,2,$3::jsonb,$4)',
        [
          contextKey,
          accountKey,
          JSON.stringify(
            seal(
              { accessToken: 'synthetic-access', refreshToken: 'synthetic' },
              KEY,
              'tokens',
              accountKey,
              contextKey,
            ),
          ),
          new Date(NOW.getTime() + 3600000),
        ],
      );
      const orderId = 'liveness-order-' + randomUUID(),
        contactId = 'liveness-contact-' + randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') n")).rows[0]
          .n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,manual_create_key,contact_id) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC',$8::jsonb,'user',$4,$5,$5,$4,$6,$7)",
        [
          orderId,
          n,
          String(n).padStart(2, '0') + '-CRM',
          owner,
          NOW,
          randomUUID(),
          contactId,
          JSON.stringify(
            encryptJson(
              {
                items: [],
                summary: {},
                observations: [],
                artwork: {},
                serviceData: {},
              },
              'order-ficha:' + orderId,
              KEY,
            ),
          ),
        ],
      );
      const groupId = randomUUID();
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
        settings: {
          sellerId: 11,
          operationNatureId: 12,
          warehouseId: 13,
          paymentMethodId: 14,
          originId: 15,
          priceListId: null,
          purchaseOrder: null,
          paymentTerms: 'À vista',
          paymentDueOn: '2026-11-06',
          receivingMethodId: null,
        },
        sourceVersions: { contactId, contactVersion: 1, sourceRevision: 0 },
        commercial: {
          orderDate: '2026-11-06',
          deliveryOn: '2026-11-12',
          paymentCondition: 'pix',
          totalCents: 200,
          groups: [
            {
              groupId,
              attributes: ATTR,
              lines: ['M', 'G'].map((size) => ({
                groupId,
                lineId: randomUUID(),
                size,
                quantity: 1,
                subtotalCents: 100,
                unitCents: 100,
                unitLexeme: '1.00',
              })),
            },
          ],
        },
      };
      const resources = {
        resolved: true,
        customerId: '101',
        groups: [
          {
            groupId,
            productId: '201',
            lines: snapshot.commercial.groups[0].lines.map((line, i) => ({
              lineId: line.lineId,
              productId: String(301 + i),
            })),
          },
        ],
      };
      /** @type {any} */
      const original = {
        actor: { id: owner, kind: 'human' },
        authorizationVersion: 1,
        accountKey,
        contextKey,
        connectionGeneration: 3,
        connectionVersion: 2,
        settingsVersion: 4,
        orderId,
        correlationId: 'synthetic-liveness-original',
      };
      /** @param {string} id @param {string} sessionBinding @param {number} version */
      const actingAs = (id, sessionBinding, version = 0) => ({
        actor: { id, kind: 'human' },
        sessionBinding,
        authorizationVersion: version,
        accountKey,
        contextKey,
        orderId,
        correlationId: 'synthetic-liveness-admin',
      });
      return {
        owner,
        admin,
        seller,
        finance,
        session,
        sellerSession,
        financeSession,
        orderId,
        snapshot,
        resources,
        original,
        input: actingAs(admin, session),
        actingAs,
        operation: /** @type {any} */ (null),
        customer: /** @type {any} */ (null),
      };
    }
    /** A second order of the same account, prepared with the same snapshot.
     * @param {any} f */
    async function secondExport(f) {
      const orderId = 'liveness-second-' + randomUUID();
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') n")).rows[0]
          .n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,manual_create_key,contact_id) SELECT $1,$2,$3,NULL,'pendente','SYNTHETIC',$4::jsonb,'user',manual_owner_id,$5,$5,manual_owner_id,$6,contact_id FROM crm.orders WHERE id=$7",
        [
          orderId,
          n,
          String(n).padStart(2, '0') + '-CRM',
          JSON.stringify(
            encryptJson(
              {
                items: [],
                summary: {},
                observations: [],
                artwork: {},
                serviceData: {},
              },
              'order-ficha:' + orderId,
              KEY,
            ),
          ),
          NOW,
          randomUUID(),
          f.orderId,
        ],
      );
      return repo.prepareExport({
        ...f.original,
        exportId: undefined,
        orderId,
        orderVersion: 1,
        snapshot: f.snapshot,
      });
    }
    /** @param {any} f @param {string} [mode] */
    async function prepared(f, mode = 'queued') {
      const original = f.original;
      const operation = await repo.prepareExport({
        ...original,
        orderVersion: 1,
        snapshot: f.snapshot,
      });
      original.exportId = operation.id;
      f.operation = operation;
      /** @param {string} id @param {string} remoteId */
      const lookup = (id, remoteId) =>
        repo.confirmResourceLookup({
          ...original,
          resourceId: id,
          expectedVersion: 0,
          remoteId,
        });
      if (mode === 'queued') return f;
      const customer = await repo.bindResource({
        ...original,
        kind: 'customer',
        identity: f.snapshot.customer.cpfCnpj,
        payload: f.snapshot.customer,
      });
      f.customer = customer;
      if (mode.startsWith('customer')) {
        if (mode === 'customerConfirmed') await lookup(customer.id, '101');
        else {
          const ticket = await repo.reserveResourceEffect({
            ...original,
            resourceId: customer.id,
            expectedVersion: 0,
            requestPayload: f.snapshot.customer,
          });
          f.ticket = ticket;
          if (mode !== 'customerReserved') {
            await repo.recordObservedResourceId({
              ...original,
              ...ticket,
              remoteId: '101',
            });
            await repo.recordResult({
              ...original,
              ...ticket,
              remoteId: '101',
              response: { id: '101' },
              outcome:
                mode === 'customerAttemptConfirmed' ? 'confirmed' : 'uncertain',
            });
          }
        }
        return f;
      }
      assert.equal(mode, 'ready');
      await lookup(customer.id, '101');
      const parent = await repo.bindResource({
        ...original,
        kind: 'product',
        identity: ATTR,
        payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
      });
      await lookup(parent.id, '201');
      for (const [i, line] of f.snapshot.commercial.groups[0].lines.entries()) {
        const variation = await repo.bindResource({
          ...original,
          kind: 'variation',
          parentId: parent.id,
          identity: line.size,
          payload: { size: line.size.toLowerCase() },
        });
        await lookup(variation.id, String(301 + i));
      }
      await repo.markReady({ ...original, resources: f.resources });
      return f;
    }
    /** @param {string} [mode] */
    const fixture = async (mode = 'queued') => prepared(await seed(), mode);
    /** @param {string} id */
    async function exportRowById(id) {
      return (
        await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [id])
      ).rows[0];
    }
    /** @param {any} f */
    async function exportRow(f) {
      return (
        await pool.query('SELECT * FROM crm.olist_exports WHERE id=$1', [
          f.operation.id,
        ])
      ).rows[0];
    }
    /** @param {any} f @param {any} [over] */
    async function invalidate(f, over = {}, admin = adminFor()) {
      return admin.invalidateExport({
        ...f.input,
        operationId: f.operation.id,
        expectedVersion: Number((await exportRow(f)).version),
        reason: CANARY,
        ...over,
      });
    }
    /** @param {string} table */
    const count = async (table) =>
      Number(
        (await pool.query('SELECT count(*)::integer n FROM crm.' + table))
          .rows[0].n,
      );
    /** @param {string} table @param {string} where @param {any[]} values */
    const countWhere = async (table, where, values) =>
      Number(
        (
          await pool.query(
            'SELECT count(*)::integer n FROM crm.' + table + ' WHERE ' + where,
            values,
          )
        ).rows[0].n,
      );
    /** Insert a sale attempt directly (the fixture needs outcomes the flows
     * reach only later) without touching the export state. @param {any} f @param {string} outcome */
    const saleAttempt = (f, outcome) =>
      pool.query(
        "INSERT INTO crm.olist_attempts(id,account_key,export_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'sale',$4,3,$5,$6)",
        [
          randomUUID(),
          accountKey,
          f.operation.id,
          randomUUID(),
          outcome,
          outcome === 'reserved' ? null : NOW,
        ],
      );
    /** @param {any} f */
    const unchanged = async (f) => {
      const row = await exportRow(f);
      assert.notEqual(row.state, 'invalidated');
      assert.equal(await count('olist_export_invalidations'), 0);
      return row;
    };
    /** @type {any[]} */
    const holds = [];
    /** A failed assertion must never leave a held transaction blocking the
     * next subtest or the cleanup. */
    async function releaseHolds() {
      for (const client of [...holds]) {
        holds.splice(holds.indexOf(client), 1);
        try {
          await client.query('ROLLBACK');
        } catch {}
        client.release();
      }
    }
    t.afterEach(releaseHolds);
    /** Hold a transaction open on its own connection.
     * @returns {Promise<{client:any,db:any,commit:()=>Promise<void>,rollback:()=>Promise<void>}>} */
    async function held() {
      const client = await pool.connect();
      holds.push(client);
      await client.query('BEGIN');
      let done = false;
      const finish = async (/** @type {string} */ sql) => {
        if (done) return;
        done = true;
        try {
          await client.query(sql);
        } finally {
          holds.splice(holds.indexOf(client), 1);
          client.release();
        }
      };
      return {
        client,
        db: {
          query: client.query.bind(client),
          transaction: (/** @type {any} */ work) => work(client),
        },
        commit: () => finish('COMMIT'),
        rollback: () => finish('ROLLBACK'),
      };
    }
    /** Prove (not guess) that some backend is waiting on a lock. */
    async function lockWaiter() {
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(
          "SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        );
        if (rows[0].n > 0) return;
        await sleep(50);
      }
      assert.fail('no backend is waiting on a lock');
    }
    /** @param {Promise<any>} promise */
    const settle = (promise) =>
      promise.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    const forbidden = (/** @type {any} */ error) =>
      error.statusCode === 403 && error.code === 'FORBIDDEN';

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      await migrate(pool, { migrations });

      await t.test(
        '(1) a queued export with a pending job is archived: state, job, event and audit carry codes only, the reason lives only in the sealed envelope',
        async () => {
          const f = await fixture();
          const before = await exportRow(f);
          assert.equal(before.state, 'queued');
          const receipt = await invalidate(f);
          assert.deepEqual(receipt, {
            operationId: f.operation.id,
            orderId: f.orderId,
            state: 'invalidated',
            version: Number(before.version) + 1,
          });
          const row = await exportRow(f);
          assert.equal(row.state, 'invalidated');
          assert.equal(row.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          assert.equal(Number(row.version), Number(before.version) + 1);
          const job = (
            await pool.query(
              "SELECT * FROM crm.outbox_jobs WHERE olist_export_id=$1 AND job_type='olist.export'",
              [f.operation.id],
            )
          ).rows[0];
          assert.equal(job.status, 'completed');
          assert.ok(job.completed_at);
          assert.equal(job.locked_by, null);
          assert.equal(job.locked_until, null);
          assert.equal(job.heartbeat_at, null);
          assert.equal(job.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          assert.equal(
            await countWhere(
              'olist_events',
              "export_id=$1 AND event_code='OLIST_EXPORT_INVALIDATED'",
              [f.operation.id],
            ),
            1,
          );
          const audit = (
            await pool.query(
              "SELECT * FROM crm.audit_events WHERE action='olist.invalidate'",
            )
          ).rows;
          assert.equal(audit.length, 1);
          assert.equal(audit[0].target_id, f.operation.id);
          assert.equal(audit[0].actor_id, f.admin);
          assert.equal(audit[0].reason, 'OLIST_EXPORT_INVALIDATED');
          const stored = (
            await pool.query('SELECT * FROM crm.olist_export_invalidations')
          ).rows;
          assert.equal(stored.length, 1);
          assert.equal(stored[0].export_id, f.operation.id);
          assert.equal(stored[0].actor_id, f.admin);
          assert.equal(stored[0].authorization_version, 0);
          assert.equal(stored[0].expected_version, Number(before.version));
          assert.equal(
            open(
              stored[0].reason_envelope,
              KEY,
              'export-invalidation',
              accountKey,
              stored[0].id,
            ),
            CANARY,
          );
          assert.throws(() =>
            open(
              stored[0].reason_envelope,
              KEY,
              'export-invalidation',
              accountKey,
              randomUUID(),
            ),
          );
          const everything = JSON.stringify(
            await Promise.all(
              [
                'olist_events',
                'audit_events',
                'idempotency_records',
                'outbox_jobs',
                'reconciliation_items',
              ].map(
                async (table) =>
                  (await pool.query('SELECT * FROM crm.' + table)).rows,
              ),
            ),
          );
          assert.doesNotMatch(everything, new RegExp(CANARY));
          assert.doesNotMatch(JSON.stringify(receipt), new RegExp(CANARY));
          assert.doesNotMatch(
            JSON.stringify(
              (
                await pool.query(
                  'SELECT id,account_key,export_id,actor_id,correlation_id FROM crm.olist_export_invalidations',
                )
              ).rows,
            ),
            new RegExp(CANARY),
          );
          // Nothing of the ERP changed: zero attempts, zero resources.
          assert.equal(await count('olist_attempts'), 0);
          assert.equal(await count('olist_resources'), 0);
        },
      );

      await t.test(
        '(2) a dead_letter / outcome_unknown / retry job with an open reconciliation item is retired and the item resolved',
        async () => {
          for (const status of ['dead_letter', 'outcome_unknown', 'retry']) {
            const f = await fixture();
            const job = (
              await pool.query(
                'SELECT id FROM crm.outbox_jobs WHERE olist_export_id=$1',
                [f.operation.id],
              )
            ).rows[0];
            if (status === 'retry')
              await pool.query(
                "UPDATE crm.outbox_jobs SET status='retry',attempt_count=2,last_error_code='OLIST_RATE_LIMITED' WHERE id=$1",
                [job.id],
              );
            else {
              await pool.query(
                "UPDATE crm.outbox_jobs SET status=$2,attempt_count=8,completed_at=$3,last_error_code='OLIST_RATE_LIMITED' WHERE id=$1",
                [job.id, status, NOW],
              );
              await pool.query(
                "INSERT INTO crm.reconciliation_items(id,job_id,status,reason,created_at) VALUES($1,$2,'open','OLIST_RATE_LIMITED',$3)",
                [randomUUID(), job.id, NOW],
              );
            }
            const receipt = await invalidate(f);
            assert.equal(receipt.state, 'invalidated', status);
            const after = (
              await pool.query('SELECT * FROM crm.outbox_jobs WHERE id=$1', [
                job.id,
              ])
            ).rows[0];
            assert.equal(after.status, 'completed', status);
            assert.ok(after.completed_at);
            assert.equal(after.last_error_code, 'OLIST_RATE_LIMITED');
            assert.equal(after.locked_by, null);
            assert.equal(
              await countWhere('reconciliation_items', "status='open'", []),
              0,
              status,
            );
            if (status !== 'retry') {
              const item = (
                await pool.query(
                  'SELECT * FROM crm.reconciliation_items WHERE job_id=$1',
                  [job.id],
                )
              ).rows[0];
              assert.equal(item.status, 'resolved');
              assert.ok(item.resolved_at);
            }
          }
        },
      );

      await t.test(
        '(3) any sale attempt, observed sale ID or remote ID blocks, in the repository and in the database trigger',
        async () => {
          for (const outcome of [
            'reserved',
            'uncertain',
            'confirmed',
            'rejected',
          ]) {
            const f = await fixture('ready');
            await saleAttempt(f, outcome);
            await assert.rejects(invalidate(f), {
              code: 'OLIST_INVALIDATION_BLOCKED',
            });
            assert.equal((await unchanged(f)).state, 'ready', outcome);
          }
          const observed = await fixture('ready');
          await pool.query(
            "UPDATE crm.olist_exports SET observed_sale_id='401' WHERE id=$1",
            [observed.operation.id],
          );
          await assert.rejects(invalidate(observed), {
            code: 'OLIST_INVALIDATION_BLOCKED',
          });
          await unchanged(observed);
          // A real reservation through the worker port also blocks.
          const reserved = await fixture('ready');
          const plan = buildOlistSalePayload({
            snapshot: reserved.snapshot,
            resolved: reserved.resources,
            reference: reserved.operation.reference,
          });
          await repo.reserveSaleEffect({
            ...reserved.original,
            requestPayload: { encoded: plan.encoded },
          });
          await assert.rejects(invalidate(reserved), {
            code: 'OLIST_INVALIDATION_BLOCKED',
          });
          assert.equal((await unchanged(reserved)).state, 'reserved');

          // Direct fraud: a receipt row for an export that had a sale attempt is
          // refused by the trigger itself (state forced to invalidated first, so
          // only the sale evidence is at stake).
          for (const evidence of ['attempt', 'observed']) {
            const f = await fixture('ready');
            if (evidence === 'attempt') await saleAttempt(f, 'rejected');
            else
              await pool.query(
                "UPDATE crm.olist_exports SET observed_sale_id='402' WHERE id=$1",
                [f.operation.id],
              );
            await pool.query(
              "UPDATE crm.olist_exports SET state='invalidated' WHERE id=$1",
              [f.operation.id],
            );
            await assert.rejects(
              pool.query(
                'INSERT INTO crm.olist_export_invalidations(id,account_key,export_id,actor_id,authorization_version,expected_version,reason_envelope,correlation_id) VALUES($1,$2,$3,$4,0,1,$5::jsonb,$6)',
                [
                  randomUUID(),
                  accountKey,
                  f.operation.id,
                  f.admin,
                  JSON.stringify(
                    seal('x', KEY, 'export-invalidation', accountKey, 'x'),
                  ),
                  'synthetic-fraud',
                ],
              ),
              /sale attempt cannot be invalidated/,
              evidence,
            );
            assert.equal(await count('olist_export_invalidations'), 0);
          }
          // ... and for a export that is not invalidated at all.
          const live = await fixture();
          await assert.rejects(
            pool.query(
              'INSERT INTO crm.olist_export_invalidations(id,account_key,export_id,actor_id,authorization_version,expected_version,reason_envelope,correlation_id) VALUES($1,$2,$3,$4,0,1,$5::jsonb,$6)',
              [
                randomUUID(),
                accountKey,
                live.operation.id,
                live.admin,
                JSON.stringify(
                  seal('x', KEY, 'export-invalidation', accountKey, 'x'),
                ),
                'synthetic-fraud',
              ],
            ),
            /requires an invalidated export/,
          );
          // The receipt table is append-only.
          const ok = await invalidate(live);
          assert.equal(ok.state, 'invalidated');
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_export_invalidations SET correlation_id=$1',
              ['tampered'],
            ),
            /append only/,
          );
          await assert.rejects(
            pool.query('DELETE FROM crm.olist_export_invalidations'),
            /append only/,
          );
        },
      );

      await t.test(
        '(4) a resource ticket reserved/uncertain blocks (reconcile first); a confirmed resource does not',
        async () => {
          for (const mode of ['customerReserved', 'customerUncertain']) {
            const f = await fixture(mode);
            await assert.rejects(invalidate(f), {
              code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
            });
            await unchanged(f);
          }
          for (const mode of [
            'customerConfirmed',
            'customerAttemptConfirmed',
          ]) {
            const f = await fixture(mode);
            const receipt = await invalidate(f);
            assert.equal(receipt.state, 'invalidated', mode);
            const resource = (
              await pool.query('SELECT * FROM crm.olist_resources')
            ).rows[0];
            assert.equal(resource.state, 'confirmed');
            assert.equal(resource.remote_id, '101');
          }
          // Attempt outcome alone (the resource row not blocking by itself):
          // a `reserved` attempt ALWAYS blocks, even when the resource row
          // already reads confirmed (a POST may still be in flight).
          const reservedAttempt = await fixture('customerConfirmed');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome) VALUES($1,$2,$3,'customer',$4,3,'reserved')",
            [
              randomUUID(),
              accountKey,
              reservedAttempt.customer.id,
              randomUUID(),
            ],
          );
          await assert.rejects(invalidate(reservedAttempt), {
            code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
          });
          await unchanged(reservedAttempt);
          // An `uncertain` attempt of a resource that is NOT confirmed (still
          // pending, or rejected) blocks too, as before.
          for (const state of ['pending', 'rejected']) {
            const f = await fixture('customerConfirmed');
            await pool.query(
              "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'customer',$4,3,'uncertain',$5)",
              [randomUUID(), accountKey, f.customer.id, randomUUID(), NOW],
            );
            await pool.query(
              'UPDATE crm.olist_resources SET state=$2,remote_id=NULL WHERE id=$1',
              [f.customer.id, state],
            );
            await assert.rejects(invalidate(f), {
              code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
            });
            await unchanged(f);
          }
          // The attempt is immutable history: an `uncertain` attempt whose
          // resource is `confirmed` WITH a remote ID no longer blocks
          // (A1 of the liveness review).
          const history = await fixture('customerConfirmed');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'customer',$4,3,'uncertain',$5)",
            [randomUUID(), accountKey, history.customer.id, randomUUID(), NOW],
          );
          const receipt = await invalidate(history);
          assert.equal(receipt.state, 'invalidated');
        },
      );

      await t.test(
        '(4b) reconcile-then-invalidate: an uncertain resource blocks until /reconcile confirms it; the old uncertain attempt then no longer blocks',
        async () => {
          const f = await fixture('customerUncertain');
          const admin = adminFor();
          // Before the reconciliation: the resource is uncertain -> refused.
          await assert.rejects(invalidate(f), {
            code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
          });
          await unchanged(f);
          assert.equal(
            await repo.assertRetrySafe({
              exportId: f.operation.id,
              accountKey,
              contextKey,
            }),
            false,
          );
          // The administrator confirms the resource by a verified lookup.
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          assert.equal(resource.state, 'uncertain');
          const request = await admin.createReadRequest({
            ...f.input,
            connectionGeneration: 3,
            connectionVersion: 2,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'conferencia sintetica',
          });
          const finished = await admin.completeReadRequest({
            ...f.input,
            requestId: request.requestId,
            matched: true,
            remoteId: '101',
            proof: { matched: true },
            connectionGeneration: 3,
          });
          assert.equal(finished.status, 'succeeded');
          // The resource is confirmed with its remote ID, but the immutable
          // attempt is still `uncertain` (trigger 0068 / completeReadRequest).
          const resourceRow = (
            await pool.query('SELECT * FROM crm.olist_resources WHERE id=$1', [
              f.customer.id,
            ])
          ).rows[0];
          assert.equal(resourceRow.state, 'confirmed');
          assert.equal(resourceRow.remote_id, '101');
          const attempts = (
            await pool.query(
              'SELECT outcome FROM crm.olist_attempts WHERE resource_id=$1',
              [f.customer.id],
            )
          ).rows;
          assert.deepEqual(
            attempts.map((attempt) => attempt.outcome),
            ['uncertain'],
          );
          // Retry gate and invalidation agree: no POST can happen any more.
          assert.equal(
            await repo.assertRetrySafe({
              exportId: f.operation.id,
              accountKey,
              contextKey,
            }),
            true,
          );
          // A confirmed resource is never posted again: on the still-live export
          // the writer refuses it, which is why the old attempt is harmless.
          await assert.rejects(
            repo.reserveResourceEffect({
              ...f.original,
              resourceId: f.customer.id,
              expectedVersion: Number(resourceRow.version),
              connectionVersion: 2,
              requestPayload: f.snapshot.customer,
            }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
          const receipt = await invalidate(f);
          assert.equal(receipt.state, 'invalidated');
          assert.equal((await exportRow(f)).state, 'invalidated');
          // Nothing in the ERP bookkeeping was rewritten.
          const kept = (
            await pool.query(
              'SELECT state,remote_id FROM crm.olist_resources WHERE id=$1',
              [f.customer.id],
            )
          ).rows[0];
          assert.deepEqual(kept, { state: 'confirmed', remote_id: '101' });
        },
      );

      await t.test(
        '(4c) assertRetrySafe fields are independent: the resource alone, or the attempt alone, makes the retry unsafe',
        async () => {
          const scope = (/** @type {any} */ f) => ({
            exportId: f.operation.id,
            accountKey,
            contextKey,
          });
          // Resource open, attempt closed (confirmed outcome): resource_open.
          const resourceOnly = await fixture('customerAttemptConfirmed');
          assert.equal(
            await repo.assertRetrySafe(scope(resourceOnly)),
            true,
            'baseline: attempt and resource both confirmed',
          );
          for (const state of ['reserved', 'uncertain']) {
            await pool.query(
              'UPDATE crm.olist_resources SET state=$2,remote_id=NULL WHERE id=$1',
              [resourceOnly.customer.id, state],
            );
            assert.equal(
              await repo.assertRetrySafe(scope(resourceOnly)),
              false,
              'resource ' + state + ' alone',
            );
            await assert.rejects(invalidate(resourceOnly), {
              code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
            });
          }
          // Attempt open, resource closed (confirmed with a remote ID):
          // attempt_open, only for `reserved` (an uncertain attempt of a
          // confirmed resource is history).
          const attemptOnly = await fixture('customerConfirmed');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'customer',$4,3,'uncertain',$5)",
            [
              randomUUID(),
              accountKey,
              attemptOnly.customer.id,
              randomUUID(),
              NOW,
            ],
          );
          assert.equal(
            await repo.assertRetrySafe(scope(attemptOnly)),
            true,
            'uncertain attempt of a confirmed resource is history',
          );
          const reserved = await fixture('customerConfirmed');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome) VALUES($1,$2,$3,'customer',$4,3,'reserved')",
            [randomUUID(), accountKey, reserved.customer.id, randomUUID()],
          );
          assert.equal(
            await repo.assertRetrySafe(scope(reserved)),
            false,
            'reserved attempt alone',
          );
          // Uncertain attempt of a resource that is not confirmed: attempt_open
          // alone (the resource row itself is pending, which is not open).
          const pending = await fixture('customerConfirmed');
          await pool.query(
            "INSERT INTO crm.olist_attempts(id,account_key,resource_id,stage,fence,generation,outcome,finished_at) VALUES($1,$2,$3,'customer',$4,3,'uncertain',$5)",
            [randomUUID(), accountKey, pending.customer.id, randomUUID(), NOW],
          );
          await pool.query(
            "UPDATE crm.olist_resources SET state='pending',remote_id=NULL WHERE id=$1",
            [pending.customer.id],
          );
          assert.equal(
            await repo.assertRetrySafe(scope(pending)),
            false,
            'uncertain attempt of a non-confirmed resource alone',
          );
        },
      );

      await t.test(
        '(4d) invalidate x resource-result writer: independent connections, no deadlock, one consistent outcome',
        async () => {
          /** A database whose transaction pauses right before its first
           * `olist_events` INSERT (the FK that takes KEY SHARE on the export),
           * i.e. after the attempt and resource row locks are already held.
           * Everything else is the real repository code on a real connection. */
          const gated = () => {
            let hit = false;
            /** @type {() => void} */
            let release = () => {};
            const gate = new Promise((resolve) => (release = () => resolve(0)));
            /** @type {() => void} */
            let reach = () => {};
            const reached = new Promise(
              (resolve) => (reach = () => resolve(0)),
            );
            return {
              reached,
              release: () => release(),
              database: {
                query: pool.query.bind(pool),
                transaction: (/** @type {any} */ work) =>
                  withTransaction(pool, (/** @type {any} */ client) =>
                    work({
                      query: async (
                        /** @type {string} */ sql,
                        /** @type {any[]} */ values,
                      ) => {
                        if (
                          !hit &&
                          /^INSERT INTO crm\.olist_events/u.test(sql)
                        ) {
                          hit = true;
                          reach();
                          await gate;
                        }
                        return client.query(sql, values);
                      },
                    }),
                  ),
              },
            };
          };
          /** @param {any} value */
          const noDeadlock = (value) => {
            assert.notEqual(
              /** @type {any} */ (value).error?.code,
              '40P01',
              'deadlock between the invalidation and the result writer',
            );
          };
          // (a) The result is `confirmed`: the writer holds the attempt and
          // resource locks, the invalidation holds the export lock and waits on
          // the resource; releasing the writer must not deadlock, and the
          // invalidation then sees the confirmed state and succeeds.
          {
            const f = await fixture('customerReserved');
            const g = gated();
            const writing = settle(
              repoFor(g.database).recordResult({
                ...f.original,
                ...f.ticket,
                remoteId: '101',
                response: { id: '101' },
                outcome: 'confirmed',
              }),
            );
            await g.reached;
            const racing = settle(invalidate(f));
            await lockWaiter();
            g.release();
            const [written, invalidated] = await Promise.all([writing, racing]);
            noDeadlock(written);
            noDeadlock(invalidated);
            assert.equal(written.ok, true);
            assert.equal(invalidated.ok, true);
            assert.equal(
              /** @type {any} */ (invalidated).value.state,
              'invalidated',
            );
            const resource = (
              await pool.query(
                'SELECT * FROM crm.olist_resources WHERE id=$1',
                [f.customer.id],
              )
            ).rows[0];
            assert.equal(resource.state, 'confirmed');
            assert.equal(
              await countWhere(
                'olist_events',
                "export_id=$1 AND event_code='OLIST_EFFECT_CONFIRMED'",
                [f.operation.id],
              ),
              1,
            );
          }
          // (b) The result is `uncertain`: the invalidation, serialized behind
          // the writer, sees the uncertain resource and is refused.
          {
            const f = await fixture('customerReserved');
            const g = gated();
            const writing = settle(
              repoFor(g.database).recordResult({
                ...f.original,
                ...f.ticket,
                response: null,
                outcome: 'uncertain',
              }),
            );
            await g.reached;
            const racing = settle(invalidate(f));
            await lockWaiter();
            g.release();
            const [written, invalidated] = await Promise.all([writing, racing]);
            noDeadlock(written);
            noDeadlock(invalidated);
            assert.equal(written.ok, true);
            assert.equal(invalidated.ok, false);
            assert.equal(
              /** @type {any} */ (invalidated).error.code,
              'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
            );
            assert.equal((await unchanged(f)).state, 'queued');
            assert.equal(
              (
                await pool.query(
                  'SELECT state FROM crm.olist_resources WHERE id=$1',
                  [f.customer.id],
                )
              ).rows[0].state,
              'uncertain',
            );
          }
          // (c) A composed (product + children) batch result, paused after its
          // first child: same guarantees, and the children are locked in the
          // same ascending order by both sides.
          {
            const f = await fixture('customerConfirmed');
            const parent = await repo.bindResource({
              ...f.original,
              kind: 'product',
              identity: ATTR,
              payload: { attributes: ATTR, fiscal: f.snapshot.productFiscal },
            });
            const children = [];
            for (const line of f.snapshot.commercial.groups[0].lines)
              children.push(
                await repo.bindResource({
                  ...f.original,
                  kind: 'variation',
                  parentId: parent.id,
                  identity: line.size,
                  payload: { size: line.size.toLowerCase() },
                }),
              );
            const ticket = await repo.reserveResourceBatchEffect({
              ...f.original,
              resourceId: parent.id,
              expectedVersion: 0,
              requestPayload: {
                tipo: 'V',
                variacoes: children.map((child) => ({ sku: child.reference })),
              },
              dependentResourceIds: children.map((child) => child.id),
              connectionVersion: 2,
            });
            await repo.recordResult({
              ...f.original,
              ...ticket,
              remoteId: '201',
              response: { id: '201' },
              outcome: 'confirmed',
            });
            const g = gated();
            const writing = settle(
              repoFor(g.database).recordResourceBatchResult({
                ...f.original,
                results: ticket.children.map(
                  (/** @type {any} */ child, /** @type {number} */ i) => ({
                    ...child,
                    outcome: 'confirmed',
                    remoteId: String(301 + i),
                    response: { id: 301 + i },
                  }),
                ),
              }),
            );
            await g.reached;
            const racing = settle(invalidate(f));
            await lockWaiter();
            g.release();
            const [written, invalidated] = await Promise.all([writing, racing]);
            noDeadlock(written);
            noDeadlock(invalidated);
            assert.equal(written.ok, true);
            assert.equal(invalidated.ok, true);
            assert.equal((await exportRow(f)).state, 'invalidated');
            assert.equal(
              await countWhere(
                'olist_resources',
                "state='confirmed' AND id=ANY($1::uuid[])",
                [children.map((child) => child.id)],
              ),
              children.length,
            );
          }
        },
      );

      await t.test(
        '(5) invalidate x worker: exactly one winner, in both orders, and the trigger closes the raw-writer race',
        async () => {
          const planFor = (/** @type {any} */ f) =>
            buildOlistSalePayload({
              snapshot: f.snapshot,
              resolved: f.resources,
              reference: f.operation.reference,
            });
          // (a) The worker reserved first and is still in its transaction.
          {
            const f = await fixture('ready');
            const worker = await held();
            await repoFor(worker.db).reserveSaleEffect({
              ...f.original,
              requestPayload: { encoded: planFor(f).encoded },
            });
            const racing = settle(invalidate(f));
            await lockWaiter();
            await worker.commit();
            const outcome = await racing;
            assert.equal(outcome.ok, false);
            // The worker's commit bumped the version the admin read, so the
            // stale-version refusal may win over the blocked-state one.
            assert.ok(
              ['OLIST_INVALIDATION_BLOCKED', 'VERSION_CONFLICT'].includes(
                /** @type {any} */ (outcome).error.code,
              ),
            );
            assert.equal((await unchanged(f)).state, 'reserved');
            assert.equal(
              await countWhere('olist_attempts', "stage='sale'", []),
              1,
            );
          }
          // (b) The invalidation holds the locks first; the worker then fails
          // without any effect.
          {
            const f = await fixture('ready');
            const admin = await held();
            const receipt = await invalidate(f, {}, adminFor(admin.db));
            assert.equal(receipt.state, 'invalidated');
            const racing = settle(
              repo.reserveSaleEffect({
                ...f.original,
                requestPayload: { encoded: planFor(f).encoded },
              }),
            );
            await lockWaiter();
            await admin.commit();
            const outcome = await racing;
            assert.equal(outcome.ok, false);
            assert.equal(
              /** @type {any} */ (outcome).error.code,
              'OLIST_EXPORT_UNAVAILABLE',
            );
            assert.equal((await exportRow(f)).state, 'invalidated');
            assert.equal(await count('olist_attempts'), 0);
            assert.equal(await count('olist_export_invalidations'), 1);
          }
          // (c) Without any application lock at all, a raw sale-attempt INSERT
          // racing an uncommitted invalidation waits and is then refused.
          {
            const f = await fixture('ready');
            const admin = await held();
            await admin.client.query(
              "UPDATE crm.olist_exports SET state='invalidated' WHERE id=$1",
              [f.operation.id],
            );
            const raw = settle(saleAttempt(f, 'reserved'));
            await lockWaiter();
            await admin.commit();
            const outcome = await raw;
            assert.equal(outcome.ok, false);
            assert.match(
              /** @type {any} */ (outcome).error.message,
              /invalidated export cannot start a sale/,
            );
            assert.equal(await count('olist_attempts'), 0);
          }
          // (d) Unsynchronized trials: whoever wins, never both.
          for (let trial = 0; trial < 8; trial++) {
            const f = await fixture('ready');
            const [worker, admin] = await Promise.all([
              settle(
                repo.reserveSaleEffect({
                  ...f.original,
                  requestPayload: { encoded: planFor(f).encoded },
                }),
              ),
              settle(invalidate(f)),
            ]);
            const sales = await countWhere(
              'olist_attempts',
              "stage='sale'",
              [],
            );
            const receipts = await count('olist_export_invalidations');
            assert.equal(sales + receipts, 1, 'trial ' + trial);
            if (worker.ok) {
              assert.equal(admin.ok, false);
              assert.ok(
                ['OLIST_INVALIDATION_BLOCKED', 'VERSION_CONFLICT'].includes(
                  /** @type {any} */ (admin).error.code,
                ),
              );
            } else {
              assert.equal(admin.ok, true);
              assert.equal(
                /** @type {any} */ (worker).error.code,
                'OLIST_EXPORT_UNAVAILABLE',
              );
            }
          }
        },
      );

      await t.test(
        '(6) a processing job (live lease) answers OLIST_EXPORT_IN_FLIGHT and nothing is altered',
        async () => {
          const f = await fixture();
          await pool.query(
            "UPDATE crm.outbox_jobs SET status='processing',attempt_count=1,locked_by='worker-1',locked_until=$2,heartbeat_at=$3 WHERE olist_export_id=$1",
            [f.operation.id, new Date(NOW.getTime() + 30000), NOW],
          );
          const before = await exportRow(f);
          await assert.rejects(invalidate(f), {
            code: 'OLIST_EXPORT_IN_FLIGHT',
          });
          const after = await exportRow(f);
          assert.equal(after.state, before.state);
          assert.equal(after.version, before.version);
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM crm.outbox_jobs WHERE olist_export_id=$1',
                [f.operation.id],
              )
            ).rows[0].status,
            'processing',
          );
          assert.equal(await count('olist_export_invalidations'), 0);
          assert.equal(
            await countWhere(
              'olist_events',
              "event_code='OLIST_EXPORT_INVALIDATED'",
              [],
            ),
            0,
          );
          assert.equal(
            await countWhere(
              'audit_events',
              "action='olist.invalidate' AND target_id=$1",
              [f.operation.id],
            ),
            0,
          );
        },
      );

      await t.test(
        '(6b) a processing job with an EXPIRED lease is orphaned: it is retired and the generation invalidated; a live lease still blocks',
        async () => {
          const lease = (/** @type {any} */ f, /** @type {number} */ ms) =>
            pool.query(
              "UPDATE crm.outbox_jobs SET status='processing',attempt_count=1,locked_by='worker-dead',locked_until=$2,heartbeat_at=$3 WHERE olist_export_id=$1",
              [f.operation.id, new Date(NOW.getTime() + ms), NOW],
            );
          // The lease ends exactly at the injected clock: still alive.
          const edge = await fixture();
          await lease(edge, 0);
          await assert.rejects(invalidate(edge), {
            code: 'OLIST_EXPORT_IN_FLIGHT',
          });
          await unchanged(edge);
          // One second past the lease: orphaned.
          const dead = await fixture();
          await lease(dead, -1000);
          const receipt = await invalidate(dead);
          assert.equal(receipt.state, 'invalidated');
          const job = (
            await pool.query(
              'SELECT * FROM crm.outbox_jobs WHERE olist_export_id=$1',
              [dead.operation.id],
            )
          ).rows[0];
          assert.equal(job.status, 'completed');
          assert.ok(job.completed_at);
          assert.equal(job.locked_by, null);
          assert.equal(job.locked_until, null);
          assert.equal(job.heartbeat_at, null);
          assert.equal(job.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          assert.equal(
            await countWhere(
              'olist_events',
              "export_id=$1 AND event_code='OLIST_EXPORT_INVALIDATED'",
              [dead.operation.id],
            ),
            1,
          );
        },
      );

      await t.test(
        '(7) replay is idempotent for any key; stale version, stale or unknown operationId and malformed input are rejected',
        async () => {
          const f = await fixture();
          const version = Number((await exportRow(f)).version);
          const first = await invalidate(f);
          const again = await invalidate(f, {
            expectedVersion: version,
            correlationId: 'another-correlation',
          });
          assert.deepEqual(again, { ...first, replayed: true });
          const stale = await invalidate(f, { expectedVersion: version + 9 });
          assert.equal(stale.replayed, true);
          assert.equal(
            await countWhere(
              'olist_events',
              "export_id=$1 AND event_code='OLIST_EXPORT_INVALIDATED'",
              [f.operation.id],
            ),
            1,
          );
          assert.equal(await count('olist_export_invalidations'), 1);
          assert.equal(
            await countWhere(
              'audit_events',
              "action='olist.invalidate' AND target_id=$1",
              [f.operation.id],
            ),
            1,
          );
          assert.equal(
            Number((await exportRow(f)).version),
            version + 1,
            'the replay never bumps the version again',
          );

          const g = await fixture();
          await assert.rejects(
            invalidate(g, {
              expectedVersion: Number((await exportRow(g)).version) + 1,
            }),
            { code: 'VERSION_CONFLICT' },
          );
          await assert.rejects(invalidate(g, { operationId: randomUUID() }), {
            code: 'VERSION_CONFLICT',
          });
          await assert.rejects(invalidate(g, { operationId: 'not-a-uuid' }), {
            code: 'INVALID_REQUEST',
          });
          await assert.rejects(invalidate(g, { reason: '   ' }), {
            code: 'INVALID_REQUEST',
          });
          await assert.rejects(invalidate(g, { reason: 'x'.repeat(1001) }), {
            code: 'INVALID_REQUEST',
          });
          await assert.rejects(invalidate(g, { expectedVersion: 0 }), {
            code: 'INVALID_REQUEST',
          });
          await assert.rejects(
            invalidate(g, { orderId: 'missing-order-' + randomUUID() }),
            { code: 'ORDER_NOT_FOUND', statusCode: 404 },
          );
          await unchanged(g);
          // An order that has no operation at all is unavailable.
          const empty = await seed();
          await assert.rejects(
            adminFor().invalidateExport({
              ...empty.input,
              operationId: randomUUID(),
              expectedVersion: 1,
              reason: CANARY,
            }),
            { code: 'OLIST_EXPORT_UNAVAILABLE' },
          );
        },
      );

      await t.test(
        '(8) current Admin authority is rechecked under lock, also on replay; the ERP connection state is irrelevant',
        async () => {
          for (const [
            label,
            actingAs,
          ] of /** @type {Array<[string,(f:any)=>any]>} */ ([
            ['seller', (f) => f.actingAs(f.seller, f.sellerSession, 1)],
            ['finance', (f) => f.actingAs(f.finance, f.financeSession, 1)],
          ])) {
            const f = await fixture();
            await assert.rejects(invalidate(f, actingAs(f)), forbidden, label);
            await unchanged(f);
          }
          const mutations =
            /** @type {Array<[string,(f:any)=>Promise<any>]>} */ ([
              [
                'capability revoked',
                (f) =>
                  pool.query(
                    'DELETE FROM crm.user_capabilities WHERE user_id=$1',
                    [f.admin],
                  ),
              ],
              [
                'session revoked',
                (f) =>
                  pool.query(
                    'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
                    [f.session, NOW],
                  ),
              ],
              [
                'authorization version changed',
                (f) =>
                  pool.query(
                    'UPDATE crm.users SET olist_authorization_version=5 WHERE id=$1',
                    [f.admin],
                  ),
              ],
              [
                'user disabled',
                (f) =>
                  pool.query(
                    'UPDATE crm.users SET disabled_at=$2 WHERE id=$1',
                    [f.admin, NOW],
                  ),
              ],
            ]);
          for (const [label, mutate] of mutations) {
            const f = await fixture();
            await mutate(f);
            await assert.rejects(invalidate(f), forbidden, label);
            await unchanged(f);
            // After a successful invalidation the replay is protected as well.
            const g = await fixture();
            assert.equal((await invalidate(g)).state, 'invalidated');
            await mutate(g);
            await assert.rejects(invalidate(g), forbidden, 'replay ' + label);
          }
          // The Olist checkbox is the exporter's grant: the Admin works without it
          // (the fixture admin has olist_enabled=false) and the exporter's grant
          // revoked later changes nothing either.
          const f = await fixture();
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
            [f.owner],
          );
          assert.equal((await invalidate(f)).state, 'invalidated');
          // No health requirement: reconnect required, token gone, generation changed,
          // creation disabled, account in recovery.
          const g = await fixture();
          await pool.query(
            'UPDATE crm.olist_connections SET reconnect_required=true,token_envelope=NULL,expires_at=NULL,generation=9 WHERE context_key=$1',
            [contextKey],
          );
          await pool.query(
            'UPDATE crm.olist_accounts SET creation_enabled=false,recovery_required=true WHERE account_key=$1',
            [accountKey],
          );
          assert.equal((await invalidate(g)).state, 'invalidated');
          assert.equal(await count('olist_attempts'), 0);
          // A cancelled order cannot be invalidated (cancellation is terminal).
          const h = await fixture();
          await pool.query(
            'UPDATE crm.orders SET cancelled_at=$2,cancelled_by=$3,cancellation_reason_envelope=$4::jsonb,version=version+1 WHERE id=$1',
            [
              h.orderId,
              NOW,
              h.owner,
              JSON.stringify(seal('r', KEY, 'x', accountKey, 'y')),
            ],
          );
          await assert.rejects(invalidate(h), { code: 'ORDER_CANCELLED' });
        },
      );

      await t.test(
        '(9) a new generation is a new row; one active per order, remote ID unique, confirmed resources reused, invalidated is terminal',
        async () => {
          const f = await fixture('ready');
          const oldRow = await exportRow(f);
          const resourceIds = async (/** @type {string} */ id) =>
            (
              await pool.query(
                'SELECT resource_id FROM crm.olist_export_resources WHERE export_id=$1 ORDER BY resource_id',
                [id],
              )
            ).rows.map((row) => row.resource_id);
          const oldResources = await resourceIds(oldRow.id);
          assert.equal(oldResources.length, 4);
          assert.equal((await invalidate(f)).state, 'invalidated');

          // The order now reads as "no operation" (admin and exporter readers).
          assert.equal(await adminFor().readOperation({ ...f.input }), null);
          assert.equal(
            (await adminFor().diagnostic({ ...f.input })).operation,
            null,
          );
          const archived = await adminFor().diagnostic({
            ...f.input,
            includeInvalidated: true,
          });
          assert.equal(archived.operation.id, oldRow.id);
          assert.equal(archived.operation.state, 'invalidated');
          assert.equal(
            archived.operation.errorCode,
            'OLIST_EXPORT_INVALIDATED',
          );
          assert.equal(
            await repo.findExport({
              ...f.original,
              transaction: undefined,
            }),
            null,
          );

          // A new generation: same snapshot, a NEW row and reference.
          const fresh = await repo.prepareExport({
            ...f.original,
            exportId: undefined,
            orderVersion: 1,
            snapshot: f.snapshot,
          });
          assert.notEqual(fresh.id, oldRow.id);
          assert.notEqual(fresh.reference, oldRow.reference);
          assert.equal(fresh.state, 'queued');
          assert.equal(await count('olist_exports'), 2);
          assert.equal((await repo.findExport({ ...f.original })).id, fresh.id);
          assert.equal(
            (await adminFor().readOperation({ ...f.input })).id,
            fresh.id,
          );
          const active = await adminFor().diagnostic({
            ...f.input,
            includeInvalidated: true,
          });
          assert.equal(active.operation.id, fresh.id);
          assert.equal(active.operation.state, 'queued');
          // The same prepare is idempotent against the ACTIVE row.
          assert.equal(
            (
              await repo.prepareExport({
                ...f.original,
                orderVersion: 1,
                snapshot: f.snapshot,
              })
            ).id,
            fresh.id,
          );
          // Confirmed resources are reused by identity.
          await repo.bindResource({
            ...f.original,
            exportId: fresh.id,
            kind: 'customer',
            identity: f.snapshot.customer.cpfCnpj,
            payload: f.snapshot.customer,
          });
          const reused = await resourceIds(fresh.id);
          assert.equal(reused.length, 1);
          assert.ok(oldResources.includes(reused[0]));
          assert.equal(await count('olist_resources'), 4);

          // One ACTIVE operation per order/account; history is unconstrained.
          await assert.rejects(
            pool.query(
              'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope) SELECT $1,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,$2,snapshot_envelope FROM crm.olist_exports WHERE id=$3',
              [randomUUID(), 'CRM-' + randomUUID(), fresh.id],
            ),
            { code: '23505', constraint: 'olist_exports_active_order_key' },
          );
          // The reference stays unique and the remote ID stays globally unique.
          await assert.rejects(
            pool.query(
              'INSERT INTO crm.olist_exports(id,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope,state) SELECT $1,account_key,context_key,connection_generation,order_id,order_version,settings_version,actor_id,authorization_version,reference,snapshot_envelope,$2 FROM crm.olist_exports WHERE id=$3',
              [randomUUID(), 'invalidated', oldRow.id],
            ),
            {
              code: '23505',
              constraint: 'olist_exports_account_key_reference_key',
            },
          );
          await pool.query(
            "UPDATE crm.olist_exports SET state='confirmed',remote_id='777' WHERE id=$1",
            [fresh.id],
          );
          const other = await secondExport(f);
          await assert.rejects(
            pool.query(
              "UPDATE crm.olist_exports SET state='confirmed',remote_id='777' WHERE id=$1",
              [other.id],
            ),
            { code: '23505', constraint: 'olist_exports_remote_key' },
          );
        },
      );

      await t.test(
        '(9b) `invalidated` never comes back, for the repository or a raw writer',
        async () => {
          const f = await fixture();
          assert.equal((await invalidate(f)).state, 'invalidated');
          for (const state of [
            'queued',
            'resolving',
            'ready',
            'reserved',
            'uncertain',
          ])
            await assert.rejects(
              pool.query('UPDATE crm.olist_exports SET state=$2 WHERE id=$1', [
                f.operation.id,
                state,
              ]),
              /invalidated export is terminal/,
              state,
            );
          // Annotating the terminal row (same state) stays possible.
          await pool.query(
            "UPDATE crm.olist_exports SET last_error_code='OLIST_EXPORT_INVALIDATED' WHERE id=$1",
            [f.operation.id],
          );
          // The old dispatcher-facing stop writer leaves it untouched, for any code.
          const before = await exportRow(f);
          for (const code of [
            'OLIST_REFRESH_IN_PROGRESS',
            'OLIST_RATE_LIMITED',
            'ORDER_CANCELLED',
            'FORBIDDEN',
          ]) {
            const returned = await repo.recordDispatchStop({
              ...f.original,
              code,
            });
            assert.equal(returned.state, 'invalidated');
          }
          const after = await exportRow(f);
          assert.equal(after.version, before.version);
          assert.equal(after.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          // Neither reservation port can start an effect on it.
          await assert.rejects(
            repo.reserveSaleEffect({
              ...f.original,
              requestPayload: { encoded: 'x' },
            }),
            { code: 'OLIST_EXPORT_UNAVAILABLE' },
          );
          await assert.rejects(
            repo.reserveEffect({
              ...f.original,
              exportId: f.operation.id,
              expectedVersion: Number(after.version),
            }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
          await assert.rejects(
            saleAttempt(f, 'reserved'),
            /invalidated export cannot start a sale/,
          );
          assert.equal(await count('olist_attempts'), 0);
        },
      );

      await t.test(
        '(9c) assertRetrySafe is true only before any possible POST',
        async () => {
          const scope = (/** @type {any} */ f) => ({
            exportId: f.operation.id,
            accountKey,
            contextKey,
          });
          const queued = await fixture();
          assert.equal(await repo.assertRetrySafe(scope(queued)), true);
          const ready = await fixture('ready');
          assert.equal(await repo.assertRetrySafe(scope(ready)), true);
          assert.equal(
            await repo.assertRetrySafe({
              exportId: ready.operation.id,
              accountKey,
            }),
            true,
          );
          // Wrong scope or unknown export: false, never an error.
          assert.equal(
            await repo.assertRetrySafe({
              ...scope(ready),
              contextKey: hash('x'),
            }),
            false,
          );
          assert.equal(
            await repo.assertRetrySafe({
              ...scope(ready),
              exportId: randomUUID(),
            }),
            false,
          );
          assert.equal(
            await repo.assertRetrySafe({ ...scope(ready), exportId: 'broken' }),
            false,
          );
          for (const outcome of [
            'reserved',
            'uncertain',
            'confirmed',
            'rejected',
          ]) {
            const f = await fixture('ready');
            await saleAttempt(f, outcome);
            assert.equal(await repo.assertRetrySafe(scope(f)), false, outcome);
          }
          const observed = await fixture('ready');
          await pool.query(
            "UPDATE crm.olist_exports SET observed_sale_id='401' WHERE id=$1",
            [observed.operation.id],
          );
          assert.equal(await repo.assertRetrySafe(scope(observed)), false);
          for (const mode of ['customerReserved', 'customerUncertain']) {
            const f = await fixture(mode);
            assert.equal(await repo.assertRetrySafe(scope(f)), false, mode);
          }
          assert.equal(
            await repo.assertRetrySafe(
              scope(await fixture('customerConfirmed')),
            ),
            true,
          );
          const gone = await fixture();
          await invalidate(gone);
          assert.equal(await repo.assertRetrySafe(scope(gone)), false);
          const reserved = await fixture('ready');
          await repo.reserveSaleEffect({
            ...reserved.original,
            requestPayload: {
              encoded: buildOlistSalePayload({
                snapshot: reserved.snapshot,
                resolved: reserved.resources,
                reference: reserved.operation.reference,
              }).encoded,
            },
          });
          assert.equal(await repo.assertRetrySafe(scope(reserved)), false);
        },
      );

      await t.test(
        '(9d) a dispatch stop with OLIST_REFRESH_IN_PROGRESS is recorded once on a live export',
        async () => {
          const f = await fixture('ready');
          const first = await repo.recordDispatchStop({
            ...f.original,
            code: 'OLIST_REFRESH_IN_PROGRESS',
          });
          assert.equal(first.last_error_code, 'OLIST_REFRESH_IN_PROGRESS');
          const again = await repo.recordDispatchStop({
            ...f.original,
            code: 'OLIST_REFRESH_IN_PROGRESS',
          });
          assert.equal(again.version, first.version);
        },
      );

      await t.test(
        '(9e) a manual link works after an invalidation and leaves the archived generation untouched',
        async () => {
          const f = await fixture('ready');
          const oldId = f.operation.id;
          assert.equal((await invalidate(f)).state, 'invalidated');
          const link = {
            ...f.input,
            exportId: randomUUID(),
            expectedOrderVersion: 1,
            expectedSettingsVersion: 4,
            expectedOperationVersion: 0,
            snapshot: f.snapshot,
            resources: f.resources,
            proof: { matched: true, lineCount: 2, totalCents: 200 },
            remoteId: '401',
            number: '99',
            reason: 'MOTIVO_VINCULO',
          };
          const linked = await adminFor().commitLink(link);
          assert.equal(linked.state, 'linked');
          assert.notEqual(linked.id, oldId);
          assert.equal(await count('olist_exports'), 2);
          assert.equal(
            (await exportRowById(oldId)).state,
            'invalidated',
            'the archived generation is untouched by the link',
          );
          assert.equal(
            (await adminFor().readOperation({ ...f.input })).id,
            linked.id,
          );
        },
      );

      await t.test(
        '(9f) a read request frozen for an archived generation never completes against the new export',
        async () => {
          const f = await fixture();
          const oldVersion = Number((await exportRow(f)).version);
          assert.equal(oldVersion, 1);
          const request = await adminFor().createReadRequest({
            ...f.input,
            connectionGeneration: 3,
            connectionVersion: 2,
            stage: 'sale',
            resourceId: null,
            expectedVersion: oldVersion,
            reason: 'conferencia sintetica',
          });
          assert.equal(request.status, 'queued');
          assert.equal((await invalidate(f)).state, 'invalidated');
          const fresh = await repo.prepareExport({
            ...f.original,
            exportId: undefined,
            orderVersion: 1,
            snapshot: f.snapshot,
          });
          // Same version number as the one the request froze: the old lookup by
          // order would have matched this new row.
          assert.equal(Number(fresh.version), oldVersion);
          const done = await adminFor().completeReadRequest({
            ...f.input,
            requestId: request.requestId,
            matched: false,
            code: 'OLIST_RESOURCE_NOT_FOUND',
            connectionGeneration: 3,
          });
          assert.equal(done.status, 'blocked');
          assert.equal(done.code, 'VERSION_CONFLICT');
          assert.equal(
            (
              await pool.query(
                'SELECT version FROM crm.olist_exports WHERE id=$1',
                [fresh.id],
              )
            ).rows[0].version,
            fresh.version,
          );
        },
      );

      await t.test(
        '(10) cancelling after an invalidation succeeds and is terminal; the archived row is not rewritten; D1 lock semantics hold',
        async () => {
          // Archived row only.
          const f = await fixture();
          assert.equal((await invalidate(f)).state, 'invalidated');
          const archived = await exportRow(f);
          const cancelled = await orders.cancelOrder({
            orderId: f.orderId,
            expectedVersion: 1,
            actor: { id: f.owner, kind: 'human', capabilities: [] },
            reason: 'Pedido duplicado sintético',
            now: NOW,
            correlationId: 'synthetic-cancel-after-invalidation',
          });
          assert.ok(cancelled.cancelledAt);
          const after = await exportRow(f);
          assert.equal(after.state, 'invalidated');
          assert.equal(after.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          assert.equal(after.version, archived.version);
          assert.equal(
            await countWhere(
              'olist_events',
              "export_id=$1 AND event_code='OLIST_ORDER_CANCELLED'",
              [f.operation.id],
            ),
            0,
          );
          await assert.rejects(
            orders.cancelOrder({
              orderId: f.orderId,
              expectedVersion: 2,
              actor: { id: f.owner, kind: 'human', capabilities: [] },
              reason: 'de novo',
              now: NOW,
              correlationId: 'again',
            }),
            { code: 'ORDER_CANCELLED' },
          );
          await assert.rejects(invalidate(f), { code: 'ORDER_CANCELLED' });

          // Archived generation plus a new ACTIVE one: only the active row is
          // closed by the cancellation.
          const g = await fixture();
          await invalidate(g);
          const fresh = await repo.prepareExport({
            ...g.original,
            orderVersion: 1,
            snapshot: g.snapshot,
          });
          await orders.cancelOrder({
            orderId: g.orderId,
            expectedVersion: 1,
            actor: { id: g.owner, kind: 'human', capabilities: [] },
            reason: 'Pedido duplicado sintético',
            now: NOW,
            correlationId: 'synthetic-cancel-two-generations',
          });
          const rows = (
            await pool.query(
              'SELECT id,state,last_error_code FROM crm.olist_exports ORDER BY created_at',
            )
          ).rows;
          assert.deepEqual(
            rows.map((row) => [row.state, row.last_error_code]),
            [
              ['invalidated', 'OLIST_EXPORT_INVALIDATED'],
              ['invalidated', 'ORDER_CANCELLED'],
            ],
          );
          assert.equal(rows[1].id, fresh.id);
          // The cancelled order shows its (cancelled) generation in the reader.
          assert.equal(
            (await adminFor().readOperation({ ...g.input })).id,
            fresh.id,
          );

          // D1: with no ERP resource attempt the commercial lock is released ...
          const released = await fixture('customerConfirmed');
          assert.equal(
            (await readOlistCommercialLocks(pool, [released.orderId])).length,
            1,
          );
          await invalidate(released);
          assert.deepEqual(
            await readOlistCommercialLocks(pool, [released.orderId]),
            [],
          );
          // ... and with a confirmed resource ATTEMPT the order stays frozen.
          const frozen = await fixture('customerAttemptConfirmed');
          await invalidate(frozen);
          assert.equal(
            (await readOlistCommercialLocks(pool, [frozen.orderId])).length,
            1,
          );
        },
      );

      await t.test(
        '(11) 0071 over 0070: existing generations survive, the unique rule becomes partial, every guard is installed',
        async () => {
          await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
          const before = migrations.filter((entry) => entry.version < '0071');
          assert.equal(before.at(-1)?.version, '0070');
          await migrate(pool, { migrations: before });
          const names = async () =>
            (
              await pool.query(
                "SELECT conname FROM pg_constraint WHERE conrelid='crm.olist_exports'::regclass AND contype='u' ORDER BY conname",
              )
            ).rows.map((row) => row.conname);
          assert.deepEqual(await names(), [
            'olist_exports_account_key_order_id_key',
            'olist_exports_account_key_reference_key',
            'olist_exports_id_account_key_key',
          ]);
          const f = await seed();
          const operation = await repo.prepareExport({
            ...f.original,
            orderVersion: 1,
            snapshot: f.snapshot,
          });
          const result = await migrate(pool, { migrations });
          assert.deepEqual(result.applied, ['0071']);
          assert.deepEqual(await names(), [
            'olist_exports_account_key_reference_key',
            'olist_exports_id_account_key_key',
          ]);
          const index = (
            await pool.query(
              "SELECT indexdef FROM pg_indexes WHERE schemaname='crm' AND indexname='olist_exports_active_order_key'",
            )
          ).rows[0];
          assert.match(index.indexdef, /UNIQUE/);
          assert.match(index.indexdef, /state <> 'invalidated'/);
          assert.equal(
            (
              await pool.query(
                'SELECT state FROM crm.olist_exports WHERE id=$1',
                [operation.id],
              )
            ).rows[0].state,
            'queued',
          );
          const triggers = (
            await pool.query(
              "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('crm.olist_exports'::regclass,'crm.olist_attempts'::regclass,'crm.olist_export_invalidations'::regclass) ORDER BY tgname",
            )
          ).rows.map((row) => row.tgname);
          for (const expected of [
            'olist_export_invalidations_append_only',
            'olist_export_invalidations_guard',
            'olist_exports_invalidated_terminal',
            'olist_attempts_no_sale_after_invalidation',
            'olist_exports_snapshot_immutable',
            'olist_sale_evidence_immutable',
            'olist_attempts_durable',
          ])
            assert.ok(triggers.includes(expected), expected);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM pg_indexes WHERE schemaname='crm' AND indexname='olist_exports_remote_key'",
              )
            ).rows[0].n,
            1,
          );
          assert.deepEqual((await migrate(pool, { migrations })).applied, []);
          // The expanded schema still serves the whole flow.
          const g = await seed();
          await prepared(g, 'ready');
          assert.equal((await invalidate(g)).state, 'invalidated');
        },
      );
    } finally {
      await releaseHolds();
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
