import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';
import {
  createOlistConnection,
  olistConfiguration,
  EMPTY_OLIST_SETTINGS,
  open,
} from '../modules/olist/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const ACCOUNT_DOCUMENT = '12345678000199';
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 21).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 23).toString('base64'),
  OLIST_CLIENT_ID: 'synthetic-app',
  OLIST_CLIENT_SECRET: 'synthetic-client-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: ACCOUNT_DOCUMENT,
};
const hash = (/** @type {string} */ value) =>
  createHash('sha256').update(value).digest('hex');
const json = (/** @type {unknown} */ body) =>
  new globalThis.Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

function gate() {
  /** @type {() => void} */
  let resolve;
  const promise = new Promise((done) => {
    resolve = () => done(undefined);
  });
  return { promise, release: () => resolve() };
}

/** Fail promptly if a regression rejects before reaching the mock provider.
 * @param {ReturnType<typeof gate>} entered @param {Promise<unknown>} operation */
async function providerReached(entered, operation) {
  await Promise.race([
    entered.promise,
    operation.then(() => {
      throw new Error('Expected the provider exchange to remain in flight');
    }),
  ]);
}

if (connectionString) {
  test('OLIST-T04: PostgreSQL OAuth, refresh fencing, revocation and central settings', async (t) => {
    assert.equal(
      new URL(connectionString).pathname.slice(1),
      'crm_silmer_test',
      'Only the dedicated synthetic database may be reset',
    );
    const pool = new Pool({ connectionString, max: 8 });
    try {
      await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
      await migrate(pool, { migrations: await loadMigrations() });

      /** Every fixture isolates the account and uses synthetic actors/sessions.
       * @param {{expiresIn?:number, expectedDocument?:string, config?:ReturnType<typeof olistConfiguration>}} [options] */
      async function fixture(options = {}) {
        await pool.query('TRUNCATE crm.olist_accounts CASCADE');
        const userId = `olist-admin-${randomUUID()}`;
        const sessionBinding = hash(randomUUID());
        const otherSession = hash(randomUUID());
        await pool.query(
          `INSERT INTO crm.users(id,email,name,password_hash) VALUES($1,$2,'Sintético','$argon2id$synthetic')`,
          [userId, `${userId}@example.test`],
        );
        await pool.query(
          `INSERT INTO crm.user_functions(user_id,function_name) VALUES($1,'Vendedor')`,
          [userId],
        );
        await pool.query(
          `INSERT INTO crm.user_capabilities(user_id,capability) VALUES($1,'COMMERCIAL_ADMIN')`,
          [userId],
        );
        for (const session of [sessionBinding, otherSession])
          await pool.query(
            `INSERT INTO crm.sessions(token_hash,user_id,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              session,
              userId,
              hash('synthetic-csrf'),
              new Date(NOW.getTime() - 60_000),
              NOW,
              new Date(NOW.getTime() + 86_400_000),
            ],
          );
        let now = NOW;
        let activeTransactions = 0;
        /** @type {Array<{url:string,grant:string|null}>} */
        const calls = [];
        const config = options.config ?? olistConfiguration(environment);
        /** @type {(url:string, init:RequestInit) => Promise<Response>} */
        let respond = async (url) =>
          url.endsWith('/token')
            ? json({
                access_token: 'synthetic-access',
                refresh_token: 'synthetic-refresh',
                expires_in: options.expiresIn ?? 3600,
                refresh_expires_in: 86400,
              })
            : json({ cpfCnpj: options.expectedDocument ?? ACCOUNT_DOCUMENT });
        const database = {
          query: (
            /** @type {string} */ sql,
            /** @type {unknown[]} */ values = [],
          ) => pool.query(sql, values),
          /** @template T @param {(client:import('pg').PoolClient) => Promise<T>} work */
          transaction: async (work) => {
            activeTransactions += 1;
            try {
              return await withTransaction(pool, work);
            } finally {
              activeTransactions -= 1;
            }
          },
        };
        const fetcher = /** @type {typeof fetch} */ (
          async (url, init) => {
            assert.equal(
              activeTransactions,
              0,
              'HTTP must start after every owning SQL transaction commits',
            );
            // A second connection can take the same row immediately. This also
            // catches HTTP hidden inside a SQL transaction holding the row lock.
            await withTransaction(pool, (client) =>
              client.query(
                'SELECT context_key FROM crm.olist_connections WHERE context_key=$1 FOR UPDATE NOWAIT',
                [config.contextKey],
              ),
            );
            const href = String(url);
            const grant =
              init?.body instanceof globalThis.URLSearchParams
                ? init.body.get('grant_type')
                : null;
            calls.push({ url: href, grant });
            return respond(href, init ?? {});
          }
        );
        const connection = createOlistConnection(database, {
          config,
          fetch: fetcher,
          clock: () => now,
        });
        const replica = createOlistConnection(database, {
          config,
          fetch: fetcher,
          clock: () => now,
        });
        const input = {
          actor: { id: userId, kind: 'human' },
          sessionBinding,
          correlationId: 'synthetic-olist-connection',
        };
        async function authorize() {
          const result = await connection.authorize(input);
          const state = new URL(result.authorizationUrl).searchParams.get(
            'state',
          );
          assert.ok(state);
          return state;
        }
        async function connect() {
          const state = await authorize();
          return connection.complete({
            ...input,
            state,
            code: 'synthetic-code',
          });
        }
        async function row() {
          return (
            await pool.query(
              'SELECT * FROM crm.olist_connections WHERE context_key=$1',
              [config.contextKey],
            )
          ).rows[0];
        }
        return {
          connection,
          replica,
          input,
          config,
          calls,
          otherSession,
          userId,
          authorize,
          connect,
          row,
          setTime: (/** @type {Date} */ next) => {
            now = next;
          },
          responder: (/** @type {typeof respond} */ handler) => {
            respond = handler;
          },
        };
      }

      await t.test(
        'missing deployment configuration leaves startup safe and performs no HTTP',
        async () => {
          const f = await fixture({ config: olistConfiguration({}) });
          const status = await f.connection.status(f.input);
          assert.equal(status.configured, false);
          assert.equal(status.connected, false);
          assert.equal(status.creationEnabled, false);
          await assert.rejects(f.connection.authorize(f.input), {
            code: 'OLIST_NOT_CONFIGURED',
          });
          await assert.rejects(f.connection.credentials(f.input), {
            code: 'OLIST_NOT_CONFIGURED',
          });
          assert.equal(f.calls.length, 0);
        },
      );

      await t.test(
        'state binds the exact live session, is consumed once, and stores only encrypted tokens',
        async () => {
          const f = await fixture();
          const state = await f.authorize();
          await assert.rejects(
            f.connection.complete({
              ...f.input,
              sessionBinding: f.otherSession,
              state,
              code: 'synthetic-code',
            }),
            { code: 'OLIST_INVALID_STATE' },
          );
          assert.equal(f.calls.length, 0);
          const status = await f.connection.complete({
            ...f.input,
            state,
            code: 'synthetic-code',
          });
          assert.equal(status.connected, true);
          assert.equal(status.creationEnabled, false);
          assert.equal(f.calls.length, 2);
          await assert.rejects(
            f.connection.complete({
              ...f.input,
              state,
              code: 'synthetic-code',
            }),
            { code: 'OLIST_INVALID_STATE' },
          );
          assert.equal(f.calls.length, 2);
          const row = await f.row();
          assert.doesNotMatch(
            JSON.stringify(row),
            /synthetic-access|synthetic-refresh|synthetic-client-secret/,
          );
          assert.deepEqual(
            open(
              row.token_envelope,
              f.config.envelopeKey,
              'tokens',
              f.config.accountKey,
              f.config.contextKey,
            ),
            {
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
            },
          );
          const events = await pool.query(
            'SELECT event_code FROM crm.olist_events ORDER BY occurred_at,id',
          );
          assert.deepEqual(
            new Set(events.rows.map((entry) => entry.event_code)),
            new Set(['OLIST_CONNECT_RESERVED', 'OLIST_CONNECTED']),
          );
        },
      );

      await t.test(
        'expired state commits its consumption without reaching the provider',
        async () => {
          const f = await fixture();
          const state = await f.authorize();
          f.setTime(new Date(NOW.getTime() + 601_000));
          await assert.rejects(
            f.connection.complete({
              ...f.input,
              state,
              code: 'synthetic-code',
            }),
            { code: 'OLIST_INVALID_STATE' },
          );
          assert.equal(f.calls.length, 0);
          const count = await pool.query(
            'SELECT count(*)::integer AS count FROM crm.olist_oauth_states',
          );
          assert.equal(count.rows[0].count, 0);
        },
      );

      await t.test(
        'the account identity returned by /info must match before tokens can be installed',
        async () => {
          const f = await fixture({ expectedDocument: '98765432000188' });
          await assert.rejects(f.connect(), { code: 'OLIST_ACCOUNT_MISMATCH' });
          const row = await f.row();
          assert.equal(row.token_envelope, null);
          assert.equal(row.reconnect_required, true);
          assert.equal((await f.connection.status(f.input)).connected, false);
        },
      );

      await t.test(
        'two API/worker replicas reserve one refresh and persist the rotated pair atomically',
        async () => {
          const f = await fixture({ expiresIn: 10 });
          await f.connect();
          const entered = gate();
          const resume = gate();
          f.responder(async (url, init) => {
            if (url.endsWith('/token')) {
              assert.equal(
                /** @type {URLSearchParams} */ (init.body).get('grant_type'),
                'refresh_token',
              );
              entered.release();
              await resume.promise;
              return json({
                access_token: 'synthetic-rotated-access',
                refresh_token: 'synthetic-rotated-refresh',
                expires_in: 3600,
                refresh_expires_in: 86400,
              });
            }
            return json({ cpfCnpj: ACCOUNT_DOCUMENT });
          });
          const first = f.connection.credentials(f.input);
          try {
            await providerReached(entered, first);
            await assert.rejects(f.replica.credentials(f.input), {
              code: 'OLIST_REFRESH_IN_PROGRESS',
            });
          } finally {
            resume.release();
          }
          const result = await first;
          assert.equal(result.token, 'synthetic-rotated-access');
          assert.equal(
            f.calls.filter((call) => call.grant === 'refresh_token').length,
            1,
          );
          const row = await f.row();
          assert.equal(row.refresh_nonce, null);
          assert.equal(row.refresh_started_at, null);
          assert.deepEqual(
            open(
              row.token_envelope,
              f.config.envelopeKey,
              'tokens',
              f.config.accountKey,
              f.config.contextKey,
            ),
            {
              accessToken: 'synthetic-rotated-access',
              refreshToken: 'synthetic-rotated-refresh',
            },
          );
        },
      );

      await t.test(
        'disconnect fences a late refresh response and never resurrects its credentials',
        async () => {
          const f = await fixture({ expiresIn: 10 });
          await f.connect();
          const entered = gate();
          const resume = gate();
          f.responder(async (url) => {
            if (url.endsWith('/token')) {
              entered.release();
              await resume.promise;
              return json({
                access_token: 'synthetic-late-access',
                refresh_token: 'synthetic-late-refresh',
                expires_in: 3600,
              });
            }
            return json({ cpfCnpj: ACCOUNT_DOCUMENT });
          });
          const refreshing = f.connection.credentials(f.input);
          const outcome = assert.rejects(refreshing, {
            code: 'OLIST_CONNECTION_CHANGED',
          });
          try {
            await providerReached(entered, refreshing);
            const before = await f.connection.status(f.input);
            const disconnected = await f.replica.disconnect({
              ...f.input,
              expectedVersion: before.version,
              reason: 'Synthetic disconnect',
            });
            assert.equal(disconnected.connected, false);
          } finally {
            resume.release();
          }
          await outcome;
          const row = await f.row();
          assert.equal(row.token_envelope, null);
          assert.equal(row.exchange_nonce, null);
          assert.equal(row.refresh_nonce, null);
        },
      );

      for (const revocation of ['privilege', 'session']) {
        await t.test(
          `${revocation} revocation during code exchange prevents late token installation`,
          async () => {
            const f = await fixture();
            const state = await f.authorize();
            const entered = gate();
            const resume = gate();
            f.responder(async (url) => {
              if (url.endsWith('/token')) {
                entered.release();
                await resume.promise;
                return json({
                  access_token: 'synthetic-revoked-access',
                  refresh_token: 'synthetic-revoked-refresh',
                  expires_in: 3600,
                });
              }
              return json({ cpfCnpj: ACCOUNT_DOCUMENT });
            });
            const completing = f.connection.complete({
              ...f.input,
              state,
              code: 'synthetic-code',
            });
            const outcome = assert.rejects(completing, { code: 'FORBIDDEN' });
            try {
              await providerReached(entered, completing);
              if (revocation === 'privilege')
                await pool.query(
                  'DELETE FROM crm.user_capabilities WHERE user_id=$1',
                  [f.userId],
                );
              else
                await pool.query(
                  'UPDATE crm.sessions SET revoked_at=$2 WHERE token_hash=$1',
                  [f.input.sessionBinding, NOW],
                );
            } finally {
              resume.release();
            }
            await outcome;
            const row = await f.row();
            assert.equal(row.token_envelope, null);
            assert.equal(row.reconnect_required, true);
            assert.equal(row.exchange_nonce, null);
          },
        );
      }

      await t.test(
        'an abandoned refresh claim requires reconnect and cannot be retried automatically',
        async () => {
          const f = await fixture({ expiresIn: 10 });
          await f.connect();
          await pool.query(
            'UPDATE crm.olist_connections SET refresh_nonce=$2,refresh_started_at=$3,version=version+1 WHERE context_key=$1',
            [
              f.config.contextKey,
              randomUUID(),
              new Date(NOW.getTime() - 61_000),
            ],
          );
          const calls = f.calls.length;
          assert.equal(
            (await f.connection.status(f.input)).reconnectRequired,
            true,
          );
          await assert.rejects(f.connection.credentials(f.input), {
            code: 'OLIST_RECONNECT_REQUIRED',
          });
          await assert.rejects(f.replica.credentials(f.input), {
            code: 'OLIST_RECONNECT_REQUIRED',
          });
          assert.equal(f.calls.length, calls);
          const row = await f.row();
          assert.equal(row.token_envelope, null);
          assert.equal(row.refresh_nonce, null);
          assert.equal(row.reconnect_required, true);
        },
      );

      await t.test(
        'central settings use encrypted storage and concurrent version compare-and-set',
        async () => {
          const f = await fixture();
          const settings = {
            ...EMPTY_OLIST_SETTINGS,
            sellerId: 7,
            originId: 8,
            paymentTerms: 'Synthetic terms',
            purchaseOrder: 'SYNTHETIC-PO',
          };
          const first = await f.connection.settings({
            ...f.input,
            settings,
            expectedVersion: 0,
            reason: 'Synthetic settings',
          });
          assert.equal(first.settingsVersion, 1);
          assert.deepEqual(first.settings, settings);
          const stored = (
            await pool.query(
              'SELECT settings_envelope FROM crm.olist_settings WHERE account_key=$1',
              [f.config.accountKey],
            )
          ).rows[0];
          assert.doesNotMatch(
            JSON.stringify(stored),
            /Synthetic terms|SYNTHETIC-PO|sellerId/,
          );
          const outcomes = await Promise.allSettled([
            f.connection.settings({
              ...f.input,
              settings: { ...settings, sellerId: 9 },
              expectedVersion: 1,
              reason: 'Synthetic concurrent settings',
            }),
            f.replica.settings({
              ...f.input,
              settings: { ...settings, sellerId: 10 },
              expectedVersion: 1,
              reason: 'Synthetic concurrent settings',
            }),
          ]);
          assert.equal(
            outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
            1,
          );
          const rejected = outcomes.find(
            (outcome) => outcome.status === 'rejected',
          );
          assert.equal(
            rejected?.status === 'rejected' && rejected.reason.code,
            'VERSION_CONFLICT',
          );
          assert.equal((await f.connection.status(f.input)).settingsVersion, 2);
          assert.equal(f.calls.length, 0);
        },
      );
    } finally {
      await pool.end();
    }
  });
} else {
  test(
    'OLIST-T04 PostgreSQL connection tests require TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
}
