import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerOrderBillingRoutes } from '../apps/api/src/order-billing-routes.js';
const BASE = '/api/v1/orders/synthetic/billing';
const CORRELATION = '00112233-4455-4677-8899-aabbccddeeff';
const HEADERS = {
  cookie: 'synthetic-session',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'synthetic-csrf',
  'idempotency-key': 'synthetic-key',
};
const versions = { expectedVersion: 1, expectedBillingVersion: 1 };
function fixture() {
  const api = Fastify();
  /** @type {any[]} */ const calls = [];
  const billing = {
    authorizeWrite: async (/** @type {any} */ input) => {
      if (
        input.cookie !== HEADERS.cookie ||
        input.csrfToken !== HEADERS['x-csrf-token'] ||
        input.origin !== HEADERS.origin
      )
        throw Object.assign(new Error('private'), {
          code: 'FORBIDDEN',
          statusCode: 403,
        });
      return { actor: { id: 'synthetic-seller', kind: 'human' } };
    },
    recordExternal: async (/** @type {any} */ input) => {
      calls.push(input);
      return {
        billing: { receivedAmountCents: 7000, balanceAmountCents: 3000 },
      };
    },
    reverseExternal: async (/** @type {any} */ input) => {
      calls.push(input);
      return { billing: { receivedAmountCents: 0, balanceAmountCents: 10000 } };
    },
    checkPayment: async (/** @type {any} */ input) => {
      calls.push(input);
      return { checkId: 'synthetic-check', state: 'queued' };
    },
    paymentCheckLookup: async (/** @type {any} */ input) => {
      calls.push(input);
      return {
        checkId: input.checkId,
        chargeId: 'charge',
        invoiceSlug: 'invoice-private',
        transactionNsu: 'transaction-private',
        receiptUrl: null,
        state: 'queued',
        amountCents: 3000,
      };
    },
    paymentCheckResult: async (/** @type {any} */ input) => {
      calls.push(input);
      return { recorded: true, checkId: input.checkId, status: input.status };
    },
  };
  api.decorate('automationAuth', {
    authorize: async (/** @type {any} */ input) => {
      if (input.authorization !== 'Basic synthetic-technical')
        throw Object.assign(new Error('private'), {
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
  return { api, calls };
}
test('BFIN-01/04/06 human routes bind actor, receipt/charge and versions with private responses', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  for (const [
    path,
    payload,
    status,
  ] of /** @type {Array<[string,any,number]>} */ ([
    [
      '/external-receipts',
      {
        ...versions,
        amountCents: 7000,
        receivedOn: '2026-11-04',
        method: 'cash',
        note: '',
      },
      200,
    ],
    [
      '/external-receipts/receipt-id/reverse',
      { ...versions, reason: 'duplicate human record' },
      200,
    ],
    [
      '/charges/charge-id/check-payment',
      { ...versions, invoiceSlug: 'invoice', transactionNsu: 'transaction' },
      202,
    ],
  ])) {
    const response = await api.inject({
      method: 'POST',
      url: BASE + path,
      headers: HEADERS,
      payload,
    });
    assert.equal(response.statusCode, status);
    assert.match(String(response.headers['cache-control']), /no-store/u);
    assert.equal(calls.at(-1).actor.id, 'synthetic-seller');
    if (path.includes('reverse'))
      assert.equal(calls.at(-1).receiptId, 'receipt-id');
    if (path.includes('check-payment')) {
      assert.equal(calls.at(-1).chargeId, 'charge-id');
      assert.deepEqual(response.json(), {
        checkId: 'synthetic-check',
        state: 'queued',
      });
    }
  }
});
test('BFIN-06/07 technical lookup/result require narrow workflow authentication and refuse forged payment claims', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  const path = '/api/v1/integrations/n8n/billing/payment-checks/check-id';
  const headers = {
    authorization: 'Basic synthetic-technical',
    'x-correlation-id': CORRELATION,
    'idempotency-key': 'synthetic-check',
    'x-silmer-workflow-key': 'silmer-order-billing',
    'x-silmer-workflow-version': 'order-billing-check-1',
    'x-silmer-execution-id': 'synthetic-execution',
  };
  assert.equal(
    (
      await api.inject({
        url: path,
        headers: { ...headers, authorization: '', cookie: HEADERS.cookie },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await api.inject({
        url: path,
        headers: { ...headers, 'x-silmer-workflow-key': 'store' },
      })
    ).statusCode,
    403,
  );
  const lookup = await api.inject({ url: path, headers });
  assert.equal(lookup.statusCode, 200);
  assert.equal(lookup.json().transactionNsu, 'transaction-private');
  assert.match(String(lookup.headers['cache-control']), /no-store/u);
  const count = calls.length;
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: path + '/result',
        headers,
        payload: { status: 'paid', amountCents: 10000 },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls.length, count);
  const result = await api.inject({
    method: 'POST',
    url: path + '/result',
    headers,
    payload: { status: 'not_paid' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, 'not_paid');
  assert.equal(calls.at(-1).checkId, 'check-id');
});
test('BFIN-01/06 reject browser auth bypass, unreviewed payment proofs and malformed command shapes before services', async (t) => {
  const { api, calls } = fixture();
  t.after(() => api.close());
  const payload = {
    ...versions,
    amountCents: 7000,
    receivedOn: '2026-11-04',
    method: 'cash',
    note: '',
  };
  for (const headers of [
    {},
    { ...HEADERS, 'x-csrf-token': '' },
    { ...HEADERS, authorization: 'Basic synthetic' },
  ]) {
    assert.equal(
      (
        await api.inject({
          method: 'POST',
          url: BASE + '/external-receipts',
          headers,
          payload,
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: BASE + '/external-receipts',
        headers: HEADERS,
        payload: { ...payload, paid: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: BASE + '/charges/c/check-payment',
        headers: HEADERS,
        payload: {
          ...versions,
          invoiceSlug: 'invoice',
          transactionNsu: 'transaction',
          amountCents: 10000,
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls.length, 0);
});
