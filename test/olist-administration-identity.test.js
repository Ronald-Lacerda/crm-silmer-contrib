import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import { createOperationReadRuntime } from '../apps/api/src/operation-runtime.js';

// T14: the two administrative Olist GETs run through the REAL identity runtime
// (no fake authorizeRead), so an action missing from the operational read set
// shows up here as a 403 for the administrator.
const origin = 'https://crm.example.test';
const encodedKey = Buffer.alloc(32, 17).toString('base64url');
const environment = {
  APP_ORIGIN: origin,
  AUTH_THROTTLE_HMAC_KEY: encodedKey,
  IDEMPOTENCY_ENVELOPE_KEY: encodedKey,
  IDENTITY_BOOTSTRAP_TOKEN: 'synthetic-bootstrap-token-with-32-characters',
  CONTACT_IDENTITY_ENVELOPE_KEY: encodedKey,
  CONTACT_IDENTITY_LOOKUP_KEY: encodedKey,
  HANDOFF_ENVELOPE_KEY: encodedKey,
  INBOX_MESSAGE_ENVELOPE_KEY: encodedKey,
  OPERATION_CURSOR_HMAC_KEY: encodedKey,
};
const orderId = 'synthetic-order';
const requestId = '00000000-0000-4000-8000-000000000009';
const prefix = '/api/v1/orders/' + orderId + '/olist';
const urls = [
  prefix + '/administration',
  prefix + '/reconciliations/' + requestId,
];

/** @type {Record<string, {functionName: string, capabilities: string[], olistEnabled: boolean}>} */
const accounts = {
  admin: {
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
    olistEnabled: false,
  },
  adminEnabled: {
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
    olistEnabled: true,
  },
  seller: { functionName: 'Vendedor', capabilities: [], olistEnabled: true },
  finance: { functionName: 'Financeiro', capabilities: [], olistEnabled: true },
};

/** @param {string} value */
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Database double: the session cookie token is the account name; the session
 * lookup receives its sha256 hex, which selects the account row.
 */
function accountDatabase() {
  const sessions = new Map(
    Object.keys(accounts).map((name) => [sha256(name), name]),
  );
  /** @type {any} */
  const value = {
    query: async () => ({ rows: [] }),
    transaction: async (/** @type {any} */ work) => {
      /** @type {string|undefined} */
      let current;
      return work({
        query: async (/** @type {string} */ sql, /** @type {any[]} */ args) => {
          if (sql.includes('UPDATE crm.sessions AS s')) {
            current = sessions.get(String(args?.[0]));
            if (!current) return { rows: [] };
            return {
              rows: [
                {
                  user_id: current,
                  token_hash: 'a'.repeat(64),
                  csrf_hash: 'b'.repeat(64),
                  created_at: '2026-11-05T12:00:00Z',
                  last_seen_at: '2026-11-05T12:00:00Z',
                  absolute_expires_at: '2030-01-01T00:00:00Z',
                  revoked_at: null,
                },
              ],
            };
          }
          if (sql.includes('FROM crm.users AS u') && current) {
            const account = accounts[current];
            return {
              rows: [
                {
                  id: current,
                  email: current + '@example.test',
                  name: 'Sintético',
                  function_name: account.functionName,
                  capabilities: account.capabilities,
                  disabled_at: null,
                  created_at: '2026-11-05T12:00:00Z',
                  password_hash: 'synthetic',
                  olist_enabled: account.olistEnabled,
                  olist_authorization_version: 1,
                },
              ],
            };
          }
          return { rows: [] };
        },
      });
    },
  };
  return value;
}

test('T14: administrative Olist reads authorize through the real identity runtime', async (t) => {
  const database = accountDatabase();
  const identity = createIdentityApiRuntime(database, environment);
  const operations = createOperationReadRuntime(database, {
    identity,
    environment,
  });
  /** @type {string[]} */ const served = [];
  const api = createApi(
    {},
    {
      olist: {
        authorizeRead: operations.authorizeRead,
        authorizeWrite: operations.authorizeWrite,
        administration: async (/** @type {any} */ input) => {
          served.push('administration');
          return { orderId: input.orderId, creationEnabled: false };
        },
        readReconciliation: async (/** @type {any} */ input) => {
          served.push('readReconciliation');
          return { requestId: input.requestId, state: 'pending' };
        },
      },
    },
  );
  t.after(() => api.close());
  /** @param {string|null} token */
  const headersFor = (token) => ({
    origin,
    'sec-fetch-site': 'same-origin',
    ...(token ? { cookie: 'crm_session=' + token } : {}),
  });
  // Administrator reads the diagnostic with or without the Olist checkbox;
  // nobody else does, whatever their checkbox says.
  const expected = /** @type {const} */ ([
    ['admin', 200],
    ['adminEnabled', 200],
    ['seller', 403],
    ['finance', 403],
  ]);
  for (const url of urls) {
    for (const [name, status] of expected) {
      const response = await api.inject({
        method: 'GET',
        url,
        headers: headersFor(name),
      });
      assert.equal(response.statusCode, status, name + ' ' + url);
      if (status === 403) assert.equal(response.json().code, 'FORBIDDEN');
    }
    // Absent or unknown session: the Olist routes answer 403 (never data).
    for (const token of [null, 'unknown-session']) {
      const response = await api.inject({
        method: 'GET',
        url,
        headers: headersFor(token),
      });
      assert.equal(response.statusCode, 403, String(token));
      assert.equal(response.json().code, 'FORBIDDEN');
    }
  }
  assert.deepEqual(served, [
    'administration',
    'administration',
    'readReconciliation',
    'readReconciliation',
  ]);
});

test('Olist projection falls back to order.read for the real administrator session without the export checkbox', async (t) => {
  const database = accountDatabase(),
    identity = createIdentityApiRuntime(database, environment),
    operations = createOperationReadRuntime(database, {
      identity,
      environment,
    });
  /** @type {any[]} */ const served = [];
  const api = createApi(
    {},
    {
      olist: {
        authorizeRead: operations.authorizeRead,
        project: async (/** @type {any} */ input) => {
          served.push(input);
          return { orderId: input.orderId, creationEnabled: false };
        },
      },
    },
  );
  t.after(() => api.close());
  for (const context of [
    { origin, 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' },
  ]) {
    const response = await api.inject({
      url: prefix,
      headers: { ...context, cookie: 'crm_session=admin' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(served.at(-1).action, 'order.read');
    assert.equal(served.at(-1).actor.olistEnabled, false);
  }
  for (const context of [
    { 'sec-fetch-site': 'cross-site' },
    {
      origin: 'https://untrusted.example.test',
      'sec-fetch-site': 'same-origin',
    },
  ]) {
    assert.equal(
      (
        await api.inject({
          url: prefix,
          headers: { ...context, cookie: 'crm_session=admin' },
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(served.length, 3);
});
