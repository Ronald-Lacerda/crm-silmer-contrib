import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerIdentityRoutes } from '../apps/api/src/identity-routes.js';
import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import {
  authorize,
  createIdentityAccessService,
  createInMemoryIdentityRepository,
  createPostgresIdentityRepository,
} from '../modules/identity-access/src/index.js';

const origin = 'https://crm.example.test';
const encodedKey = Buffer.alloc(32, 17).toString('base64url');
const environment = {
  APP_ORIGIN: origin,
  AUTH_THROTTLE_HMAC_KEY: encodedKey,
  IDEMPOTENCY_ENVELOPE_KEY: encodedKey,
  IDENTITY_BOOTSTRAP_TOKEN: 'synthetic-bootstrap-token-with-32-characters',
};

test('OLIST-T19: checkbox is independent of role and never grants commercial or administrative access', () => {
  for (const functionName of /** @type {const} */ ([
    'Vendedor',
    'Financeiro',
  ])) {
    for (const admin of [false, true]) {
      const actor = {
        id: 'human',
        functionName,
        capabilities: /** @type {Array<'COMMERCIAL_ADMIN'>} */ (
          admin ? ['COMMERCIAL_ADMIN'] : []
        ),
      };
      for (const action of ['olist.read', 'olist.export']) {
        assert.throws(() => authorize(actor, action), { code: 'FORBIDDEN' });
        assert.doesNotThrow(() =>
          authorize({ ...actor, olistEnabled: true }, action),
        );
        assert.throws(
          () =>
            authorize(
              {
                ...actor,
                olistEnabled: true,
                disabledAt: '2026-11-05T12:00:00Z',
              },
              action,
            ),
          { code: 'FORBIDDEN' },
        );
        assert.throws(
          () =>
            authorize(
              { ...actor, olistEnabled: true, kind: 'assistant' },
              action,
            ),
          { code: 'FORBIDDEN' },
        );
      }
      for (const action of ['olist.manage', 'olist.link', 'olist.reconcile']) {
        if (functionName === 'Vendedor' && admin)
          assert.doesNotThrow(() => authorize(actor, action));
        else
          assert.throws(
            () => authorize({ ...actor, olistEnabled: true }, action),
            { code: 'FORBIDDEN' },
          );
      }
      if (functionName === 'Financeiro') {
        for (const action of [
          'order.read',
          'order.edit',
          'conversation.read',
          'user.manage',
        ])
          assert.throws(
            () => authorize({ ...actor, olistEnabled: true }, action),
            { code: 'FORBIDDEN' },
          );
      }
    }
  }
});

async function domainHarness() {
  let sequence = 0;
  /** @type {any[]} */
  const events = [];
  const repository = createInMemoryIdentityRepository();
  const service = createIdentityAccessService({
    repository,
    auditPort: {
      append: async (event) => {
        events.push(event);
      },
    },
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    passwordParameters: { memory: 64, parallelism: 2, passes: 2 },
  });
  const { user: admin } = await service.bootstrapAdmin({
    correlationId: 'bootstrap',
    email: 'admin@example.test',
    name: 'Admin',
    password: 'synthetic-password',
    reason: 'Synthetic setup',
  });
  const base = {
    actorId: admin.id,
    correlationId: 'change',
    reason: 'Synthetic authorization',
  };
  return { service, repository, admin, base, events };
}

test('OLIST-T19: default false, versioned grants, stale version rejection, safe audit and no self-enable', async () => {
  const { service, admin, base, events } = await domainHarness();
  assert.equal(admin.olistEnabled, false);
  assert.equal(admin.olistAuthorizationVersion, 0);
  const { user } = await service.createOperationalUser({
    ...base,
    email: 'finance@example.test',
    name: 'Equipe',
    password: 'synthetic-password',
    accessType: 'finance',
  });
  assert.equal(user.olistEnabled, false);
  assert.equal(user.olistAuthorizationVersion, 0);
  const first = await service.updateUser({
    ...base,
    targetId: user.id,
    olistEnabled: true,
    expectedOlistAuthorizationVersion: 0,
  });
  assert.equal(first.user.olistEnabled, true);
  assert.equal(first.user.olistAuthorizationVersion, 1);
  assert.equal(first.user.functionName, 'Financeiro');
  assert.deepEqual(first.user.capabilities, []);
  await assert.rejects(
    service.updateUser({
      ...base,
      targetId: user.id,
      olistEnabled: false,
      expectedOlistAuthorizationVersion: 0,
    }),
    { code: 'VERSION_CONFLICT' },
  );
  await assert.rejects(
    service.updateUser({ ...base, targetId: user.id, olistEnabled: false }),
    { code: 'INVALID_REQUEST' },
  );
  await assert.rejects(
    service.updateUser({
      ...base,
      targetId: admin.id,
      olistEnabled: true,
      expectedOlistAuthorizationVersion: 0,
    }),
    { code: 'FORBIDDEN' },
  );
  const unchanged = await service.updateUser({
    ...base,
    targetId: user.id,
    olistEnabled: true,
    expectedOlistAuthorizationVersion: 1,
  });
  assert.equal(unchanged.user.olistAuthorizationVersion, 1);
  const last = await service.updateUser({
    ...base,
    targetId: user.id,
    olistEnabled: false,
    expectedOlistAuthorizationVersion: 1,
  });
  assert.equal(last.user.olistAuthorizationVersion, 2);
  assert.equal(last.user.olistEnabled, false);
  const audit = events.filter((event) =>
    event.action.startsWith('identity.user.olist.'),
  );
  assert.deepEqual(
    audit.map((event) => [event.action, event.version]),
    [
      ['identity.user.olist.enabled', 1],
      ['identity.user.olist.disabled', 2],
    ],
  );
  assert.doesNotMatch(JSON.stringify(audit), /@|synthetic-password/);
});

test('OLIST-T19: initial grant is explicit, admins may revoke own grant and non-admins cannot grant', async () => {
  const { service, admin, base } = await domainHarness();
  const { user: second } = await service.createOperationalUser({
    ...base,
    email: 'second@example.test',
    name: 'Segundo',
    password: 'synthetic-password',
    accessType: 'admin',
    olistEnabled: true,
  });
  assert.equal(second.olistEnabled, true);
  assert.equal(second.olistAuthorizationVersion, 1);
  const self = await service.updateUser({
    ...base,
    actorId: second.id,
    targetId: second.id,
    olistEnabled: false,
    expectedOlistAuthorizationVersion: 1,
  });
  assert.equal(self.user.olistEnabled, false);
  const { user: seller } = await service.createOperationalUser({
    ...base,
    email: 'seller@example.test',
    name: 'Vendedor',
    password: 'synthetic-password',
  });
  await assert.rejects(
    service.updateUser({
      ...base,
      actorId: seller.id,
      targetId: admin.id,
      olistEnabled: true,
      expectedOlistAuthorizationVersion: 0,
    }),
    { code: 'FORBIDDEN' },
  );
});

test('OLIST-T19: HTTP checkbox accepts booleans and requires an integer revision on PATCH', async () => {
  const api = Fastify();
  /** @type {any[]} */
  const calls = [];
  registerIdentityRoutes(
    api,
    {
      allowedOrigins: [origin],
      createUser: async (/** @type {any} */ input) => {
        calls.push(input);
        return { user: {} };
      },
      updateUser: async (/** @type {any} */ input) => {
        if (input.expectedOlistAuthorizationVersion === 99)
          throw Object.assign(new Error('Synthetic stale revision'), {
            code: 'VERSION_CONFLICT',
            statusCode: 409,
          });
        calls.push(input);
        return { user: {} };
      },
    },
    () => ({ correlationId: 'synthetic' }),
  );
  const headers = {
    origin,
    cookie: 'crm_session=opaque; crm_csrf=csrf',
    'x-csrf-token': 'csrf',
    'idempotency-key': 'synthetic-key',
  };
  try {
    const created = await api.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers,
      payload: {
        name: 'Equipe',
        email: 'team@example.test',
        password: 'synthetic',
        reason: 'Synthetic',
        olistEnabled: true,
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(calls[0].olistEnabled, true);
    const changed = await api.inject({
      method: 'PATCH',
      url: '/api/v1/users/target',
      headers,
      payload: {
        reason: 'Synthetic',
        olistEnabled: false,
        expectedOlistAuthorizationVersion: 4,
      },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(calls[1].expectedOlistAuthorizationVersion, 4);
    const before = calls.length;
    for (const patch of [
      { olistEnabled: true },
      { olistEnabled: 'false', expectedOlistAuthorizationVersion: 0 },
      { olistEnabled: false, expectedOlistAuthorizationVersion: -1 },
      { olistEnabled: false, expectedOlistAuthorizationVersion: 0.5 },
      { olistEnabled: false, expectedOlistAuthorizationVersion: '0' },
      { expectedOlistAuthorizationVersion: 0, name: 'Equipe' },
    ]) {
      const response = await api.inject({
        method: 'PATCH',
        url: '/api/v1/users/target',
        headers,
        payload: { reason: 'Synthetic', ...patch },
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.length, before);
    const stale = await api.inject({
      method: 'PATCH',
      url: '/api/v1/users/target',
      headers,
      payload: {
        reason: 'Synthetic',
        olistEnabled: true,
        expectedOlistAuthorizationVersion: 99,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
  } finally {
    await api.close();
  }
});

test('OLIST-T19: current sessions observe live authorization revocation and carry authorization revision', async () => {
  let enabled = true;
  let version = 4;
  /** @type {any} */
  const database = {
    query: async () => ({ rows: [] }),
    transaction: async (/** @type {any} */ work) =>
      work({
        query: async (/** @type {string} */ sql) => {
          if (sql.includes('UPDATE crm.sessions AS s'))
            return {
              rows: [
                {
                  user_id: 'actor',
                  token_hash: 'a'.repeat(64),
                  csrf_hash: 'b'.repeat(64),
                  created_at: '2026-11-05T12:00:00Z',
                  last_seen_at: '2026-11-05T12:00:00Z',
                  absolute_expires_at: '2030-01-01T00:00:00Z',
                  revoked_at: null,
                },
              ],
            };
          if (sql.includes('FROM crm.users AS u'))
            return {
              rows: [
                {
                  id: 'actor',
                  email: 'finance@example.test',
                  name: 'Equipe',
                  function_name: 'Financeiro',
                  capabilities: [],
                  disabled_at: null,
                  created_at: '2026-11-05T12:00:00Z',
                  password_hash: 'synthetic',
                  olist_enabled: enabled,
                  olist_authorization_version: version,
                },
              ],
            };
          return { rows: [] };
        },
      }),
  };
  const identity = createIdentityApiRuntime(database, environment);
  const input = {
    action: 'olist.export',
    sessionToken: 'opaque',
    csrfToken: 'csrf',
  };
  const result = await identity.authorizeOperational(input);
  assert.equal(result.actor.olistEnabled, true);
  assert.equal(result.actor.olistAuthorizationVersion, 4);
  assert.equal(
    (
      await identity.authorizeOperationalRead({
        action: 'olist.read',
        sessionToken: 'opaque',
      })
    ).actor.id,
    'actor',
  );
  enabled = false;
  version += 1;
  await assert.rejects(identity.authorizeOperational(input), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    identity.authorizeOperationalRead({
      action: 'olist.read',
      sessionToken: 'opaque',
    }),
    { code: 'FORBIDDEN' },
  );
  const current = await identity.current({ sessionToken: 'opaque' });
  assert.equal(current.user.olistEnabled, false);
  assert.equal(current.user.olistAuthorizationVersion, 5);
});

test('OLIST-T19: PostgreSQL compare-and-set rechecks revision under user lock before any write', async () => {
  /** @type {string[]} */
  const queries = [];
  const repository = createPostgresIdentityRepository({
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FOR UPDATE'))
        return {
          rows: [
            {
              id: 'target',
              olist_enabled: true,
              olist_authorization_version: 2,
            },
          ],
        };
      return { rows: [] };
    },
  });
  await assert.rejects(
    repository.updateUser('target', {
      olistEnabled: false,
      expectedOlistAuthorizationVersion: 1,
      name: 'Never committed',
    }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FOR UPDATE/);
});

test('OLIST-T19: disabling and re-enabling invalidate earlier Olist authorization revisions', async () => {
  const { service, base } = await domainHarness();
  const { user } = await service.createOperationalUser({
    ...base,
    email: 'enabled@example.test',
    name: 'Equipe',
    password: 'synthetic-password',
    olistEnabled: true,
  });
  const disabled = await service.setUserDisabled({
    ...base,
    targetId: user.id,
    disabled: true,
  });
  assert.equal(disabled.user.olistAuthorizationVersion, 2);
  const enabled = await service.setUserDisabled({
    ...base,
    targetId: user.id,
    disabled: false,
  });
  assert.equal(enabled.user.olistAuthorizationVersion, 3);
  await assert.rejects(
    service.updateUser({
      ...base,
      targetId: user.id,
      olistEnabled: false,
      expectedOlistAuthorizationVersion: 1,
    }),
    { code: 'VERSION_CONFLICT' },
  );
});
