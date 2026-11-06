import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { parseLeadOutcomeCommand } from '../apps/api/src/lead-outcome-runtime.js';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const SELLER = {
  id: 'seller-lead-synthetic',
  kind: 'human',
  functionName: 'Vendedor',
  capabilities: [],
};
const ORIGIN = 'https://crm.example.test';
const URL = '/api/v1/conversations/conversation-synthetic/lead-outcome';
const LOSSES_URL = '/api/v1/dashboard/metrics/losses';
const NOTE = 'Cliente fechou com outra malharia sintética';
const control = (/** @type {number} */ code) => String.fromCharCode(code);

/** @param {any} [actor] @param {any} [record] */
function harness(actor = SELLER, record) {
  /** @type {any[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  /** @param {any} input */
  const session = (input) => {
    if (!String(input.cookie ?? '').includes('crm_session='))
      throw Object.assign(new Error('no session'), {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
  };
  const runtime = {
    authorizeRead: async (/** @type {any} */ input) => {
      session(input);
      authorize(actor, input.action);
      return { actor };
    },
    authorizeWrite: async (/** @type {any} */ input) => {
      session(input);
      authorize(actor, input.action);
      if (input.origin !== ORIGIN || input.csrfToken !== 'synthetic-csrf')
        throw Object.assign(new Error('forbidden'), {
          statusCode: 403,
          code: 'CSRF_INVALID',
        });
      return { actor };
    },
    record:
      record ??
      (async (/** @type {any} */ input) => {
        calls.push(input);
        const command = parseLeadOutcomeCommand(input.body);
        return {
          conversationId: input.conversationId,
          outcome: command.outcome,
          outcomeVersion: command.expectedOutcomeVersion + 1,
          reasonCode: command.reasonCode,
          hasNote: command.note !== null,
          ownerId: actor.id,
          markedBy: actor.id,
          markedAt: '2026-11-05T18:00:00.000Z',
        };
      }),
    detail: async (/** @type {any} */ input) => {
      calls.push(input);
      return { state: 'open', outcomeVersion: 0 };
    },
  };
  const metrics = {
    authorizeRead: runtime.authorizeRead,
    losses: async (/** @type {any} */ input) => {
      calls.push(input);
      return { days: input.days, scope: 'self', rows: [] };
    },
  };
  return {
    calls,
    logs,
    api: createApi(
      {},
      {
        leadOutcomes: runtime,
        dashboardMetrics: metrics,
        logger: createSafeLogger({
          service: 'crm-silmer-api',
          sink: (/** @type {any} */ line) => logs.push(JSON.stringify(line)),
        }),
      },
    ),
  };
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
      'idempotency-key': 'lead-command-synthetic',
      ...headers,
    },
    payload: /** @type {any} */ (body),
  });
}

const LOST = {
  outcome: 'lost',
  reasonCode: 'outro',
  note: `  ${NOTE}  `,
  expectedConversationVersion: 12,
  expectedOutcomeVersion: 0,
};

test('MET-06: a valid loss reaches the runtime trimmed and the answer never echoes the note', async (t) => {
  const { api, calls, logs } = harness();
  t.after(() => api.close());
  const response = await post(api, LOST);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(response.json()).sort(), [
    'conversationId',
    'hasNote',
    'markedAt',
    'markedBy',
    'outcome',
    'outcomeVersion',
    'ownerId',
    'reasonCode',
  ]);
  assert.equal(response.json().hasNote, true);
  assert.doesNotMatch(response.body, /malharia/u);
  assert.equal(calls[0].actor.id, SELLER.id);
  assert.equal(calls[0].idempotencyKey, 'lead-command-synthetic');
  assert.equal(calls[0].conversationId, 'conversation-synthetic');
  assert.equal(parseLeadOutcomeCommand(calls[0].body).note, NOTE);
  assert.equal(
    logs.some((line) => line.includes('malharia')),
    false,
  );
  const reopened = await post(api, {
    outcome: 'reopened',
    expectedConversationVersion: 12,
    expectedOutcomeVersion: 1,
  });
  assert.equal(reopened.statusCode, 200);
  assert.equal(reopened.json().reasonCode, null);
  assert.equal(reopened.json().hasNote, false);
  // 140 characters, counted as characters (an emoji is one), are accepted.
  const limit = await post(api, {
    ...LOST,
    note: `${'a'.repeat(139)}🧵`,
  });
  assert.equal(limit.statusCode, 200);
  // The length is measured after NFC: 140 decomposed "é" are 140 characters.
  calls.length = 0;
  const decomposed = await post(api, {
    ...LOST,
    note: `e${control(0x301)}`.repeat(140),
  });
  assert.equal(decomposed.statusCode, 200);
  assert.equal(
    parseLeadOutcomeCommand(calls[0].body).note,
    control(0xe9).repeat(140),
  );
  const plain = await post(api, { ...LOST, note: 'Cliente desistiu' });
  assert.equal(plain.statusCode, 200);
});

test('MET-06: extra keys, a forged actor and a note outside "outro" are 400', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  for (const body of [
    { ...LOST, actorId: 'admin-forged' },
    { ...LOST, ownerId: 'other' },
    { ...LOST, reasonCode: 'preco' },
    { ...LOST, reasonCode: 'preco', note: '' },
    { ...LOST, outcome: 'won' },
    { ...LOST, outcome: undefined },
    { ...LOST, expectedConversationVersion: 0 },
    { ...LOST, expectedConversationVersion: '12' },
    { ...LOST, expectedOutcomeVersion: -1 },
    { ...LOST, expectedOutcomeVersion: 1.5 },
    {
      outcome: 'reopened',
      expectedConversationVersion: 12,
      expectedOutcomeVersion: 0,
    },
    {
      outcome: 'reopened',
      reasonCode: 'preco',
      expectedConversationVersion: 12,
      expectedOutcomeVersion: 1,
    },
    [LOST],
  ]) {
    const refused = await post(api, body);
    assert.equal(refused.statusCode, 400, JSON.stringify(body));
    assert.match(
      refused.headers['content-type'] ?? '',
      /application\/problem\+json/u,
    );
    assert.equal(refused.json().code, 'INVALID_REQUEST', JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('MET-06: closed reason list and the 1-140 control-free note are 422', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  for (const [body, code] of /** @type {Array<[any,string]>} */ ([
    [
      { ...LOST, reasonCode: undefined, note: undefined },
      'INVALID_LOSS_REASON',
    ],
    [{ ...LOST, reasonCode: 'desinteresse' }, 'INVALID_LOSS_REASON'],
    [{ ...LOST, reasonCode: 'PRECO', note: undefined }, 'INVALID_LOSS_REASON'],
    [{ ...LOST, reasonCode: 7 }, 'INVALID_LOSS_REASON'],
    [{ ...LOST, note: undefined }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: null }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: '' }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: '    ' }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: 'a'.repeat(141) }, 'INVALID_LOSS_NOTE'],
    [
      { ...LOST, note: `linha um${control(10)}linha dois` },
      'INVALID_LOSS_NOTE',
    ],
    [{ ...LOST, note: `sino${control(7)}` }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: `zero${control(0)}byte` }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: `bidi${control(0x202e)}texto` }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: control(0x200e) }, 'INVALID_LOSS_NOTE'],
    [
      { ...LOST, note: `Cliente${control(0x200b)}desistiu` },
      'INVALID_LOSS_NOTE',
    ],
    [{ ...LOST, note: `privado${control(0xe000)}` }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: `sepa${control(0x2028)}rador` }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: '!!! ...' }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: '🧵🧵' }, 'INVALID_LOSS_NOTE'],
    [{ ...LOST, note: `e${control(0x301)}`.repeat(141) }, 'INVALID_LOSS_NOTE'],
  ])) {
    const refused = await post(api, JSON.parse(JSON.stringify(body)));
    assert.equal(refused.statusCode, 422, JSON.stringify(body));
    assert.equal(refused.json().code, code, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('MET-06: CSRF, Idempotency-Key and Financeiro are refused before the runtime', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const noCsrf = await post(api, LOST, { 'x-csrf-token': '' });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().code, 'CSRF_INVALID');
  const foreign = await post(api, LOST, { origin: 'https://evil.example' });
  assert.equal(foreign.statusCode, 403);
  for (const key of ['', '   ', 'x'.repeat(256), `key${control(1)}`]) {
    const refused = await post(api, LOST, { 'idempotency-key': key });
    assert.equal(refused.statusCode, 400, JSON.stringify(key));
    assert.equal(refused.json().code, 'INVALID_IDEMPOTENCY_KEY');
  }
  const missing = await api.inject({
    method: 'POST',
    url: URL,
    headers: {
      cookie: 'crm_session=synthetic',
      origin: ORIGIN,
      'x-csrf-token': 'synthetic-csrf',
    },
    payload: LOST,
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal(calls.length, 0);

  const financial = harness({ ...SELLER, functionName: 'Financeiro' });
  t.after(() => financial.api.close());
  const refused = await post(financial.api, LOST);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'FORBIDDEN');
  const read = await financial.api.inject({
    url: URL,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(read.statusCode, 403);
  const losses = await financial.api.inject({
    url: LOSSES_URL,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(losses.statusCode, 403);
  assert.equal(financial.calls.length, 0);
});

test('MET-06: domain conflicts keep their code; a failure is a bare 503', async (t) => {
  for (const [statusCode, code] of /** @type {Array<[number,string]>} */ ([
    [409, 'LEAD_HAS_ORDER'],
    [409, 'LEAD_AWAITING_REPLY'],
    [409, 'LEAD_NOT_ELIGIBLE'],
    [409, 'LEAD_ALREADY_LOST'],
    [409, 'LEAD_NOT_LOST'],
    [409, 'VERSION_CONFLICT'],
    [409, 'IDEMPOTENCY_KEY_REUSED'],
    [404, 'CONVERSATION_NOT_FOUND'],
  ])) {
    const { api } = harness(SELLER, async () => {
      throw Object.assign(new Error(code), { statusCode, code });
    });
    t.after(() => api.close());
    const response = await post(api, LOST);
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.json().code, code);
  }
  const { api } = harness(SELLER, async () => {
    throw new Error(`connection terminated near ${NOTE}`);
  });
  t.after(() => api.close());
  const failed = await post(api, LOST);
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    type: 'about:blank',
    title: 'SERVICE_UNAVAILABLE',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  });
});

test('MET-08: the detail read takes no query and losses accept only days=7|30', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  const detail = await api.inject({
    url: URL,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.headers['cache-control'], 'private, no-store');
  assert.equal(calls.at(-1).conversationId, 'conversation-synthetic');
  const forged = await api.inject({
    url: `${URL}?actorId=other`,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(forged.statusCode, 400);
  const losses = await api.inject({
    url: `${LOSSES_URL}?days=30`,
    headers: { cookie: 'crm_session=synthetic' },
  });
  assert.equal(losses.statusCode, 200);
  assert.equal(calls.at(-1).days, 30);
  for (const [url, code] of [
    [`${LOSSES_URL}?days=14`, 'INVALID_FILTER'],
    [`${LOSSES_URL}?userId=other`, 'INVALID_REQUEST'],
    [`${LOSSES_URL}?days=7&scope=team`, 'INVALID_REQUEST'],
  ]) {
    const refused = await api.inject({ url });
    assert.equal(refused.statusCode, 400, url);
    assert.equal(refused.json().code, code, url);
  }
});

test('MET-06: no session is 401 and the command limit is 30 per minute', async (t) => {
  const { api, calls } = harness();
  t.after(() => api.close());
  for (const request of [
    { method: 'GET', url: URL },
    { method: 'GET', url: LOSSES_URL },
    {
      method: 'POST',
      url: URL,
      headers: {
        origin: ORIGIN,
        'x-csrf-token': 'synthetic-csrf',
        'idempotency-key': 'lead-command-synthetic',
      },
      payload: LOST,
    },
  ]) {
    const refused = await api.inject(/** @type {any} */ (request));
    assert.equal(refused.statusCode, 401, request.url);
    assert.equal(refused.json().code, 'INVALID_CREDENTIALS', request.url);
  }
  assert.equal(calls.length, 0);
  const limited = harness();
  t.after(() => limited.api.close());
  const statuses = [];
  for (let attempt = 0; attempt < 31; attempt += 1)
    statuses.push(
      (
        await post(limited.api, LOST, {
          'idempotency-key': `lead-command-${attempt}`,
        })
      ).statusCode,
    );
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
  assert.equal(statuses.at(-1), 429);
  assert.equal(limited.calls.length, 30);
});
