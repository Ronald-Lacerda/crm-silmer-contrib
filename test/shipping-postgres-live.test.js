import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createShippingApiRuntime } from '../apps/api/src/shipping-runtime.js';
import {
  loadMigrations,
  migrate,
  withTransaction,
} from '../modules/database/src/index.js';

// T138: dedicated synthetic PostgreSQL only. This suite resets crm/crm_meta.
const connectionString = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-01T12:00:00Z');
const INPUT = {
  actor: { id: 'shipping-admin', kind: 'human' },
  sessionBinding: 'a'.repeat(64),
  correlationId: 'shipping-live-synthetic',
};
const ENV = {
  MELHOR_ENVIO_ENABLED: 'true',
  MELHOR_ENVIO_ENVIRONMENT: 'sandbox',
  MELHOR_ENVIO_CLIENT_ID: '1234',
  MELHOR_ENVIO_CLIENT_SECRET: 'synthetic-client-secret',
  MELHOR_ENVIO_REDIRECT_URI: 'https://crm.example.test/melhor-envio',
  MELHOR_ENVIO_USER_AGENT: 'CRM Silmer (support@example.test)',
  MELHOR_ENVIO_ENVELOPE_KEY: Buffer.alloc(32, 19).toString('base64'),
};
const QUOTE = {
  fromPostalCode: '01001000',
  toPostalCode: '20040020',
  weightGrams: 800,
  widthCm: 15,
  heightCm: 10,
  lengthCm: 20,
  insuranceValueCents: 10000,
};
/** @param {unknown} value */
const reply = (value) => ({
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(value),
});

/** @param {Pool} pool */
function databaseFor(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (/** @type {any} */ work) => withTransaction(pool, work),
  };
}

if (!connectionString) {
  test(
    'Shipping PostgreSQL integration requires TEST_DATABASE_URL',
    { skip: true },
    () => {},
  );
} else {
  assert.equal(
    decodeURIComponent(new URL(connectionString).pathname.slice(1)),
    'crm_silmer_test',
    'Shipping tests may reset only the dedicated synthetic crm_silmer_test database',
  );
  const pool = new Pool({ connectionString, max: 8 });
  const db = databaseFor(pool);
  before(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await migrate(pool, { migrations: await loadMigrations() });
    await pool.query(
      "INSERT INTO crm.users(id,email,password_hash,name) VALUES('shipping-admin','shipping-admin@example.test','$argon2id$synthetic','Shipping Admin')",
    );
    await pool.query(
      "INSERT INTO crm.user_functions(user_id,function_name) VALUES('shipping-admin','Vendedor')",
    );
    // This is the first synthetic administrator in the freshly reset DB:
    // bootstrap grants have no granting user, matching identity-access.
    // Self-grants remain prohibited by user_capabilities_grant_separation_check.
    await pool.query(
      "INSERT INTO crm.user_capabilities(user_id,capability,granted_by) VALUES('shipping-admin','COMMERCIAL_ADMIN',NULL)",
    );
  });
  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS crm_meta CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS crm CASCADE');
    await pool.end();
  });

  test('T138: migrations, one-use state, multi-replica refresh, fencing and crash recovery use real PostgreSQL', async (t) => {
    /** @type {()=>void} */ let release = () => {};
    /** @type {()=>void} */ let began = () => {};
    /** @type {Promise<void>|null} */ let gate = null;
    let started = Promise.resolve();
    let tokenCalls = 0;
    let time = NOW;
    /** @param {string} url @param {RequestInit} init */
    const fetch = async (url, init) => {
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1;
        const body = JSON.parse(String(init.body));
        if (body.grant_type === 'refresh_token' && gate) {
          began();
          await gate;
        }
        return reply({
          access_token: `synthetic-access-${tokenCalls}`,
          refresh_token: `synthetic-refresh-${tokenCalls}`,
          expires_in: 10,
        });
      }
      return reply([
        {
          id: 1,
          name: 'PAC',
          company: { name: 'Correios' },
          price: '25.90',
          delivery_time: 5,
        },
      ]);
    };
    const runtime = createShippingApiRuntime(db, {
      access: {},
      environment: ENV,
      clock: () => time,
      fetch,
    });
    const replica = createShippingApiRuntime(db, {
      access: {},
      environment: ENV,
      clock: () => time,
      fetch,
    });
    async function connect() {
      const { authorizationUrl } = await runtime.authorize(INPUT);
      const state = new URL(authorizationUrl).searchParams.get('state');
      await runtime.complete({ ...INPUT, state, code: 'synthetic-code' });
      return state;
    }
    function pauseRefresh() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
      started = new Promise((resolve) => {
        began = resolve;
      });
    }
    async function connection() {
      return (await pool.query('SELECT * FROM crm.shipping_connections'))
        .rows[0];
    }

    await t.test(
      'migration accepts existing TEXT user ids; state is bound, consumed and tokens encrypted',
      async () => {
        const state = await connect();
        const row = await connection();
        assert.equal(row.connected_by, INPUT.actor.id);
        assert.equal(row.token_envelope.algorithm, 'AES-256-GCM');
        assert.ok(!JSON.stringify(row).includes('synthetic-access'));
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer AS count FROM crm.shipping_oauth_states',
            )
          ).rows[0].count,
          0,
        );
        const count = tokenCalls;
        await assert.rejects(
          runtime.complete({ ...INPUT, state, code: 'replay' }),
          { code: 'MELHOR_ENVIO_INVALID_STATE' },
        );
        assert.equal(tokenCalls, count);
      },
    );

    await t.test(
      'replicas claim exactly one refresh before network and disconnect wins over its late result',
      async () => {
        pauseRefresh();
        const count = tokenCalls;
        const pending = runtime.quote({ ...INPUT, body: QUOTE });
        await started;
        assert.ok((await connection()).refresh_started_at);
        await assert.rejects(replica.quote({ ...INPUT, body: QUOTE }), {
          code: 'MELHOR_ENVIO_REFRESH_IN_PROGRESS',
        });
        await replica.disconnect(INPUT);
        release();
        await assert.rejects(pending, {
          code: 'MELHOR_ENVIO_CONNECTION_CHANGED',
        });
        gate = null;
        assert.equal(tokenCalls, count + 1);
        assert.equal((await runtime.status(INPUT)).connected, false);
        assert.equal((await connection()).token_envelope, null);
      },
    );

    await t.test(
      'state consumed before a concurrent disconnect cannot reconnect or exchange the code',
      async () => {
        const { authorizationUrl } = await runtime.authorize(INPUT);
        const state = new URL(authorizationUrl).searchParams.get('state');
        const count = tokenCalls;
        const intercepted = {
          ...db,
          transaction: async (/** @type {any} */ work) => {
            let consumed = false;
            const result = await db.transaction(
              async (/** @type {any} */ client) =>
                work({
                  query: async (
                    /** @type {string} */ sql,
                    /** @type {any[]} */ values,
                  ) => {
                    const result = await client.query(sql, values);
                    if (sql.includes('RETURNING connection_version'))
                      consumed = true;
                    return result;
                  },
                }),
            );
            if (consumed) await replica.disconnect(INPUT);
            return result;
          },
        };
        const raced = createShippingApiRuntime(intercepted, {
          access: {},
          environment: ENV,
          clock: () => time,
          fetch,
        });
        await assert.rejects(
          raced.complete({ ...INPUT, state, code: 'synthetic-code' }),
          { code: 'MELHOR_ENVIO_CONNECTION_CHANGED' },
        );
        assert.equal(tokenCalls, count);
        assert.equal((await runtime.status(INPUT)).connected, false);
      },
    );

    await t.test(
      'rollback after a successful remote refresh leaves a durable attempt and prevents blind retry',
      async () => {
        await connect();
        const count = tokenCalls;
        await pool.query(
          `CREATE FUNCTION crm.shipping_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='SHIPPING_TOKEN_REFRESHED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
        );
        await pool.query(
          'CREATE TRIGGER shipping_test_audit_failure BEFORE INSERT ON crm.audit_events FOR EACH ROW EXECUTE FUNCTION crm.shipping_test_audit_failure()',
        );
        try {
          await assert.rejects(runtime.quote({ ...INPUT, body: QUOTE }));
          assert.ok((await connection()).refresh_started_at);
          await assert.rejects(replica.quote({ ...INPUT, body: QUOTE }), {
            code: 'MELHOR_ENVIO_REFRESH_IN_PROGRESS',
          });
          time = new Date(NOW.getTime() + 61_000);
          await assert.rejects(replica.quote({ ...INPUT, body: QUOTE }), {
            code: 'MELHOR_ENVIO_RECONNECT_REQUIRED',
          });
          assert.equal(tokenCalls, count + 1);
          assert.equal((await connection()).reconnect_required, true);
        } finally {
          await pool.query(
            'DROP TRIGGER shipping_test_audit_failure ON crm.audit_events',
          );
          await pool.query('DROP FUNCTION crm.shipping_test_audit_failure()');
        }
      },
    );

    await t.test(
      'a revoked admin cannot use server-held credentials',
      async () => {
        await connect();
        const count = tokenCalls;
        await pool.query(
          "DELETE FROM crm.user_capabilities WHERE user_id='shipping-admin'",
        );
        await assert.rejects(runtime.quote({ ...INPUT, body: QUOTE }), {
          code: 'FORBIDDEN',
        });
        assert.equal(tokenCalls, count);
      },
    );
  });
}
