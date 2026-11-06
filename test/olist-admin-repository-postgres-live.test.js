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

const URL = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 91),
  HMAC = Buffer.alloc(32, 92);
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
    'OLIST-T09 administrative repository requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T09 existing links and administrative read-only recovery are atomic and durable', async (t) => {
    assert.equal(new globalThis.URL(URL).pathname.slice(1), 'crm_silmer_test');
    const pool = new Pool({ connectionString: URL, max: 8 });
    const db = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const adminFor = (/** @type {any} */ database = db) =>
      createOlistAdminRepository(database, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    const repo = createOlistRepository(db, {
      envelopeKey: KEY,
      hmacKey: HMAC,
      clock: () => NOW,
    });
    const accountKey = hash('synthetic-t09-account'),
      contextKey = hash('synthetic-t09-context');
    /** @param {any} [mode] @returns {Promise<any>} */
    async function fixture(mode = {}) {
      await pool.query('TRUNCATE crm.olist_accounts CASCADE');
      const owner = 'owner-' + randomUUID(),
        admin = 'admin-' + randomUUID(),
        session = hash(randomUUID());
      for (const id of [owner, admin]) {
        await pool.query(
          "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',$3,$4)",
          [id, id + '@example.test', id === owner, id === owner ? 1 : 0],
        );
        await pool.query(
          "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
          [id],
        );
      }
      await pool.query(
        "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
        [admin],
      );
      await pool.query(
        'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
        [
          session,
          admin,
          hash('synthetic-csrf'),
          NOW,
          new Date(NOW.getTime() + 86400000),
        ],
      );
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
      const orderId = 't09-order-' + randomUUID(),
        contactId = 't09-contact-' + randomUUID(),
        groupId = randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') n")).rows[0]
          .n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,manual_create_key,contact_id) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC','{}'::jsonb,'user',$4,$5,$5,$4,$6,$7)",
        [
          orderId,
          n,
          String(n).padStart(2, '0') + '-CRM',
          owner,
          NOW,
          randomUUID(),
          contactId,
        ],
      );
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
        sourceVersions: {
          contactId,
          contactVersion: 1,
          sourceRevision: 0,
        },
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
        correlationId: 'synthetic-t09-original',
      };
      const input = {
        actor: { id: admin, kind: 'human' },
        sessionBinding: session,
        authorizationVersion: 0,
        accountKey,
        contextKey,
        connectionGeneration: 3,
        connectionVersion: 2,
        orderId,
        correlationId: 'synthetic-t09-admin',
      };
      /** @type {any} */ let operation = null;
      /** @type {any} */ let customer = null,
        parent = null,
        child = null,
        ticket = null;
      if (mode.operation) {
        operation = await repo.prepareExport({
          ...original,
          orderVersion: 1,
          snapshot,
        });
        original.exportId = operation.id;
        if (mode.customer || mode.sale || mode.variation) {
          customer = await repo.bindResource({
            ...original,
            kind: 'customer',
            identity: snapshot.customer.cpfCnpj,
            payload: snapshot.customer,
          });
          if (!mode.customer)
            await repo.confirmResourceLookup({
              ...original,
              resourceId: customer.id,
              expectedVersion: 0,
              remoteId: '101',
            });
          else {
            ticket = await repo.reserveResourceEffect({
              ...original,
              resourceId: customer.id,
              expectedVersion: 0,
              requestPayload: snapshot.customer,
            });
            await repo.recordObservedResourceId({
              ...original,
              ...ticket,
              remoteId: '101',
            });
            await repo.recordResult({
              ...original,
              ...ticket,
              outcome: 'uncertain',
            });
          }
        }
        if (mode.sale || mode.variation) {
          parent = await repo.bindResource({
            ...original,
            kind: 'product',
            identity: ATTR,
            payload: { attributes: ATTR, fiscal: snapshot.productFiscal },
          });
          await repo.confirmResourceLookup({
            ...original,
            resourceId: parent.id,
            expectedVersion: 0,
            remoteId: '201',
          });
          for (const [
            i,
            line,
          ] of snapshot.commercial.groups[0].lines.entries()) {
            const resource = await repo.bindResource({
              ...original,
              kind: 'variation',
              parentId: parent.id,
              identity: line.size,
              payload: { size: line.size.toLowerCase() },
            });
            if (mode.variation && i === 0) {
              child = resource;
              ticket = await repo.reserveResourceEffect({
                ...original,
                resourceId: resource.id,
                expectedVersion: 0,
                requestPayload: {
                  sku: resource.reference,
                  grade: [{ chave: 'Tamanho', valor: line.size }],
                },
              });
              await repo.recordObservedResourceId({
                ...original,
                ...ticket,
                remoteId: '201',
              });
              await repo.recordResult({
                ...original,
                ...ticket,
                outcome: 'uncertain',
              });
            } else
              await repo.confirmResourceLookup({
                ...original,
                resourceId: resource.id,
                expectedVersion: 0,
                remoteId: String(301 + i),
              });
          }
        }
        if (mode.sale) {
          await repo.markReady({ ...original, resources });
          const plan = buildOlistSalePayload({
            snapshot,
            resolved: resources,
            reference: operation.reference,
          });
          ticket = await repo.reserveSaleEffect({
            ...original,
            requestPayload: { encoded: plan.encoded },
          });
          await repo.persistSaleObservedId({
            ...original,
            ...ticket,
            remoteId: '401',
            remoteNumber: '99',
          });
          await repo.markSaleUncertain({ ...original, ...ticket });
        }
      }
      await pool.query(
        'UPDATE crm.olist_accounts SET creation_enabled=false,recovery_required=true WHERE account_key=$1',
        [accountKey],
      );
      await pool.query(
        'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
        [owner],
      );
      const proof = { matched: true, lineCount: 2, totalCents: 200 };
      const link = {
        ...input,
        exportId: randomUUID(),
        expectedOrderVersion: 1,
        expectedSettingsVersion: 4,
        expectedOperationVersion: 0,
        snapshot,
        resources,
        proof,
        remoteId: '401',
        number: '99',
        reason: 'PRIVATE_REASON_CANARY',
      };
      return {
        input,
        original,
        link,
        snapshot,
        resources,
        proof,
        operation,
        customer,
        parent,
        child,
        ticket,
        admin,
        owner,
        orderId,
        session,
      };
    }
    const count = async (/** @type {string} */ table) =>
      Number(
        (await pool.query('SELECT count(*)::integer n FROM crm.' + table))
          .rows[0].n,
      );
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      const migrations = await loadMigrations();
      await migrate(pool, { migrations });
      await t.test(
        'migration reapply is empty and retains existing outbox kinds',
        async () => {
          const second = await migrate(pool, { migrations });
          assert.equal(second.applied.length, 0);
        },
      );
      await t.test(
        'admin without checkbox links an existing sale with all shared identities and zero creation jobs',
        async () => {
          const f = await fixture();
          const admin = adminFor();
          const row = await admin.commitLink(f.link);
          assert.equal(row.state, 'linked');
          assert.equal(row.remote_id, '401');
          assert.equal(await count('olist_attempts'), 0);
          assert.equal(await count('outbox_jobs'), 0);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM crm.olist_export_resources WHERE export_id=$1',
                [row.id],
              )
            ).rows[0].n,
            4,
          );
          const evidence = open(
            row.readback_envelope,
            KEY,
            'sale-readback',
            accountKey,
            row.id,
          );
          assert.equal(evidence.reason, 'PRIVATE_REASON_CANARY');
          assert.doesNotMatch(
            JSON.stringify(
              (
                await pool.query(
                  'SELECT action,reason FROM crm.audit_events WHERE target_id=$1',
                  [row.id],
                )
              ).rows,
            ),
            /PRIVATE_REASON_CANARY/,
          );
          const replay = await admin.commitLink(f.link);
          assert.equal(replay.id, row.id);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM crm.olist_events WHERE export_id=$1',
                [row.id],
              )
            ).rows[0].n,
            1,
          );
          const diagnostic = await admin.diagnostic(f.input);
          assert.equal(diagnostic.resources.length, 4);
          assert.equal(diagnostic.operation.state, 'linked');
          assert.doesNotMatch(
            JSON.stringify(diagnostic),
            /PRIVATE_REASON_CANARY|52998224725|Rua Sintética/,
          );
        },
      );
      await t.test(
        'current admin and version guards defeat revoked authority, session and changed connection/settings/order',
        async () => {
          for (const mutate of [
            async (/** @type {any} */ f) =>
              pool.query('DELETE FROM crm.user_capabilities WHERE user_id=$1', [
                f.admin,
              ]),
            async (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
                [f.session, NOW],
              ),
            async () =>
              pool.query(
                'UPDATE crm.olist_connections SET generation=4 WHERE context_key=$1',
                [contextKey],
              ),
            async () =>
              pool.query(
                'UPDATE crm.olist_settings SET version=5 WHERE account_key=$1',
                [accountKey],
              ),
            async (/** @type {any} */ f) =>
              pool.query('UPDATE crm.orders SET version=2 WHERE id=$1', [
                f.orderId,
              ]),
          ]) {
            const f = await fixture();
            await mutate(f);
            await assert.rejects(adminFor().commitLink(f.link));
            assert.equal(await count('olist_exports'), 0);
            assert.equal(await count('olist_resources'), 0);
          }
        },
      );
      await t.test(
        'audit failure rolls back complete link graph and proof',
        async () => {
          const f = await fixture();
          const failed = {
            query: db.query,
            transaction: (/** @type {any} */ work) =>
              withTransaction(pool, (tx) =>
                work({
                  query: async (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ values,
                  ) => {
                    if (sql.includes('INSERT INTO crm.audit_events'))
                      throw new Error('SYNTHETIC_AUDIT_FAILURE');
                    return tx.query(sql, values);
                  },
                }),
              ),
          };
          await assert.rejects(adminFor(failed).commitLink(f.link));
          assert.equal(await count('olist_exports'), 0);
          assert.equal(await count('olist_resources'), 0);
          assert.equal(await count('olist_events'), 0);
        },
      );
      await t.test(
        'competing links serialize on the order and never overwrite a different remote',
        async () => {
          const f = await fixture();
          const outcomes = await Promise.allSettled([
            adminFor().commitLink(f.link),
            adminFor().commitLink({
              ...f.link,
              exportId: randomUUID(),
              remoteId: '402',
            }),
          ]);
          assert.equal(
            outcomes.filter((v) => v.status === 'fulfilled').length,
            1,
          );
          assert.equal(
            outcomes.filter((v) => v.status === 'rejected').length,
            1,
          );
          assert.equal(await count('olist_exports'), 1);
          assert.equal(await count('olist_attempts'), 0);
        },
      );
      await t.test(
        'one remote sale cannot be linked by competing distinct orders',
        async () => {
          const f = await fixture();
          const other = 'other-' + randomUUID();
          const n = Number(
            (await pool.query("SELECT nextval('crm.order_number_seq') n"))
              .rows[0].n,
          );
          await pool.query(
            'INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,manual_create_key,contact_id) SELECT $2,$3,$4,NULL,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,$5,contact_id FROM crm.orders WHERE id=$1',
            [
              f.orderId,
              other,
              n,
              String(n).padStart(2, '0') + '-CRM',
              randomUUID(),
            ],
          );
          const outcomes = await Promise.allSettled([
            adminFor().commitLink(f.link),
            adminFor().commitLink({
              ...f.link,
              exportId: randomUUID(),
              orderId: other,
            }),
          ]);
          assert.equal(
            outcomes.filter((v) => v.status === 'fulfilled').length,
            1,
          );
          const rejected = outcomes.find((v) => v.status === 'rejected');
          assert.equal(rejected?.status, 'rejected');
          if (rejected?.status === 'rejected')
            assert.equal(rejected.reason.code, 'VERSION_CONFLICT');
          assert.equal(await count('olist_exports'), 1);
          assert.equal(await count('olist_resources'), 4);
          assert.equal(await count('olist_events'), 1);
        },
      );
      await t.test(
        'existing sale reservation forbids legacy link even when every amount matches',
        async () => {
          const f = await fixture({ operation: true, sale: true });
          const op = await adminFor().readOperation(f.input);
          await assert.rejects(
            adminFor().commitLink({
              ...f.link,
              exportId: op.id,
              expectedOperationVersion: op.version,
            }),
            { code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED' },
          );
          assert.equal(
            (await adminFor().readOperation(f.input)).state,
            'uncertain',
          );
        },
      );
      await t.test(
        'read request and internal read-only job are atomic, scoped, versioned and encrypted',
        async () => {
          const f = await fixture({ operation: true, customer: true });
          const admin = adminFor();
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'PRIVATE_READ_REASON',
          });
          assert.equal(request.status, 'queued');
          assert.doesNotMatch(JSON.stringify(request), /PRIVATE_READ_REASON/);
          const loaded = await admin.loadReadRequest({
            requestId: request.id,
            accountKey,
            contextKey,
          });
          assert.equal(loaded.payload.reason, 'PRIVATE_READ_REASON');
          assert.equal(loaded.actor.id, f.admin);
          assert.equal(loaded.authorizationVersion, 0);
          const job = (
            await pool.query(
              "SELECT * FROM crm.outbox_jobs WHERE job_type='olist.reconcile'",
            )
          ).rows[0];
          assert.equal(job.queue, 'olist_reconcile');
          assert.equal(job.effect_policy, 'internal');
          assert.equal(job.idempotency_key, request.id);
          await assert.rejects(
            admin.readRequest({
              ...f.input,
              requestId: request.id,
              orderId: 'wrong-order',
            }),
            { code: 'OLIST_RESOURCE_NOT_FOUND' },
          );
          await assert.rejects(
            admin.createReadRequest({
              ...f.input,
              stage: 'product',
              resourceId: resource.id,
              expectedVersion: resource.version,
              reason: 'explicit',
            }),
            { code: 'OLIST_RESOURCE_NOT_FOUND' },
          );
        },
      );
      await t.test(
        'uncertain shared resource reconciles after original revocation and preserves the old attempt byte for byte',
        async () => {
          const f = await fixture({ operation: true, customer: true });
          const admin = adminFor();
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          const before = (
            await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
              f.ticket.attemptId,
            ])
          ).rows[0];
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'explicit review',
          });
          const finished = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: true,
            remoteId: '101',
            proof: { matched: true },
          });
          assert.equal(finished.status, 'succeeded');
          assert.deepEqual(
            (
              await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
                f.ticket.attemptId,
              ])
            ).rows[0],
            before,
          );
          assert.equal(
            (await admin.readResource({ ...f.input, resourceId: resource.id }))
              .state,
            'confirmed',
          );
          const version = finished.version;
          const again = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: true,
            remoteId: '101',
            proof: { matched: true },
          });
          assert.equal(again.version, version);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM crm.olist_events WHERE event_code='OLIST_RECONCILIATION_CONFIRMED'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'zero, multiple and divergent reads block without unreserving or creating another effect',
        async () => {
          for (const code of [
            'OLIST_RECONCILIATION_REQUIRED',
            'OLIST_AMBIGUOUS_MATCH',
            'OLIST_RESOURCE_DIVERGENT',
          ]) {
            const f = await fixture({ operation: true, customer: true });
            const admin = adminFor();
            const resource = await admin.readResource({
              ...f.input,
              resourceId: f.customer.id,
            });
            const request = await admin.createReadRequest({
              ...f.input,
              stage: 'customer',
              resourceId: resource.id,
              expectedVersion: resource.version,
              reason: 'review',
            });
            const before = (
              await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
                f.ticket.attemptId,
              ])
            ).rows[0];
            const result = await admin.completeReadRequest({
              ...f.input,
              requestId: request.id,
              matched: false,
              code,
            });
            assert.equal(result.status, 'blocked');
            assert.equal(result.code, code);
            assert.equal(
              (
                await admin.readResource({
                  ...f.input,
                  resourceId: resource.id,
                })
              ).state,
              'uncertain',
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT * FROM crm.olist_attempts WHERE id=$1',
                  [f.ticket.attemptId],
                )
              ).rows[0],
              before,
            );
            assert.equal(await count('olist_attempts'), 1);
          }
        },
      );
      await t.test(
        'late administrator revocation forbids success but frozen request records a bounded negative ledger result',
        async () => {
          const f = await fixture({ operation: true, customer: true });
          const admin = adminFor();
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'review',
          });
          await pool.query(
            'DELETE FROM crm.user_capabilities WHERE user_id=$1',
            [f.admin],
          );
          await assert.rejects(
            admin.completeReadRequest({
              ...f.input,
              requestId: request.id,
              matched: true,
              remoteId: '101',
              proof: { matched: true },
            }),
            { code: 'FORBIDDEN' },
          );
          const result = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: false,
            code: 'FORBIDDEN',
          });
          assert.equal(result.status, 'blocked');
          assert.equal(result.code, 'FORBIDDEN');
          assert.equal(
            (
              await pool.query(
                'SELECT state FROM crm.olist_resources WHERE id=$1',
                [resource.id],
              )
            ).rows[0].state,
            'uncertain',
          );
        },
      );
      await t.test(
        'source target race blocks only the stale read request and preserves resource evidence',
        async () => {
          const f = await fixture({ operation: true, customer: true });
          const admin = adminFor();
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'review',
          });
          await pool.query(
            'UPDATE crm.olist_resources SET version=version+1 WHERE id=$1',
            [resource.id],
          );
          const result = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: true,
            remoteId: '101',
            proof: { matched: true },
          });
          assert.equal(result.status, 'blocked');
          assert.equal(result.code, 'VERSION_CONFLICT');
          assert.equal(
            (await admin.readResource({ ...f.input, resourceId: resource.id }))
              .state,
            'uncertain',
          );
        },
      );
      await t.test(
        'variation observation of parent never binds the parent as the child and may confirm a proven canonical child',
        async () => {
          const f = await fixture({ operation: true, variation: true });
          const admin = adminFor();
          const child = await admin.readResource({
            ...f.input,
            resourceId: f.child.id,
          });
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'variation',
            resourceId: child.id,
            expectedVersion: child.version,
            reason: 'review',
          });
          await assert.rejects(
            admin.completeReadRequest({
              ...f.input,
              requestId: request.id,
              matched: true,
              remoteId: '201',
              proof: { matched: true, parentRemoteId: '201' },
            }),
            { code: 'OLIST_VARIATION_DIVERGENT' },
          );
          const done = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: true,
            remoteId: '301',
            proof: { matched: true, parentRemoteId: '201' },
          });
          assert.equal(done.status, 'succeeded');
          assert.equal(
            (await admin.readResource({ ...f.input, resourceId: child.id }))
              .remote_id,
            '301',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT observed_remote_id FROM crm.olist_attempts WHERE id=$1',
                [f.ticket.attemptId],
              )
            ).rows[0].observed_remote_id,
            '201',
          );
        },
      );
      await t.test(
        'sale recovery checks frozen request and ID, preserves uncertainty history and confirms exact proof once',
        async () => {
          const f = await fixture({ operation: true, sale: true });
          const admin = adminFor();
          const op = await admin.readOperation(f.input);
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'sale',
            resourceId: null,
            expectedVersion: op.version,
            reason: 'review',
          });
          const before = (
            await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
              f.ticket.attemptId,
            ])
          ).rows[0];
          await assert.rejects(
            admin.completeReadRequest({
              ...f.input,
              requestId: request.id,
              matched: true,
              remoteId: '402',
              number: '99',
              proof: f.proof,
            }),
            { code: 'OLIST_SALE_DIVERGENT' },
          );
          const done = await admin.completeReadRequest({
            ...f.input,
            requestId: request.id,
            matched: true,
            remoteId: '401',
            number: '99',
            proof: f.proof,
          });
          assert.equal(done.status, 'succeeded');
          assert.equal((await admin.readOperation(f.input)).state, 'confirmed');
          assert.deepEqual(
            (
              await pool.query('SELECT * FROM crm.olist_attempts WHERE id=$1', [
                f.ticket.attemptId,
              ])
            ).rows[0],
            before,
          );
          assert.equal(await count('olist_attempts'), 1);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM crm.outbox_jobs WHERE job_type='olist.export'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'read proof/audit rollback leaves request queued and target uncertain',
        async () => {
          const f = await fixture({ operation: true, customer: true });
          const admin = adminFor();
          const resource = await admin.readResource({
            ...f.input,
            resourceId: f.customer.id,
          });
          const request = await admin.createReadRequest({
            ...f.input,
            stage: 'customer',
            resourceId: resource.id,
            expectedVersion: resource.version,
            reason: 'review',
          });
          const failed = {
            query: db.query,
            transaction: (/** @type {any} */ work) =>
              withTransaction(pool, (tx) =>
                work({
                  query: async (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ values,
                  ) => {
                    if (sql.includes('INSERT INTO crm.audit_events'))
                      throw new Error('SYNTHETIC_AUDIT_FAILURE');
                    return tx.query(sql, values);
                  },
                }),
              ),
          };
          await assert.rejects(
            adminFor(failed).completeReadRequest({
              ...f.input,
              requestId: request.id,
              matched: true,
              remoteId: '101',
              proof: { matched: true },
            }),
          );
          assert.equal(
            (await admin.readRequest({ ...f.input, requestId: request.id }))
              .status,
            'queued',
          );
          assert.equal(
            (await admin.readResource({ ...f.input, resourceId: resource.id }))
              .state,
            'uncertain',
          );
        },
      );
    } finally {
      await pool.end();
    }
  });
