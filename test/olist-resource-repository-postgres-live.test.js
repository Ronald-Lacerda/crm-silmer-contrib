import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createOlistResourceResolver } from '../modules/olist/src/resource-resolver.js';
import { createOlistResourceWriter } from '../modules/olist/src/resource-writer.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  createOlistRepository,
  seal,
  open,
} from '../modules/olist/src/index.js';
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 71),
  HMAC = Buffer.alloc(32, 73);
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const PRODUCT = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Redonda',
  audience: '',
};
if (!connectionString)
  test(
    'OLIST-T22 resource PostgreSQL requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T22: shared identities and durable composed resource reservations', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 10 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repoFor = (db = database) =>
      createOlistRepository(db, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    const repo = repoFor();
    let seq = 0;
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      async function fixture() {
        await pool.query('TRUNCATE crm.olist_accounts CASCADE');
        const actorId = 'resource-' + randomUUID(),
          sessionBinding = hash(randomUUID());
        const accountKey = hash('resource-account'),
          contextKey = hash('resource-context');
        await pool.query(
          "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Synthetic','$argon2id$synthetic',true,1)",
          [actorId, actorId + '@example.test'],
        );
        await pool.query(
          "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Financeiro')",
          [actorId],
        );
        await pool.query(
          'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
          [
            sessionBinding,
            actorId,
            hash('csrf'),
            NOW,
            new Date(NOW.getTime() + 3600000),
          ],
        );
        await pool.query(
          'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
          [accountKey],
        );
        await pool.query(
          'INSERT INTO crm.olist_settings(account_key) VALUES($1)',
          [accountKey],
        );
        await pool.query(
          'INSERT INTO crm.olist_connections(context_key,account_key,token_envelope,expires_at) VALUES($1,$2,$3::jsonb,$4)',
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
        const base = {
          actor: { id: actorId, kind: 'human' },
          sessionBinding,
          authorizationVersion: 1,
          accountKey,
          contextKey,
          connectionGeneration: 0,
          connectionVersion: 0,
          settingsVersion: 0,
          correlationId: 'synthetic-resource',
        };
        /** @param {any} [snapshotOverride] */
        async function exportOrder(snapshotOverride) {
          const orderId = 'resource-order-' + randomUUID(),
            contactId = 'resource-contact-' + randomUUID();
          seq++;
          await pool.query(
            'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
            [contactId, NOW],
          );
          await pool.query(
            "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,contact_id,manual_owner_id,manual_create_key) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC','{}'::jsonb,'user',$4,$5,$5,$6,$4,$7)",
            [
              orderId,
              seq,
              String(seq).padStart(2, '0') + '-CRM',
              actorId,
              NOW,
              contactId,
              randomUUID(),
            ],
          );
          return repo.prepareExport({
            ...base,
            orderId,
            orderVersion: 1,
            snapshot: {
              customer: { nome: 'Synthetic Private Buyer' },
              commercial: { groups: [] },
              ...snapshotOverride,
              sourceVersions: {
                contactId,
                contactVersion: 1,
                sourceRevision: 0,
              },
            },
          });
        }
        const operation = await exportOrder();
        const input = { ...base, exportId: operation.id };
        const customer = () =>
          repo.bindResource({
            ...input,
            kind: 'customer',
            identity: '52998224725',
            payload: {
              cpfCnpj: '52998224725',
              nome: 'Synthetic Private Buyer',
            },
          });
        return { base, input, operation, exportOrder, customer };
      }
      /** @param {string[]} sizes */
      function resolutionSnapshot(sizes) {
        const groupId = randomUUID();
        return {
          policy: 'exact-cent-v1',
          productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
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
          commercial: {
            totalCents: sizes.length * 300,
            groups: [
              {
                groupId,
                attributes: structuredClone(PRODUCT),
                lines: sizes.map((size) => ({
                  groupId,
                  lineId: randomUUID(),
                  size,
                  quantity: 3,
                  subtotalCents: 300,
                  unitCents: 100,
                  unitLexeme: '1.00',
                })),
              },
            ],
          },
        };
      }
      /** The real writer validates, reserves, and serializes every mocked POST.
       * Only the ERP state is synthetic; all local identities/tickets use SQL.
       * @param {any} f @param {any} [behavior] */
      function remoteFor(f, behavior = {}) {
        /** @type {Map<number,any>} */ const contacts = new Map();
        /** @type {Map<number,any>} */ const products = new Map();
        /** @type {any[]} */ const writes = [];
        let sequence = 100,
          failTimeout = Boolean(behavior.timeoutProduct),
          failCommit = Boolean(behavior.commitProduct);
        let lastKind = '';
        const client = {
          findCustomer: async (/** @type {string} */ document) =>
            structuredClone(
              [...contacts.values()].find((v) => v.cpfCnpj === document) ??
                null,
            ),
          contact: async (/** @type {number} */ id) =>
            structuredClone(contacts.get(id) ?? null),
          findProduct: async (/** @type {string} */ sku) =>
            structuredClone(
              [...products.values()].find((v) => v.sku === sku) ?? null,
            ),
          product: async (/** @type {number} */ id) =>
            structuredClone(products.get(id) ?? null),
        };
        const scoped = behavior.commitProduct
          ? {
              query: database.query,
              transaction: (/** @type {any} */ work) =>
                withTransaction(pool, (tx) =>
                  work({
                    query: async (
                      /** @type {string} */ sql,
                      /** @type {any[]} */ values = [],
                    ) => {
                      if (
                        failCommit &&
                        lastKind === 'product' &&
                        sql.startsWith(
                          'UPDATE crm.olist_attempts SET outcome',
                        ) &&
                        values[1] === 'confirmed'
                      ) {
                        failCommit = false;
                        throw new Error(
                          'synthetic commit failure after known product ID',
                        );
                      }
                      return tx.query(sql, values);
                    },
                  }),
                ),
            }
          : database;
        const sqlRepo = repoFor(scoped);
        const writer = createOlistResourceWriter({
          credentials: async () => ({
            token: 'synthetic-resource-token',
            version: 0,
          }),
          quota: { reserve: async () => {}, observe: async () => {} },
          fetch: async (url, init) => {
            assert.equal(init?.method, 'POST');
            const path = new URL(String(url)).pathname;
            const payload = JSON.parse(String(init?.body));
            const kind = path.endsWith('/contatos')
              ? 'customer'
              : path.endsWith('/variacoes')
                ? 'variation'
                : 'product';
            lastKind = kind;
            writes.push({ kind, payload });
            let id = ++sequence;
            if (kind === 'customer') contacts.set(id, { ...payload, id });
            else if (kind === 'product') {
              const parent = {
                ...payload,
                id,
                situacao: 'A',
                tipoVariacao: 'P',
                variacoes: /** @type {any[]} */ ([]),
              };
              products.set(id, parent);
              for (const variation of payload.variacoes) {
                const childId = ++sequence;
                products.set(childId, {
                  ...variation,
                  id: childId,
                  tipo: 'S',
                  tipoVariacao: 'V',
                  situacao: 'A',
                  produtoPai: { id },
                });
                parent.variacoes.push({ ...variation, id: childId });
              }
            } else {
              const parentId = Number(path.split('/').at(-2));
              const parent = products.get(parentId);
              assert.ok(parent);
              products.set(id, {
                ...payload,
                id,
                tipo: 'S',
                tipoVariacao: 'V',
                situacao: 'A',
                produtoPai: { id: parentId },
              });
              parent.variacoes.push({ ...payload, id });
              id = parentId; // The proven provider response returns the parent ID.
            }
            if (kind === 'customer' && behavior.afterCustomer)
              await behavior.afterCustomer();
            if (kind === 'product' && failTimeout) {
              failTimeout = false;
              throw new Error('synthetic response timeout');
            }
            return new globalThis.Response(JSON.stringify({ id }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          },
        });
        const resolver = () =>
          createOlistResourceResolver({
            repository: sqlRepo,
            client,
            writer,
            config: {
              accountKey: f.base.accountKey,
              contextKey: f.base.contextKey,
              hmacKey: HMAC,
            },
          });
        return { contacts, products, writes, resolver };
      }
      await t.test(
        'two independent orders bind one shared entity and retain encrypted immutable base',
        async () => {
          const f = await fixture(),
            other = await f.exportOrder();
          const [a, b] = await Promise.all([
            f.customer(),
            repo.bindResource({
              ...f.base,
              exportId: other.id,
              kind: 'customer',
              identity: '52998224725',
              payload: {
                nome: 'Synthetic Private Buyer',
                cpfCnpj: '52998224725',
              },
            }),
          ]);
          assert.equal(a.id, b.id);
          assert.equal(a.payload_hash, b.payload_hash);
          const stored = await repo.readResource({
            ...f.input,
            resourceId: a.id,
          });
          assert.equal(stored.payload.nome, 'Synthetic Private Buyer');
          assert.doesNotMatch(
            JSON.stringify(a.snapshot_envelope),
            /Private Buyer|52998224725/,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM crm.olist_export_resources WHERE resource_id=$1',
                [a.id],
              )
            ).rows[0].n,
            2,
          );
          await assert.rejects(
            repo.bindResource({
              ...f.input,
              kind: 'customer',
              identity: '52998224725',
              payload: { cpfCnpj: '52998224725', nome: 'Changed Buyer' },
            }),
            { code: 'OLIST_RESOURCE_DIVERGENT' },
          );
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_resources SET payload_hash=$2 WHERE id=$1',
              [a.id, hash('tampered')],
            ),
            /immutable/,
          );
          assert.equal(
            (await repo.readExport(f.input)).snapshot.customer.nome,
            'Synthetic Private Buyer',
          );
        },
      );
      await t.test(
        'independent connections reserve one resource effect and every replay remains closed',
        async () => {
          const f = await fixture(),
            row = await f.customer();
          const input = {
            ...f.input,
            resourceId: row.id,
            expectedVersion: 0,
            requestPayload: { cpfCnpj: '52998224725' },
          };
          const contenders = await Promise.allSettled([
            repo.reserveResourceEffect(input),
            repoFor().reserveResourceEffect(input),
          ]);
          assert.equal(
            contenders.filter((x) => x.status === 'fulfilled').length,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM crm.olist_attempts WHERE resource_id=$1',
                [row.id],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            repo.reserveResourceEffect({ ...input, expectedVersion: 1 }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
          const read = await repo.readResource({
            ...f.input,
            resourceId: row.id,
          });
          assert.equal(
            read.latestAttempt.requestPayload.cpfCnpj,
            '52998224725',
          );
          assert.doesNotMatch(
            JSON.stringify(read.latestAttempt.request_envelope),
            /52998224725/,
          );
          await assert.rejects(
            repo.confirmResourceLookup({
              ...f.input,
              resourceId: row.id,
              expectedVersion: 1,
              remoteId: 91,
            }),
            { code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED' },
          );
        },
      );
      await t.test(
        'parent base shares across different initial sizes; composed request reserves every child once',
        async () => {
          const f = await fixture(),
            second = await f.exportOrder();
          const base = {
            ...f.input,
            kind: 'product',
            identity: PRODUCT,
            payload: {
              attributes: PRODUCT,
              fiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
            },
          };
          const parent = await repo.bindResource(base);
          const same = await repo.bindResource({
            ...base,
            exportId: second.id,
          });
          assert.equal(same.id, parent.id);
          const m = await repo.bindResource({
            ...f.input,
            kind: 'variation',
            identity: 'M',
            parentId: parent.id,
            payload: { size: 'M' },
          });
          const g = await repo.bindResource({
            ...f.input,
            kind: 'variation',
            identity: 'G',
            parentId: parent.id,
            payload: { size: 'G' },
          });
          const request = {
            tipo: 'V',
            variacoes: [{ sku: m.reference }, { sku: g.reference }],
          };
          const ticket = await repo.reserveResourceBatchEffect({
            ...f.input,
            resourceId: parent.id,
            expectedVersion: 0,
            requestPayload: request,
            dependentResourceIds: [m.id, g.id],
          });
          assert.equal(ticket.children.length, 2);
          const read = await repo.readResource({
            ...f.input,
            resourceId: parent.id,
          });
          assert.equal(read.latestAttempt.children.length, 2);
          assert.equal(
            (await repo.readResource({ ...f.input, resourceId: m.id })).state,
            'reserved',
          );
          await assert.rejects(
            repo.reserveResourceEffect({
              ...f.input,
              resourceId: m.id,
              expectedVersion: 1,
              requestPayload: { size: 'M' },
            }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
          await repo.recordResult({
            ...f.base,
            ...ticket,
            outcome: 'confirmed',
            remoteId: 301,
            response: { id: 301 },
          });
          await repo.recordResourceBatchResult({
            ...f.base,
            results: ticket.children.map(
              (/** @type {any} */ child, /** @type {number} */ idx) => ({
                ...child,
                outcome: 'confirmed',
                remoteId: 401 + idx,
              }),
            ),
          });
          assert.equal(
            (await repo.readResource({ ...f.input, resourceId: parent.id }))
              .remote_id,
            '301',
          );
          const p = await repo.bindResource({
            ...f.base,
            exportId: second.id,
            kind: 'variation',
            identity: 'P',
            parentId: parent.id,
            payload: { size: 'P' },
          });
          const pTicket = await repo.reserveResourceEffect({
            ...f.base,
            exportId: second.id,
            resourceId: p.id,
            expectedVersion: 0,
            requestPayload: { sku: p.reference },
          });
          assert.ok(pTicket.attemptId);
          assert.deepEqual(pTicket.children, []);
        },
      );
      await t.test(
        'observed parent ID is durable before lookup and never confirms a child implicitly',
        async () => {
          const f = await fixture(),
            parent = await repo.bindResource({
              ...f.input,
              kind: 'product',
              identity: PRODUCT,
              payload: { attributes: PRODUCT },
            });
          await repo.confirmResourceLookup({
            ...f.input,
            resourceId: parent.id,
            expectedVersion: 0,
            remoteId: 301,
          });
          const child = await repo.bindResource({
            ...f.input,
            kind: 'variation',
            identity: 'M',
            parentId: parent.id,
            payload: { size: 'M' },
          });
          const ticket = await repo.reserveResourceEffect({
            ...f.input,
            resourceId: child.id,
            expectedVersion: 0,
            requestPayload: { size: 'M' },
          });
          await repo.recordObservedResourceId({
            ...f.base,
            ...ticket,
            remoteId: 301,
          });
          const observed = await repo.readResource({
            ...f.input,
            resourceId: child.id,
          });
          assert.equal(observed.state, 'reserved');
          assert.equal(observed.remote_id, null);
          assert.equal(observed.latestAttempt.observed_remote_id, '301');
          await assert.rejects(
            repo.recordObservedResourceId({
              ...f.base,
              ...ticket,
              remoteId: 999,
            }),
            { code: 'OLIST_RESOURCE_DIVERGENT' },
          );
          await repo.recordResult({
            ...f.base,
            ...ticket,
            outcome: 'uncertain',
          });
          await repo.reconcileResourceLookup({
            ...f.input,
            resourceId: child.id,
            expectedVersion: 2,
            remoteId: 401,
          });
          const recovered = await repo.readResource({
            ...f.input,
            resourceId: child.id,
          });
          assert.equal(recovered.state, 'confirmed');
          assert.equal(recovered.remote_id, '401');
          assert.equal(recovered.latestAttempt.outcome, 'uncertain');
          await assert.rejects(
            repo.reserveResourceEffect({
              ...f.input,
              resourceId: child.id,
              expectedVersion: 3,
              requestPayload: { size: 'M' },
            }),
            { code: 'OLIST_EFFECT_ALREADY_RESERVED' },
          );
        },
      );
      await t.test(
        'each fresh guard defeats stale actor, settings, connection, recovery and source',
        async () => {
          for (const [sql, values, error] of [
            [
              'UPDATE crm.users SET olist_enabled=false WHERE id=$1',
              'actor',
              'FORBIDDEN',
            ],
            [
              'UPDATE crm.sessions SET revoked_at=$2 WHERE user_id=$1',
              'actor',
              'FORBIDDEN',
            ],
            [
              'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
              'account',
              'VERSION_CONFLICT',
            ],
            [
              'UPDATE crm.olist_connections SET version=version+1 WHERE account_key=$1',
              'account',
              'OLIST_CONNECTION_CHANGED',
            ],
            [
              'UPDATE crm.olist_connections SET generation=generation+1 WHERE account_key=$1',
              'account',
              'OLIST_CONNECTION_CHANGED',
            ],
            [
              'UPDATE crm.olist_accounts SET recovery_required=true WHERE account_key=$1',
              'account',
              'OLIST_CREATION_DISABLED',
            ],
            [
              'UPDATE crm.orders SET version=version+1 WHERE id=$1',
              'order',
              'VERSION_CONFLICT',
            ],
          ]) {
            const f = await fixture(),
              row = await f.customer();
            await pool.query(/** @type {string} */ (sql), [
              values === 'actor'
                ? f.base.actor.id
                : values === 'order'
                  ? f.operation.order_id
                  : f.base.accountKey,
              ...(String(sql).includes('$2') ? [NOW] : []),
            ]);
            await assert.rejects(
              repo.reserveResourceEffect({
                ...f.input,
                resourceId: row.id,
                expectedVersion: 0,
                requestPayload: { name: 'Synthetic' },
              }),
              { code: /** @type {string} */ (error) },
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int n FROM crm.olist_attempts',
                )
              ).rows[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        'source contact and supplemental revision changes invalidate subsequent effects',
        async () => {
          for (const mode of ['contact', 'revision', 'contact-link']) {
            const f = await fixture(),
              row = await f.customer();
            const snapshot = (await repo.readExport(f.input)).snapshot;
            if (mode === 'contact')
              await pool.query(
                'UPDATE crm.contacts SET version=version+1 WHERE id=$1',
                [snapshot.sourceVersions.contactId],
              );
            else if (mode === 'contact-link') {
              const otherContact = 'resource-other-' + randomUUID();
              await pool.query(
                'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
                [otherContact, NOW],
              );
              await pool.query(
                'UPDATE crm.orders SET contact_id=$2 WHERE id=$1',
                [f.operation.order_id, otherContact],
              );
            } else
              await pool.query(
                'INSERT INTO crm.order_olist_source_revisions(order_id,revision,order_version,source_hmac,data_envelope,updated_by,updated_at) VALUES($1,1,1,$2,$3::jsonb,$4,$5)',
                [
                  f.operation.order_id,
                  hash('synthetic-source'),
                  JSON.stringify(
                    seal({}, KEY, 'source', f.base.accountKey, 'source'),
                  ),
                  f.base.actor.id,
                  NOW,
                ],
              );
            await assert.rejects(
              repo.reserveResourceEffect({
                ...f.input,
                resourceId: row.id,
                expectedVersion: 0,
                requestPayload: { name: 'Synthetic' },
              }),
              { code: 'VERSION_CONFLICT' },
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int n FROM crm.olist_attempts',
                )
              ).rows[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        'post-effect IDs survive revocation and failed local recording cannot free a reservation',
        async () => {
          const f = await fixture(),
            row = await f.customer();
          const ticket = await repo.reserveResourceEffect({
            ...f.input,
            resourceId: row.id,
            expectedVersion: 0,
            requestPayload: { name: 'Synthetic' },
          });
          const failDb = {
            query: database.query,
            transaction: (/** @type {any} */ work) =>
              withTransaction(pool, (client) =>
                work({
                  query: async (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ params,
                  ) => {
                    if (sql.includes('INSERT INTO crm.audit_events'))
                      throw new Error('synthetic audit failure');
                    return client.query(sql, params);
                  },
                }),
              ),
          };
          await assert.rejects(
            repoFor(failDb).recordResult({
              ...f.base,
              ...ticket,
              outcome: 'confirmed',
              remoteId: 101,
            }),
            /audit failure/,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT state FROM crm.olist_resources WHERE id=$1',
                [row.id],
              )
            ).rows[0].state,
            'reserved',
          );
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false WHERE id=$1',
            [f.base.actor.id],
          );
          await repo.recordObservedResourceId({
            ...f.base,
            ...ticket,
            remoteId: 101,
          });
          await repo.recordResult({
            ...f.base,
            ...ticket,
            outcome: 'confirmed',
            remoteId: 101,
          });
          const saved = (
            await pool.query('SELECT * FROM crm.olist_resources WHERE id=$1', [
              row.id,
            ])
          ).rows[0];
          assert.equal(saved.remote_id, '101');
          const attempt = (
            await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
              ticket.attemptId,
            ])
          ).rows[0];
          assert.equal(attempt.observed_remote_id, '101');
          assert.equal(attempt.outcome, 'confirmed');
          assert.equal(
            open(
              attempt.request_envelope,
              KEY,
              'resource-request',
              f.base.accountKey,
              ticket.attemptId,
            ).name,
            'Synthetic',
          );
        },
      );
      await t.test(
        'real resolver and writer share SQL reservations across overlapping orders and only add the missing size',
        async () => {
          const f = await fixture(),
            a = await f.exportOrder(resolutionSnapshot(['M', 'G'])),
            b = await f.exportOrder(resolutionSnapshot(['P', 'G']));
          const remote = remoteFor(f);
          const inputA = { ...f.base, exportId: a.id },
            inputB = { ...f.base, exportId: b.id };
          await Promise.allSettled([
            remote.resolver().resolve(inputA),
            remote.resolver().resolve(inputB),
          ]);
          const first = await remote.resolver().resolve(inputA);
          const second = await remote.resolver().resolve(inputB);
          assert.equal(first.resolved, true);
          assert.equal(second.resolved, true);
          assert.equal(first.customerId, second.customerId);
          assert.equal(first.groups[0].productId, second.groups[0].productId);
          assert.equal(
            remote.writes.filter((v) => v.kind === 'customer').length,
            1,
          );
          assert.equal(
            remote.writes.filter((v) => v.kind === 'product').length,
            1,
          );
          assert.equal(
            remote.writes.filter((v) => v.kind === 'variation').length,
            1,
          );
          const resources = (
            await pool.query(
              'SELECT kind,state,count(*)::int n FROM crm.olist_resources GROUP BY kind,state',
            )
          ).rows;
          assert.deepEqual(
            resources.map((v) => [v.kind, v.state, v.n]).sort(),
            [
              ['customer', 'confirmed', 1],
              ['product', 'confirmed', 1],
              ['variation', 'confirmed', 3],
            ].sort(),
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int n FROM crm.olist_attempts'))
              .rows[0].n,
            5,
          );
        },
      );
      await t.test(
        'real resolver recovers a composed POST timeout or failed commit through GET without another POST',
        async () => {
          for (const failure of ['timeoutProduct', 'commitProduct']) {
            const f = await fixture(),
              operation = await f.exportOrder(resolutionSnapshot(['M', 'G']));
            const remote = remoteFor(f, { [failure]: true });
            const input = { ...f.base, exportId: operation.id };
            await assert.rejects(remote.resolver().resolve(input));
            assert.equal(remote.writes.length, 2);
            const parent = (
              await pool.query(
                "SELECT r.*,a.observed_remote_id FROM crm.olist_resources r JOIN crm.olist_attempts a ON a.resource_id=r.id WHERE r.kind='product'",
              )
            ).rows[0];
            assert.equal(parent.state, 'uncertain');
            if (failure === 'commitProduct')
              assert.ok(
                parent.observed_remote_id,
                'known successful parent ID survives failed result transaction',
              );
            const recovered = await remote.resolver().resolve(input);
            assert.equal(recovered.resolved, true);
            assert.equal(
              remote.writes.length,
              2,
              'reconciliation must not resend parent or child',
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_resources WHERE state<>'confirmed'",
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_attempts WHERE outcome='uncertain'",
                )
              ).rows[0].n,
              3,
              'original uncertainty remains durable evidence',
            );
          }
        },
      );
      await t.test(
        'real resolver stops before the next entity when authorization or settings change after customer POST',
        async () => {
          for (const change of ['authorization', 'settings']) {
            const f = await fixture(),
              operation = await f.exportOrder(resolutionSnapshot(['M']));
            const remote = remoteFor(f, {
              afterCustomer: async () => {
                if (change === 'authorization')
                  await pool.query(
                    'UPDATE crm.users SET olist_enabled=false WHERE id=$1',
                    [f.base.actor.id],
                  );
                else
                  await pool.query(
                    'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                    [f.base.accountKey],
                  );
              },
            });
            await assert.rejects(
              remote.resolver().resolve({ ...f.base, exportId: operation.id }),
              {
                code:
                  change === 'authorization' ? 'FORBIDDEN' : 'VERSION_CONFLICT',
              },
            );
            assert.deepEqual(
              remote.writes.map((v) => v.kind),
              ['customer'],
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_attempts WHERE stage IN ('product','variation')",
                )
              ).rows[0].n,
              0,
            );
            const customer = (
              await pool.query(
                "SELECT r.state,a.outcome,a.observed_remote_id FROM crm.olist_resources r JOIN crm.olist_attempts a ON a.resource_id=r.id WHERE r.kind='customer'",
              )
            ).rows[0];
            assert.ok(customer.observed_remote_id);
            assert.equal(customer.state, 'confirmed');
            assert.equal(customer.outcome, 'confirmed');
          }
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
