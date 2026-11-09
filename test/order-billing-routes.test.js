import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { authorize } from '../modules/identity-access/src/authorization.js';
import { createAutomationCredentials } from '../modules/identity-access/src/automation-credentials.js';
import { registerOrderBillingRoutes } from '../apps/api/src/order-billing-routes.js';

const CORRELATION = '00112233-4455-4677-8899-aabbccddeeff';
const PREFIX = '/api/v1/orders/order-synthetic/billing';
const TECH = '/api/v1/integrations/n8n/billing/charges/charge-synthetic';
const HUMAN = {
  cookie: 'crm_session=seller',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic-csrf',
  'idempotency-key': 'synthetic-command-1',
};
const AUTOMATION = {
  authorization: 'Basic synthetic-credential',
  'idempotency-key': 'synthetic-callback-1',
  'x-correlation-id': CORRELATION,
  'x-silmer-workflow-key': 'silmer-order-billing',
  'x-silmer-workflow-version': 'order-billing-1',
  'x-silmer-execution-id': 'execution-synthetic-1',
};
const PLAN = { expectedVersion: 1, expectedBillingVersion: 0, percent: 30 };

function fixture() {
  const api = Fastify();
  /** @type {any[]} */ const calls = [];
  /** @param {any} input @param {boolean} write */
  function access(input, write) {
    if (!input.cookie)
      throw Object.assign(new Error('private credential'), {
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    if (write && input.csrfToken !== 'synthetic-csrf')
      throw Object.assign(new Error('private session'), {
        code: 'CSRF_INVALID',
        statusCode: 403,
      });
    const actor = {
      id: 'synthetic-user',
      functionName: input.cookie.includes('finance')
        ? 'Financeiro'
        : 'Vendedor',
      capabilities: [],
    };
    authorize(/** @type {any} */ (actor), input.action);
    return { actor };
  }
  /** @type {any} */ const billing = {
    authorizeRead: (/** @type {any} */ input) => access(input, false),
    authorizeWrite: (/** @type {any} */ input) => access(input, true),
  };
  for (const method of [
    'get',
    'configure',
    'issue',
    'refund',
    'reconcile',
    'lookup',
    'reserve',
    'created',
    'payment',
  ]) {
    billing[method] = async (/** @type {any} */ input) => {
      calls.push({ method, input });
      return { billing: { version: 1 }, allowed: true };
    };
  }
  api.decorate('automationAuth', {
    authorize: async (/** @type {any} */ input) => {
      if (input.authorization !== AUTOMATION.authorization)
        throw Object.assign(new Error('secret'), {
          code: 'INVALID_AUTOMATION_CREDENTIALS',
          statusCode: 401,
        });
      return {
        actor: { id: 'AUTOMATION_EXECUTOR' },
        credentialVersion: 'current',
      };
    },
  });
  registerOrderBillingRoutes(api, billing, () => ({
    correlationId: CORRELATION,
    requestId: CORRELATION,
  }));
  return { api, billing, calls };
}

test('COB-01/13: billing requires a human seller session, keeps links private and denies Financeiro', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const headers of [
    {},
    { ...HUMAN, authorization: AUTOMATION.authorization },
    { ...HUMAN, cookie: 'crm_session=finance' },
  ]) {
    const response = await api.inject({ url: PREFIX, headers });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(calls.length, 0);
  const response = await api.inject({ url: PREFIX, headers: HUMAN });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(calls[0].method, 'get');
});

test('COB-04: CSRF, strict command shapes and idempotency key are checked before billing writes', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const [
    headers,
    payload,
    status,
  ] of /** @type {Array<[any,any,number]>} */ ([
    [{ ...HUMAN, 'x-csrf-token': '' }, PLAN, 403],
    [HUMAN, { ...PLAN, amountCents: 1 }, 400],
    [HUMAN, { expectedVersion: 1, percent: 30 }, 400],
    [HUMAN, [], 400],
    [{ ...HUMAN, 'idempotency-key': '' }, PLAN, 400],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: `${PREFIX}/charges`,
      headers,
      payload,
    });
    assert.equal(response.statusCode, status);
  }
  assert.equal(calls.length, 0);
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/charges`,
    headers: HUMAN,
    payload: PLAN,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].method, 'issue');
  assert.equal(calls[0].input.idempotencyKey, HUMAN['idempotency-key']);
  assert.equal(calls[0].input.correlationId, CORRELATION);
});

test('COB-06/14: technical reserve is credential/workflow bound and cannot be invoked by a browser session', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const [headers, status] of /** @type {Array<[any,number]>} */ ([
    [{ ...AUTOMATION, authorization: '' }, 401],
    [{ ...AUTOMATION, 'x-silmer-workflow-key': 'shop-checkout' }, 403],
    [{ ...AUTOMATION, 'x-silmer-execution-id': '' }, 400],
    [{ ...AUTOMATION, 'x-correlation-id': 'different' }, 400],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: `${TECH}/reserve`,
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, status);
  }
  assert.equal(calls.length, 0);
  const result = await api.inject({
    method: 'POST',
    url: `${TECH}/reserve`,
    headers: AUTOMATION,
    payload: {},
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].input.executionId, AUTOMATION['x-silmer-execution-id']);
  assert.equal(calls[0].input.chargeId, 'charge-synthetic');
});

test('COB-06/13: callback rejects extra unverified claims and never leaks upstream payloads', async (t) => {
  const { api, billing, calls } = fixture();
  t.after(() => api.close());
  const payload = {
    transactionNsu: 'transaction-synthetic',
    invoiceSlug: 'invoice-synthetic',
    amountCents: 54000,
    paidAmountCents: 55000,
    method: 'credit_card',
    installments: 3,
    receiptUrl: null,
  };
  const rejected = await api.inject({
    method: 'POST',
    url: `${TECH}/payment`,
    headers: AUTOMATION,
    payload: { ...payload, paid: true, actor: 'admin' },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(calls.length, 0);
  billing.payment = async () => {
    throw new Error('private customer, secret checkout token');
  };
  const failure = await api.inject({
    method: 'POST',
    url: `${TECH}/payment`,
    headers: AUTOMATION,
    payload,
  });
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.json().code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(failure.body, /customer|secret|checkout token/u);
});

test('COB-01/16: technical capabilities never grant human commercial commands', () => {
  const actor = /** @type {any} */ ({
    id: 'seller',
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
  });
  const technical = createAutomationCredentials({
    clientId: 'billing-test',
    currentSecret: 'synthetic-secret-for-billing-tests-32chars',
  });
  for (const action of [
    'billing.checkout.reserve',
    'billing.checkout.record',
    'billing.checkout.read',
    'billing.payment.record',
  ]) {
    assert.throws(() => authorize(actor, action), { code: 'FORBIDDEN' });
    assert.equal(technical.isActionAllowed(action), true);
  }
  assert.equal(technical.isActionAllowed('billing.manage'), false);
});

test('OLIST-19/46: a locally cancelled order is refused with its own 409 code, not masked as 503', async (t) => {
  const { api, billing } = fixture();
  t.after(() => api.close());
  billing.issue = async () => {
    throw Object.assign(new Error('internal detail'), {
      code: 'ORDER_CANCELLED',
      statusCode: 409,
    });
  };
  const response = await api.inject({
    method: 'POST',
    url: `${PREFIX}/charges`,
    headers: HUMAN,
    payload: PLAN,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'ORDER_CANCELLED');
  assert.doesNotMatch(response.body, /internal detail/u);
});
