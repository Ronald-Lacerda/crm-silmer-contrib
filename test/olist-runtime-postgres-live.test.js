import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createApi } from '../apps/api/src/app.js';
import { createOlistApiRuntime } from '../apps/api/src/olist-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  EMPTY_OLIST_SETTINGS,
  olistConfiguration,
  seal,
} from '../modules/olist/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-runtime-app',
  OLIST_CLIENT_SECRET: 'synthetic-runtime-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 31).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 32).toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 33).toString('base64url'),
};
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');

if (connectionString) {
  test('OLIST-T03/T04/T19: real runtime projections, fresh authorization and atomic idempotent commands', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 8 });
    const config = olistConfiguration(environment);
    const database = {
      query: (
        /** @type {string} */ sql,
        /** @type {unknown[]} */ values = [],
      ) => pool.query(sql, values),
      /** @template T @param {(client:import('pg').PoolClient)=>Promise<T>} work */
      transaction: (work) => withTransaction(pool, work),
    };
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      async function fixture() {
        // Each fixture has separate users, sessions and idempotency scopes.
        await pool.query('TRUNCATE crm.olist_accounts CASCADE');
        /** @type {Record<string, any>} */
        const actors = {};
        for (const [role, functionName, enabled, disabled] of [
          ['admin', 'Vendedor', false, false],
          ['finance', 'Financeiro', true, false],
          ['seller', 'Vendedor', true, false],
          ['disabled', 'Vendedor', true, true],
        ]) {
          const id = `olist-runtime-${role}-${randomUUID()}`;
          const token = randomUUID();
          const sessionBinding = hash(token);
          await pool.query(
            `INSERT INTO crm.users(id,email,name,password_hash,olist_enabled,olist_authorization_version,disabled_at)
             VALUES($1,$2,'Conta sintética','$argon2id$synthetic',$3,$4,$5)`,
            [
              id,
              `${id}@example.test`,
              enabled,
              enabled ? 1 : 0,
              disabled ? NOW : null,
            ],
          );
          await pool.query(
            'INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,$2)',
            [id, functionName],
          );
          if (role === 'admin')
            await pool.query(
              "INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')",
              [id],
            );
          await pool.query(
            `INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [
              sessionBinding,
              id,
              hash('synthetic-csrf'),
              new Date(NOW.getTime() - 60_000),
              NOW,
              new Date(NOW.getTime() + 86_400_000),
            ],
          );
          actors[/** @type {string} */ (role)] = {
            actor: {
              id,
              kind: 'human',
              olistEnabled: true,
              capabilities: ['COMMERCIAL_ADMIN'],
            },
            sessionBinding,
            token,
            correlationId: 'synthetic-olist-runtime',
          };
        }
        /** @type {Array<{url:string,method:string}>} */
        const calls = [];
        const fetcher = /** @type {typeof fetch} */ (
          async (url, init) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET' });
            return new globalThis.Response(
              JSON.stringify({
                itens: [{ id: 7, nome: 'Vendedor sintético' }],
                paginacao: { offset: 0, total: 1, limit: 50 },
              }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          }
        );
        const access = {
          authorizeRead: async () => ({ actor: actors.admin.actor }),
          authorizeWrite: async () => ({ actor: actors.admin.actor }),
        };
        const runtime = createOlistApiRuntime(database, {
          access,
          environment,
          fetch: fetcher,
          clock: () => NOW,
        });
        return { actors, runtime, calls, access, fetcher };
      }

      await t.test(
        'OLIST-48/T17: audited pilot activation, replay, recovery and immediate disable',
        async () => {
          const f = await fixture();
          const runtime = createOlistApiRuntime(database, {
            access: f.access,
            environment: {
              ...environment,
              OLIST_PILOT_USER_IDS: f.actors.seller.actor.id,
            },
            fetch: async () => {
              throw new Error('Creation switch must not call ERP');
            },
            clock: () => NOW,
          });
          await runtime.settings({
            ...f.actors.admin,
            idempotencyKey: 'pilot-settings',
            expectedVersion: 0,
            settings: EMPTY_OLIST_SETTINGS,
            reason: 'Synthetic settings',
          });
          const enable = {
            ...f.actors.admin,
            idempotencyKey: 'pilot-enable',
            expectedVersion: 0,
            enabled: true,
            reason: 'Synthetic pilot',
          };
          await assert.rejects(runtime.creation(enable), {
            code: 'OLIST_CREATION_DISABLED',
          });
          await pool.query(
            'UPDATE crm.olist_accounts SET recovery_required=false WHERE account_key=$1',
            [config.accountKey],
          );
          await assert.rejects(
            runtime.creation({ ...enable, idempotencyKey: 'pilot-no-token' }),
            { code: 'OLIST_RECONNECT_REQUIRED' },
          );
          await pool.query(
            'UPDATE crm.olist_connections SET token_envelope=$2::jsonb,expires_at=$3 WHERE context_key=$1',
            [
              config.contextKey,
              JSON.stringify(
                seal(
                  {
                    accessToken: 'synthetic',
                    refreshToken: 'synthetic-refresh',
                  },
                  config.envelopeKey,
                  'tokens',
                  config.accountKey,
                  config.contextKey,
                ),
              ),
              new Date(NOW.getTime() + 3600_000),
            ],
          );
          await assert.rejects(
            runtime.creation({
              ...f.actors.finance,
              idempotencyKey: 'pilot-not-admin',
              expectedVersion: 0,
              enabled: true,
              reason: 'Synthetic',
            }),
            { code: 'FORBIDDEN' },
          );
          const activated = await runtime.creation({
            ...enable,
            idempotencyKey: 'pilot-enable-valid',
          });
          assert.equal(activated.creationEnabled, true);
          assert.equal(activated.recoveryRequired, false);
          assert.equal(activated.pilotConfigured, true);
          assert.equal(activated.version, 1);
          await pool.query(
            'UPDATE crm.olist_connections SET expires_at=$2 WHERE context_key=$1',
            [config.contextKey, new Date(NOW.getTime() - 1)],
          );
          assert.equal(
            (await runtime.status(f.actors.admin)).creationEnabled,
            true,
          );
          assert.equal(
            (await runtime.status(f.actors.admin)).creationActive,
            true,
          );
          await pool.query(
            'UPDATE crm.olist_connections SET expires_at=$2 WHERE context_key=$1',
            [config.contextKey, new Date(NOW.getTime() + 3600_000)],
          );
          assert.deepEqual(
            await runtime.creation({
              ...enable,
              idempotencyKey: 'pilot-enable-valid',
            }),
            activated,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM crm.olist_events WHERE event_code='OLIST_CREATION_ENABLED'",
              )
            ).rows[0].count,
            1,
          );
          await assert.rejects(
            runtime.creation({ ...enable, idempotencyKey: 'pilot-stale' }),
            { code: 'VERSION_CONFLICT' },
          );
          const concurrent = await Promise.allSettled(
            ['a', 'b'].map((suffix) =>
              runtime.creation({
                ...enable,
                idempotencyKey: 'pilot-race-' + suffix,
                expectedVersion: 1,
                enabled: false,
              }),
            ),
          );
          assert.equal(
            concurrent.filter((entry) => entry.status === 'fulfilled').length,
            1,
          );
          const rejected = concurrent.find(
            (entry) => entry.status === 'rejected',
          );
          assert.equal(
            rejected?.status === 'rejected' && rejected.reason.code,
            'VERSION_CONFLICT',
          );
          await runtime.creation({
            ...enable,
            idempotencyKey: 'pilot-reenable',
            expectedVersion: 2,
          });
          await pool.query(
            'UPDATE crm.olist_connections SET reconnect_required=true,token_envelope=NULL,expires_at=NULL,refresh_expires_at=NULL WHERE context_key=$1',
            [config.contextKey],
          );
          const offline = await runtime.status(f.actors.admin);
          assert.equal(offline.creationEnabled, false);
          // The switch remains visible, so an administrator can still turn it off.
          assert.equal(offline.creationActive, true);
          const disabled = await runtime.creation({
            ...enable,
            idempotencyKey: 'pilot-disable',
            expectedVersion: 3,
            enabled: false,
          });
          assert.equal(disabled.creationEnabled, false);
          assert.equal(disabled.version, 4);
          assert.equal(
            (
              await pool.query(
                'SELECT recovery_required,creation_enabled FROM crm.olist_accounts WHERE account_key=$1',
                [config.accountKey],
              )
            ).rows[0].creation_enabled,
            false,
          );
          assert.equal(f.calls.length, 0);
        },
      );

      /** Seed a confirmed legacy order owned by someone other than Financeiro.
       * Its encrypted ficha contains sentinels that must never reach projection.
       * @param {any} owner */
      async function seedOrder(owner) {
        const id = randomUUID();
        const contactId = randomUUID();
        await pool.query(
          `INSERT INTO crm.contacts(id,display_name,created_at,updated_at)
           VALUES($1,'Cliente privado sintético',$2,$2)`,
          [contactId, NOW],
        );
        const { rows } = await pool.query(
          `WITH next_number AS (SELECT nextval('crm.order_number_seq') AS value)
           INSERT INTO crm.orders(id,number_sequence,number,conversation_id,contact_id,manual_owner_id,manual_create_key,
             status,fab_code,ficha_envelope,missing_fields,final_amount_cents,payment_condition,order_date,
             confirmed_at,confirmed_by,created_by_kind,created_by,created_at,updated_at)
           SELECT $1,value,lpad(value::text,2,'0')||'-CRM',NULL,$2,$3,$4,
             'confirmado','SYNTHETIC',$5::jsonb,'{}',600,'pix','2026-11-05',$6,$3,'user',$3,$6,$6
           FROM next_number RETURNING id,number,status`,
          [
            id,
            contactId,
            owner.actor.id,
            randomUUID(),
            JSON.stringify(
              seal(
                {
                  summary: {
                    cliente: 'Cliente privado sintético',
                    telefone: '11999990000',
                  },
                  conversation: 'synthetic-private-conversation',
                  notes: 'synthetic-private-note',
                },
                config.envelopeKey,
                'synthetic-order',
                config.accountKey,
                id,
              ),
            ),
            NOW,
          ],
        );
        return rows[0];
      }

      await t.test(
        'enabled Financeiro and seller locate any owner by exact number/UUID without trusting legacy completeness or exposing PII',
        async () => {
          const { actors, runtime } = await fixture();
          const order = await seedOrder(actors.seller);
          for (const viewer of [actors.finance, actors.seller]) {
            const byNumber = await runtime.lookup({
              ...viewer,
              query: order.number,
            });
            const byId = await runtime.lookup({ ...viewer, query: order.id });
            assert.deepEqual(byId, byNumber);
            assert.deepEqual(Object.keys(byNumber).sort(), [
              'creationEnabled',
              'number',
              'operation',
              'orderId',
              'pendingFields',
              'status',
            ]);
            assert.equal(byNumber.status, 'confirmado');
            assert.equal(byNumber.creationEnabled, false);
            assert.deepEqual(byNumber.pendingFields, [
              {
                code: 'OLIST_CREATION_DISABLED',
                label: 'Geração Olist ainda indisponível.',
              },
            ]);
            assert.equal(byNumber.operation, null);
            assert.doesNotMatch(
              JSON.stringify(byNumber),
              /Cliente privado|11999990000|synthetic-private|ficha|contact|conversation|finalAmount/i,
            );
          }
          for (const query of [
            '1',
            'CRM',
            '%-CRM',
            '01-CRM OR TRUE',
            'Cliente privado sintético',
            'x'.repeat(65),
          ])
            await assert.rejects(runtime.lookup({ ...actors.finance, query }), {
              code: 'INVALID_REQUEST',
            });
          await assert.rejects(
            runtime.lookup({ ...actors.finance, query: randomUUID() }),
            { code: 'ORDER_NOT_FOUND' },
          );
        },
      );

      await t.test(
        'a forged/stale actor never bypasses current checkbox, disabled user, session or commercial profile restrictions',
        async () => {
          const { actors, runtime } = await fixture();
          const order = await seedOrder(actors.seller);
          await assert.rejects(
            runtime.lookup({ ...actors.admin, query: order.number }),
            { code: 'FORBIDDEN' },
          );
          await assert.rejects(
            runtime.lookup({ ...actors.disabled, query: order.number }),
            { code: 'FORBIDDEN' },
          );
          await assert.rejects(
            runtime.project({
              ...actors.finance,
              action: 'order.read',
              orderId: order.id,
            }),
            { code: 'FORBIDDEN' },
          );
          assert.equal(
            (
              await runtime.project({
                ...actors.admin,
                action: 'order.read',
                orderId: order.id,
              })
            ).orderId,
            order.id,
          );
          await pool.query(
            'UPDATE crm.users SET olist_enabled=false,olist_authorization_version=olist_authorization_version+1 WHERE id=$1',
            [actors.finance.actor.id],
          );
          await assert.rejects(
            runtime.lookup({ ...actors.finance, query: order.number }),
            { code: 'FORBIDDEN' },
          );
          await pool.query(
            'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
            [actors.seller.sessionBinding, NOW],
          );
          await assert.rejects(
            runtime.project({ ...actors.seller, orderId: order.id }),
            { code: 'FORBIDDEN' },
          );
        },
      );

      await t.test(
        'settings, authorize and disconnect replay atomically once; payload conflicts fail and JSON key order is immaterial',
        async () => {
          const { actors, runtime, calls } = await fixture();
          const settings = { ...EMPTY_OLIST_SETTINGS, sellerId: 11 };
          const command = {
            ...actors.admin,
            idempotencyKey: 'runtime-settings',
            expectedVersion: 0,
            reason: 'Synthetic settings',
            settings,
          };
          const saved = await runtime.settings(command);
          const reordered = Object.fromEntries(
            Object.entries(settings).toReversed(),
          );
          assert.deepEqual(
            await runtime.settings({ ...command, settings: reordered }),
            saved,
          );
          await assert.rejects(
            runtime.settings({
              ...command,
              settings: { ...settings, sellerId: 12 },
            }),
            { code: 'IDEMPOTENCY_KEY_REUSED' },
          );
          assert.equal(saved.settingsVersion, 1);
          const authorize = {
            ...actors.admin,
            idempotencyKey: 'runtime-authorize',
          };
          const links = await Promise.all([
            runtime.authorize(authorize),
            runtime.authorize(authorize),
          ]);
          assert.deepEqual(links[0], links[1]);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM crm.olist_oauth_states WHERE actor_id=$1',
                [actors.admin.actor.id],
              )
            ).rows[0].count,
            1,
          );
          const disconnect = {
            ...actors.admin,
            idempotencyKey: 'runtime-disconnect',
            expectedVersion: 0,
            reason: 'Synthetic disconnect',
          };
          const disconnected = await runtime.disconnect(disconnect);
          assert.deepEqual(await runtime.disconnect(disconnect), disconnected);
          assert.equal(disconnected.version, 1);
          assert.equal(disconnected.creationEnabled, false);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM crm.olist_events WHERE actor_id=$1 AND event_code='OLIST_DISCONNECTED'",
                [actors.admin.actor.id],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM crm.idempotency_records WHERE actor_id=$1',
                [actors.admin.actor.id],
              )
            ).rows[0].count,
            3,
          );
          assert.equal(
            calls.length,
            0,
            'administrative local commands must not contact the ERP',
          );
          await pool.query(
            'DELETE FROM crm.user_capabilities WHERE user_id=$1',
            [actors.admin.actor.id],
          );
          for (const operation of [
            () => runtime.settings(command),
            () => runtime.authorize(authorize),
            () => runtime.disconnect(disconnect),
          ])
            await assert.rejects(operation(), { code: 'FORBIDDEN' });
        },
      );

      await t.test(
        'missing idempotency configuration performs no connection or settings mutation',
        async () => {
          const { actors, access } = await fixture();
          const runtime = createOlistApiRuntime(database, {
            access,
            environment: { ...environment, IDEMPOTENCY_ENVELOPE_KEY: '' },
            clock: () => NOW,
          });
          await assert.rejects(
            runtime.settings({
              ...actors.admin,
              idempotencyKey: 'missing-key',
              expectedVersion: 0,
              reason: 'Synthetic',
              settings: EMPTY_OLIST_SETTINGS,
            }),
            { code: 'OLIST_NOT_CONFIGURED' },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM crm.olist_accounts',
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM crm.idempotency_records WHERE actor_id=$1',
                [actors.admin.actor.id],
              )
            ).rows[0].count,
            0,
          );
        },
      );

      await t.test(
        'failed idempotency completion rolls back settings, disconnect and OAuth state with their audits',
        async () => {
          const { actors, runtime, access } = await fixture();
          await runtime.settings({
            ...actors.admin,
            idempotencyKey: 'baseline',
            expectedVersion: 0,
            reason: 'Synthetic baseline',
            settings: { ...EMPTY_OLIST_SETTINGS, sellerId: 11 },
          });
          const sentinel = new Error(
            'Synthetic idempotency persistence failure',
          );
          const failedDatabase = {
            query: database.query,
            /** @template T @param {(client:any)=>Promise<T>} work */
            transaction: (work) =>
              withTransaction(pool, (client) =>
                work({
                  query: async (
                    /** @type {string} */ sql,
                    /** @type {unknown[]} */ values = [],
                  ) => {
                    if (/UPDATE crm\.idempotency_records/u.test(sql))
                      throw sentinel;
                    return client.query(sql, values);
                  },
                }),
              ),
          };
          const failed = createOlistApiRuntime(failedDatabase, {
            access,
            environment,
            clock: () => NOW,
          });
          async function persisted() {
            const connections = await pool.query(
              'SELECT * FROM crm.olist_connections WHERE context_key=$1',
              [config.contextKey],
            );
            const settings = await pool.query(
              'SELECT * FROM crm.olist_settings WHERE account_key=$1',
              [config.accountKey],
            );
            const states = await pool.query(
              'SELECT * FROM crm.olist_oauth_states WHERE actor_id=$1 ORDER BY state_hash',
              [actors.admin.actor.id],
            );
            const events = await pool.query(
              'SELECT * FROM crm.olist_events WHERE actor_id=$1 ORDER BY id',
              [actors.admin.actor.id],
            );
            const audits = await pool.query(
              "SELECT * FROM crm.audit_events WHERE actor_id=$1 AND action='olist.connection' ORDER BY id",
              [actors.admin.actor.id],
            );
            return [
              connections.rows,
              settings.rows,
              states.rows,
              events.rows,
              audits.rows,
            ];
          }
          const baseline = await persisted();
          const commands = [
            () =>
              failed.settings({
                ...actors.admin,
                idempotencyKey: 'failed-settings',
                expectedVersion: 1,
                reason: 'Synthetic change',
                settings: { ...EMPTY_OLIST_SETTINGS, sellerId: 22 },
              }),
            () =>
              failed.disconnect({
                ...actors.admin,
                idempotencyKey: 'failed-disconnect',
                expectedVersion: 0,
                reason: 'Synthetic disconnect',
              }),
            () =>
              failed.authorize({
                ...actors.admin,
                idempotencyKey: 'failed-authorize',
              }),
          ];
          for (const operation of commands) {
            await assert.rejects(operation(), sentinel);
            assert.deepEqual(await persisted(), baseline);
          }
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM crm.idempotency_records WHERE actor_id=$1 AND idempotency_key LIKE 'failed-%'",
                [actors.admin.actor.id],
              )
            ).rows[0].count,
            0,
          );
        },
      );

      await t.test(
        'catalog credentials require current administrator and mappings reject malformed UUID before a database cast',
        async () => {
          const { actors, runtime, calls } = await fixture();
          await runtime.authorize({
            ...actors.admin,
            idempotencyKey: 'lookup-setup',
          });
          await pool.query(
            'UPDATE crm.olist_connections SET token_envelope=$2::jsonb,expires_at=$3,reconnect_required=false WHERE context_key=$1',
            [
              config.contextKey,
              JSON.stringify(
                seal(
                  {
                    accessToken: 'synthetic-access',
                    refreshToken: 'synthetic-refresh',
                  },
                  config.envelopeKey,
                  'tokens',
                  config.accountKey,
                  config.contextKey,
                ),
              ),
              new Date(NOW.getTime() + 3_600_000),
            ],
          );
          const result = await runtime.lookups({
            ...actors.admin,
            kind: 'sellers',
          });
          assert.deepEqual(result, {
            items: [{ id: 7, name: 'Vendedor sintético' }],
          });
          assert.equal(calls.length, 1);
          assert.match(
            calls[0].url,
            /^https:\/\/api\.tiny\.com\.br\/public-api\/v3\/vendedores\?/u,
          );
          for (const viewer of [actors.finance, actors.disabled])
            await assert.rejects(
              runtime.lookups({ ...viewer, kind: 'sellers' }),
              { code: 'FORBIDDEN' },
            );
          for (const kind of [
            'https://elsewhere.example.test',
            '../pedidos',
            'delete',
          ])
            await assert.rejects(runtime.lookups({ ...actors.admin, kind }), {
              code: 'INVALID_REQUEST',
            });
          for (const resourceId of ['-'.repeat(36), 'abc', '../../private'])
            await assert.rejects(
              runtime.mappings({ ...actors.admin, resourceId }),
              { code: 'INVALID_REQUEST', statusCode: 400 },
            );
          await assert.rejects(
            runtime.mappings({ ...actors.admin, resourceId: randomUUID() }),
            { code: 'OLIST_RESOURCE_NOT_FOUND' },
          );
          assert.equal(calls.length, 1);
        },
      );

      await t.test(
        'createApi mounts the real runtime and its strict command body preserves local mutation and projection boundaries',
        async () => {
          const { actors, runtime } = await fixture();
          const api = createApi(
            {},
            {
              olist: runtime,
              logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
            },
          );
          const headers = {
            cookie: `crm_session=${actors.admin.token}; crm_csrf=synthetic-csrf`,
            origin: environment.APP_ORIGIN,
            'x-csrf-token': 'synthetic-csrf',
            'idempotency-key': 'mounted-settings',
          };
          try {
            const status = await api.inject({
              method: 'GET',
              url: '/api/v1/integrations/olist/status',
              headers,
            });
            assert.equal(status.statusCode, 200);
            assert.equal(status.json().creationEnabled, false);
            const response = await api.inject({
              method: 'POST',
              url: '/api/v1/integrations/olist/settings',
              headers,
              payload: {
                expectedVersion: 0,
                reason: 'Synthetic mounted command',
                settings: EMPTY_OLIST_SETTINGS,
              },
            });
            assert.equal(response.statusCode, 200);
            assert.equal(response.json().settingsVersion, 1);
            const injected = await api.inject({
              method: 'POST',
              url: '/api/v1/integrations/olist/settings',
              headers,
              payload: {
                expectedVersion: 1,
                reason: 'Synthetic',
                settings: EMPTY_OLIST_SETTINGS,
                actor: actors.seller.actor,
              },
            });
            assert.equal(injected.statusCode, 400);
            assert.match(
              injected.headers['content-type'] ?? '',
              /application\/problem\+json/u,
            );
            assert.equal(
              injected.headers['cache-control'],
              'private, no-store',
            );
          } finally {
            await api.close();
          }
        },
      );
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await pool.end();
    }
  });
} else {
  test(
    'Olist runtime PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
