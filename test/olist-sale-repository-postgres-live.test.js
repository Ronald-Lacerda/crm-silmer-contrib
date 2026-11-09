import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { createOlistRepository } from '../modules/olist/src/repository.js';
import { seal, open } from '../modules/olist/src/crypto.js';
import { createOlistDispatcher } from '../modules/olist/src/dispatcher.js';
import { createOlistResourceResolver } from '../modules/olist/src/resource-resolver.js';
import { createOlistResourceWriter } from '../modules/olist/src/resource-writer.js';
import { createOlistSaleWriter } from '../modules/olist/src/sale-writer.js';
import { captureOlistExistingBuyer } from '../modules/olist/src/existing-buyer.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 81),
  HMAC = Buffer.alloc(32, 82);
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const ATTR = {
  garment: 'Camisa',
  color: 'Azul',
  fabric: '["Algodão"]',
  application: 'Silk',
  collar: 'Polo',
  audience: '',
};
if (!connectionString)
  test(
    'OLIST-T08 sale repository requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T08 final sale reservation, observed IDs and exact-readback completion', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const database = {
      query: pool.query.bind(pool),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    const repoFor = (/** @type {any} */ db = database) =>
      createOlistRepository(db, {
        envelopeKey: KEY,
        hmacKey: HMAC,
        clock: () => NOW,
      });
    const accountKey = hash('synthetic-sale-account'),
      contextKey = hash('synthetic-sale-context');
    /** @param {any} [behavior] @returns {Promise<any>} */
    async function fixture(behavior = {}) {
      await pool.query('TRUNCATE crm.olist_accounts CASCADE');
      const actorId = 't08-sale-' + randomUUID();
      await pool.query(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',true,1)",
        [actorId, actorId + '@example.test'],
      );
      await pool.query(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Financeiro')",
        [actorId],
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
      const orderId = 'sale-order-' + randomUUID(),
        contactId = 'sale-contact-' + randomUUID(),
        groupId = randomUUID();
      await pool.query(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await pool.query("SELECT nextval('crm.order_number_seq') AS n"))
          .rows[0].n,
      );
      await pool.query(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,contact_id,manual_owner_id,manual_create_key) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC','{}'::jsonb,'user',$4,$5,$5,$6,$4,$7)",
        [
          orderId,
          n,
          String(n).padStart(2, '0') + '-CRM',
          actorId,
          NOW,
          contactId,
          randomUUID(),
        ],
      );
      /** @type {any} */ const snapshot = {
        policy: 'exact-cent-v1',
        customer: {
          nome: 'Comprador Privado Sintético',
          cpfCnpj: '52998224725',
          tipoPessoa: 'F',
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
          totalCents: 600,
          groups: [
            {
              groupId,
              attributes: ATTR,
              lines: ['M', 'G'].map((size) => ({
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
      const base = {
        actor: { id: actorId, kind: 'human' },
        authorizationVersion: 1,
        accountKey,
        contextKey,
        connectionGeneration: 3,
        connectionVersion: 2,
        settingsVersion: 4,
        correlationId: 'synthetic-t08-sale',
      };
      await pool.query(
        'UPDATE crm.olist_settings SET settings_envelope=$2::jsonb WHERE account_key=$1',
        [
          accountKey,
          JSON.stringify(
            seal(snapshot.settings, KEY, 'settings', accountKey, 'central'),
          ),
        ],
      );
      let erpBuyer = null;
      if (behavior.existingBuyer) {
        erpBuyer = { id: 101, ...snapshot.customer };
        Object.assign(
          snapshot,
          captureOlistExistingBuyer({
            config: {
              accountKey: behavior.sourceAccountKey ?? accountKey,
              hmacKey: HMAC,
            },
            buyer: { name: erpBuyer.nome, phone: erpBuyer.celular },
            contact: erpBuyer,
          }),
        );
        if (behavior.forgedProof) snapshot.buyerSource.digest = '0'.repeat(64);
        if (behavior.deferredFiscal) {
          snapshot.productFiscal = null;
          snapshot.productFiscalDeferred = true;
        }
      }
      const repo = repoFor();
      const operation = await repo.prepareExport({
        ...base,
        orderId,
        orderVersion: 1,
        snapshot,
      });
      const input = { ...base, exportId: operation.id };
      if (behavior.fresh)
        return {
          repo,
          input,
          resources: null,
          snapshot,
          actorId,
          orderId,
          contactId,
          erpBuyer,
        };
      if (!behavior.existingBuyer) {
        const customer = await repo.bindResource({
          ...input,
          kind: 'customer',
          identity: snapshot.customer.cpfCnpj,
          payload: snapshot.customer,
        });
        await repo.confirmResourceLookup({
          ...input,
          resourceId: customer.id,
          expectedVersion: 0,
          remoteId: '101',
        });
      }
      const parent = await repo.bindResource({
        ...input,
        kind: 'product',
        identity: ATTR,
        payload: {
          attributes: ATTR,
          fiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
        },
      });
      await repo.confirmResourceLookup({
        ...input,
        resourceId: parent.id,
        expectedVersion: 0,
        remoteId: '201',
      });
      const lines = [];
      for (const [i, line] of snapshot.commercial.groups[0].lines.entries()) {
        const child = await repo.bindResource({
          ...input,
          kind: 'variation',
          parentId: parent.id,
          identity: line.size,
          payload: { size: line.size },
        });
        const id = String(301 + i);
        await repo.confirmResourceLookup({
          ...input,
          resourceId: child.id,
          expectedVersion: 0,
          remoteId: id,
        });
        lines.push({ lineId: line.lineId, productId: id });
      }
      const resources = {
        resolved: true,
        customerId: '101',
        groups: [{ groupId, productId: '201', lines }],
      };
      return {
        repo,
        input,
        resources,
        snapshot,
        actorId,
        orderId,
        contactId,
        erpBuyer,
      };
    }
    async function reserved() {
      const f = await fixture();
      await f.repo.markReady({ ...f.input, resources: f.resources });
      const ticket = await f.repo.reserveSaleEffect({
        ...f.input,
        requestPayload: { encoded: '{"private-sale":"synthetic"}' },
      });
      return { ...f, ticket };
    }
    const attemptCount = async (/** @type {string} */ id) =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM crm.olist_attempts WHERE export_id=$1 AND stage='sale'",
            [id],
          )
        ).rows[0].n,
      );
    /** Real dispatcher/writers/repository; only ERP HTTP state is synthetic.
     * @param {any} f @param {any} [behavior] */
    function remoteFor(f, behavior = {}) {
      /** @type {Map<number,any>} */ const contacts = new Map(),
        products = new Map(),
        sales = new Map();
      /** @type {any[]} */ const writes = [];
      /** @type {string[]} */ const reads = [];
      let sequence = 100,
        timeoutSale = Boolean(behavior.timeoutSale),
        failObservation = Boolean(behavior.failObservation);
      if (behavior.existingBuyer)
        contacts.set(
          behavior.existingBuyer.id,
          structuredClone(behavior.existingBuyer),
        );
      const scoped = behavior.failObservation
        ? {
            query: database.query,
            transaction: (/** @type {any} */ work) =>
              withTransaction(pool, (tx) =>
                work({
                  query: (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ values = [],
                  ) => {
                    if (
                      failObservation &&
                      sql.startsWith(
                        'UPDATE crm.olist_exports SET observed_sale_id',
                      )
                    ) {
                      failObservation = false;
                      throw new Error(
                        'synthetic commit failure after sale POST',
                      );
                    }
                    return tx.query(sql, values);
                  },
                }),
              ),
          }
        : database;
      const repository = repoFor(scoped);
      const client = {
        findCustomer: async (/** @type {string} */ document) =>
          structuredClone(
            [...contacts.values()].find((v) => v.cpfCnpj === document) ?? null,
          ),
        contact: async (/** @type {number} */ id) =>
          structuredClone(contacts.get(id) ?? null),
        findProduct: async (/** @type {string} */ sku) =>
          structuredClone(
            [...products.values()].find((v) => v.sku === sku) ?? null,
          ),
        product: async (/** @type {number} */ id) =>
          structuredClone(products.get(id) ?? null),
        findOrder: async (/** @type {string} */ reference) => {
          reads.push('find');
          const found = [...sales.values()].find(
            (v) => v.ecommerce.numeroPedidoEcommerce === reference,
          );
          return found
            ? { id: found.id, numeroPedido: found.numeroPedido }
            : null;
        },
        orderRaw: async (/** @type {number} */ id) => {
          reads.push('detail');
          const body = structuredClone(sales.get(id));
          if (behavior.compensate) {
            body.itens[0].valorUnitario = 1.01;
            body.itens[1].valorUnitario = 0.99;
          }
          return JSON.stringify(body);
        },
      };
      const quota = { reserve: async () => {}, observe: async () => {} };
      const credentials = async () => ({
        token: 'synthetic-dispatch-token',
        version: 2,
      });
      const http = async (/** @type {any} */ url, /** @type {any} */ init) => {
        assert.equal(init.method, 'POST');
        const path = new URL(String(url)).pathname,
          payload = JSON.parse(String(init.body));
        const kind = path.endsWith('/contatos')
          ? 'customer'
          : path.endsWith('/pedidos')
            ? 'sale'
            : path.endsWith('/variacoes')
              ? 'variation'
              : 'product';
        writes.push({ kind, payload, encoded: String(init.body) });
        let id = ++sequence;
        if (kind === 'customer') {
          contacts.set(id, { ...payload, id });
          if (behavior.afterCustomer) await behavior.afterCustomer();
        } else if (kind === 'product') {
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
          if (behavior.afterProduct) await behavior.afterProduct(contacts);
        } else if (kind === 'variation') {
          const parentId = Number(path.split('/').at(-2));
          products.set(id, {
            ...payload,
            id,
            tipo: 'S',
            tipoVariacao: 'V',
            situacao: 'A',
            produtoPai: { id: parentId },
          });
          products.get(parentId).variacoes.push({ ...payload, id });
          id = parentId;
        } else {
          assert.match(String(init.body), /"valorUnitario":1\.00/u);
          sales.set(id, {
            id,
            numeroPedido: id + 1000,
            cliente: {
              id: payload.idContato,
              cpfCnpj:
                contacts.get(payload.idContato)?.cpfCnpj ??
                f.snapshot.customer.cpfCnpj,
            },
            ...payload,
            valorTotalProdutos: 6,
            valorTotalPedido: 6,
          });
          if (timeoutSale) {
            timeoutSale = false;
            throw new Error('synthetic lost sale response');
          }
        }
        return new globalThis.Response(
          JSON.stringify({
            id,
            ...(kind === 'sale' ? { numeroPedido: id + 1000 } : {}),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      };
      const config = { accountKey, contextKey, hmacKey: HMAC };
      const resolver = createOlistResourceResolver({
        repository,
        client,
        writer: createOlistResourceWriter({ credentials, quota, fetch: http }),
        config,
      });
      const dispatcher = createOlistDispatcher({
        repository,
        client,
        resourceResolver: resolver,
        saleWriter: createOlistSaleWriter({ credentials, quota, fetch: http }),
        config,
      });
      return { dispatcher, writes, reads, behavior, repository };
    }
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });
      await t.test(
        'ERP-existing mapping requires account-bound frozen proof and exact ID without any customer resource',
        async () => {
          for (const mode of ['valid', 'forged', 'other-account', 'wrong-id']) {
            const f = await fixture({
              existingBuyer: true,
              sourceAccountKey: mode === 'other-account' ? 'other' : accountKey,
              forgedProof: mode === 'forged',
            });
            if (mode === 'wrong-id') f.resources.customerId = '902';
            if (mode === 'valid') {
              await f.repo.markReady({ ...f.input, resources: f.resources });
              await f.repo.reserveSaleEffect({
                ...f.input,
                requestPayload: { encoded: '{"synthetic":true}' },
              });
              assert.equal(await attemptCount(f.input.exportId), 1);
            } else {
              await assert.rejects(
                f.repo.markReady({ ...f.input, resources: f.resources }),
                {
                  code:
                    mode === 'wrong-id'
                      ? 'OLIST_RESOURCES_UNRESOLVED'
                      : 'OLIST_CUSTOMER_DIVERGENT',
                },
              );
              assert.equal(await attemptCount(f.input.exportId), 0);
            }
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_resources WHERE account_key=$1 AND kind='customer'",
                  [accountKey],
                )
              ).rows[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        'real dispatcher reuses ERP buyer and defers product fiscal without POSTcustomer; changed buyer blocks sale reservation',
        async () => {
          for (const changed of [false, true]) {
            const f = await fixture({
                fresh: true,
                existingBuyer: true,
                deferredFiscal: true,
              }),
              contact = f.erpBuyer;
            const remote = remoteFor(f, {
              existingBuyer: contact,
              ...(changed
                ? {
                    afterProduct: (/** @type {Map<number,any>} */ contacts) => {
                      contacts.get(101).situacao = 'I';
                    },
                  }
                : {}),
            });
            const result = await remote.dispatcher.dispatch(f.input);
            assert.deepEqual(
              remote.writes.map((row) => row.kind),
              changed ? ['product'] : ['product', 'sale'],
            );
            assert.equal(await attemptCount(f.input.exportId), changed ? 0 : 1);
            assert.ok(
              remote.writes
                .filter((row) => row.kind === 'product')
                .every(
                  (row) =>
                    !Object.hasOwn(row.payload, 'ncm') &&
                    !Object.hasOwn(row.payload, 'origem') &&
                    !Object.hasOwn(row.payload, 'unidade'),
                ),
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM crm.olist_resources WHERE account_key=$1 AND kind='customer'",
                  [accountKey],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(result.outcome, changed ? 'outcome_unknown' : 'sent');
            if (changed)
              assert.equal(result.errorCode, 'OLIST_CUSTOMER_DIVERGENT');
          }
        },
      );
      await t.test(
        'ready validates every customer, parent and size mapping by identity and freezes it once',
        async () => {
          const f = await fixture();
          for (const change of [
            (/** @type {any} */ r) => (r.customerId = '999'),
            (/** @type {any} */ r) => r.groups[0].lines.pop(),
            (/** @type {any} */ r) => (r.groups[0].lines[0].productId = '201'),
            (/** @type {any} */ r) =>
              (r.groups[0].lines[0].lineId = randomUUID()),
          ]) {
            const wrong = structuredClone(f.resources);
            change(wrong);
            await assert.rejects(
              f.repo.markReady({ ...f.input, resources: wrong }),
              { code: 'OLIST_RESOURCES_UNRESOLVED' },
            );
          }
          const row = await f.repo.markReady({
            ...f.input,
            resources: f.resources,
          });
          assert.equal(row.state, 'ready');
          assert.equal(row.stage, 'sale');
          assert.deepEqual(
            open(
              row.resource_mapping_envelope,
              KEY,
              'sale-resources',
              accountKey,
              row.id,
            ),
            f.resources,
          );
          const again = await f.repo.markReady({
            ...f.input,
            resources: f.resources,
          });
          assert.equal(again.version, row.version);
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_exports SET resource_mapping_hash=$2 WHERE id=$1',
              [row.id, 'a'.repeat(64)],
            ),
          );
          assert.equal(await attemptCount(row.id), 0);
        },
      );
      await t.test(
        'stage is monotonic and stop classifications contain only fixed safe codes',
        async () => {
          const f = await fixture();
          const first = await f.repo.updateStage({
            ...f.input,
            stage: 'product',
            state: 'resolving',
          });
          assert.equal(first.stage, 'product');
          const old = await f.repo.updateStage({
            ...f.input,
            stage: 'customer',
          });
          assert.equal(old.stage, 'product');
          assert.equal(old.version, first.version);
          const stopped = await f.repo.recordDispatchStop({
            ...f.input,
            code: 'PRIVATE buyer@example.test',
          });
          assert.equal(stopped.last_error_code, 'OLIST_DISPATCH_STOPPED');
          const advanced = await f.repo.updateStage({
            ...f.input,
            stage: 'variation',
          });
          assert.equal(advanced.last_error_code, null);
        },
      );
      await t.test(
        'two independent workers reserve one immutable sale effect and never recycle its ticket',
        async () => {
          const f = await fixture();
          await f.repo.markReady({ ...f.input, resources: f.resources });
          const settled = await Promise.allSettled([
            f.repo.reserveSaleEffect({
              ...f.input,
              requestPayload: { encoded: '{"itens":[]}' },
            }),
            repoFor().reserveSaleEffect({
              ...f.input,
              requestPayload: { encoded: '{"itens":[]}' },
            }),
          ]);
          assert.equal(
            settled.filter((/** @type {any} */ r) => r.status === 'fulfilled')
              .length,
            1,
          );
          assert.equal(await attemptCount(f.input.exportId), 1);
          const ticket = /** @type {PromiseFulfilledResult<any>} */ (
            settled.find((/** @type {any} */ r) => r.status === 'fulfilled')
          ).value;
          const context = await f.repo.loadDispatchContext(f.input);
          assert.equal(context.state, 'reserved');
          assert.deepEqual(context.saleAttempt.requestPayload, {
            encoded: '{"itens":[]}',
          });
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_attempts SET request_hash=$2 WHERE id=$1',
              [ticket.attemptId, 'f'.repeat(64)],
            ),
          );
          await f.repo.markSaleUncertain({ ...f.input, ...ticket });
          await assert.rejects(
            f.repo.reserveSaleEffect({
              ...f.input,
              requestPayload: { encoded: '{}' },
            }),
          );
          assert.equal(await attemptCount(f.input.exportId), 1);
        },
      );
      await t.test(
        'observed IDs survive revocation and exact positive result completes without changing CRM',
        async () => {
          const f = await reserved();
          await f.repo.persistSaleObservedId({
            ...f.input,
            ...f.ticket,
            remoteId: '701',
            remoteNumber: '987',
          });
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
            [f.actorId],
          );
          await assert.rejects(f.repo.validateDispatch(f.input), {
            code: 'FORBIDDEN',
          });
          await f.repo.finishSale({
            ...f.input,
            ...f.ticket,
            matched: true,
            remoteId: '701',
            number: '987',
            proof: { matched: true, lineCount: 2, totalCents: 600 },
          });
          const context = await f.repo.loadDispatchContext(f.input);
          assert.equal(context.state, 'confirmed');
          assert.equal(context.stage, 'complete');
          assert.equal(context.remote_id, '701');
          assert.equal(context.remote_number, '987');
          assert.equal(context.saleAttempt.outcome, 'confirmed');
          const order = (
            await pool.query(
              'SELECT status,version,order_date,paid_on FROM crm.orders WHERE id=$1',
              [f.orderId],
            )
          ).rows[0];
          assert.deepEqual(order, {
            status: 'pendente',
            version: 1,
            order_date: null,
            paid_on: null,
          });
          await assert.rejects(
            f.repo.persistSaleObservedId({
              ...f.input,
              ...f.ticket,
              remoteId: '702',
            }),
            { code: 'OLIST_SALE_DIVERGENT' },
          );
          const replay = await f.repo.finishSale({
            ...f.input,
            ...f.ticket,
            matched: true,
            remoteId: '701',
            number: '987',
          });
          assert.equal(replay.replayed, true);
        },
      );
      await t.test(
        'uncertain outcome preserves history and accepts only later positive readback with observed ID',
        async () => {
          const f = await reserved();
          await f.repo.markSaleUncertain({ ...f.input, ...f.ticket });
          await f.repo.persistSaleObservedId({
            ...f.input,
            ...f.ticket,
            remoteId: '702',
            remoteNumber: '988',
          });
          let context = await f.repo.loadDispatchContext(f.input);
          assert.equal(context.saleAttempt.outcome, 'uncertain');
          assert.equal(context.saleAttempt.observedRemoteId, '702');
          await assert.rejects(
            f.repo.finishSale({
              ...f.input,
              ...f.ticket,
              matched: false,
              remoteId: '702',
              number: '988',
            }),
          );
          await assert.rejects(
            f.repo.finishSale({
              ...f.input,
              ...f.ticket,
              matched: true,
              remoteId: '702',
              number: '988',
              proof: { matched: true, lineCount: 2, totalCents: 601 },
            }),
            { code: 'OLIST_SALE_DIVERGENT' },
          );
          await f.repo.finishSale({
            ...f.input,
            ...f.ticket,
            matched: true,
            remoteId: '702',
            number: '988',
            proof: { matched: true, lineCount: 2, totalCents: 600 },
          });
          context = await f.repo.loadDispatchContext(f.input);
          assert.equal(context.state, 'confirmed');
          assert.equal(context.saleAttempt.outcome, 'uncertain');
          assert.equal(context.observed_sale_id, '702');
          await assert.rejects(
            pool.query(
              'UPDATE crm.olist_attempts SET observed_remote_id=$2 WHERE id=$1',
              [f.ticket.attemptId, '702'],
            ),
          );
        },
      );
      await t.test(
        'source, current settings, connection and recovery gates stop reservation before HTTP',
        async () => {
          for (const mutate of [
            async (/** @type {any} */ f) =>
              pool.query(
                'UPDATE crm.contacts SET version=version+1 WHERE id=$1',
                [f.contactId],
              ),
            async () =>
              pool.query(
                'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                [accountKey],
              ),
            async () =>
              pool.query(
                'UPDATE crm.olist_connections SET generation=generation+1 WHERE context_key=$1',
                [contextKey],
              ),
            async () =>
              pool.query(
                'UPDATE crm.olist_accounts SET recovery_required=true WHERE account_key=$1',
                [accountKey],
              ),
          ]) {
            const f = await fixture();
            await f.repo.markReady({ ...f.input, resources: f.resources });
            await mutate(f);
            await assert.rejects(
              f.repo.reserveSaleEffect({
                ...f.input,
                requestPayload: { encoded: '{}' },
              }),
            );
            assert.equal(await attemptCount(f.input.exportId), 0);
          }
        },
      );
      await t.test(
        'audit persistence failure rolls back reservation and confirmation while retaining prior observations',
        async () => {
          const f = await fixture();
          await f.repo.markReady({ ...f.input, resources: f.resources });
          const failed = {
            query: database.query,
            transaction: (/** @type {any} */ work) =>
              withTransaction(pool, (tx) =>
                work({
                  query: (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ values = [],
                  ) => {
                    if (sql.includes('INSERT INTO crm.audit_events'))
                      throw new Error('synthetic audit failure');
                    return tx.query(sql, values);
                  },
                }),
              ),
          };
          await assert.rejects(
            repoFor(failed).reserveSaleEffect({
              ...f.input,
              requestPayload: { encoded: '{}' },
            }),
          );
          assert.equal(await attemptCount(f.input.exportId), 0);
          const ticket = await f.repo.reserveSaleEffect({
            ...f.input,
            requestPayload: { encoded: '{}' },
          });
          await f.repo.persistSaleObservedId({
            ...f.input,
            ...ticket,
            remoteId: '703',
          });
          await assert.rejects(
            repoFor(failed).finishSale({
              ...f.input,
              ...ticket,
              matched: true,
              remoteId: '703',
              number: '989',
              proof: { matched: true, lineCount: 2, totalCents: 600 },
            }),
          );
          const context = await f.repo.loadDispatchContext(f.input);
          assert.equal(context.state, 'reserved');
          assert.equal(context.saleAttempt.observedRemoteId, '703');
          assert.equal(context.saleAttempt.outcome, 'reserved');
        },
      );
      await t.test(
        'real dispatcher creates all resources and one sale, then replays without another POST',
        async () => {
          const f = await fixture({ fresh: true }),
            remote = remoteFor(f);
          const result = await remote.dispatcher.dispatch({
            exportId: f.input.exportId,
          });
          assert.equal(result.outcome, 'sent', JSON.stringify(result));
          assert.deepEqual(
            remote.writes.map((w) => w.kind),
            ['customer', 'product', 'sale'],
          );
          const saved = await f.repo.loadDispatchContext(f.input);
          assert.equal(saved.state, 'confirmed');
          assert.equal(saved.stage, 'complete');
          assert.equal(saved.saleAttempt.outcome, 'confirmed');
          assert.ok(saved.resourceMapping);
          assert.equal(
            (await remote.dispatcher.dispatch({ exportId: f.input.exportId }))
              .outcome,
            'sent',
          );
          assert.equal(remote.writes.length, 3);
        },
      );
      await t.test(
        'compensating wrong line prices cannot pass equal global totals and no second sale is sent',
        async () => {
          const f = await fixture({ fresh: true }),
            remote = remoteFor(f, { compensate: true });
          const first = await remote.dispatcher.dispatch({
            exportId: f.input.exportId,
          });
          assert.equal(first.outcome, 'outcome_unknown');
          let saved = await f.repo.loadDispatchContext(f.input);
          assert.equal(saved.state, 'uncertain');
          assert.ok(saved.saleAttempt.observedRemoteId);
          assert.equal(saved.remote_id, null);
          await remote.dispatcher.dispatch({ exportId: f.input.exportId });
          assert.equal(
            remote.writes.filter((w) => w.kind === 'sale').length,
            1,
          );
          remote.behavior.compensate = false;
          assert.equal(
            (await remote.dispatcher.dispatch({ exportId: f.input.exportId }))
              .outcome,
            'sent',
          );
          saved = await f.repo.loadDispatchContext(f.input);
          assert.equal(saved.saleAttempt.outcome, 'uncertain');
          assert.equal(saved.state, 'confirmed');
        },
      );
      await t.test(
        'lost POST response and failed observation commit recover by reference/GET without duplicate creation',
        async () => {
          for (const behavior of [
            { timeoutSale: true },
            { failObservation: true },
          ]) {
            const f = await fixture({ fresh: true }),
              remote = remoteFor(f, behavior);
            const first = await remote.dispatcher.dispatch({
              exportId: f.input.exportId,
            });
            assert.equal(first.outcome, 'outcome_unknown');
            assert.equal(remote.reads.filter((r) => r === 'detail').length, 0);
            assert.equal(
              (await remote.dispatcher.dispatch({ exportId: f.input.exportId }))
                .outcome,
              'sent',
            );
            assert.equal(
              remote.writes.filter((w) => w.kind === 'sale').length,
              1,
            );
            assert.equal(
              remote.writes.filter((w) => w.kind === 'customer').length,
              1,
            );
          }
        },
      );
      await t.test(
        'competing real dispatchers and expired delivery retries cannot create a second sale',
        async () => {
          const f = await fixture({ fresh: true }),
            remote = remoteFor(f);
          const results = await Promise.all([
            remote.dispatcher.dispatch({ exportId: f.input.exportId }),
            remote.dispatcher.dispatch({ exportId: f.input.exportId }),
          ]);
          assert.ok(
            results.some((r) => r.outcome === 'sent'),
            JSON.stringify(results),
          );
          assert.equal(
            remote.writes.filter((w) => w.kind === 'sale').length,
            1,
          );
          assert.equal(
            (await remote.dispatcher.dispatch({ exportId: f.input.exportId }))
              .outcome,
            'sent',
          );
          assert.equal(await attemptCount(f.input.exportId), 1);
        },
      );
      await t.test(
        'revocation or settings change after customer POST preserves that entity and prevents dependent POSTs',
        async () => {
          for (const setting of [false, true]) {
            const f = await fixture({ fresh: true });
            const remote = remoteFor(f, {
              afterCustomer: async () =>
                setting
                  ? pool.query(
                      'UPDATE crm.olist_settings SET version=version+1 WHERE account_key=$1',
                      [accountKey],
                    )
                  : pool.query(
                      'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
                      [f.actorId],
                    ),
            });
            const result = await remote.dispatcher.dispatch({
              exportId: f.input.exportId,
            });
            assert.notEqual(result.outcome, 'sent');
            assert.deepEqual(
              remote.writes.map((w) => w.kind),
              ['customer'],
            );
            const resources = (
              await pool.query(
                "SELECT state,remote_id FROM crm.olist_resources WHERE account_key=$1 AND kind='customer'",
                [accountKey],
              )
            ).rows;
            assert.equal(resources[0].state, 'confirmed');
            assert.ok(resources[0].remote_id);
            const saved = await f.repo.loadDispatchContext(f.input);
            assert.ok(saved.last_error_code);
            assert.equal(saved.saleAttempt, null);
          }
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
