import assert from 'node:assert/strict';
import test from 'node:test';
import { createOlistAdministration } from '../apps/api/src/olist-administration.js';
import { createOlistApiRuntime } from '../apps/api/src/olist-runtime.js';
import { olistConfiguration } from '../modules/olist/src/index.js';

// L1 unit coverage of the API-side `invalidate` command with a database double
// that answers only the statements the command is allowed to run (actor/session
// lock + idempotency record). The repository is a fake: the SQL side lives in
// the live suites.
const NOW = new Date('2026-11-08T12:00:00.000Z');
const environment = {
  APP_ORIGIN: 'https://crm.example.test',
  OLIST_ENABLED: 'true',
  OLIST_CLIENT_ID: 'synthetic-export-app',
  OLIST_CLIENT_SECRET: 'synthetic-export-secret',
  OLIST_REDIRECT_URI: 'https://crm.example.test/olist',
  OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
  OLIST_ENVELOPE_KEY: Buffer.alloc(32, 73).toString('base64'),
  OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 74).toString('base64'),
  IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 75).toString('base64url'),
};
const config = olistConfiguration(environment);
const SESSION = 'a'.repeat(64);
const orderId = 'synthetic-order';
const operationId = '00000000-0000-4000-8000-000000000019';
const REASON = 'PRIVATE_INVALIDATION_REASON_CANARY';

/** @param {Partial<{olistEnabled:boolean, functionName:string, capabilities:string[], sessionValid:boolean}>} [patch] */
function world(patch = {}) {
  const state = {
    olistEnabled: false,
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
    sessionValid: true,
    ...patch,
  };
  /** @type {Array<{sql:string,args:any[]}>} */ const log = [];
  /** @type {Map<string, any>} */ let records = new Map();
  /** @param {string} sql @param {any[]} args */
  async function query(sql, args = []) {
    log.push({ sql, args });
    if (sql.includes('FROM crm.users u JOIN crm.user_functions f'))
      return {
        rows: [
          {
            id: 'admin-example',
            olist_enabled: state.olistEnabled,
            olist_authorization_version: 2,
            function_name: state.functionName,
          },
        ],
      };
    if (sql.includes('FROM crm.user_capabilities'))
      return { rows: state.capabilities.map((capability) => ({ capability })) };
    if (sql.includes('FROM crm.sessions WHERE token_hash'))
      return { rows: state.sessionValid ? [{ token_hash: SESSION }] : [] };
    if (sql.includes('INSERT INTO crm.idempotency_records')) {
      const id = args[0] + '|' + args[1];
      if (records.has(id)) return { rows: [] };
      records.set(id, {
        scope: args[0],
        idempotency_key: args[1],
        fingerprint: args[2],
        actor_id: args[3],
        action: args[4],
        target_type: args[5],
        target_id: args[6],
        version: args[7],
        reason: args[8],
        correlation_id: args[9],
        status: 'pending',
        response: null,
      });
      return { rows: [{ inserted: true }] };
    }
    if (sql.includes('FROM crm.idempotency_records'))
      return { rows: [records.get(args[0] + '|' + args[1])].filter(Boolean) };
    if (sql.includes('UPDATE crm.idempotency_records')) {
      const row = records.get(args[0] + '|' + args[1]);
      row.status = 'completed';
      row.response = JSON.parse(args[2]);
      return { rows: [{ completed: true }] };
    }
    throw new Error('unexpected statement: ' + sql);
  }
  const database = {
    query,
    transaction: async (/** @type {any} */ work) => {
      const before = new Map(
        [...records].map(([key, value]) => [key, { ...value }]),
      );
      try {
        return await work({ query });
      } catch (error) {
        records = before;
        throw error;
      }
    },
  };
  return { state, log, database, records: () => records };
}

/** @param {ReturnType<typeof world>} w @param {any} [overrides] */
function harness(w, overrides = {}) {
  /** @type {any[]} */ const received = [];
  let guards = 0;
  const repository = {
    guard: async () => {
      guards++;
      throw Object.assign(new Error('OLIST_CONNECTION_CHANGED'), {
        code: 'OLIST_CONNECTION_CHANGED',
        statusCode: 409,
      });
    },
    invalidateExport: async (/** @type {any} */ input) => {
      received.push(input);
      return {
        operationId: input.operationId,
        orderId: input.orderId,
        state: 'invalidated',
        version: input.expectedVersion + 1,
        // Anything beyond the contract must never reach the client.
        reason: 'LEAK_REASON',
        snapshot: { buyer: 'LEAK_SNAPSHOT' },
        replayed: false,
      };
    },
    ...overrides,
  };
  const administration = createOlistAdministration(w.database, {
    config,
    environment,
    clock: () => NOW,
    repository,
    // The command is local: nothing may touch the ERP client or the preview.
    connection: new Proxy({}, { get: () => assert.fail('connection used') }),
    preview: new Proxy({}, { get: () => assert.fail('preview used') }),
    fetch: () => assert.fail('ERP HTTP used'),
  });
  return { administration, received, guards: () => guards };
}

/** @param {any} [patch] */
function command(patch = {}) {
  return {
    orderId,
    actor: { id: 'admin-example', kind: 'human' },
    sessionBinding: SESSION,
    correlationId: 'corr-invalidate',
    idempotencyKey: 'invalidate-key-1',
    operationId,
    expectedVersion: 3,
    reason: '  ' + REASON + '  ',
    ...patch,
  };
}

test('L1 invalidate runs locally: actor lock only (no connection guard), allowlisted receipt, coded idempotency record', async () => {
  const w = world();
  const h = harness(w);
  const receipt = await h.administration.invalidate(command());
  assert.deepEqual(receipt, {
    operationId,
    orderId,
    state: 'invalidated',
    version: 4,
  });
  assert.equal(h.guards(), 0, 'repository.guard must not run');
  assert.equal(h.received.length, 1);
  const input = h.received[0];
  assert.equal(input.reason, REASON, 'reason is trimmed before sealing');
  assert.equal(input.operationId, operationId);
  assert.equal(input.expectedVersion, 3);
  assert.equal(input.orderId, orderId);
  assert.equal(input.accountKey, config.accountKey);
  assert.equal(input.contextKey, config.contextKey);
  assert.equal(input.actor.id, 'admin-example');
  assert.equal(input.sessionBinding, SESSION);
  assert.equal(input.correlationId, 'corr-invalidate');
  assert.equal(typeof input.transaction.query, 'function');
  // Actor, capability and session are locked before the idempotency record.
  const kinds = w.log.map((entry) =>
    entry.sql.includes('FROM crm.users u')
      ? 'actor'
      : entry.sql.includes('user_capabilities')
        ? 'grants'
        : entry.sql.includes('FROM crm.sessions')
          ? 'session'
          : entry.sql.includes('INSERT INTO crm.idempotency_records')
            ? 'idem'
            : 'other',
  );
  assert.deepEqual(kinds.slice(0, 4), ['actor', 'grants', 'session', 'idem']);
  const [record] = [...w.records().values()];
  assert.equal(record.action, 'olist.invalidate');
  assert.equal(record.reason, 'OLIST_EXPORT_INVALIDATED');
  assert.equal(record.version, '3');
  assert.equal(record.status, 'completed');
  assert.equal(record.target_type, 'order');
  assert.equal(record.target_id, orderId);
  assert.match(record.scope, /:admin-example:invalidate$/u);
  // The reason lives only in the sealed repository envelope: nothing the
  // idempotency store persisted (identity, fingerprint, response) carries it.
  assert.doesNotMatch(
    JSON.stringify([...w.records().values()]),
    /PRIVATE_|LEAK_/u,
  );
  assert.doesNotMatch(
    JSON.stringify(w.log.map((entry) => entry.args)),
    /PRIVATE_|LEAK_/u,
  );
});

test('L1 invalidate forwards the replay marker only when the repository says so', async () => {
  const w = world();
  const h = harness(w, {
    invalidateExport: async (/** @type {any} */ input) => ({
      operationId: input.operationId,
      orderId: input.orderId,
      state: 'invalidated',
      version: 4,
      replayed: true,
    }),
  });
  assert.deepEqual(await h.administration.invalidate(command()), {
    operationId,
    orderId,
    state: 'invalidated',
    version: 4,
    replayed: true,
  });
});

test('L1 invalidate replays the stored receipt for the same key and body while re-locking the actor', async () => {
  const w = world();
  const h = harness(w);
  const first = await h.administration.invalidate(command());
  const actorLocks = () =>
    w.log.filter((entry) => entry.sql.includes('FROM crm.users u')).length;
  assert.equal(actorLocks(), 1);
  const second = await h.administration.invalidate(command());
  assert.deepEqual(second, first);
  assert.equal(h.received.length, 1, 'the repository ran once');
  assert.equal(actorLocks(), 2, 'replay revalidated the actor under lock');
  // Same key, different body: conflict, nothing executed.
  await assert.rejects(
    h.administration.invalidate(command({ expectedVersion: 4 })),
    { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 },
  );
  assert.equal(h.received.length, 1);
  // Revoked access: the stored receipt is not served.
  for (const patch of [
    { capabilities: [] },
    { functionName: 'Financeiro', capabilities: [], olistEnabled: true },
    { sessionValid: false },
  ]) {
    Object.assign(w.state, patch);
    await assert.rejects(h.administration.invalidate(command()), {
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  }
  assert.equal(h.received.length, 1);
});

test('L1 invalidate works without the Olist checkbox and refuses everyone but the administrator', async () => {
  for (const [patch, allowed] of /** @type {const} */ ([
    [{ olistEnabled: false }, true],
    [{ olistEnabled: true }, true],
    [{ capabilities: [], olistEnabled: true }, false],
    [
      { functionName: 'Financeiro', capabilities: [], olistEnabled: true },
      false,
    ],
    [{ sessionValid: false }, false],
  ])) {
    const w = world(/** @type {any} */ (patch));
    const h = harness(w);
    if (allowed) await h.administration.invalidate(command());
    else
      await assert.rejects(h.administration.invalidate(command()), {
        code: 'FORBIDDEN',
      });
    assert.equal(h.received.length, allowed ? 1 : 0, JSON.stringify(patch));
  }
  // A non-human principal never reaches the repository either.
  const w = world();
  const h = harness(w);
  await assert.rejects(
    h.administration.invalidate(
      command({ actor: { id: 'admin-example', kind: 'assistant' } }),
    ),
    { code: 'FORBIDDEN' },
  );
  assert.equal(h.received.length, 0);
});

test('L1 invalidate validates the body before touching the database', async () => {
  const w = world();
  const h = harness(w);
  for (const patch of [
    { operationId: 'not-a-uuid' },
    { operationId: '0000000A-0000-4000-8000-00000000001B' },
    { operationId: null },
    { operationId: 7 },
    { expectedVersion: 0 },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: '3' },
    { expectedVersion: undefined },
    { reason: '' },
    { reason: '   ' },
    { reason: 'line\nbreak' },
    { reason: 'nul\u0000byte' },
    { reason: 'x'.repeat(1001) },
    { reason: 42 },
    { orderId: '' },
    { idempotencyKey: undefined },
    { idempotencyKey: 'has space' },
    { idempotencyKey: 'x'.repeat(129) },
  ]) {
    await assert.rejects(
      h.administration.invalidate(command(patch)),
      { code: 'INVALID_REQUEST', statusCode: 400 },
      JSON.stringify(patch),
    );
  }
  assert.equal(h.received.length, 0);
  // Pure validation: no statement reached the database.
  assert.deepEqual(w.log, []);
  // The longest accepted reason still passes.
  await h.administration.invalidate(
    command({ reason: 'y'.repeat(1000), idempotencyKey: 'invalidate-key-max' }),
  );
  assert.equal(h.received.length, 1);
});

test('L1 invalidate refusals roll the idempotency record back so the same key can retry', async () => {
  const w = world();
  let refuse = true;
  const h = harness(w, {
    invalidateExport: async (/** @type {any} */ input) => {
      if (refuse)
        throw Object.assign(new Error('OLIST_INVALIDATION_BLOCKED'), {
          code: 'OLIST_INVALIDATION_BLOCKED',
          statusCode: 409,
        });
      return {
        operationId: input.operationId,
        orderId: input.orderId,
        state: 'invalidated',
        version: 4,
      };
    },
  });
  await assert.rejects(h.administration.invalidate(command()), {
    code: 'OLIST_INVALIDATION_BLOCKED',
    statusCode: 409,
  });
  assert.equal(w.records().size, 0);
  refuse = false;
  assert.equal((await h.administration.invalidate(command())).version, 4);
  assert.equal(w.records().size, 1);
});

test('L1 invalidate is unavailable (503) when Olist is not configured', async () => {
  const w = world();
  const unconfigured = createOlistAdministration(w.database, {
    config: olistConfiguration({}),
    environment,
    clock: () => NOW,
    repository: { guard: async () => {}, invalidateExport: async () => ({}) },
    connection: {},
    preview: {},
  });
  await assert.rejects(unconfigured.invalidate(command()), {
    code: 'OLIST_NOT_CONFIGURED',
    statusCode: 503,
  });
  assert.deepEqual(w.log, []);
});

/**
 * L1/2.5: once an order has an archived (invalidated) generation next to the
 * active one, the projection must pick the active row, or else the latest
 * invalidated one. The double applies the semantics the SQL declares (active
 * filter, ordering, LIMIT) over rows inserted oldest-first, so a query that
 * regressed to "first row for the order" returns the wrong generation here.
 * @param {Array<Record<string, any>>} exportRows
 */
function projectionHarness(exportRows) {
  const w = world({ olistEnabled: true });
  /** @type {string[]} */ const exportSql = [];
  const base = w.database.query;
  /** @param {string} sql @param {any[]} args */
  const query = async (sql, args = []) => {
    if (sql.includes('FROM crm.orders o LEFT JOIN crm.conversations c'))
      return {
        rows: [
          {
            id: orderId,
            number: '41-CRM',
            status: 'pendente',
            manual_owner_id: null,
            assigned_user_id: null,
          },
        ],
      };
    if (sql.includes('FROM crm.olist_exports')) {
      exportSql.push(sql);
      let rows = exportRows.filter(
        (row) => row.account_key === args[0] && row.order_id === args[1],
      );
      if (/state\s*<>\s*'invalidated'/u.test(sql))
        rows = rows.filter((row) => row.state !== 'invalidated');
      if (/ORDER BY \(state='invalidated'\)/u.test(sql))
        rows = [...rows].sort(
          (a, b) =>
            Number(a.state === 'invalidated') -
              Number(b.state === 'invalidated') ||
            Date.parse(b.created_at) - Date.parse(a.created_at),
        );
      if (/LIMIT 1\b/u.test(sql)) rows = rows.slice(0, 1);
      return { rows };
    }
    return base(sql, args);
  };
  const database = {
    query,
    transaction: async (/** @type {any} */ work) => work({ query }),
  };
  const runtime = createOlistApiRuntime(database, {
    access: {},
    environment,
    clock: () => NOW,
  });
  return { runtime, exportSql };
}

const generation = (
  /** @type {string} */ state,
  /** @type {string} */ createdAt,
  /** @type {Record<string, any>} */ extra = {},
) => ({
  account_key: config.accountKey,
  order_id: orderId,
  state,
  stage: 'customer',
  remote_number: null,
  last_error_code: null,
  created_at: createdAt,
  ...extra,
});
const projectInput = {
  actor: { id: 'admin-example', kind: 'human' },
  sessionBinding: SESSION,
  orderId,
  action: 'olist.read',
};

test('L1 project shows the active generation, not the archived one, regardless of insertion order', async () => {
  const { runtime } = projectionHarness([
    generation('invalidated', '2026-11-08T10:00:00Z', {
      last_error_code: 'OLIST_EXPORT_INVALIDATED',
    }),
    generation('queued', '2026-11-08T11:00:00Z'),
  ]);
  const projection = await runtime.project(projectInput);
  assert.equal(projection.operation?.state, 'queued');
  assert.equal(projection.operation?.stage, 'customer');
  assert.equal('errorCode' in (projection.operation ?? {}), false);
});

test('L1 project falls back to the latest invalidated generation when none is active', async () => {
  const { runtime } = projectionHarness([
    generation('invalidated', '2026-11-08T09:00:00Z', {
      last_error_code: 'OLIST_EXPORT_UNAVAILABLE',
    }),
    generation('invalidated', '2026-11-08T11:00:00Z', {
      last_error_code: 'OLIST_EXPORT_INVALIDATED',
    }),
  ]);
  const projection = await runtime.project(projectInput);
  assert.deepEqual(projection.operation, {
    state: 'invalidated',
    stage: 'customer',
    number: null,
    errorCode: 'OLIST_EXPORT_INVALIDATED',
  });
});

test('L1 project reads exactly one row and keeps the other order/account untouched', async () => {
  const { runtime, exportSql } = projectionHarness([
    generation('invalidated', '2026-11-08T09:00:00Z'),
    generation('ready', '2026-11-08T10:00:00Z', { remote_number: null }),
    generation('confirmed', '2026-11-08T12:00:00Z', {
      order_id: 'another-order',
      remote_number: '999',
    }),
  ]);
  const projection = await runtime.project(projectInput);
  assert.equal(projection.operation?.state, 'ready');
  assert.equal(exportSql.length, 1);
  assert.match(exportSql[0], /LIMIT 1\b/u);
  const empty = await projectionHarness([]).runtime.project(projectInput);
  assert.equal(empty.operation, null);
});
