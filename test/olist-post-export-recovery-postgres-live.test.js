import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { WorkerRuntime } from '../apps/worker/src/worker.js';
import { createOlistJobHandler } from '../apps/worker/src/olist-runtime.js';
import { PostgresJobQueue } from '../modules/integration-reliability/src/postgres-job-queue.js';
import { createSafeLogger } from '../modules/shared/src/observability.js';
import { OlistError } from '../modules/olist/src/errors.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOlistRepository } from '../modules/olist/src/repository.js';
import { createOlistAdminRepository } from '../modules/olist/src/admin-repository.js';
import { createOlistResourceWriter } from '../modules/olist/src/resource-writer.js';
import { createOlistReadonlyInspector } from '../modules/olist/src/readonly-inspector.js';
import { seal } from '../modules/olist/src/crypto.js';
import { PostgresOrderRepository } from '../modules/orders/src/adapters/postgres-order-repository.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 91),
  HMAC = Buffer.alloc(32, 92);
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
function deferred() {
  /** @type {()=>void} */ let resolve;
  const promise = new Promise(
    /** @param {(value?: any)=>void} done */ (done) => {
      resolve = done;
    },
  );
  return { promise, resolve: () => resolve() };
}
if (!connectionString)
  test(
    'OLIST-T10 post-export recovery requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T10 shared effects, current authority and restored pending state', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({
      connectionString,
      max: 8,
      options: '-c statement_timeout=12000 -c lock_timeout=8000',
    });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repo = createOlistRepository(database, {
      envelopeKey: KEY,
      hmacKey: HMAC,
      clock: () => NOW,
    });
    const orders = new PostgresOrderRepository({ database, envelopeKey: KEY });
    const admin = createOlistAdminRepository(database, {
      envelopeKey: KEY,
      hmacKey: HMAC,
      clock: () => NOW,
    });
    const accountKey = hash('synthetic-t10-recovery-account'),
      contextKey = hash('synthetic-t10-recovery-context');
    const buyer = {
      nome: 'Cliente Sintetico',
      cpfCnpj: '52998224725',
      tipoPessoa: 'F',
      celular: '5511999990000',
      situacao: 'B',
      endereco: {
        cep: '29010000',
        municipio: 'Vitoria',
        uf: 'ES',
        endereco: 'Rua Sintetica',
        bairro: 'Centro',
        numero: '10',
      },
    };
    async function setup() {
      await pool.query('TRUNCATE crm.olist_accounts CASCADE');
      await pool.query(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,1)',
        [accountKey],
      );
      await pool.query(
        'INSERT INTO crm.olist_connections(context_key,account_key,generation,version,token_envelope,expires_at) VALUES($1,$2,1,1,$3::jsonb,$4)',
        [
          contextKey,
          accountKey,
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
    }
    /** @param {boolean} [administrator] */
    async function operation(administrator = false) {
      const actorId = 't10-recovery-user-' + randomUUID(),
        contactId = 't10-contact-' + randomUUID(),
        orderId = 't10-order-' + randomUUID();
      await pool.query(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',true,1)",
        [actorId, actorId + '@example.test'],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
        [actorId],
      );
      if (administrator)
        await pool.query(
          "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
          [actorId],
        );
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') n")).rows[0]
          .n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,contact_id,manual_owner_id,manual_create_key) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC',$4::jsonb,'user',$5,$6,$6,$7,$5,$8)",
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
          actorId,
          NOW,
          contactId,
          randomUUID(),
        ],
      );
      const base = {
        actor: {
          id: actorId,
          kind: 'human',
          capabilities: administrator ? ['COMMERCIAL_ADMIN'] : [],
        },
        authorizationVersion: 1,
        accountKey,
        contextKey,
        connectionGeneration: 1,
        connectionVersion: 1,
        settingsVersion: 1,
        correlationId: 'synthetic-t10-recovery',
      };
      const snapshot = {
        customer: buyer,
        commercial: { groups: [] },
        sourceVersions: { contactId, contactVersion: 1, sourceRevision: 0 },
      };
      const row = await repo.prepareExport({
        ...base,
        orderId,
        orderVersion: 1,
        snapshot,
      });
      return { ...base, exportId: row.id, orderId };
    }
    /** @param {any} input */
    const bindBuyer = (input) =>
      repo.bindResource({
        ...input,
        kind: 'customer',
        identity: buyer.cpfCnpj,
        payload: buyer,
      });
    /** @param {any} input @param {any} resource */
    const reserveBuyer = (input, resource) =>
      repo.reserveResourceEffect({
        ...input,
        resourceId: resource.id,
        expectedVersion: Number(resource.version),
        requestPayload: { nome: buyer.nome, cpfCnpj: buyer.cpfCnpj },
      });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await t.test(
        'cancellation and revocation during a shared customer POST retain its late result for the other order',
        async () => {
          await setup();
          const first = await operation(),
            second = await operation();
          const [a, b] = await Promise.all([
            bindBuyer(first),
            bindBuyer(second),
          ]);
          assert.equal(a.id, b.id);
          const entered = deferred(),
            release = deferred();
          let posts = 0;
          const writer = createOlistResourceWriter({
            credentials: async () => ({
              token: 'synthetic-shared-token',
              version: 1,
            }),
            quota: { reserve: async () => {}, observe: async () => {} },
            fetch: async () => {
              posts++;
              entered.resolve();
              await release.promise;
              return new globalThis.Response('{"id":101}', {
                status: 201,
                headers: { 'content-type': 'application/json' },
              });
            },
          });
          const pending = writer.dispatch({
            kind: 'customer',
            payload: buyer,
            reserve: (/** @type {any} */ payload) =>
              repo.reserveResourceEffect({
                ...first,
                resourceId: a.id,
                expectedVersion: Number(a.version),
                requestPayload: payload,
              }),
          });
          await entered.promise;
          try {
            await orders.cancelOrder({
              orderId: first.orderId,
              expectedVersion: 1,
              actor: first.actor,
              reason: 'Pedido duplicado sintético',
              now: NOW,
              correlationId: first.correlationId,
            });
            await pool.query(
              'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
              [first.actor.id],
            );
            await assert.rejects(reserveBuyer(second, { ...b, version: 1 }), {
              code: 'OLIST_EFFECT_ALREADY_RESERVED',
            });
          } finally {
            release.resolve();
          }
          const response = await pending;
          await repo.recordObservedResourceId({
            ...first,
            ...response.reservation,
            remoteId: response.remoteId,
          });
          await repo.recordResult({
            ...first,
            ...response.reservation,
            remoteId: response.remoteId,
            outcome: 'confirmed',
            response: { id: response.remoteId },
          });
          const reused = await repo.readResource({
            ...second,
            resourceId: b.id,
          });
          assert.equal(reused.state, 'confirmed');
          assert.equal(reused.remote_id, '101');
          assert.equal(reused.latestAttempt.outcome, 'confirmed');
          assert.equal(posts, 1);
          assert.equal(
            (await repo.loadDispatchContext(first)).state,
            'invalidated',
          );
          await assert.rejects(repo.validateDispatch(first), {
            code: 'FORBIDDEN',
          });
          await assert.rejects(reserveBuyer(second, reused), {
            code: 'OLIST_EFFECT_ALREADY_RESERVED',
          });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM crm.olist_attempts WHERE resource_id=$1',
                [a.id],
              )
            ).rows[0].n,
            1,
          );
          await repo.validateDispatch(second);
        },
      );
      await t.test(
        'revocation after each registration stage accepts its ticket once and stops the next reservation',
        async () => {
          for (const stage of ['customer', 'product', 'variation']) {
            await setup();
            const input = await operation();
            const customer = await bindBuyer(input);
            let target = customer;
            if (stage !== 'customer') {
              await repo.confirmResourceLookup({
                ...input,
                resourceId: customer.id,
                expectedVersion: 0,
                remoteId: '101',
              });
              const parent = await repo.bindResource({
                ...input,
                kind: 'product',
                identity: {
                  garment: 'Camisa',
                  color: 'Azul',
                  fabric: '["Algodão"]',
                  application: 'Silk',
                  collar: 'Polo',
                  audience: '',
                },
                payload: { attributes: 'synthetic' },
              });
              const child = await repo.bindResource({
                ...input,
                kind: 'variation',
                parentId: parent.id,
                identity: 'M',
                payload: { size: 'M' },
              });
              if (stage === 'product')
                target = { ...parent, childId: child.id };
              else {
                await repo.confirmResourceLookup({
                  ...input,
                  resourceId: parent.id,
                  expectedVersion: 0,
                  remoteId: '201',
                });
                target = child;
              }
            }
            const ticket = await repo.reserveResourceEffect({
              ...input,
              resourceId: target.id,
              expectedVersion: Number(target.version),
              dependentResourceIds: target.childId ? [target.childId] : [],
              requestPayload: { synthetic: stage },
            });
            await pool.query(
              'UPDATE crm.users SET disabled_at=$2,olist_authorization_version=2 WHERE id=$1',
              [input.actor.id, NOW],
            );
            const late = {
              ...input,
              ...ticket,
              outcome: 'confirmed',
              remoteId:
                stage === 'customer'
                  ? '101'
                  : stage === 'product'
                    ? '201'
                    : '301',
              response: { synthetic: stage },
            };
            assert.equal((await repo.recordResult(late)).replayed, false);
            assert.equal((await repo.recordResult(late)).replayed, true);
            await assert.rejects(
              repo.reserveResourceEffect({
                ...input,
                resourceId: target.id,
                expectedVersion: 2,
                requestPayload: { synthetic: stage },
              }),
              { code: 'FORBIDDEN' },
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int n FROM crm.olist_attempts WHERE resource_id=$1',
                  [target.id],
                )
              ).rows[0].n,
              1,
            );
          }
        },
      );
      await t.test(
        'lease expiry after a reserved POST preserves the known entity and quarantines the queue without redispatch',
        async () => {
          await setup();
          const input = await operation(),
            resource = await bindBuyer(input);
          const jobId = (
            await pool.query(
              'SELECT id FROM crm.outbox_jobs WHERE olist_export_id=$1 AND job_type=$2',
              [input.exportId, 'olist.export'],
            )
          ).rows[0].id;
          const queue = new PostgresJobQueue({ database });
          let currentTime = NOW.getTime(),
            posts = 0,
            dispatches = 0;
          const writer = createOlistResourceWriter({
            credentials: async () => ({
              token: 'synthetic-lease-token',
              version: 1,
            }),
            quota: { reserve: async () => {}, observe: async () => {} },
            fetch: async () => {
              posts++;
              currentTime += 31000;
              return new globalThis.Response('{"id":601}', {
                status: 201,
                headers: { 'content-type': 'application/json' },
              });
            },
          });
          const dispatcher = {
            async dispatch(
              /** @type {any} */ target,
              /** @type {any} */ context,
            ) {
              dispatches++;
              assert.equal(target.exportId, input.exportId);
              const response = await writer.dispatch({
                kind: 'customer',
                payload: buyer,
                reserve: (/** @type {any} */ payload) =>
                  repo.reserveResourceEffect({
                    ...input,
                    resourceId: resource.id,
                    expectedVersion: 0,
                    requestPayload: payload,
                  }),
              });
              await repo.recordObservedResourceId({
                ...input,
                ...response.reservation,
                remoteId: response.remoteId,
              });
              await repo.recordResult({
                ...input,
                ...response.reservation,
                outcome: 'confirmed',
                remoteId: response.remoteId,
                response: { id: response.remoteId },
              });
              if (!(await context.heartbeat()))
                throw new OlistError('OLIST_JOB_LEASE_LOST');
              throw new Error(
                'Synthetic clock must have expired the real lease',
              );
            },
          };
          const options = {
            queue,
            queueName: 'olist',
            now: () => currentTime,
            logger: createSafeLogger({
              service: 'crm-silmer-worker',
              sink: () => {},
            }),
            handlers: {
              'olist.export': createOlistJobHandler({
                dispatcher,
                environment: { OLIST_DISPATCH_ENABLED: 'true' },
              }),
            },
          };
          assert.equal(
            await new WorkerRuntime({
              ...options,
              workerId: 't10-lease-first',
            }).runOnce(),
            1,
          );
          assert.equal(
            await new WorkerRuntime({
              ...options,
              workerId: 't10-lease-second',
            }).runOnce(),
            0,
          );
          assert.equal(posts, 1);
          assert.equal(dispatches, 1);
          const job = (
            await pool.query(
              'SELECT status,last_error_code FROM crm.outbox_jobs WHERE id=$1',
              [jobId],
            )
          ).rows[0];
          assert.equal(job.status, 'outcome_unknown');
          assert.equal(job.last_error_code, 'WORKER_LEASE_EXPIRED');
          assert.equal(
            (
              await pool.query(
                'SELECT state,retry_safe FROM crm.processing_attempts WHERE job_id=$1',
                [jobId],
              )
            ).rows[0].retry_safe,
            false,
          );
          const saved = await repo.readResource({
            ...input,
            resourceId: resource.id,
          });
          assert.equal(saved.state, 'confirmed');
          assert.equal(saved.remote_id, '601');
          assert.equal(saved.latestAttempt.observed_remote_id, '601');
          await assert.rejects(reserveBuyer(input, saved), {
            code: 'OLIST_EFFECT_ALREADY_RESERVED',
          });
        },
      );
      await t.test(
        'restored pending resource with remote-only inclusion stays blocked until administrative read proves the identity',
        async () => {
          await setup();
          const input = await operation(),
            administrator = await operation(true),
            resource = await bindBuyer(input);
          // This is a restored local pending state: the provider has an entity that
          // is outside the local backup window, with no local attempt or ID.
          const provider = new Map([['52998224725', { id: '501', ...buyer }]]);
          await pool.query(
            'UPDATE crm.olist_accounts SET creation_enabled=false,recovery_required=true WHERE account_key=$1',
            [accountKey],
          );
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
            [input.actor.id],
          );
          await assert.rejects(reserveBuyer(input, resource), {
            code: 'FORBIDDEN',
          });
          const shared = await bindBuyer(administrator);
          await assert.rejects(reserveBuyer(administrator, shared), {
            code: 'OLIST_CREATION_DISABLED',
          });
          const before = await pool.query(
            'SELECT * FROM crm.olist_attempts WHERE account_key=$1',
            [accountKey],
          );
          assert.equal(before.rows.length, 0);
          const request = await admin.createReadRequest({
            ...administrator,
            resourceId: shared.id,
            stage: 'customer',
            expectedVersion: Number(shared.version),
            reason: 'Conferência sintética após restore',
          });
          let gets = 0;
          const inspector = createOlistReadonlyInspector({
            config: { hmacKey: HMAC },
            client: {
              async findCustomer(/** @type {string} */ document) {
                await admin.guard(administrator, 'olist.reconcile');
                gets++;
                const candidate = provider.get(document);
                return candidate
                  ? { ...candidate, id: Number(candidate.id) }
                  : null;
              },
              async contact(/** @type {number} */ id) {
                await admin.guard(administrator, 'olist.reconcile');
                gets++;
                const candidate = [...provider.values()].find(
                  (value) => Number(value.id) === id,
                );
                return candidate ? { ...candidate, id } : null;
              },
            },
          });
          const proof = await inspector.reconcileResource({
            resource: await admin.readResource({
              ...administrator,
              resourceId: shared.id,
            }),
            parent: null,
          });
          await admin.completeReadRequest({
            ...administrator,
            requestId: request.id,
            matched: true,
            remoteId: proof.remoteId,
            proof: proof.proof,
          });
          const recovered = await admin.readResource({
            ...administrator,
            resourceId: shared.id,
          });
          assert.equal(recovered.state, 'confirmed');
          assert.equal(recovered.remote_id, '501');
          assert.equal(gets, 2);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM crm.olist_attempts WHERE account_key=$1',
                [accountKey],
              )
            ).rows[0].n,
            0,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT creation_enabled,recovery_required FROM crm.olist_accounts WHERE account_key=$1',
                [accountKey],
              )
            ).rows[0],
            { creation_enabled: false, recovery_required: true },
          );
          await assert.rejects(repo.validateDispatch(administrator), {
            code: 'OLIST_CREATION_DISABLED',
          });
          // Confirming one recovered identity never grants permission to resume
          // creation of missing products, sizes or a sale.
          await assert.rejects(
            repo.reserveSaleEffect({
              ...administrator,
              requestPayload: { encoded: '{}' },
            }),
            { code: 'OLIST_CREATION_DISABLED' },
          );
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
