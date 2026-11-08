import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { parseConversationReminderCommand } from '../apps/api/src/conversation-reminder-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';

const SELLER = {
  id: 'seller-reminder-synthetic',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: [],
};
const FINANCE = {
  ...SELLER,
  id: 'finance-synthetic',
  functionName: 'Financeiro',
};
const ORIGIN = 'https://crm.example.test';
const URL = '/api/v1/conversations/conversation-synthetic/reminder';
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

/** @param {any} [actor] */
function harness(actor = SELLER) {
  /** @type {any[]} */
  const calls = [];
  const runtime = {
    authorizeWrite: async (/** @type {any} */ input) => {
      if (!String(input.cookie ?? '').includes('crm_session='))
        throw Object.assign(new Error('no session'), {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
        });
      authorize(actor, input.action);
      if (input.origin !== ORIGIN || input.csrfToken !== 'synthetic-csrf')
        throw Object.assign(new Error('forbidden'), {
          statusCode: 403,
          code: 'CSRF_INVALID',
        });
      return { actor };
    },
    set: async (/** @type {any} */ input) => {
      calls.push(input);
      return {
        conversationId: input.conversationId,
        remindAt: FUTURE,
        decisionVersion: 1,
      };
    },
  };
  return { calls, api: createApi({}, { conversationReminders: runtime }) };
}

/** @param {any} api @param {unknown} body @param {Record<string,string>} [headers] */
function post(api, body, headers = {}) {
  return api.inject({
    method: 'POST',
    url: URL,
    headers: {
      cookie: 'crm_session=synthetic',
      origin: ORIGIN,
      'x-csrf-token': 'synthetic-csrf',
      'idempotency-key': 'reminder-command-synthetic',
      ...headers,
    },
    payload: /** @type {any} */ (body),
  });
}

test('INBOX-VEZ-01 reminder: a valid command reaches the runtime and the answer is no-store', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const response = await post(api, { remindAt: FUTURE, expectedVersion: 4 });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(response.json()).sort(), [
    'conversationId',
    'decisionVersion',
    'remindAt',
  ]);
  assert.equal(calls[0].actor.id, SELLER.id);
  assert.equal(calls[0].idempotencyKey, 'reminder-command-synthetic');
  assert.equal(calls[0].conversationId, 'conversation-synthetic');
});

test('INBOX-VEZ-01 reminder: strict body, closed date format and early refusals', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  for (const body of [
    { remindAt: FUTURE },
    { expectedVersion: 1 },
    { remindAt: FUTURE, expectedVersion: 1, note: 'x' },
    { remindAt: FUTURE, expectedVersion: 1, userId: 'other' },
    { remindAt: FUTURE, expectedVersion: 0 },
    { remindAt: FUTURE, expectedVersion: '1' },
    [],
  ])
    assert.equal((await post(api, body)).statusCode, 400, JSON.stringify(body));
  for (const remindAt of [
    '2026-12-01T10:00:00',
    '2026-12-01',
    '2026-02-31T10:00:00Z',
    'amanhã',
    12,
    null,
  ]) {
    const response = await post(api, { remindAt, expectedVersion: 1 });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'INVALID_REMINDER_DATE');
  }
  assert.equal(calls.length, 0);
});

test('INBOX-VEZ-01 reminder: session, CSRF, idempotency key and role are enforced', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const body = { remindAt: FUTURE, expectedVersion: 1 };
  assert.equal((await post(api, body, { cookie: '' })).statusCode, 401);
  assert.equal((await post(api, body, { 'x-csrf-token': '' })).statusCode, 403);
  const noKey = await post(api, body, { 'idempotency-key': '' });
  assert.equal(noKey.statusCode, 400);
  assert.equal(noKey.json().code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal(calls.length, 0);
  const finance = harness(FINANCE);
  t.after(() => finance.api.close());
  assert.equal((await post(finance.api, body)).statusCode, 403);
  assert.equal(finance.calls.length, 0);
});

test('INBOX-VEZ-01 reminder: unexpected failures never leak details', async (t) => {
  const api = createApi(
    {},
    {
      conversationReminders: {
        authorizeWrite: async () => ({ actor: SELLER }),
        set: async () => {
          throw new Error('database password leaked');
        },
      },
    },
  );
  t.after(() => api.close());
  const response = await post(api, { remindAt: FUTURE, expectedVersion: 1 });
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /password/u);
});

test('INBOX-VEZ-01 reminder: the parser normalizes the date to UTC', () => {
  const parsed = parseConversationReminderCommand({
    remindAt: '2030-01-02T10:00:00-03:00',
    expectedVersion: 2,
  });
  assert.deepEqual(parsed, {
    remindAt: '2030-01-02T13:00:00.000Z',
    expectedVersion: 2,
  });
});
