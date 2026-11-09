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
import { createOlistDispatcher } from '../modules/olist/src/dispatcher.js';
import { olistConfiguration } from '../modules/olist/src/index.js';
import { OlistError } from '../modules/olist/src/errors.js';
import { seal } from '../modules/olist/src/crypto.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import { createOlistApiRuntime } from '../apps/api/src/olist-runtime.js';
import { createOlistDispatchRuntime } from '../apps/worker/src/olist-runtime.js';
import { createOlistWorkerRuntime } from '../apps/worker/src/worker.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const URL = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 71),
  HMAC = Buffer.alloc(32, 72);
const CANARY = 'PRIVATE_INVALIDATION_CANARY';
const workerEnvironment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_DISPATCH_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-worker',
  OLIST_CLIENT_SECRET: 'synthetic-worker-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: KEY.toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: HMAC.toString('base64'),
};
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
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
    'OLIST-LIVENESS dispatcher and worker SQL requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-LIVENESS dispatcher and worker: pre-effect retry, terminal denials and archived exports on a real queue', async (t) => {
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
    // The real runtime derives both keys from its environment.
    const { accountKey, contextKey } = olistConfiguration(workerEnvironment);

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
    /** The real repository with a scripted provider: only the reads can fail, a
     * POST would throw, so a test that reaches one fails loudly.
     * @param {any} f @param {any} script */
    function dispatcherFor(f, script) {
      const calls = { dispatch: 0, finds: 0, posts: 0 };
      const client = {
        async findOrder() {
          calls.finds += 1;
          const failure = script.findFails?.shift();
          if (failure) throw new OlistError(failure);
          return script.existingSale
            ? { id: 401, numeroPedido: 401, numeroPedidoEcommerce: 'x' }
            : null;
        },
        async orderRaw() {
          throw new Error('no readback expected');
        },
      };
      const inner = createOlistDispatcher({
        repository: repo,
        client,
        resourceResolver: {
          async resolve() {
            throw new Error('no resolution expected');
          },
        },
        saleWriter: {
          async dispatch() {
            calls.posts += 1;
            throw new Error('no POST expected');
          },
        },
        config: { accountKey, contextKey },
        prepare: script.prepare,
      });
      return {
        calls,
        async dispatch(/** @type {any} */ input) {
          calls.dispatch += 1;
          return inner.dispatch(input);
        },
      };
    }
    /** The real worker runtime and the real PostgresJobQueue around it.
     * @param {any} dispatcher */
    const workerFor = (dispatcher) =>
      createOlistWorkerRuntime({
        database: db,
        environment: workerEnvironment,
        dispatcher,
        logger: createSafeLogger({
          service: 'crm-silmer-worker',
          sink: () => {},
        }),
      });
    /** @param {any} f */
    const jobRow = async (f) =>
      (
        await pool.query(
          'SELECT * FROM crm.outbox_jobs WHERE olist_export_id=$1',
          [f.operation.id],
        )
      ).rows[0];
    /** @param {any} f */
    const makeDue = (f) =>
      pool.query(
        "UPDATE crm.outbox_jobs SET available_at=now()-interval '1 second' WHERE olist_export_id=$1",
        [f.operation.id],
      );

    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      await migrate(pool, { migrations });

      await t.test(
        '(1) "not now" before any ticket: the job retries after ~15 s with a stop code, then a real failure ends it as dead_letter',
        async () => {
          const f = await fixture();
          const script =
            /** @type {{findFails:string[],existingSale?:boolean}} */ ({
              findFails: ['OLIST_RATE_LIMITED'],
            });
          const dispatcher = dispatcherFor(f, script);
          const worker = workerFor(dispatcher);
          assert.ok(worker);
          const before = Date.now();
          assert.equal(await worker.runOnce(), 1);
          let job = await jobRow(f);
          assert.equal(job.status, 'retry');
          assert.equal(Number(job.attempt_count), 1);
          assert.equal(job.locked_by, null);
          assert.equal(job.last_error_code, 'OLIST_RATE_LIMITED');
          const delay = new Date(job.available_at).getTime() - before;
          // 15 s base, jitter of +-25 %: the 1 s default would fail the lower bound.
          assert.ok(delay >= 10_000 && delay <= 20_000, 'delay ' + delay);
          const attempt = (
            await pool.query(
              'SELECT * FROM crm.processing_attempts WHERE job_id=$1',
              [job.id],
            )
          ).rows[0];
          assert.equal(attempt.state, 'failed');
          assert.equal(attempt.error_code, 'OLIST_RATE_LIMITED');
          assert.equal(attempt.retry_safe, true);
          assert.equal(
            await countWhere('reconciliation_items', 'job_id=$1', [job.id]),
            0,
          );
          const row = await exportRow(f);
          assert.equal(row.state, 'queued');
          assert.equal(row.last_error_code, 'OLIST_RATE_LIMITED');
          assert.equal(
            await countWhere('olist_attempts', 'export_id=$1', [
              f.operation.id,
            ]),
            0,
            'no ticket of any kind',
          );
          assert.equal(dispatcher.calls.posts, 0);
          // Not due yet: nothing is claimed.
          assert.equal(await worker.runOnce(), 0);
          // Redelivery works once due; a terminal reason is not retried.
          await makeDue(f);
          script.existingSale = true;
          assert.equal(await worker.runOnce(), 1);
          job = await jobRow(f);
          assert.equal(job.status, 'dead_letter');
          assert.equal(Number(job.attempt_count), 2);
          assert.equal(job.last_error_code, 'OLIST_SALE_ALREADY_EXISTS');
          assert.equal(dispatcher.calls.dispatch, 2);
          assert.equal(dispatcher.calls.posts, 0);
        },
      );

      await t.test(
        '(2) the code, not a flag, decides: UNAVAILABLE and REFRESH_IN_PROGRESS also retry; an unrelated lookup failure does not',
        async () => {
          for (const [code, status] of [
            ['OLIST_UNAVAILABLE', 'retry'],
            ['OLIST_REFRESH_IN_PROGRESS', 'retry'],
            ['OLIST_INCOMPLETE_LOOKUP', 'outcome_unknown'],
          ]) {
            const f = await fixture();
            const worker = workerFor(dispatcherFor(f, { findFails: [code] }));
            assert.ok(worker);
            assert.equal(await worker.runOnce(), 1);
            assert.equal((await jobRow(f)).status, status, code);
          }
        },
      );

      await t.test(
        '(3) a reserved or uncertain resource ticket denies the retry in the real database gate: the job is terminal, nothing is sent again',
        async () => {
          for (const mode of ['customerReserved', 'customerUncertain']) {
            const f = await fixture(mode);
            assert.equal(await repo.assertRetrySafe(f.original), false, mode);
            const dispatcher = dispatcherFor(f, {
              findFails: ['OLIST_RATE_LIMITED'],
            });
            const worker = workerFor(dispatcher);
            assert.ok(worker);
            assert.equal(await worker.runOnce(), 1);
            const job = await jobRow(f);
            assert.equal(job.status, 'dead_letter', mode);
            assert.equal(
              (
                await pool.query(
                  'SELECT reason FROM crm.reconciliation_items WHERE job_id=$1',
                  [job.id],
                )
              ).rows[0].reason,
              'non_retryable_failure',
            );
            assert.equal(dispatcher.calls.posts, 0);
            assert.equal(await worker.runOnce(), 0, 'never delivered again');
          }
        },
      );

      await t.test(
        '(4) a sale attempt of any outcome denies the retry gate and an UNAVAILABLE lookup stays uncertain',
        async () => {
          for (const outcome of ['reserved', 'uncertain', 'confirmed']) {
            const f = await fixture();
            await pool.query(
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
            assert.equal(
              await repo.assertRetrySafe(f.original),
              false,
              outcome,
            );
            const worker = workerFor(
              dispatcherFor(f, { findFails: ['OLIST_UNAVAILABLE'] }),
            );
            assert.ok(worker);
            assert.equal(await worker.runOnce(), 1);
            const job = await jobRow(f);
            assert.notEqual(job.status, 'retry', outcome);
          }
        },
      );

      await t.test(
        '(5) attempts exhausted: dead_letter, then the administrator invalidates; the job is closed and never delivered',
        async () => {
          const f = await fixture();
          await pool.query(
            'UPDATE crm.outbox_jobs SET attempt_count=7 WHERE olist_export_id=$1',
            [f.operation.id],
          );
          const dispatcher = dispatcherFor(f, {
            findFails: ['OLIST_RATE_LIMITED'],
          });
          const worker = workerFor(dispatcher);
          assert.ok(worker);
          assert.equal(await worker.runOnce(), 1);
          let job = await jobRow(f);
          assert.equal(job.status, 'dead_letter');
          assert.equal(Number(job.attempt_count), 8);
          assert.equal(
            (
              await pool.query(
                'SELECT reason FROM crm.reconciliation_items WHERE job_id=$1',
                [job.id],
              )
            ).rows[0].reason,
            'attempts_exhausted',
          );
          const receipt = await invalidate(f);
          assert.equal(receipt.state, 'invalidated');
          job = await jobRow(f);
          assert.equal(job.status, 'completed');
          assert.equal(await worker.runOnce(), 0);
          assert.equal(dispatcher.calls.dispatch, 1);
        },
      );

      await t.test(
        '(6) invalidated while the job is pending: the worker never claims it, and a stray delivery still has no effect',
        async () => {
          const f = await fixture();
          const dispatcher = dispatcherFor(f, {});
          const worker = workerFor(dispatcher);
          assert.ok(worker);
          assert.equal((await invalidate(f)).state, 'invalidated');
          assert.equal((await jobRow(f)).status, 'completed');
          assert.equal(await worker.runOnce(), 0);
          assert.equal(dispatcher.calls.dispatch, 0);

          // Defence in depth: even if the job were delivered, the dispatcher
          // reads the archived row and stops before any HTTP.
          const stray = await pool.query(
            "UPDATE crm.outbox_jobs SET status='pending',completed_at=NULL,available_at=now()-interval '1 second' WHERE olist_export_id=$1 RETURNING id",
            [f.operation.id],
          );
          assert.equal(stray.rowCount, 1);
          const versionBefore = (await exportRow(f)).version;
          assert.equal(await worker.runOnce(), 1);
          assert.equal(dispatcher.calls.dispatch, 1);
          assert.equal(dispatcher.calls.finds, 0, 'no HTTP');
          assert.equal(dispatcher.calls.posts, 0);
          const job = await jobRow(f);
          assert.equal(job.status, 'dead_letter');
          assert.equal(job.last_error_code, 'OLIST_EXPORT_UNAVAILABLE');
          const row = await exportRow(f);
          assert.equal(row.state, 'invalidated');
          assert.equal(row.last_error_code, 'OLIST_EXPORT_INVALIDATED');
          assert.equal(row.version, versionBefore, 'the archive is untouched');
          assert.equal(
            await countWhere('olist_attempts', 'export_id=$1', [
              f.operation.id,
            ]),
            0,
          );
        },
      );

      await t.test(
        '(7) an expired access token is renewed by prepare before the guard: without it the same job ends CONNECTION_CHANGED',
        async () => {
          const f = await fixture();
          // The connection expired five minutes before the repository clock.
          await pool.query(
            'UPDATE crm.olist_connections SET expires_at=$2 WHERE context_key=$1',
            [contextKey, new Date(NOW.getTime() - 300_000)],
          );
          const stale = dispatcherFor(f, { findFails: ['OLIST_RATE_LIMITED'] });
          const staleResult = await stale.dispatch({
            exportId: f.operation.id,
          });
          assert.equal(staleResult.outcome, 'failed');
          assert.equal(staleResult.errorCode, 'OLIST_CONNECTION_CHANGED');
          assert.equal(staleResult.retryable, false);
          assert.equal(stale.calls.finds, 0, 'it ended before any lookup');

          const renewed = dispatcherFor(f, {
            findFails: ['OLIST_RATE_LIMITED'],
            prepare: async () => {
              await pool.query(
                'UPDATE crm.olist_connections SET expires_at=$2 WHERE context_key=$1',
                [contextKey, new Date(NOW.getTime() + 3_600_000)],
              );
            },
          });
          const result = await renewed.dispatch({ exportId: f.operation.id });
          assert.equal(result.outcome, 'failed');
          assert.equal(result.errorCode, 'OLIST_RATE_LIMITED');
          assert.equal(result.retryable, true);
          assert.equal(
            renewed.calls.finds,
            1,
            'the guard passed after prepare',
          );
        },
      );
      await t.test(
        'OLIST-48/T17: real worker refuses a queued actor removed from the private pilot before any provider effect',
        async () => {
          for (const pilot of ['', 'other-synthetic-operator']) {
            const f = await fixture();
            let requests = 0;
            const runtime = createOlistDispatchRuntime({
              database: db,
              environment: {
                ...workerEnvironment,
                OLIST_PILOT_USER_IDS: pilot,
              },
              fetch: async () => {
                requests++;
                throw new Error('Out-of-pilot job must not call provider');
              },
              clock: () => NOW,
            });
            const result = await runtime.dispatch(
              { exportId: f.operation.id },
              {
                heartbeat: async () => true,
                markEffectStarted: async () => true,
              },
            );
            assert.equal(result.outcome, 'failed');
            assert.equal(result.errorCode, 'FORBIDDEN');
            assert.equal(result.retryable, false);
            assert.equal(requests, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS count FROM crm.olist_attempts WHERE export_id=$1',
                  [f.operation.id],
                )
              ).rows[0].count,
              0,
            );
          }
        },
      );
      await t.test(
        '(8) the real worker composition renews an expired token first and waits for a blocked quota with a lease beat, then defers instead of failing',
        async () => {
          const f = await fixture();
          await pool.query(
            'UPDATE crm.olist_connections SET expires_at=$2 WHERE context_key=$1',
            [contextKey, new Date(NOW.getTime() - 300_000)],
          );
          const versionBefore = Number(
            (
              await pool.query(
                'SELECT version FROM crm.olist_connections WHERE context_key=$1',
                [contextKey],
              )
            ).rows[0].version,
          );
          /** @type {string[]} */ const urls = [];
          /** @type {Record<string, number>} */ const at = {};
          const json = (/** @type {any} */ body) =>
            new globalThis.Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          const fetcher = async (
            /** @type {any} */ url,
            /** @type {any} */ init,
          ) => {
            const text = String(url);
            urls.push((init?.method ?? 'GET') + ' ' + text);
            if (text.endsWith('/oauth2/token') || init?.method === 'POST')
              return json({
                access_token: 'synthetic-renewed-access',
                refresh_token: 'synthetic-renewed-refresh',
                expires_in: 3600,
              });
            if (text.endsWith('/info')) {
              // The renewal is done: now the shared window turns busy for ~1.3 s.
              await pool.query(
                "INSERT INTO crm.olist_quotas(account_key,blocked_until) VALUES($1,now()+interval '1300 milliseconds') ON CONFLICT (account_key) DO UPDATE SET blocked_until=EXCLUDED.blocked_until",
                [accountKey],
              );
              at.info = Date.now();
              return json({ cpfCnpj: '12345678000199' });
            }
            if (text.includes('/pedidos?')) {
              at.orders = Date.now();
              return json({
                itens: [],
                paginacao: { offset: 0, limit: 50, total: 0 },
              });
            }
            throw new Error('network is down for everything else');
          };
          let beats = 0;
          const runtime = createOlistDispatchRuntime({
            database: db,
            environment: {
              ...workerEnvironment,
              OLIST_PILOT_USER_IDS: f.owner,
            },
            fetch: fetcher,
            clock: () => NOW,
          });
          const result = await runtime.dispatch(
            { exportId: f.operation.id },
            {
              heartbeat: async () => {
                beats += 1;
                return true;
              },
              markEffectStarted: async () => true,
            },
          );
          assert.equal(result.outcome, 'failed', JSON.stringify(result));
          assert.equal(result.errorCode, 'OLIST_UNAVAILABLE');
          assert.equal(result.retryable, true);
          assert.equal(result.retrySafe, true);
          // The token was renewed before the guard, so the job reached the reads.
          assert.ok(urls[0].startsWith('POST '), urls[0]);
          const connection = (
            await pool.query(
              'SELECT version,expires_at FROM crm.olist_connections WHERE context_key=$1',
              [contextKey],
            )
          ).rows[0];
          assert.ok(Number(connection.version) > versionBefore);
          assert.ok(new Date(connection.expires_at) > NOW);
          // The order lookup waited for the blocked window instead of failing.
          assert.ok(
            at.orders - at.info >= 1000,
            'waited ' + (at.orders - at.info) + ' ms',
          );
          assert.ok(
            beats >= 2,
            'the lease was beaten during the wait: ' + beats,
          );
          assert.equal(
            urls.filter((url) => url.startsWith('POST ')).length,
            1,
            'only the token renewal is a POST',
          );
          assert.equal(
            await countWhere('olist_attempts', 'export_id=$1', [
              f.operation.id,
            ]),
            0,
          );
        },
      );
      await t.test(
        '(9) the API lookups wait at most 8 s for quota: a brief block is waited out, a long one is a 429-class OLIST_RATE_LIMITED with retryAfterMs',
        async () => {
          const f = await fixture();
          const json = (/** @type {any} */ body) =>
            new globalThis.Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          let reads = 0;
          const api = createOlistApiRuntime(db, {
            environment: workerEnvironment,
            access: {},
            fetch: async () => {
              reads += 1;
              return json([{ id: 1, nome: 'Depósito sintético' }]);
            },
            clock: () => NOW,
          });
          const block = (/** @type {string} */ interval) =>
            pool.query(
              'INSERT INTO crm.olist_quotas(account_key,blocked_until) VALUES($1,now()+$2::interval) ON CONFLICT (account_key) DO UPDATE SET blocked_until=EXCLUDED.blocked_until',
              [accountKey, interval],
            );
          await block('1200 milliseconds');
          const started = Date.now();
          const waited = await api.lookups({ ...f.input, kind: 'warehouses' });
          assert.deepEqual(waited, {
            items: [{ id: 1, name: 'Depósito sintético' }],
          });
          assert.ok(Date.now() - started >= 900, 'it waited out the block');
          assert.equal(reads, 1);
          // A block longer than the 8 s API wait fails at once, without HTTP.
          await block('60 seconds');
          const before = Date.now();
          await assert.rejects(
            api.lookups({ ...f.input, kind: 'warehouses' }),
            (/** @type {any} */ error) => {
              assert.equal(error.code, 'OLIST_RATE_LIMITED');
              assert.equal(error.statusCode, 429);
              assert.ok(
                error.retryAfterMs > 8000 && error.retryAfterMs <= 60_000,
              );
              return true;
            },
          );
          assert.ok(Date.now() - before < 4000, 'no long sleep in a request');
          assert.equal(reads, 1, 'no HTTP while the window is blocked');
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
