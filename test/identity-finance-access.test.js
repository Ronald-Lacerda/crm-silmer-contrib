import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { registerIdentityRoutes } from '../apps/api/src/identity-routes.js';
import { createIdentityApiRuntime } from '../apps/api/src/identity-runtime.js';
import {
  authorize,
  createIdentityAccessService,
  createInMemoryIdentityRepository,
  OPERATIONAL_ACTIONS,
} from '../modules/identity-access/src/index.js';

const origin = 'https://crm.example.test';
const key = Buffer.alloc(32, 17).toString('base64url');
const environment = {
  APP_ORIGIN: origin,
  AUTH_THROTTLE_HMAC_KEY: key,
  IDEMPOTENCY_ENVELOPE_KEY: key,
  IDENTITY_BOOTSTRAP_TOKEN:
    'synthetic-bootstrap-token-longer-than-32-characters',
};

test('FINQ-03/16: Financeiro has only finance actions and Admin has finance read only', () => {
  const finance = {
    capabilities: [],
    functionName: /** @type {const} */ ('Financeiro'),
    id: 'finance-user',
  };
  const seller = {
    capabilities: [],
    functionName: /** @type {const} */ ('Vendedor'),
    id: 'seller-user',
  };
  const admin = {
    ...seller,
    capabilities: /** @type {Array<'COMMERCIAL_ADMIN'>} */ ([
      'COMMERCIAL_ADMIN',
    ]),
  };
  for (const action of OPERATIONAL_ACTIONS) {
    assert.throws(
      () => authorize(finance, action),
      { code: 'FORBIDDEN' },
      action,
    );
  }
  for (const action of ['finance.read', 'finance.complete', 'finance.reopen']) {
    assert.doesNotThrow(() => authorize(finance, action));
    assert.throws(() => authorize(seller, action), { code: 'FORBIDDEN' });
    if (action === 'finance.read')
      assert.doesNotThrow(() => authorize(admin, action));
    else assert.throws(() => authorize(admin, action), { code: 'FORBIDDEN' });
    assert.throws(
      () => authorize({ ...finance, capabilities: admin.capabilities }, action),
      { code: 'FORBIDDEN' },
    );
  }
  assert.throws(() => authorize(finance, 'user.manage'), { code: 'FORBIDDEN' });
  assert.throws(
    () => authorize({ ...finance, kind: 'assistant' }, 'finance.read'),
    { code: 'FORBIDDEN' },
  );
});

test('FINQ-T01: three access types preserve separation and changing access revokes sessions', async () => {
  let sequence = 0;
  const repository = createInMemoryIdentityRepository();
  /** @type {any[]} */
  const events = [];
  const service = createIdentityAccessService({
    auditPort: {
      append: async (event) => {
        events.push(event);
      },
    },
    clock: () => new Date('2026-10-22T12:00:00.000Z'),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    passwordParameters: { memory: 64, parallelism: 2, passes: 2 },
    repository,
  });
  const { user: admin } = await service.bootstrapAdmin({
    correlationId: 'bootstrap-access',
    email: 'admin@example.test',
    name: 'Admin',
    password: 'synthetic-secret',
    reason: 'Synthetic setup',
  });
  const base = {
    actorId: admin.id,
    correlationId: 'create-access',
    name: 'Equipe',
    password: 'synthetic-secret',
    reason: 'Synthetic account',
  };
  const { user: finance } = await service.createOperationalUser({
    ...base,
    email: 'finance@example.test',
    accessType: 'finance',
  });
  assert.equal(finance.functionName, 'Financeiro');
  assert.deepEqual(finance.capabilities, []);
  const { user: secondAdmin } = await service.createOperationalUser({
    ...base,
    email: 'second-admin@example.test',
    accessType: 'admin',
  });
  assert.equal(secondAdmin.functionName, 'Vendedor');
  assert.deepEqual(secondAdmin.capabilities, ['COMMERCIAL_ADMIN']);
  const { user: seller } = await service.createOperationalUser({
    ...base,
    email: 'seller@example.test',
  });
  assert.equal(seller.functionName, 'Vendedor');
  assert.deepEqual(seller.capabilities, []);
  const session = await service.login({
    email: 'finance@example.test',
    password: 'synthetic-secret',
  });
  await service.updateUser({
    actorId: admin.id,
    targetId: finance.id,
    accessType: 'admin',
    correlationId: 'promote-access',
    reason: 'Synthetic promotion',
  });
  await assert.rejects(service.authenticate(session.sessionToken), {
    code: 'INVALID_SESSION',
  });
  assert.deepEqual((await repository.findUserById(finance.id))?.capabilities, [
    'COMMERCIAL_ADMIN',
  ]);
  const { user: demoted } = await service.updateUser({
    actorId: admin.id,
    targetId: finance.id,
    accessType: 'finance',
    correlationId: 'demote-access',
    reason: 'Synthetic reassignment',
  });
  assert.equal(demoted.functionName, 'Financeiro');
  assert.deepEqual(demoted.capabilities, []);
  await assert.rejects(
    service.updateUser({
      actorId: admin.id,
      targetId: admin.id,
      accessType: 'finance',
      correlationId: 'self-access',
      reason: 'Synthetic self reassignment',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    service.createOperationalUser({
      ...base,
      accessType: /** @type {any} */ ('root'),
      email: 'unknown@example.test',
    }),
    { code: 'INVALID_REQUEST' },
  );
  assert.equal(
    events.filter((e) => e.action === 'identity.user.access.changed').length,
    2,
  );
  assert.ok(events.every((e) => !JSON.stringify(e).includes('@example.test')));
  assert.ok(
    events.every((e) => !JSON.stringify(e).includes('synthetic-secret')),
  );
});

test('FINQ-T01: HTTP access type selection is forwarded and invalid types fail before mutation', async () => {
  const api = Fastify();
  /** @type {any[]} */
  const calls = [];
  registerIdentityRoutes(
    api,
    {
      allowedOrigins: [origin],
      createUser: async (/** @type {any} */ input) => {
        calls.push(input);
        return { user: { id: 'created' } };
      },
      updateUser: async (/** @type {any} */ input) => {
        calls.push(input);
        return { user: { id: input.targetId } };
      },
    },
    () => ({ correlationId: 'synthetic-correlation' }),
  );
  const headers = {
    origin,
    cookie: 'crm_session=opaque; crm_csrf=csrf',
    'x-csrf-token': 'csrf',
    'idempotency-key': 'synthetic-key',
  };
  try {
    for (const accessType of ['seller', 'finance', 'admin']) {
      const created = await api.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers,
        payload: {
          name: 'Equipe',
          email: 'team@example.test',
          password: 'synthetic',
          reason: 'Synthetic setup',
          accessType,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(calls.at(-1).accessType, accessType);
      const patched = await api.inject({
        method: 'PATCH',
        url: '/api/v1/users/target',
        headers,
        payload: { reason: 'Synthetic change', accessType },
      });
      assert.equal(patched.statusCode, 200);
      assert.equal(calls.at(-1).accessType, accessType);
    }
    const before = calls.length;
    for (const accessType of ['root', '', null, {}, ['finance']]) {
      const response = await api.inject({
        method: 'PATCH',
        url: '/api/v1/users/target',
        headers,
        payload: { reason: 'Synthetic change', accessType },
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.length, before);
  } finally {
    await api.close();
  }
});

/** @param {{functionName: 'Financeiro'|'Vendedor', capabilities: string[], disabledAt?: string|null}} user */
function runtimeFor(user) {
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
                  created_at: '2026-10-22T12:00:00Z',
                  last_seen_at: '2026-10-22T12:00:00Z',
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
                  email: 'actor@example.test',
                  name: 'Equipe',
                  function_name: user.functionName,
                  capabilities: user.capabilities,
                  disabled_at: user.disabledAt ?? null,
                  created_at: '2026-10-22T12:00:00Z',
                  can_delete: true,
                  password_hash: '$argon2id$synthetic',
                },
              ],
            };
          return { rows: [] };
        },
      }),
  };
  return createIdentityApiRuntime(database, environment);
}

test('T138: Melhor Envio requires live administrative access for reads and writes', async () => {
  assert.equal(OPERATIONAL_ACTIONS.has('shipping.manage'), false);
  const profiles = [
    { functionName: 'Vendedor', capabilities: ['COMMERCIAL_ADMIN'] },
    { functionName: 'Vendedor', capabilities: [] },
    { functionName: 'Financeiro', capabilities: [] },
    {
      functionName: 'Vendedor',
      capabilities: ['COMMERCIAL_ADMIN'],
      disabledAt: '2026-11-01T12:00:00Z',
    },
  ];
  for (const [index, profile] of profiles.entries()) {
    const identity = runtimeFor(/** @type {any} */ (profile));
    const input = {
      action: 'shipping.manage',
      sessionToken: 'opaque',
      csrfToken: 'csrf',
    };
    for (const check of [
      () => identity.authorizeOperationalRead(input),
      () => identity.authorizeOperational(input),
    ]) {
      if (index === 0) assert.equal((await check()).actor.id, 'actor');
      else await assert.rejects(check(), { code: 'FORBIDDEN' });
    }
  }
  assert.throws(
    () =>
      authorize(
        {
          id: 'automation',
          kind: 'assistant',
          functionName: 'Vendedor',
          capabilities: ['COMMERCIAL_ADMIN'],
        },
        'shipping.manage',
      ),
    { code: 'FORBIDDEN' },
  );
});

test('FINQ-03/16: runtime reads and writes enforce live finance role instead of widening seller access', async () => {
  const finance = runtimeFor({ functionName: 'Financeiro', capabilities: [] });
  const admin = runtimeFor({
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
  });
  const seller = runtimeFor({ functionName: 'Vendedor', capabilities: [] });
  assert.equal(
    (
      await finance.authorizeOperationalRead({
        action: 'finance.read',
        sessionToken: 'opaque',
      })
    ).actor.functionName,
    'Financeiro',
  );
  await admin.authorizeOperationalRead({
    action: 'finance.read',
    sessionToken: 'opaque',
  });
  await assert.rejects(
    seller.authorizeOperationalRead({
      action: 'finance.read',
      sessionToken: 'opaque',
    }),
    { code: 'FORBIDDEN' },
  );
  for (const action of ['order.read', 'conversation.read', 'contact.read']) {
    await assert.rejects(
      finance.authorizeOperationalRead({ action, sessionToken: 'opaque' }),
      { code: 'FORBIDDEN' },
    );
  }
  for (const action of ['finance.complete', 'finance.reopen']) {
    await finance.authorizeOperational({
      action,
      sessionToken: 'opaque',
      csrfToken: 'csrf',
    });
    await assert.rejects(
      admin.authorizeOperational({
        action,
        sessionToken: 'opaque',
        csrfToken: 'csrf',
      }),
      { code: 'FORBIDDEN' },
    );
  }
  const disabled = runtimeFor({
    functionName: 'Financeiro',
    capabilities: [],
    disabledAt: '2026-10-22T13:00:00Z',
  });
  await assert.rejects(
    disabled.authorizeOperationalRead({
      action: 'finance.read',
      sessionToken: 'opaque',
    }),
    { code: 'FORBIDDEN' },
  );
  // A new finance session may not replay administrative commands from before its reassignment.
  await assert.rejects(
    finance.updateUser({
      sessionToken: 'opaque',
      csrfToken: 'csrf',
      targetId: 'other',
      name: 'Equipe',
      correlationId: 'replay',
      idempotencyKey: 'old-admin-command',
      reason: 'Synthetic replay',
    }),
    { code: 'FORBIDDEN' },
  );
});
