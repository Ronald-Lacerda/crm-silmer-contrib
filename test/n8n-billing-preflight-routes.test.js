import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerN8nBillingPreflightRoutes } from '../apps/api/src/n8n-billing-preflight-routes.js';

const headers = {
  authorization: 'Basic synthetic',
  'x-correlation-id': 'trace',
  'x-silmer-workflow-key': 'workflow',
  'x-silmer-workflow-version': 'version',
  'x-silmer-execution-id': 'execution',
};
const url = '/api/v1/integrations/n8n/commands/command/preflight';
/** @param {import('node:test').TestContext} t @param {any} [result] */
async function harness(t, result = { valid: true }) {
  const api = Fastify();
  const calls = /** @type {any[]} */ ([]);
  api.decorate('automationAuth', {
    async authorize(/** @type {any} */ input) {
      assert.equal(input.action, 'integration.n8n.command.media.read');
      if (!input.authorization)
        throw Object.assign(new Error('private-auth'), { statusCode: 401 });
    },
  });
  registerN8nBillingPreflightRoutes(
    api,
    {
      async readReservedSend(/** @type {any} */ input) {
        calls.push(input);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    () => ({ correlationId: 'trace', requestId: 'request' }),
  );
  t.after(() => api.close());
  return { api, calls };
}
test('BAPI-07: preflight binds the exact reserved execution and projects only a strict boolean', async (t) => {
  const { api, calls } = await harness(t, {
    valid: true,
    checkoutUrl: 'private-url',
  });
  const response = await api.inject({ url, headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { valid: true });
  assert.deepEqual(calls, [
    {
      commandId: 'command',
      technical: {
        workflowKey: 'workflow',
        workflowVersion: 'version',
        executionId: 'execution',
      },
    },
  ]);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});
for (const result of [{ valid: false }, { valid: 'true' }, {}])
  test('BAPI-07: non-true preflight denies sending', async (t) => {
    const { api } = await harness(t, result);
    assert.deepEqual((await api.inject({ url, headers })).json(), {
      valid: false,
    });
  });
for (const statusCode of [401, 403, 404, 409, 503])
  test(`BAPI-07: preflight error ${statusCode} reveals no private data`, async (t) => {
    const { api } = await harness(
      t,
      Object.assign(new Error('private-canary'), { statusCode }),
    );
    const response = await api.inject({ url, headers });
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.json().valid, false);
    assert.doesNotMatch(response.body, /private-canary/);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });
test('BAPI-07: missing credentials, forged identity, query selectors and HEAD cannot reach reservation', async (t) => {
  const { api, calls } = await harness(t);
  for (const [field, status] of [
    ['authorization', 401],
    ['x-silmer-execution-id', 400],
    ['x-silmer-workflow-key', 400],
    ['x-correlation-id', 400],
  ]) {
    const missing = { ...headers };
    Reflect.deleteProperty(missing, field);
    assert.equal(
      (await api.inject({ url, headers: missing })).statusCode,
      status,
    );
  }
  assert.equal(
    (await api.inject({ url: `${url}?conversation_id=other`, headers }))
      .statusCode,
    400,
  );
  assert.equal(
    (await api.inject({ method: 'HEAD', url, headers })).statusCode,
    404,
  );
  assert.equal(calls.length, 0);
});
