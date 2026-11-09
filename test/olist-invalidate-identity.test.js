import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApi } from '../apps/api/src/app.js';
import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import { createOperationReadRuntime } from '../apps/api/src/operation-runtime.js';

// L1: the administrative invalidation is a WRITE. It runs through the REAL
// identity runtime (no fake authorizeWrite), so an action missing from
// OLIST_ACTIONS shows up here as a 403 for the administrator (sibling of the
// T14 read-set bug), and any other account stays refused.
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
const operationId = '00000000-0000-4000-8000-000000000019';
const url = '/api/v1/orders/' + orderId + '/olist/invalidate';
const payload = {
  operationId,
  expectedVersion: 3,
  reason: 'PRIVATE_INVALIDATION_REASON_CANARY',
};

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
/** The session token is the account name; its CSRF token is `csrf-<name>`. */
const csrfFor = (/** @type {string} */ name) => 'csrf-' + name;

/**
 * Database double: the session lookup receives the sha256 hex of the cookie
 * token, which selects the account row; the CSRF variant of the lookup also
 * carries the sha256 of the CSRF header and only matches the right pair.
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
            const name = sessions.get(String(args?.[0]));
            const csrfChecked = args?.length === 4;
            if (
              !name ||
              (csrfChecked && String(args[1]) !== sha256(csrfFor(name)))
            )
              return { rows: [] };
            current = name;
            return {
              rows: [
                {
                  user_id: name,
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

test('L1: invalidate authorizes through the real identity runtime for the administrator only', async (t) => {
  const database = accountDatabase();
  const identity = createIdentityApiRuntime(database, environment);
  const operations = createOperationReadRuntime(database, {
    identity,
    environment,
  });
  /** @type {any[]} */ const served = [];
  const api = createApi(
    {},
    {
      olist: {
        authorizeRead: operations.authorizeRead,
        authorizeWrite: operations.authorizeWrite,
        invalidate: async (/** @type {any} */ input) => {
          served.push(input);
          return {
            operationId: input.operationId,
            orderId: input.orderId,
            state: 'invalidated',
            version: input.expectedVersion + 1,
          };
        },
      },
    },
  );
  t.after(() => api.close());
  /** @param {string|null} token @param {string} [csrf] */
  const headersFor = (token, csrf = token ? csrfFor(token) : '') => ({
    origin,
    'sec-fetch-site': 'same-origin',
    'idempotency-key': 'olist-invalidate-identity',
    'x-csrf-token': csrf,
    ...(token ? { cookie: 'crm_session=' + token } : {}),
  });
  // The administrator invalidates with or without the Olist checkbox; an
  // enabled seller or Financeiro never does, whatever their checkbox says.
  const expected = /** @type {const} */ ([
    ['admin', 200],
    ['adminEnabled', 200],
    ['seller', 403],
    ['finance', 403],
  ]);
  for (const [name, status] of expected) {
    const response = await api.inject({
      method: 'POST',
      url,
      headers: headersFor(name),
      payload,
    });
    assert.equal(response.statusCode, status, name + ' ' + response.body);
    if (status === 200)
      assert.deepEqual(response.json(), {
        operationId,
        orderId,
        state: 'invalidated',
        version: 4,
      });
    else assert.equal(response.json().code, 'FORBIDDEN');
  }
  // Absent or unknown session, and a wrong CSRF token: 403, never data.
  for (const headers of [
    headersFor(null),
    headersFor('unknown-session'),
    headersFor('admin', 'forged-csrf-token'),
    headersFor('admin', ''),
  ]) {
    const response = await api.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 403, JSON.stringify(headers));
    assert.equal(response.json().code, 'FORBIDDEN');
  }
  // Same-origin only: a foreign Origin is refused even for the administrator.
  const foreign = await api.inject({
    method: 'POST',
    url,
    headers: {
      ...headersFor('admin'),
      origin: 'https://untrusted.example.test',
    },
    payload,
  });
  assert.equal(foreign.statusCode, 403);
  assert.deepEqual(
    served.map((input) => input.actor.id),
    ['admin', 'adminEnabled'],
  );
  // The command carries the current human actor and the session binding only.
  assert.equal(served[0].actor.kind, 'human');
  assert.equal(served[0].sessionBinding, sha256('admin'));
  assert.equal(served[0].operationId, operationId);
  assert.equal(served[0].expectedVersion, 3);
  assert.equal(served[0].idempotencyKey, 'olist-invalidate-identity');
});
