// OLIST-T15: synthetic rehearsal of stage failures and of a database restore.
// Adapted from the existing uncommitted T15 rehearsal in the olist-liveness checkout;
// the source file is preserved. T17 adds the private synthetic pilot allowlist.
//
// Real PostgreSQL 17 (dedicated databases), 100 % synthetic data, creation
// switched off in every environment but this one, NO real network: the ERP is a
// fake `fetch` living in this process that counts every GET and POST. The real
// worker (queue, lease, handler), dispatcher, resolver, writers, repository
// and administrative repository run unchanged against it.
//
// WHAT THIS PROVES (RFC 050 OLIST-16, 17, 27, 28, 29, 48; ADR 069)
//   T15-REH-1..7  per-stage failures never produce a second POST, and every
//                 uncertain effect is reconciled by READS only;
//   T15-REH-8     retention: attempts, snapshots and envelopes cannot be purged
//                 (finding M3 of T14; no purge path exists, none is built here);
//   T15-REH-R1..4 the restore. The restore has NO technical interlock (accepted
//                 risk A4 of T14): the flags live in the restored database. R1
//                 documents what is missing, R2..R4 prove the procedural
//                 interlock below.
//
// WHAT THIS DOES NOT PROVE
//   * A local database is not EasyPanel, and a fake `fetch` is not RustFS nor
//     the Olist ERP: no real ERP behaviour, quota, indexing delay, OAuth
//     rotation or credential is exercised. The "search lag" of R1b is a
//     modelled premise ("zero in a search does not prove absence"), not an
//     observation.
//   * The backup mechanism below is NOT a production backup: it proves neither
//     the EasyPanel backup procedure, retention, encryption of the backup, RPO
//     nor RTO. A TEMPLATE snapshot is not a logical/physical backup.
//   * An OAuth refresh token rotated after the backup is stale in the restored
//     database (the connection would need a reconnect); not modelled.
//
// BACKUP / RESTORE MECHANISM (printed as a test diagnostic on every run)
//   * default (and ALWAYS in CI, whose runner has no pg_dump/pg_restore):
//     `CREATE DATABASE <backup> TEMPLATE <live>` after every pool is closed,
//     restore = drop the live database and `CREATE DATABASE <live> TEMPLATE
//     <backup>`.
//   * `OLIST_REHEARSAL_PG_BIN=<dir with pg_dump and pg_restore>`: `pg_dump -Fc`
//     into a temporary file and `pg_restore` into a recreated database.
//   Only databases named `crm_silmer_test*` are touched.
//
// RESTORE PROCEDURE UNDER REHEARSAL (the script of the runbook, in this order;
// `restoreProcedure()` below executes exactly these steps):
//   1. Keep every consumer off: no worker with OLIST_DISPATCH_ENABLED=true and
//      no reconciliation worker is started before step 4 is complete.
//   2. In the restored database: `creation_enabled=false` and
//      `recovery_required=true` on the account (SQL: there is no command).
//   3. Retire the leases of the Olist queues (`outbox_jobs.locked_until`) so the
//      first poll classifies the in-flight jobs (effect started => outcome
//      unknown, never redelivered) (SQL: there is no command).
//   4. Expire every outstanding preview by re-saving the Olist settings through
//      the administrative command (settings version + 1; a preview carries the
//      settings version and the export command rejects a stale one).
//   5. Reconcile the window by READS ONLY: "Conferir" (/reconcile) for every
//      reserved or uncertain effect and "Vincular venda existente" for a sale
//      found in the ERP without a local ticket. Nothing is POSTed.
//   6. Check that nothing is left unreconciled (`assertWindowReconciled()`).
//   7. Only then switch creation on again (SQL: there is no command) and let
//      new exports flow.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import { PostgresJobQueue } from '../modules/integration-reliability/src/postgres-job-queue.js';
import { createSafeLogger } from '../modules/shared/src/index.js';
import { createOlistAdminRepository } from '../modules/olist/src/admin-repository.js';
import { createOlistClient } from '../modules/olist/src/client.js';
import { createOlistConnection } from '../modules/olist/src/connection.js';
import { createOlistReadonlyInspector } from '../modules/olist/src/readonly-inspector.js';
import { createOlistRepository } from '../modules/olist/src/repository.js';
import { olistConfiguration } from '../modules/olist/src/configuration.js';
import { seal } from '../modules/olist/src/crypto.js';
import { encryptJson } from '../modules/orders/src/adapters/envelope.js';
import {
  createOlistReconciliationWorkerRuntime,
  createOlistWorkerRuntime,
} from '../apps/worker/src/worker.js';

const baseUrl = process.env.TEST_DATABASE_URL;
const pgBin = process.env.OLIST_REHEARSAL_PG_BIN;
const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = Buffer.alloc(32, 151),
  HMAC = Buffer.alloc(32, 152);
const API = 'https://api.tiny.com.br/public-api/v3';
const TOKEN_URL =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const LIVE = 'crm_silmer_test_t15_live';
const BACKUP = 'crm_silmer_test_t15_backup';
const DOCUMENT = '52998224725';
const ATTR_BLUE = {
  garment: 'camisa',
  color: 'azul',
  fabric: '["algodão"]',
  application: 'silk',
  collar: 'polo',
  audience: '',
};
const ATTR_GREEN = { ...ATTR_BLUE, color: 'verde' };
const ENV_ON = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_DISPATCH_ENABLED: 'true',
  OLIST_PILOT_USER_IDS: '',
  OLIST_CLIENT_ID: 'synthetic-rehearsal',
  OLIST_CLIENT_SECRET: 'synthetic-rehearsal-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: KEY.toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: HMAC.toString('base64'),
};
const ENV_OFF = { ...ENV_ON, OLIST_DISPATCH_ENABLED: 'false' };
const { accountKey, contextKey } = olistConfiguration(ENV_ON);
const SETTINGS = Object.freeze({
  sellerId: 11,
  operationNatureId: 12,
  warehouseId: 13,
  paymentMethodId: 14,
  priceListId: null,
  originId: 15,
  paymentTerms: 'À vista',
  purchaseOrder: null,
  productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
  paymentDueOn: '2026-11-06',
  receivingMethodId: null,
});
const { productFiscal: _fiscal, ...saleSettings } = SETTINGS;
void _fiscal; // Product fiscal policy is separate from the sale settings snapshot.
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const logger = createSafeLogger({
  service: 'crm-silmer-worker',
  sink: () => {},
});
function deferred() {
  /** @type {()=>void} */ let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}
/** @param {any} body @param {number} [status] @param {string} [type] */
const json = (body, status = 200, type = 'application/json') =>
  new globalThis.Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': type } },
  );
/** @param {string} value */
const digits = (value) => String(value).replace(/[.\-/\s]/gu, '');

/** The ERP: an in-process fake of the official API. It keeps every entity,
 * counts every request and can script one outcome per POST: `ok` (default),
 * `lost` (created, answer lost), `5xx` (created, 502), `noid` (created, 200
 * without id), `badbody` (created, 200 that is not JSON), `hang` (the process
 * "dies" holding the request: nothing is created until `completeInFlight`).
 * `searchLag` hides entities created inside the restore window from the
 * list/search endpoints only (a GET by id still finds them): the premise
 * "zero in a search does not prove absence" made executable.
 * @param {any} [seed] */
function createFakeErp(seed) {
  /** @type {any} */
  const state = seed
    ? structuredClone(seed)
    : { seq: 5000, contacts: [], products: [], orders: [], window: false };
  const posts = { customer: 0, product: 0, variation: 0, sale: 0 };
  let gets = 0;
  /** @type {Record<string, string[]>} */
  const script = { customer: [], product: [], variation: [], sale: [] };
  /** @type {Record<string, (()=>Promise<void>|void)|null>} */
  const after = { customer: null, product: null, variation: null, sale: null };
  /** @type {Array<(request:any)=>('network'|'quota'|undefined)>} */
  const interceptors = [];
  const hung = deferred();
  /** @type {any} */ let inFlight = null;
  let searchLag = false;
  /** @type {any[]} */ const log = [];
  const nextId = () => ++state.seq;
  /** @param {any} entity */
  const visible = (entity) => !(searchLag && entity.late);
  /** @param {any[]} items @param {URLSearchParams} query */
  const page = (items, query) => {
    const offset = Number(query.get('offset') ?? 0);
    return json({
      itens: items.slice(offset, offset + 50),
      paginacao: { offset, limit: 50, total: items.length },
    });
  };
  /** @param {string} kind @param {string} text @param {any} [extra] */
  function create(kind, text, extra) {
    const body = JSON.parse(text);
    if (kind === 'customer') {
      const id = nextId();
      state.contacts.push({ ...body, id, late: state.window });
      return id;
    }
    if (kind === 'product') {
      const id = nextId();
      state.products.push({
        id,
        kind: 'parent',
        tipo: 'V',
        situacao: 'A',
        sku: body.sku,
        descricao: body.descricao,
        ncm: body.ncm,
        origem: body.origem,
        unidade: body.unidade,
        late: state.window,
      });
      for (const variation of body.variacoes)
        state.products.push({
          id: nextId(),
          kind: 'child',
          parentId: id,
          sku: variation.sku,
          grade: variation.grade,
          tipo: 'V',
          situacao: 'A',
          late: state.window,
        });
      return id;
    }
    if (kind === 'variation') {
      state.products.push({
        id: nextId(),
        kind: 'child',
        parentId: extra.parentId,
        sku: body.sku,
        grade: body.grade,
        tipo: 'V',
        situacao: 'A',
        late: state.window,
      });
      return extra.parentId;
    }
    const id = nextId();
    const units = [
      ...text.matchAll(/"valorUnitario":([0-9]+\.[0-9]{2})/gu),
    ].map((match) => match[1]);
    const total = /"valor":([0-9]+\.[0-9]{2})/u.exec(text)?.[1] ?? '0.00';
    const contact = state.contacts.find(
      (/** @type {any} */ value) => value.id === body.idContato,
    );
    const items = body.itens
      .map(
        (/** @type {any} */ item, /** @type {number} */ i) =>
          `{"produto":{"id":${item.produto.id}},"quantidade":${item.quantidade},"valorUnitario":${units[i]},"infoAdicional":${JSON.stringify(item.infoAdicional)}}`,
      )
      .join(',');
    state.orders.push({
      id,
      reference: body.ecommerce.numeroPedidoEcommerce,
      late: state.window,
      raw: `{"id":${id},"numeroPedido":${id},"situacao":0,"data":"${body.data}","dataPrevista":"${body.dataPrevista}","cliente":{"id":${body.idContato},"cpfCnpj":"${contact?.cpfCnpj ?? ''}"},"ecommerce":{"id":${body.ecommerce.id},"numeroPedidoEcommerce":"${body.ecommerce.numeroPedidoEcommerce}"},"vendedor":{"id":${body.vendedor.id}},"naturezaOperacao":{"id":${body.naturezaOperacao.id}},"deposito":{"id":${body.deposito.id}},"pagamento":{"meioPagamento":{"id":${body.pagamento.meioPagamento.id}},"parcelas":[{"data":"${body.pagamento.parcelas[0].data}","valor":${total}}]},"itens":[${items}],"valorTotalProdutos":${total},"valorTotalPedido":${total}}`,
    });
    return id;
  }
  /** @param {string} kind @param {string} text @param {any} [extra] */
  async function post(kind, text, extra) {
    const action = script[kind].shift() ?? 'ok';
    if (action === 'hang') {
      inFlight = { kind, text, extra };
      hung.resolve();
      return new Promise(() => {});
    }
    posts[/** @type {'customer'} */ (kind)] += 1;
    const id = create(kind, text, extra);
    log.push({ kind, id });
    await after[kind]?.();
    if (action === 'lost') throw new TypeError('synthetic socket hang up');
    if (action === '5xx') return json({ error: 'upstream' }, 502);
    if (action === 'noid') return json({}, 200);
    if (action === 'badbody') return json('not json at all', 200, 'text/plain');
    return json({ id }, 201);
  }
  /** @param {any} url @param {any} init */
  async function fetch(url, init) {
    const method = init?.method ?? 'GET';
    const text = String(url);
    if (text === TOKEN_URL)
      return json({
        access_token: 'synthetic-access-' + nextId(),
        refresh_token: 'synthetic-refresh-' + nextId(),
        expires_in: 3600,
      });
    assert.ok(text.startsWith(API + '/'), 'unexpected host ' + text);
    const parsed = new URL(text);
    const path = parsed.pathname.slice('/public-api/v3'.length);
    const query = parsed.searchParams;
    for (const interceptor of interceptors) {
      const fault = interceptor({ method, path });
      if (fault === 'network') throw new TypeError('synthetic network down');
    }
    if (method === 'POST') {
      const body = String(init.body);
      if (path === '/contatos') return post('customer', body);
      if (path === '/produtos') return post('product', body);
      if (path === '/pedidos') return post('sale', body);
      const variation = /^\/produtos\/(\d+)\/variacoes$/u.exec(path);
      if (variation)
        return post('variation', body, { parentId: Number(variation[1]) });
      throw new Error('unexpected POST ' + path);
    }
    gets += 1;
    if (path === '/info') return json({ cpfCnpj: '12345678000199' });
    if (path === '/contatos')
      return page(
        state.contacts.filter(
          (/** @type {any} */ contact) =>
            visible(contact) &&
            digits(contact.cpfCnpj) === digits(query.get('cpfCnpj') ?? '') &&
            (query.get('situacao') ?? 'B') === contact.situacao,
        ),
        query,
      );
    const contact = /^\/contatos\/(\d+)$/u.exec(path);
    if (contact) {
      const found = state.contacts.find(
        (/** @type {any} */ value) => value.id === Number(contact[1]),
      );
      return found ? json(found) : json({}, 404);
    }
    if (path === '/produtos')
      return page(
        state.products.filter(
          (/** @type {any} */ product) =>
            visible(product) &&
            product.sku === query.get('codigo') &&
            product.situacao === query.get('situacao'),
        ),
        query,
      );
    const product = /^\/produtos\/(\d+)$/u.exec(path);
    if (product) {
      const found = state.products.find(
        (/** @type {any} */ value) => value.id === Number(product[1]),
      );
      if (!found) return json({}, 404);
      if (found.kind === 'child')
        return json({
          id: found.id,
          sku: found.sku,
          tipo: 'V',
          situacao: 'A',
          tipoVariacao: 'V',
          produtoPai: { id: found.parentId },
        });
      return json({
        ...found,
        grade: ['Tamanho'],
        variacoes: state.products
          .filter(
            (/** @type {any} */ child) =>
              child.kind === 'child' && child.parentId === found.id,
          )
          .map((/** @type {any} */ child) => ({
            id: child.id,
            sku: child.sku,
            grade: child.grade,
          })),
      });
    }
    if (path === '/pedidos')
      return page(
        state.orders
          .filter(
            (/** @type {any} */ order) =>
              visible(order) &&
              order.reference === query.get('numeroPedidoEcommerce'),
          )
          .map((/** @type {any} */ order) => ({ id: order.id })),
        query,
      );
    const order = /^\/pedidos\/(\d+)$/u.exec(path);
    if (order) {
      const found = state.orders.find(
        (/** @type {any} */ value) => value.id === Number(order[1]),
      );
      return found ? json(found.raw) : json({}, 404);
    }
    throw new Error('unexpected GET ' + path);
  }
  const identityCounts = () => {
    /** @param {string[]} values */
    const dup = (values) =>
      values.length - new Set(values.filter(Boolean)).size;
    return {
      customers: dup(state.contacts.map((/** @type {any} */ c) => c.cpfCnpj)),
      products: dup(
        state.products
          .filter((/** @type {any} */ p) => p.kind === 'parent')
          .map((/** @type {any} */ p) => p.sku),
      ),
      sales: dup(state.orders.map((/** @type {any} */ o) => o.reference)),
    };
  };
  return {
    fetch,
    posts,
    script,
    after,
    interceptors,
    hung: hung.promise,
    get gets() {
      return gets;
    },
    get log() {
      return log;
    },
    get state() {
      return state;
    },
    /** Entities in the ERP, by kind. */
    get entities() {
      return {
        customers: state.contacts.length,
        parents: state.products.filter(
          (/** @type {any} */ p) => p.kind === 'parent',
        ).length,
        children: state.products.filter(
          (/** @type {any} */ p) => p.kind === 'child',
        ).length,
        sales: state.orders.length,
      };
    },
    totalPosts: () =>
      posts.customer + posts.product + posts.variation + posts.sale,
    /** Duplicates by identity (document, SKU, e-commerce reference). */
    duplicates: identityCounts,
    /** @param {boolean} on */
    setSearchLag(on) {
      searchLag = on;
    },
    /** Entities created from now on are "inside the window". */
    openWindow() {
      state.window = true;
    },
    snapshot: () => structuredClone(state),
    /** The POST that was in flight when the process died reaches the ERP. */
    completeInFlight() {
      assert.ok(inFlight, 'no request in flight');
      posts[/** @type {'customer'} */ (inFlight.kind)] += 1;
      const id = create(inFlight.kind, inFlight.text, inFlight.extra);
      inFlight = null;
      return id;
    },
  };
}

if (!baseUrl)
  test(
    'OLIST-T15 recovery rehearsal requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
else
  test('OLIST-T15 synthetic rehearsal of stage failures and restore', async (t) => {
    const baseName = new URL(baseUrl).pathname.slice(1);
    assert.match(baseName, /^crm_silmer_test/u);
    /** @param {string} name */
    const urlFor = (name) => {
      const url = new URL(baseUrl);
      url.pathname = '/' + name;
      return url.href;
    };
    const mechanism = pgBin
      ? 'pg_dump -Fc + pg_restore (' + pgBin + ')'
      : 'CREATE DATABASE ... TEMPLATE (logical snapshot, NOT a production backup)';
    t.diagnostic('T15 backup/restore mechanism: ' + mechanism);

    /** @param {(client:Client)=>Promise<any>} work */
    async function asServer(work) {
      const client = new Client({ connectionString: urlFor('postgres') });
      await client.connect();
      try {
        return await work(client);
      } finally {
        await client.end();
      }
    }
    /** @type {Pool} */ let pool = /** @type {any} */ (null);
    const openPool = () =>
      new Pool({
        connectionString: urlFor(LIVE),
        max: 10,
        options: '-c statement_timeout=20000 -c lock_timeout=12000',
      });
    const db = {
      query: (/** @type {any[]} */ ...args) =>
        /** @type {any} */ (pool.query)(...args),
      transaction: (/** @type {any} */ work) => withTransaction(pool, work),
    };
    /** Persistence outage after a POST: the worker's repository fails while the
     * queue (a separate handle) keeps working, as a database blip would. */
    const fault = { armed: false };
    const faultyDb = {
      query: (/** @type {any[]} */ ...args) =>
        fault.armed
          ? Promise.reject(new Error('synthetic database outage'))
          : /** @type {any} */ (pool.query)(...args),
      transaction: (/** @type {any} */ work) =>
        fault.armed
          ? Promise.reject(new Error('synthetic database outage'))
          : withTransaction(pool, work),
    };
    const q = (/** @type {string} */ sql, /** @type {any[]} */ params = []) =>
      pool.query(sql, params);
    const one = async (
      /** @type {string} */ sql,
      /** @type {any[]} */ params = [],
    ) => (await pool.query(sql, params)).rows[0];
    const count = async (
      /** @type {string} */ table,
      /** @type {string} */ where = 'true',
      /** @type {any[]} */ params = [],
    ) =>
      Number(
        (
          await pool.query(
            'SELECT count(*)::integer n FROM crm.' + table + ' WHERE ' + where,
            params,
          )
        ).rows[0].n,
      );

    // ---- clock shared by every simulated process --------------------------
    const clock = { ms: Date.now() };
    const advance = (/** @type {number} */ ms) => {
      clock.ms += ms;
    };
    /** Quota: the harness refills the shared window after every ERP request so
     * no test waits a real minute. `squeeze` leaves exactly one unit, so reads
     * pass while any write (which needs headroom for its readbacks) starves. */
    const quota = { mode: /** @type {'refill'|'squeeze'} */ ('refill') };
    /** @param {ReturnType<typeof createFakeErp>} erp */
    const networkFor = (erp) => {
      return async (/** @type {any} */ url, /** @type {any} */ init) => {
        try {
          return await erp.fetch(url, init);
        } finally {
          await pool
            .query(
              'UPDATE crm.olist_quotas SET used=$1,remaining=NULL,blocked_until=NULL,window_started_at=now()',
              [quota.mode === 'squeeze' ? 29 : 0],
            )
            .catch(() => {});
        }
      };
    };
    /** One simulated process: the real worker composition over the fake ERP.
     * @param {{name:string,erp:ReturnType<typeof createFakeErp>,environment?:any,faulty?:boolean}} input */
    function worker({ name, erp, environment = ENV_ON, faulty = false }) {
      return createOlistWorkerRuntime({
        database: faulty ? faultyDb : db,
        environment,
        fetch: networkFor(erp),
        clock: () => NOW,
        now: () => clock.ms,
        workerId: name,
        logger,
        queue: new PostgresJobQueue({
          database: db,
          retryBaseMs: 15_000,
          retryMaxMs: 300_000,
        }),
      });
    }
    /** @param {{name:string,erp:ReturnType<typeof createFakeErp>}} input */
    function reconciler({ name, erp }) {
      return createOlistReconciliationWorkerRuntime({
        database: db,
        environment: ENV_ON,
        fetch: networkFor(erp),
        clock: () => NOW,
        now: () => clock.ms,
        workerId: name,
        logger,
      });
    }
    /** Run the worker until its queue is empty (bounded).
     * @param {any} runtime */
    async function drain(runtime) {
      let jobs = 0;
      for (let i = 0; i < 6; i++) {
        const n = await runtime.runOnce();
        if (!n) break;
        jobs += n;
      }
      return jobs;
    }

    // ---- database lifecycle ------------------------------------------------
    async function createLive() {
      if (pool) await pool.end().catch(() => {});
      await asServer(async (client) => {
        await client.query('DROP DATABASE IF EXISTS ' + LIVE + ' WITH (FORCE)');
        await client.query('CREATE DATABASE ' + LIVE);
      });
      pool = openPool();
      await migrate(pool, { migrations: await loadMigrations() });
    }
    async function takeBackup() {
      await pool.end();
      if (pgBin) {
        const dir = mkdtempSync(join(tmpdir(), 'olist-t15-'));
        const file = join(dir, 'backup.dump');
        execFileSync(
          join(pgBin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'),
          ['--format=custom', '--file=' + file, '--dbname=' + urlFor(LIVE)],
          { stdio: 'pipe' },
        );
        backupFile = file;
      } else
        await asServer(async (client) => {
          await client.query(
            'DROP DATABASE IF EXISTS ' + BACKUP + ' WITH (FORCE)',
          );
          await client.query('CREATE DATABASE ' + BACKUP + ' TEMPLATE ' + LIVE);
        });
      pool = openPool();
    }
    async function restoreBackup() {
      await pool.end();
      if (pgBin) {
        await asServer(async (client) => {
          await client.query(
            'DROP DATABASE IF EXISTS ' + LIVE + ' WITH (FORCE)',
          );
          await client.query('CREATE DATABASE ' + LIVE);
        });
        execFileSync(
          join(
            pgBin,
            process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore',
          ),
          [
            '--exit-on-error',
            '--no-owner',
            '--dbname=' + urlFor(LIVE),
            backupFile,
          ],
          { stdio: 'pipe' },
        );
      } else
        await asServer(async (client) => {
          await client.query(
            'DROP DATABASE IF EXISTS ' + LIVE + ' WITH (FORCE)',
          );
          await client.query('CREATE DATABASE ' + LIVE + ' TEMPLATE ' + BACKUP);
        });
      pool = openPool();
    }
    let backupFile = '';

    // ---- synthetic world ----------------------------------------------------
    /** @param {string} id @param {boolean} olist @param {string[]} [caps] */
    async function user(id, olist, caps = []) {
      const session = hash(randomUUID());
      await q(
        "INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version) VALUES($1,$2,'Sintético','$argon2id$synthetic',$3,$4)",
        [id, id + '@example.test', olist, olist ? 1 : 0],
      );
      await q(
        "INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')",
        [id],
      );
      for (const capability of caps)
        await q(
          'INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,$2)',
          [id, capability],
        );
      await q(
        'INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$4,$5)',
        [
          session,
          id,
          hash('synthetic-csrf'),
          NOW,
          new Date(NOW.getTime() + 86_400_000),
        ],
      );
      return session;
    }
    /** Account enabled, one connection, settings; owner (seller with the box
     * ticked) and administrator (with a session). */
    async function seedWorld() {
      await q('TRUNCATE crm.olist_accounts CASCADE');
      const owner = 'rehearsal-owner-' + randomUUID(),
        admin = 'rehearsal-admin-' + randomUUID();
      ENV_ON.OLIST_PILOT_USER_IDS = owner;
      await user(owner, true);
      const adminSession = await user(admin, true, ['COMMERCIAL_ADMIN']);
      await q(
        'INSERT INTO crm.olist_accounts(account_key,creation_enabled,recovery_required) VALUES($1,true,false)',
        [accountKey],
      );
      await q(
        'INSERT INTO crm.olist_settings(account_key,version) VALUES($1,1)',
        [accountKey],
      );
      await q(
        'INSERT INTO crm.olist_connections(context_key,account_key,generation,version,token_envelope,expires_at) VALUES($1,$2,1,1,$3::jsonb,$4)',
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
          new Date(NOW.getTime() + 3_600_000),
        ],
      );
      clock.ms = Date.now();
      quota.mode = 'refill';
      return { owner, admin, adminSession };
    }
    const repo = createOlistRepository(db, {
      envelopeKey: KEY,
      hmacKey: HMAC,
      clock: () => NOW,
    });
    const adminRepo = createOlistAdminRepository(db, {
      envelopeKey: KEY,
      hmacKey: HMAC,
      clock: () => NOW,
    });
    const connection = () =>
      createOlistConnection(db, {
        config: olistConfiguration(ENV_ON),
        clock: () => NOW,
        fetch: (/** @type {any} */ url, /** @type {any} */ init) =>
          currentErp.fetch(url, init),
      });
    /** @type {ReturnType<typeof createFakeErp>} */
    let currentErp = createFakeErp();

    /** A new Order and its export generation, queued exactly as the export
     * command does (real `prepareExport`). A different `attrs` is a different
     * product; a different `sizes` list is a different set of variations.
     * @param {any} world @param {{attrs?:any,sizes?:string[],document?:string,settingsVersion?:number}} [options] */
    async function newExport(world, options = {}) {
      const {
        attrs = ATTR_BLUE,
        sizes = ['M', 'G'],
        document = DOCUMENT,
      } = options;
      const orderId = 'rehearsal-order-' + randomUUID(),
        contactId = 'rehearsal-contact-' + randomUUID();
      await q(
        'INSERT INTO crm.contacts(id,created_at,updated_at) VALUES($1,$2,$2)',
        [contactId, NOW],
      );
      const n = Number(
        (await one("SELECT nextval('crm.order_number_seq') n")).n,
      );
      await q(
        "INSERT INTO crm.orders(id,number_sequence,number,conversation_id,status,fab_code,ficha_envelope,created_by_kind,created_by,created_at,updated_at,manual_owner_id,manual_create_key,contact_id) VALUES($1,$2,$3,NULL,'pendente','SYNTHETIC',$8::jsonb,'user',$4,$5,$5,$4,$6,$7)",
        [
          orderId,
          n,
          String(n).padStart(2, '0') + '-CRM',
          world.owner,
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
      const lines = sizes.map((size) => ({
        groupId,
        lineId: randomUUID(),
        size,
        quantity: 1,
        subtotalCents: 100,
        unitCents: 100,
        unitLexeme: '1.00',
      }));
      const snapshot = {
        policy: 'exact-cent-v1',
        customer: {
          tipoPessoa: 'F',
          cpfCnpj: document,
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
        productFiscal: SETTINGS.productFiscal,
        settings: saleSettings,
        sourceVersions: { contactId, contactVersion: 1, sourceRevision: 0 },
        commercial: {
          orderDate: '2026-11-06',
          deliveryOn: '2026-11-12',
          paymentCondition: 'pix',
          totalCents: 100 * sizes.length,
          groups: [{ groupId, attributes: attrs, lines }],
        },
      };
      const live = await one(
        'SELECT c.generation,c.version,s.version AS settings_version FROM crm.olist_connections c JOIN crm.olist_settings s USING(account_key) WHERE c.context_key=$1',
        [contextKey],
      );
      const base = {
        actor: { id: world.owner, kind: 'human' },
        authorizationVersion: 1,
        accountKey,
        contextKey,
        connectionGeneration: Number(live.generation),
        connectionVersion: Number(live.version),
        settingsVersion:
          options.settingsVersion ?? Number(live.settings_version),
        orderId,
        correlationId: 'synthetic-rehearsal',
      };
      const row = await repo.prepareExport({
        ...base,
        orderVersion: 1,
        snapshot,
      });
      return {
        ...base,
        exportId: row.id,
        reference: row.reference,
        snapshot,
      };
    }
    /** @param {any} order */
    const exportRow = (order) =>
      one('SELECT * FROM crm.olist_exports WHERE id=$1', [order.exportId]);
    /** @param {any} order */
    const jobRow = (order) =>
      one(
        "SELECT * FROM crm.outbox_jobs WHERE olist_export_id=$1 AND job_type='olist.export'",
        [order.exportId],
      );
    /** Resources of the export by kind, with the state the ERP link has.
     * @param {any} order */
    const resourcesOf = async (order) =>
      (
        await q(
          'SELECT r.kind,r.state,r.remote_id,r.reference FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id WHERE e.export_id=$1 ORDER BY r.kind,r.reference',
          [order.exportId],
        )
      ).rows;
    /** @param {any} order */
    const attemptsOf = async (order) =>
      (
        await q(
          'SELECT a.stage,a.outcome FROM crm.olist_attempts a WHERE a.export_id=$1 OR a.resource_id IN (SELECT resource_id FROM crm.olist_export_resources WHERE export_id=$1) ORDER BY a.created_at,a.id',
          [order.exportId],
        )
      ).rows;
    const attemptsByStage = async (
      /** @type {any} */ order,
      /** @type {string} */ stage,
    ) => (await attemptsOf(order)).filter((row) => row.stage === stage);

    /** Admin input shared by the administrative commands.
     * @param {any} world @param {any} order */
    const adminInput = (world, order) => ({
      actor: { id: world.admin, kind: /** @type {const} */ ('human') },
      sessionBinding: world.adminSession,
      accountKey,
      contextKey,
      orderId: order.orderId,
      correlationId: 'synthetic-rehearsal-admin',
    });
    /** The stage the target export has to reach is primed with real exports so
     * the next POST of that stage is the one under test.
     * @param {any} world @param {ReturnType<typeof createFakeErp>} erp
     * @param {'customer'|'product'|'variation'|'sale'} stage */
    async function primedExport(world, erp, stage) {
      if (stage !== 'customer') {
        const prior = await newExport(world, {
          attrs: stage === 'product' ? ATTR_GREEN : ATTR_BLUE,
          sizes: stage === 'variation' ? ['M'] : ['M', 'G'],
        });
        const runtime = worker({ name: 'prime-' + stage, erp });
        assert.ok(runtime);
        assert.equal(await drain(runtime), 1);
        assert.equal((await exportRow(prior)).state, 'confirmed');
      }
      return newExport(world, {
        attrs: ATTR_BLUE,
        sizes: ['M', 'G'],
      });
    }
    const STAGES = /** @type {const} */ ([
      'customer',
      'product',
      'variation',
      'sale',
    ]);
    /** The local resource whose effect is the (single) ticket of `stage`.
     * @param {any} order @param {string} stage */
    async function ticketedResource(order, stage) {
      if (stage === 'sale') return null;
      return one(
        "SELECT r.* FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id JOIN crm.olist_attempts a ON a.resource_id=r.id WHERE e.export_id=$1 AND a.stage=$2 AND a.outcome IN ('reserved','uncertain')",
        [order.exportId, stage],
      );
    }
    /** "Conferir no Olist": a queued administrative read request answered by the
     * read-only reconciliation worker. Reads only; returns the stored result.
     * @param {any} world @param {any} order @param {string} stage @param {any} erp @param {any} [resource] */
    async function reconcile(world, order, stage, erp, resource = null) {
      const target = resource
        ? await one('SELECT * FROM crm.olist_resources WHERE id=$1', [
            resource.id,
          ])
        : await exportRow(order);
      const request = await adminRepo.createReadRequest({
        ...adminInput(world, order),
        stage,
        resourceId: resource ? resource.id : null,
        expectedVersion: Number(target.version),
        reason: 'Conferência sintética',
      });
      const runtime = reconciler({ name: 'reconcile-' + stage, erp });
      assert.ok(runtime);
      await drain(runtime);
      return adminRepo.readRequest({
        ...adminInput(world, order),
        requestId: request.id,
      });
    }
    /** Snapshot of the counters so a phase can assert "no POST since".
     * @param {ReturnType<typeof createFakeErp>} erp */
    const mark = (erp) => ({
      ...erp.posts,
      total: erp.totalPosts(),
      gets: erp.gets,
    });
    /** @param {ReturnType<typeof createFakeErp>} erp @param {any} before */
    const postsSince = (erp, before) => erp.totalPosts() - before.total;
    /** @param {string} stage */
    const stageTickets = (stage) =>
      count('olist_attempts', 'stage=$1', [stage]);
    /** At-least-once delivery: the queue hands the same job over again.
     * @param {any} order */
    const redeliver = (order) =>
      q(
        "UPDATE crm.outbox_jobs SET status='pending',locked_by=NULL,locked_until=NULL,heartbeat_at=NULL,completed_at=NULL,available_at=now()-interval '1 second' WHERE olist_export_id=$1",
        [order.exportId],
      );
    /** A new generation of the same Order, as the export command prepares it.
     * @param {any} order */
    async function reExport(order) {
      const live = await one(
        'SELECT c.generation,c.version,s.version AS settings_version FROM crm.olist_connections c JOIN crm.olist_settings s USING(account_key) WHERE c.context_key=$1',
        [contextKey],
      );
      const input = {
        actor: order.actor,
        authorizationVersion: 1,
        accountKey,
        contextKey,
        connectionGeneration: Number(live.generation),
        connectionVersion: Number(live.version),
        settingsVersion: Number(live.settings_version),
        orderId: order.orderId,
        correlationId: 'synthetic-rehearsal',
      };
      const row = await repo.prepareExport({
        ...input,
        orderVersion: 1,
        snapshot: order.snapshot,
      });
      return {
        ...input,
        exportId: row.id,
        reference: row.reference,
        snapshot: order.snapshot,
      };
    }
    // @@HELPERS@@

    try {
      await createLive();
      await t.test(
        'T15-REH-0 harness: a clean export posts each identity once',
        async () => {
          const world = await seedWorld();
          const erp = (currentErp = createFakeErp());
          const order = await newExport(world);
          const runtime = worker({ name: 'smoke', erp });
          assert.ok(runtime);
          assert.equal(await drain(runtime), 1);
          assert.deepEqual(erp.posts, {
            customer: 1,
            product: 1,
            variation: 0,
            sale: 1,
          });
          assert.deepEqual(erp.entities, {
            customers: 1,
            parents: 1,
            children: 2,
            sales: 1,
          });
          const row = await exportRow(order);
          assert.equal(row.state, 'confirmed');
          assert.equal((await jobRow(order)).status, 'completed');
          assert.deepEqual(erp.duplicates(), {
            customers: 0,
            products: 0,
            sales: 0,
          });
          // Replaying the delivery posts nothing.
          await q(
            "UPDATE crm.outbox_jobs SET status='pending',completed_at=NULL,available_at=now()-interval '1 second' WHERE olist_export_id=$1",
            [order.exportId],
          );
          assert.equal(await drain(runtime), 1);
          assert.equal(erp.totalPosts(), 3);
        },
      );
      await t.test(
        'T15-REH-1 the worker dies after the ticket and before the POST: nothing is reposted, the redelivery is uncertain, never a second POST',
        async (t1) => {
          for (const stage of STAGES)
            await t1.test('stage ' + stage, async () => {
              const world = await seedWorld();
              const erp = (currentErp = createFakeErp());
              const order = await primedExport(world, erp, stage);
              const before = mark(erp);
              const ticketsBefore = await stageTickets(stage);
              erp.script[stage] = ['hang'];
              const dyingWorker = worker({ name: 'dies', erp });
              assert.ok(dyingWorker);
              const run = dyingWorker.runOnce();
              assert.equal(
                await Promise.race([
                  erp.hung.then(() => 'hung'),
                  run.then(() => 'returned'),
                ]),
                'hung',
                'the POST of this stage must be reached',
              );
              // The ticket is durable, the POST never left, the job holds a lease.
              assert.equal(await stageTickets(stage), ticketsBefore + 1);
              assert.equal(postsSince(erp, before), 0);
              assert.equal((await jobRow(order)).status, 'processing');
              // A new process starts after the lease: the job is classified, not run.
              advance(31_000);
              const restarted = worker({ name: 'restarted', erp });
              assert.ok(restarted);
              assert.equal(await restarted.runOnce(), 0);
              const job = await jobRow(order);
              assert.equal(job.status, 'outcome_unknown');
              assert.equal(job.last_error_code, 'WORKER_LEASE_EXPIRED');
              assert.equal(
                await count('reconciliation_items', 'job_id=$1', [job.id]),
                1,
              );
              // Even a redelivery cannot post: the unresolved ticket blocks it.
              await redeliver(order);
              assert.equal(await restarted.runOnce(), 1);
              assert.equal(postsSince(erp, before), 0);
              assert.equal(await stageTickets(stage), ticketsBefore + 1);
              assert.notEqual((await jobRow(order)).status, 'completed');
              // Zero in a search after a ticket proves nothing (OLIST-17): the
              // read-only check stays blocked and still posts nothing.
              const resource = await ticketedResource(order, stage);
              if (stage !== 'sale') assert.ok(resource);
              const result = await reconcile(
                world,
                order,
                stage,
                erp,
                resource,
              );
              assert.equal(result.status, 'blocked');
              assert.equal(postsSince(erp, before), 0);
              assert.notEqual((await exportRow(order)).state, 'confirmed');
              if (stage !== 'sale')
                assert.notEqual(
                  (await ticketedResource(order, stage))?.state,
                  undefined,
                );
            });
        },
      );

      /** Drive one stage into a failed POST. Returns the context and the
       * counters taken just before the run.
       * @param {'customer'|'product'|'variation'|'sale'} stage @param {{action?:string,persistence?:boolean}} how */
      async function failAt(stage, { action, persistence = false }) {
        const world = await seedWorld();
        const erp = (currentErp = createFakeErp());
        const order = await primedExport(world, erp, stage);
        const before = mark(erp);
        if (action) erp.script[stage] = [action];
        if (persistence)
          erp.after[stage] = () => {
            fault.armed = true;
          };
        try {
          assert.equal(
            await drain(worker({ name: 'w', erp, faulty: persistence })),
            1,
          );
        } finally {
          fault.armed = false;
          erp.after[stage] = null;
        }
        return { world, erp, order, before };
      }
      /** The POST reached the ERP but the worker did not get a usable answer.
       * @param {string} title @param {string[]} actions */
      const lostAnswer = (title, actions) =>
        t.test(title, async (t1) => {
          for (const stage of STAGES)
            for (const action of actions) {
              await t1.test(
                stage + ' / ' + action + ': read-only way out',
                async () => {
                  const { world, erp, order, before } = await failAt(stage, {
                    action,
                  });
                  // Exactly the POST under test happened; every dependent waits.
                  assert.equal(erp.posts[stage] - before[stage], 1);
                  assert.equal(postsSince(erp, before), 1);
                  assert.equal(
                    (await attemptsByStage(order, stage)).at(-1)?.outcome,
                    'uncertain',
                  );
                  assert.equal((await jobRow(order)).status, 'outcome_unknown');
                  assert.notEqual((await exportRow(order)).state, 'confirmed');
                  // The way out is a READ: the ERP has the entity, the check links it.
                  const resource = await ticketedResource(order, stage);
                  const gets = erp.gets;
                  const result = await reconcile(
                    world,
                    order,
                    stage,
                    erp,
                    resource,
                  );
                  assert.equal(result.status, 'succeeded');
                  assert.ok(erp.gets > gets, 'the check issues GETs');
                  assert.equal(postsSince(erp, before), 1, 'and no POST');
                  assert.deepEqual(erp.duplicates(), {
                    customers: 0,
                    products: 0,
                    sales: 0,
                  });
                  if (stage === 'sale')
                    assert.equal((await exportRow(order)).state, 'confirmed');
                  else
                    assert.equal(
                      (
                        await one(
                          'SELECT state FROM crm.olist_resources WHERE id=$1',
                          [resource.id],
                        )
                      ).state,
                      'confirmed',
                    );
                },
              );
              await t1.test(
                stage +
                  ' / ' +
                  action +
                  ': a redelivery never posts the same identity twice',
                async () => {
                  const { erp, order, before } = await failAt(stage, {
                    action,
                  });
                  const tickets = await stageTickets(stage);
                  await redeliver(order);
                  await drain(worker({ name: 'again', erp }));
                  // The resolver may confirm the entity by READING it, but the
                  // stage is posted exactly once and no identity exists twice.
                  assert.equal(erp.posts[stage] - before[stage], 1);
                  assert.equal(await stageTickets(stage), tickets);
                  assert.deepEqual(erp.duplicates(), {
                    customers: 0,
                    products: 0,
                    sales: 0,
                  });
                },
              );
            }
        });
      await lostAnswer(
        'T15-REH-2 the POST was made and the answer was lost (timeout / 5xx): uncertain, dependents blocked, /reconcile resolves by reads',
        ['lost', '5xx'],
      );
      await lostAnswer(
        'T15-REH-3 invalid body / 2xx without an id: uncertain, never advanced, never reposted',
        ['badbody', 'noid'],
      );

      await t.test(
        'T15-REH-2b after the lost customer answer is reconciled, the Order is released and the new generation reuses the customer (no second customer POST)',
        async () => {
          const world = await seedWorld();
          const erp = (currentErp = createFakeErp());
          const order = await newExport(world);
          erp.script.customer = ['lost'];
          assert.equal(await drain(worker({ name: 'w', erp })), 1);
          const resource = await ticketedResource(order, 'customer');
          // While the customer is uncertain, invalidating is refused (ADR 069).
          await assert.rejects(
            adminRepo.invalidateExport({
              ...adminInput(world, order),
              operationId: order.exportId,
              expectedVersion: Number((await exportRow(order)).version),
              reason: 'Pedido parado sintético',
            }),
            { code: 'OLIST_RESOURCE_RECONCILIATION_REQUIRED' },
          );
          assert.equal(
            (await reconcile(world, order, 'customer', erp, resource)).status,
            'succeeded',
          );
          const receipt = await adminRepo.invalidateExport({
            ...adminInput(world, order),
            operationId: order.exportId,
            expectedVersion: Number((await exportRow(order)).version),
            reason: 'Pedido parado sintético',
          });
          assert.equal(receipt.state, 'invalidated');
          const next = await reExport(order);
          assert.notEqual(next.exportId, order.exportId);
          assert.equal(await drain(worker({ name: 'next', erp })), 1);
          assert.deepEqual(erp.posts, {
            customer: 1,
            product: 1,
            variation: 0,
            sale: 1,
          });
          assert.equal((await exportRow(next)).state, 'confirmed');
          assert.deepEqual(erp.duplicates(), {
            customers: 0,
            products: 0,
            sales: 0,
          });
        },
      );

      await t.test(
        'T15-REH-4 the result cannot be persisted after the POST: the ticket stays reserved, nothing is released, the way out is a read',
        async (t1) => {
          for (const stage of STAGES) {
            await t1.test(
              'stage ' + stage + ': read-only way out',
              async () => {
                const { world, erp, order, before } = await failAt(stage, {
                  persistence: true,
                });
                assert.equal(erp.posts[stage] - before[stage], 1);
                assert.equal(postsSince(erp, before), 1);
                assert.equal(
                  (await attemptsByStage(order, stage)).at(-1)?.outcome,
                  'reserved',
                );
                assert.equal((await jobRow(order)).status, 'outcome_unknown');
                assert.notEqual((await exportRow(order)).state, 'confirmed');
                if (stage !== 'sale')
                  assert.equal(
                    (await ticketedResource(order, stage))?.state,
                    'reserved',
                  );
                const resource = await ticketedResource(order, stage);
                const result = await reconcile(
                  world,
                  order,
                  stage,
                  erp,
                  resource,
                );
                assert.equal(result.status, 'succeeded');
                assert.equal(postsSince(erp, before), 1);
                assert.deepEqual(erp.duplicates(), {
                  customers: 0,
                  products: 0,
                  sales: 0,
                });
              },
            );
            await t1.test(
              'stage ' +
                stage +
                ': a redelivery with the database back posts nothing twice',
              async () => {
                const { erp, order, before } = await failAt(stage, {
                  persistence: true,
                });
                const tickets = await stageTickets(stage);
                await redeliver(order);
                await drain(worker({ name: 'back', erp }));
                assert.equal(erp.posts[stage] - before[stage], 1);
                assert.equal(await stageTickets(stage), tickets);
                assert.deepEqual(erp.duplicates(), {
                  customers: 0,
                  products: 0,
                  sales: 0,
                });
              },
            );
          }
        },
      );

      await t.test(
        'T15-REH-5 the quota is exhausted before the write: the job is deferred with NO ticket and NO POST, then completes once',
        async (t1) => {
          for (const stage of STAGES)
            await t1.test('stage ' + stage, async () => {
              const world = await seedWorld();
              const erp = (currentErp = createFakeErp());
              const order = await primedExport(world, erp, stage);
              const before = mark(erp);
              const ticketsBefore = await stageTickets(stage);
              quota.mode = 'squeeze';
              assert.equal(await drain(worker({ name: 'busy', erp })), 1);
              const job = await jobRow(order);
              assert.equal(job.status, 'retry');
              assert.equal(job.last_error_code, 'OLIST_RATE_LIMITED');
              assert.equal(postsSince(erp, before), 0);
              assert.equal(await stageTickets(stage), ticketsBefore);
              assert.equal(
                await repo.assertRetrySafe({
                  exportId: order.exportId,
                  accountKey,
                  contextKey,
                }),
                true,
              );
              // Window free again: the very same job finishes, one POST per identity.
              quota.mode = 'refill';
              advance(60_000);
              assert.equal(await drain(worker({ name: 'later', erp })), 1);
              assert.equal((await exportRow(order)).state, 'confirmed');
              assert.equal(await stageTickets(stage), ticketsBefore + 1);
              assert.deepEqual(erp.duplicates(), {
                customers: 0,
                products: 0,
                sales: 0,
              });
            });
        },
      );

      await t.test(
        'T15-REH-6 revoking the checkbox / deactivating the seller between stages stops the NEXT effect and reconciles the one already started (OLIST-27)',
        async (t1) => {
          const revocations = {
            'checkbox unticked': (/** @type {string} */ id) =>
              q(
                'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=2 WHERE id=$1',
                [id],
              ),
            'user deactivated': (/** @type {string} */ id) =>
              q(
                'UPDATE crm.users SET disabled_at=$2,olist_authorization_version=2 WHERE id=$1',
                [id, NOW],
              ),
          };
          for (const [name, revoke] of Object.entries(revocations))
            for (const point of /** @type {const} */ (['customer', 'product']))
              await t1.test(
                name + ' during the ' + point + ' POST',
                async () => {
                  const world = await seedWorld();
                  const erp = (currentErp = createFakeErp());
                  const order = await newExport(world);
                  erp.after[point] = async () => {
                    await revoke(world.owner);
                  };
                  assert.equal(await drain(worker({ name: 'w', erp })), 1);
                  // The started effect is not lost: the ticket keeps the id the ERP
                  // gave (the revoked user can no longer authorise the readback).
                  assert.equal(erp.posts[point], 1);
                  const ticket = (await attemptsByStage(order, point)).at(-1);
                  assert.equal(ticket?.outcome, 'uncertain');
                  const observed = await one(
                    'SELECT observed_remote_id FROM crm.olist_attempts WHERE stage=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
                    [point],
                  );
                  assert.equal(
                    observed.observed_remote_id,
                    String(erp.log.find((entry) => entry.kind === point).id),
                  );
                  // The next effect never happens.
                  const next =
                    point === 'customer' ? ['product', 'sale'] : ['sale'];
                  for (const stage of next)
                    assert.equal(
                      erp.posts[/** @type {'sale'} */ (stage)],
                      0,
                      stage,
                    );
                  const job = await jobRow(order);
                  assert.equal(job.last_error_code, 'FORBIDDEN');
                  assert.notEqual(job.status, 'completed');
                  assert.notEqual((await exportRow(order)).state, 'confirmed');
                  // The administrator's read-only check is independent of the
                  // revoked seller: it links what the ERP already holds, no POST.
                  const before = erp.totalPosts();
                  const open = (
                    await q(
                      "SELECT r.* FROM crm.olist_resources r JOIN crm.olist_export_resources e ON e.resource_id=r.id WHERE e.export_id=$1 AND r.state<>'confirmed' ORDER BY (r.kind='variation'),r.reference",
                      [order.exportId],
                    )
                  ).rows;
                  assert.ok(open.length >= 1);
                  // Only the effect that started is present in the ERP. Later
                  // resources stay pending; reads must never create them.
                  for (const resource of open.filter(
                    (row) => row.kind === point,
                  ))
                    assert.equal(
                      (
                        await reconcile(
                          world,
                          order,
                          resource.kind,
                          erp,
                          resource,
                        )
                      ).status,
                      'succeeded',
                    );
                  assert.equal(erp.totalPosts(), before);
                  for (const row of (await resourcesOf(order)).filter(
                    (value) => value.kind === point,
                  ))
                    assert.equal(row.state, 'confirmed');
                  assert.deepEqual(erp.duplicates(), {
                    customers: 0,
                    products: 0,
                    sales: 0,
                  });
                },
              );
          await t1.test(
            'revoked before the job runs: no request reaches the ERP at all',
            async () => {
              const world = await seedWorld();
              const erp = (currentErp = createFakeErp());
              const order = await newExport(world);
              await revocations['user deactivated'](world.owner);
              assert.equal(await drain(worker({ name: 'w', erp })), 1);
              assert.equal(erp.gets, 0);
              assert.equal(erp.totalPosts(), 0);
              assert.equal(await count('olist_attempts'), 0);
              assert.equal((await jobRow(order)).last_error_code, 'FORBIDDEN');
            },
          );
        },
      );

      await t.test(
        'T15-REH-7 an OAuth reconnection in the middle (generation + 1): the export fails safe, the administrator releases the Order, the created entities are reused by the new generation',
        async () => {
          const world = await seedWorld();
          const erp = (currentErp = createFakeErp());
          const order = await newExport(world);
          const generation = Number(
            (await one('SELECT generation FROM crm.olist_connections'))
              .generation,
          );
          erp.after.product = async () => {
            const input = {
              actor: { id: world.admin, kind: /** @type {const} */ ('human') },
              sessionBinding: world.adminSession,
              correlationId: 'synthetic-reconnect',
            };
            const { authorizationUrl } = await connection().authorize(input);
            const state = new URL(authorizationUrl).searchParams.get('state');
            await connection().complete({
              ...input,
              state,
              code: 'synthetic-code',
            });
          };
          assert.equal(await drain(worker({ name: 'w', erp })), 1);
          erp.after.product = null;
          assert.equal(
            Number(
              (await one('SELECT generation FROM crm.olist_connections'))
                .generation,
            ),
            generation + 1,
          );
          // Fails safe: the customer and the product were created and linked, the
          // sale was never posted, and the job did not complete.
          assert.deepEqual(erp.posts, {
            customer: 1,
            product: 1,
            variation: 0,
            sale: 0,
          });
          const job = await jobRow(order);
          assert.notEqual(job.status, 'completed');
          assert.equal(job.last_error_code, 'OLIST_CONNECTION_CHANGED');
          assert.notEqual((await exportRow(order)).state, 'confirmed');
          const unresolved = (await resourcesOf(order)).filter(
            (row) => row.state !== 'confirmed',
          );
          t.diagnostic(
            'T15-REH-7 resources not confirmed after the reconnection: ' +
              JSON.stringify(
                unresolved.map((row) => row.kind + ':' + row.state),
              ),
          );
          // Any resource left uncertain is first reconciled by reading.
          for (const row of unresolved) {
            const resource = await one(
              'SELECT * FROM crm.olist_resources WHERE reference=$1',
              [row.reference],
            );
            assert.equal(
              (await reconcile(world, order, resource.kind, erp, resource))
                .status,
              'succeeded',
            );
          }
          const receipt = await adminRepo.invalidateExport({
            ...adminInput(world, order),
            operationId: order.exportId,
            expectedVersion: Number((await exportRow(order)).version),
            reason: 'Reconexão sintética no meio da exportação',
          });
          assert.equal(receipt.state, 'invalidated');
          const next = await reExport(order);
          assert.equal(await drain(worker({ name: 'next', erp })), 1);
          assert.equal((await exportRow(next)).state, 'confirmed');
          // The new generation reused the entities: only the sale was posted.
          assert.deepEqual(erp.posts, {
            customer: 1,
            product: 1,
            variation: 0,
            sale: 1,
          });
          assert.deepEqual(erp.duplicates(), {
            customers: 0,
            products: 0,
            sales: 0,
          });
          assert.equal((await exportRow(order)).state, 'invalidated');
        },
      );

      await t.test(
        'T15-REH-8 retention today: attempts, snapshots, resource bases and events cannot be purged; no sanctioned purge path exists (T14 finding M3)',
        async () => {
          const world = await seedWorld();
          const erp = (currentErp = createFakeErp());
          const order = await newExport(world);
          assert.equal(await drain(worker({ name: 'w', erp })), 1);
          assert.equal((await exportRow(order)).state, 'confirmed');
          /** @type {Array<[string,string,RegExp]>} */
          const forbidden = [
            ['DELETE FROM crm.olist_attempts', 'attempt delete', /durable/u],
            [
              "UPDATE crm.olist_attempts SET safe_code='X_PURGED'",
              'attempt update',
              /immutable/u,
            ],
            [
              'UPDATE crm.olist_exports SET snapshot_envelope=\'{"algorithm":"AES-256-GCM","keyVersion":1,"version":1,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA","ciphertext":"AAAA"}\'::jsonb',
              'snapshot overwrite',
              /immutable/u,
            ],
            [
              "UPDATE crm.olist_resources SET snapshot_envelope=NULL,payload_hash=NULL WHERE kind='customer'",
              'resource base wipe',
              /immutable|complete/u,
            ],
            ['DELETE FROM crm.olist_events', 'event delete', /append only/u],
            [
              "UPDATE crm.olist_events SET event_code='X'",
              'event update',
              /append only/u,
            ],
          ];
          for (const [sql, name, message] of forbidden)
            await assert.rejects(q(sql), message, name);
          // Deleting the export or a resource that carries history is stopped by
          // the references (a different guard, not a purge path).
          await assert.rejects(q('DELETE FROM crm.olist_exports'));
          await assert.rejects(q('DELETE FROM crm.olist_resources'));
          // There is no function or command to purge them either.
          const purge = await q(
            "SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm' AND proname ~* '(purge|expurg|retention|vacuum)' AND proname ~* 'olist'",
          );
          assert.deepEqual(purge.rows, []);
          assert.ok(
            (await count('olist_attempts')) > 0 &&
              (await count('olist_events')) > 0,
            'history is intact',
          );
        },
      );

      // =====================================================================
      // RESTORE (OLIST-28, 29; accepted risk A4 of T14)
      // =====================================================================
      await t.test(
        'T15-REH-R restore: the database goes back to an earlier instant while the ERP keeps what was created after it',
        async (t1) => {
          // ---- the world at the backup instant ---------------------------
          const world = await seedWorld();
          const live = (currentErp = createFakeErp());
          // A: customer and product confirmed, export ready, the SALE ticket
          // reserved; the worker dies holding the POST (job `processing`, lease
          // alive).
          const orderA = await newExport(world);
          live.script.sale = ['hang'];
          const dyingWorker = worker({ name: 'live-1', erp: live });
          assert.ok(dyingWorker);
          const dying = dyingWorker.runOnce();
          assert.equal(
            await Promise.race([
              live.hung.then(() => 'hung'),
              dying.then(() => 'returned'),
            ]),
            'hung',
          );
          // C: a second product (green) whose resources are bound locally but
          // not created yet: the job stopped before any effect (network blip).
          const orderC = await newExport(world, {
            attrs: ATTR_GREEN,
            sizes: ['M', 'G'],
          });
          live.interceptors.push((request) =>
            request.method === 'GET' && !request.path.startsWith('/pedidos')
              ? 'network'
              : undefined,
          );
          const beforeEffectWorker = worker({ name: 'live-2', erp: live });
          assert.ok(beforeEffectWorker);
          assert.equal(await beforeEffectWorker.runOnce(), 1);
          live.interceptors.length = 0;
          assert.equal((await jobRow(orderC)).status, 'retry');
          assert.deepEqual(
            (await resourcesOf(orderC)).map(
              (row) => row.kind + ':' + row.state,
            ),
            [
              'customer:confirmed',
              'product:pending',
              'variation:pending',
              'variation:pending',
            ],
          );
          assert.equal((await jobRow(orderA)).status, 'processing');
          assert.equal((await exportRow(orderA)).state, 'reserved');
          assert.equal(await stageTickets('sale'), 1);
          assert.deepEqual(live.entities, {
            customers: 1,
            parents: 1,
            children: 2,
            sales: 0,
          });
          const backupAt = clock.ms;
          const previewSettingsVersion = Number(
            (await one('SELECT version FROM crm.olist_settings')).version,
          );
          // ---- BACKUP ----------------------------------------------------
          await takeBackup();
          // ---- the window: the live system keeps running ------------------
          const beforeWindow = mark(live);
          live.openWindow();
          const saleA = live.completeInFlight(); // the POST in flight lands
          clock.ms = backupAt + 120_000;
          assert.equal(await drain(worker({ name: 'live-3', erp: live })), 1);
          clock.ms = backupAt;
          assert.deepEqual(live.entities, {
            customers: 1,
            parents: 2,
            children: 4,
            sales: 2,
          });
          assert.equal(live.posts.product - beforeWindow.product, 1);
          assert.equal(live.posts.sale - beforeWindow.sale, 2);
          const windowState = live.snapshot();
          const saleC = windowState.orders.find(
            (/** @type {any} */ o) => o.reference === orderC.reference,
          ).id;
          t.diagnostic(
            'T15-REH-R window: the ERP holds sale A=' +
              saleA +
              ', and product + sale C=' +
              saleC +
              ' that the backup does not contain',
          );

          // ---- helpers of the restore rounds ---------------------------------
          /** The database as of the backup, the ERP as of now.
           * @param {{lag:boolean,mutation?:{skipLeases?:boolean,skipPreviews?:boolean,enableEarly?:boolean,skipReconcile?:boolean}}} how */
          async function restored({ lag, mutation = {} }) {
            await restoreBackup();
            clock.ms = backupAt + 5_000; // the restore ends inside A's 30 s lease
            quota.mode = 'refill';
            const erp = (currentErp = createFakeErp(windowState));
            erp.setSearchLag(lag);
            return { erp, mutation, previewSettingsVersion };
          }
          /** @param {any} order */
          const dispatchBase = (order) => ({
            exportId: order.exportId,
            actor: order.actor,
            authorizationVersion: 1,
            accountKey,
            contextKey,
            connectionGeneration: order.connectionGeneration,
            settingsVersion: order.settingsVersion,
            correlationId: 'synthetic-rehearsal',
          });
          const flagsNow = () =>
            one(
              'SELECT creation_enabled,recovery_required FROM crm.olist_accounts WHERE account_key=$1',
              [accountKey],
            );
          const enableCreation = () =>
            q(
              'UPDATE crm.olist_accounts SET creation_enabled=true,recovery_required=false WHERE account_key=$1',
              [accountKey],
            );
          /** Steps 2-4 of the runbook script (the header of this file).
           * @param {any} ctx */
          async function restoreProcedure(ctx) {
            await q(
              'UPDATE crm.olist_accounts SET creation_enabled=false,recovery_required=true WHERE account_key=$1',
              [accountKey],
            );
            if (!ctx.mutation.skipLeases)
              await q(
                "UPDATE crm.outbox_jobs SET locked_until=$1 WHERE queue IN ('olist','olist_reconcile') AND status='processing'",
                [new Date(clock.ms)],
              );
            if (!ctx.mutation.skipPreviews) {
              const current = await one(
                'SELECT version FROM crm.olist_settings WHERE account_key=$1',
                [accountKey],
              );
              await connection().settings({
                actor: { id: world.admin, kind: 'human' },
                sessionBinding: world.adminSession,
                expectedVersion: Number(current.version),
                reason: 'Prévias anteriores ao backup invalidadas (restore)',
                settings: SETTINGS,
                correlationId: 'synthetic-restore',
              });
            }
            if (ctx.mutation.enableEarly) await enableCreation();
          }
          /** Step 6: nothing may be left unreconciled before creation is
           * switched on. The system does NOT enforce this; the operator does.
           * @param {string} tag */
          async function assertWindowReconciled(tag) {
            const open = {
              exports: await count(
                'olist_exports',
                "state NOT IN ('confirmed','linked','invalidated','rejected')",
              ),
              resources: await count('olist_resources', "state<>'confirmed'"),
              reserved: await count('olist_attempts', "outcome='reserved'"),
            };
            assert.deepEqual(
              open,
              { exports: 0, resources: 0, reserved: 0 },
              '[' +
                tag +
                '] the window is not reconciled: ' +
                JSON.stringify(open),
            );
          }
          /** Step 5: "Conferir" for the sale ticket of A and "Vincular venda
           * existente" for the sale of C, reads only.
           * @param {any} ctx */
          async function reconcileWindow(ctx) {
            const { erp } = ctx;
            erp.setSearchLag(false); // the ERP search caught up
            const sale = await reconcile(world, orderA, 'sale', erp);
            assert.equal(
              sale.status,
              'succeeded',
              '[R3-window] sale of A: ' + JSON.stringify(sale),
            );
            const operation = await adminRepo.readOperation({
              ...adminInput(world, orderC),
              action: 'olist.link',
            });
            const client = createOlistClient({
              credentials: async () => ({ token: 'synthetic', version: 1 }),
              quota: {
                reserve: async () => {},
                observe: async () => {},
                block: async () => {},
              },
              fetch: erp.fetch,
            });
            const found = await client.findOrder(operation.reference);
            assert.ok(
              found,
              '[R3-window] the sale of C must be visible to the search',
            );
            const checked = await createOlistReadonlyInspector({
              client,
              config: { hmacKey: HMAC },
            }).existingSale({
              snapshot: operation.snapshot,
              reference: operation.reference,
              remoteId: found.id,
              allowLegacyReference: false,
            });
            const settings = await one(
              'SELECT version FROM crm.olist_settings WHERE account_key=$1',
              [accountKey],
            );
            await adminRepo.commitLink({
              ...adminInput(world, orderC),
              remoteId: checked.remoteId,
              number: checked.number,
              snapshot: operation.snapshot,
              resources: checked.resources,
              proof: checked.proof,
              reason: 'Venda criada depois do backup (restore)',
              expectedOperationVersion: Number(operation.version),
              expectedOrderVersion: 1,
              expectedSettingsVersion: Number(settings.version),
            });
          }

          // ---- R1 ------------------------------------------------------------
          await t1.test(
            'T15-REH-R1a WITHOUT the procedure, ERP search consistent: the lookups keep the restored worker from reposting, but nothing stops it from running',
            async () => {
              const ctx = await restored({ lag: false });
              // THE MISSING GUARD: the restored database says "creation on".
              assert.deepEqual(await flagsNow(), {
                creation_enabled: true,
                recovery_required: false,
              });
              await repo.validateDispatch(dispatchBase(orderC)); // does not throw
              const before = mark(ctx.erp);
              const runtime = worker({ name: 'restored', erp: ctx.erp });
              assert.ok(runtime);
              await drain(runtime); // inside A's lease: nothing due
              advance(55_000);
              await drain(runtime);
              // A is classified; C found its sale in the ERP and stopped.
              assert.equal((await jobRow(orderA)).status, 'outcome_unknown');
              assert.equal(
                (await jobRow(orderC)).last_error_code,
                'OLIST_SALE_ALREADY_EXISTS',
              );
              assert.equal(postsSince(ctx.erp, before), 0);
              assert.deepEqual(ctx.erp.duplicates(), {
                customers: 0,
                products: 0,
                sales: 0,
              });
            },
          );
          await t1.test(
            'T15-REH-R1b WITHOUT the procedure, ERP search lagging behind (modelled premise): the restored worker REPOSTS the product and the sale the ERP already has (documented accepted risk A4)',
            async () => {
              const ctx = await restored({ lag: true });
              // THE MISSING GUARD, executable: the local command guard that would
              // refuse every effect lets the restored worker through.
              assert.deepEqual(await flagsNow(), {
                creation_enabled: true,
                recovery_required: false,
              });
              await repo.validateDispatch(dispatchBase(orderC));
              const before = mark(ctx.erp);
              const runtime = worker({ name: 'restored', erp: ctx.erp });
              assert.ok(runtime);
              await drain(runtime);
              advance(55_000);
              await drain(runtime);
              // NOT a "known failure": this asserts the risk the owner accepted.
              // If a technical interlock (an epoch marker verified at boot) is ever
              // added, these assertions must flip and the runbook be rewritten.
              const duplicates = ctx.erp.duplicates();
              assert.equal(
                postsSince(ctx.erp, before) > 0,
                true,
                'without the procedure the ERP receives POSTs',
              );
              assert.equal(duplicates.products >= 1, true, 'duplicate product');
              assert.equal(duplicates.sales >= 1, true, 'duplicate sale');
              t.diagnostic(
                'T15-REH-R1b ERP duplicates without the procedure: ' +
                  JSON.stringify(duplicates) +
                  ' posts=' +
                  JSON.stringify(ctx.erp.posts),
              );
            },
          );

          // ---- R2..R4 ----------------------------------------------------------
          /** @param {any} ctx */
          async function phaseR2(ctx) {
            const { erp } = ctx;
            const before = mark(erp);
            assert.deepEqual(
              await flagsNow(),
              { creation_enabled: false, recovery_required: true },
              '[R2-flags] creation must stay off until the window is reconciled',
            );
            // Step 1: with dispatch off no consumer even exists.
            assert.equal(
              worker({ name: 'off', erp, environment: ENV_OFF }),
              undefined,
            );
            await assert.rejects(
              repo.validateDispatch(dispatchBase(orderC)),
              { code: 'OLIST_CREATION_DISABLED' },
              '[R2-flags] the local guard must refuse',
            );
            const runtime = worker({ name: 'restored', erp });
            assert.ok(runtime);
            await drain(runtime); // inside A's original lease
            assert.equal(
              await count(
                'outbox_jobs',
                "queue='olist' AND status='processing'",
              ),
              0,
              '[R2-leases] a dead holder still owns a live lease after the restore',
            );
            assert.equal((await jobRow(orderA)).status, 'outcome_unknown');
            assert.equal(
              await count('reconciliation_items', "status='open'"),
              1,
              '[R2-leases] the in-flight job must be surfaced',
            );
            advance(55_000);
            await drain(runtime); // C is due now
            assert.equal(
              postsSince(erp, before),
              0,
              '[R2-posts] the ERP received POSTs: ' + JSON.stringify(erp.posts),
            );
            assert.deepEqual(erp.duplicates(), {
              customers: 0,
              products: 0,
              sales: 0,
            });
            const current = Number(
              (
                await one(
                  'SELECT version FROM crm.olist_settings WHERE account_key=$1',
                  [accountKey],
                )
              ).version,
            );
            assert.ok(
              current > ctx.previewSettingsVersion,
              '[R2-previews] a preview issued before the backup is still valid',
            );
            // The job of C stopped at the local guard, before any request.
            assert.notEqual((await jobRow(orderC)).status, 'completed');
            assert.equal(erp.gets, before.gets, 'no request left the process');
          }
          /** @param {any} ctx */
          async function phaseR3(ctx) {
            const { erp } = ctx;
            const before = mark(erp);
            if (!ctx.mutation.skipReconcile) await reconcileWindow(ctx);
            assert.equal(
              postsSince(erp, before),
              0,
              '[R3-window] reconciliation must not POST',
            );
            const a = await exportRow(orderA);
            assert.equal(
              a.state,
              'confirmed',
              '[R3-window] sale of A not confirmed',
            );
            assert.equal(
              a.remote_id,
              String(saleA),
              '[R3-window] sale of A not linked to the ERP id',
            );
            const c = await exportRow(orderC);
            assert.equal(c.state, 'linked', '[R3-window] sale of C not linked');
            assert.equal(c.remote_id, String(saleC));
            const resources = await resourcesOf(orderC);
            for (const row of resources)
              assert.equal(
                row.state,
                'confirmed',
                '[R3-window] ' + row.kind + ' of C not confirmed',
              );
            const parent = resources.find((row) => row.kind === 'product');
            assert.equal(
              parent.remote_id,
              String(
                windowState.products.find(
                  (/** @type {any} */ p) => p.sku === parent.reference,
                ).id,
              ),
              '[R3-window] the product of C is not the one the ERP holds',
            );
            assert.deepEqual(erp.duplicates(), {
              customers: 0,
              products: 0,
              sales: 0,
            });
          }
          /** @param {any} ctx */
          async function phaseR4(ctx) {
            const { erp } = ctx;
            await assertWindowReconciled('R4-gate');
            await enableCreation();
            // A new Order for the same customer and product, prepared with the
            // current settings, runs; one prepared from a pre-backup preview does not.
            // Use a different Order with no active export: otherwise the
            // existing-operation fingerprint guard masks the settings fence.
            await assert.rejects(
              newExport(world, {
                attrs: ATTR_GREEN,
                settingsVersion: ctx.previewSettingsVersion,
              }),
              { code: 'VERSION_CONFLICT' },
              '[R4-gate] a pre-backup preview must be refused',
            );
            const fresh = await newExport(world, { attrs: ATTR_GREEN });
            const before = mark(erp);
            const runtime = worker({ name: 'resumed', erp });
            assert.ok(runtime);
            advance(60_000);
            assert.equal((await drain(runtime)) >= 1, true);
            // Only the new sale is created, once; every other identity is reused.
            assert.deepEqual(
              { ...erp.posts, total: erp.totalPosts() - before.total },
              { customer: 0, product: 0, variation: 0, sale: 1, total: 1 },
            );
            assert.equal((await exportRow(fresh)).state, 'confirmed');
            // Replaying the delivery posts nothing more.
            await redeliver(fresh);
            advance(60_000);
            await drain(runtime);
            assert.equal(erp.posts.sale, 1);
            assert.deepEqual(erp.duplicates(), {
              customers: 0,
              products: 0,
              sales: 0,
            });
            assert.equal(erp.entities.sales, 3);
          }

          /** @type {any} */ let shared;
          await t1.test(
            'T15-REH-R2 WITH the procedure: zero POSTs to the ERP during and after the restore until the window is reconciled, even with a lagging search',
            async () => {
              shared = await restored({ lag: true });
              await restoreProcedure(shared);
              await phaseR2(shared);
              assert.equal(shared.erp.totalPosts(), 0);
            },
          );
          await t1.test(
            'T15-REH-R3 the reconciliation of the window finds in the ERP what was created after the backup and links it without creating anything',
            async () => {
              await phaseR3(shared);
              assert.equal(shared.erp.totalPosts(), 0);
            },
          );
          await t1.test(
            'T15-REH-R4 only after the reconciliation and the explicit switch-on does a new export run, creating each identity once',
            async () => {
              await phaseR4(shared);
            },
          );

          // ---- mutations: each removed control makes the rehearsal fail --------
          /** @param {string} title @param {any} mutation @param {RegExp} expected @param {(ctx:any)=>Promise<void>} run */
          const mutated = (title, mutation, expected, run) =>
            t1.test('MUTATION ' + title, async () => {
              const ctx = await restored({ lag: true, mutation });
              await restoreProcedure(ctx);
              await assert.rejects(run(ctx), (/** @type {any} */ error) => {
                assert.equal(
                  error?.name,
                  'AssertionError',
                  String(error?.stack ?? error),
                );
                assert.match(error.message, expected);
                return true;
              });
            });
          await mutated(
            '(a1) without retiring the leases R2 fails',
            { skipLeases: true },
            /\[R2-leases\]/u,
            phaseR2,
          );
          await mutated(
            '(a2) without invalidating the previews R2 fails',
            { skipPreviews: true },
            /\[R2-previews\]/u,
            phaseR2,
          );
          await mutated(
            '(b) switching creation on before reconciling R2 fails',
            { enableEarly: true },
            /\[R2-flags\]/u,
            phaseR2,
          );
          await mutated(
            '(c1) skipping the reconciliation R3 fails',
            { skipReconcile: true },
            /\[R3-window\]/u,
            async (ctx) => {
              await phaseR2(ctx);
              await phaseR3(ctx);
            },
          );
          await mutated(
            '(c2) skipping the reconciliation R4 cannot switch creation on',
            { skipReconcile: true },
            /\[R4-gate\]/u,
            async (ctx) => {
              await phaseR2(ctx);
              await phaseR4(ctx);
            },
          );
          await t1.test(
            'MUTATION (b2) creation switched on early AND no preview invalidation: the lagging ERP receives the duplicates (the two controls are redundant, either one alone holds)',
            async () => {
              const ctx = await restored({
                lag: true,
                mutation: { enableEarly: true, skipPreviews: true },
              });
              await restoreProcedure(ctx);
              const before = mark(ctx.erp);
              const runtime = worker({ name: 'restored', erp: ctx.erp });
              assert.ok(runtime);
              await drain(runtime);
              advance(55_000);
              await drain(runtime);
              assert.equal(postsSince(ctx.erp, before) > 0, true);
              assert.equal(ctx.erp.duplicates().sales >= 1, true);
            },
          );
        },
      );
    } finally {
      if (pool) await pool.end().catch(() => {});
      await asServer(async (client) => {
        await client.query('DROP DATABASE IF EXISTS ' + LIVE + ' WITH (FORCE)');
        await client.query(
          'DROP DATABASE IF EXISTS ' + BACKUP + ' WITH (FORCE)',
        );
      }).catch(() => {});
      if (backupFile)
        rmSync(join(backupFile, '..'), { recursive: true, force: true });
    }
  });
