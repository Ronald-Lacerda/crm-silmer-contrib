import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerFinanceRoutes } from '../apps/api/src/finance-routes.js';
import {
  financeCursor,
  financeQuery,
  financeVersions,
  isFinanceEligible,
} from '../modules/orders/src/domain/finance.js';

const eligible = {
  status: 'confirmado',
  paid_on: '2026-10-20',
  is_test: false,
  finance_payment_review_required: false,
  final_amount_cents: 10000,
  origin: 'atendimento',
};

test('FINQ-04/05: full settlement, confirmation, non-test and reviewed legacy dates are required', () => {
  assert.equal(isFinanceEligible(eligible), true);
  for (const overrides of [
    { status: 'pendente' },
    { cancelled_at: '2026-11-06T15:00:00.000Z' },
    { paid_on: null },
    { is_test: true },
    { finance_payment_review_required: true },
    { final_amount_cents: 0 },
    { origin: 'loja', paid_amount_cents: 9999 },
  ]) {
    assert.equal(isFinanceEligible({ ...eligible, ...overrides }), false);
  }
  assert.equal(
    isFinanceEligible({
      ...eligible,
      origin: 'loja',
      paid_amount_cents: 10000,
    }),
    true,
  );
  assert.equal(isFinanceEligible(null), false);
});

test('OLIST-46: cancellation removes financial eligibility while preserving scoped history', () => {
  const cancelled = {
    ...eligible,
    cancelled_at: '2026-11-06T15:00:00.000Z',
    completed_at: '2026-11-05T15:00:00.000Z',
  };
  assert.equal(isFinanceEligible(cancelled), false);
  assert.equal(isFinanceEligible(cancelled, true), true);
  for (const overrides of [
    { status: 'pendente' },
    { paid_on: null },
    { is_test: true },
    { finance_payment_review_required: true },
    { origin: 'loja', paid_amount_cents: 9999 },
  ]) {
    assert.equal(
      isFinanceEligible({ ...cancelled, ...overrides }, true),
      false,
    );
  }
});

test('FINQ-06: bounded filters and cursors cannot cross lists', () => {
  assert.deepEqual(financeQuery(), {
    status: 'waiting',
    limit: 25,
    after: null,
  });
  const row = {
    id: 'order-1',
    number_sequence: 1,
    paid_on: '2026-10-20',
    completed_at: '2026-10-21T12:00:00Z',
  };
  for (const status of /** @type {const} */ (['waiting', 'completed'])) {
    const cursor = financeCursor(row, status);
    assert.equal(financeQuery({ status, cursor }).after?.id, row.id);
    assert.throws(
      () =>
        financeQuery({
          status: status === 'waiting' ? 'completed' : 'waiting',
          cursor,
        }),
      { code: 'INVALID_CURSOR' },
    );
  }
  for (const query of [
    null,
    [],
    { owner: 'seller-1' },
    { status: ['waiting'] },
    { limit: 0 },
    { limit: 101 },
    { cursor: 'garbage' },
  ]) {
    assert.throws(() => financeQuery(query), { statusCode: 400 });
  }
  for (const input of [
    null,
    {},
    { expectedVersion: 1, expectedFinanceVersion: -1 },
    { expectedVersion: '1', expectedFinanceVersion: 0 },
  ]) {
    assert.throws(() => financeVersions(input), {
      code: 'INVALID_EXPECTED_VERSION',
    });
  }
});

test('FINQ-03/11: HTTP reads and commands use distinct guards, strict bodies and safe errors', async () => {
  const api = Fastify();
  /** @type {any[]} */
  const calls = [];
  let denied = false;
  let failed = false;
  const finance = {
    authorizeRead: async (/** @type {any} */ input) => {
      calls.push(input);
      if (denied)
        throw Object.assign(new Error('secret'), {
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      return { actor: { id: 'finance-1' } };
    },
    authorizeWrite: async (/** @type {any} */ input) => {
      calls.push(input);
      if (denied)
        throw Object.assign(new Error('secret'), {
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      return { actor: { id: 'finance-1' } };
    },
    list: async () => {
      if (failed) throw new Error('private database data');
      return {
        items: [],
        counts: { waiting: 0, completed: 0 },
        nextCursor: null,
      };
    },
    get: async () => ({ order: { id: 'order-1' } }),
    change: async (/** @type {any} */ input) => {
      calls.push(input);
      return { order: { id: input.orderId } };
    },
  };
  registerFinanceRoutes(api, finance, () => ({
    correlationId: 'synthetic-correlation',
  }));
  try {
    const list = await api.inject({ url: '/api/v1/finance/orders' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'private, no-store');
    assert.equal(calls[0].action, 'finance.read');
    const headers = {
      'idempotency-key': 'synthetic-key',
      'x-csrf-token': 'csrf',
      origin: 'https://crm.example.test',
      cookie: 'crm_session=test',
    };
    for (const action of ['complete', 'reopen']) {
      const result = await api.inject({
        method: 'POST',
        url: `/api/v1/finance/orders/order-1/${action}`,
        headers,
        payload: { expectedVersion: 3, expectedFinanceVersion: 0 },
      });
      assert.equal(result.statusCode, 200);
      assert.equal(calls.at(-2).action, `finance.${action}`);
      assert.equal(calls.at(-2).csrfToken, 'csrf');
      assert.equal(calls.at(-1).idempotencyKey, 'synthetic-key');
      assert.equal(calls.at(-1).correlationId, 'synthetic-correlation');
    }
    const invalid = await api.inject({
      method: 'POST',
      url: '/api/v1/finance/orders/order-1/complete',
      headers,
      payload: {
        expectedVersion: 3,
        expectedFinanceVersion: 0,
        finalAmountCents: 1,
      },
    });
    assert.equal(invalid.statusCode, 400);
    denied = true;
    for (const request of [
      { url: '/api/v1/finance/orders' },
      { url: '/api/v1/finance/orders/order-1' },
      {
        method: /** @type {const} */ ('POST'),
        url: '/api/v1/finance/orders/order-1/complete',
        headers,
        payload: { expectedVersion: 3, expectedFinanceVersion: 0 },
      },
    ]) {
      const result = await api.inject(request);
      assert.equal(result.statusCode, 403);
      assert.equal(JSON.stringify(result.json()).includes('secret'), false);
    }
    denied = false;
    failed = true;
    const failure = await api.inject({ url: '/api/v1/finance/orders' });
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.json().code, 'SERVICE_UNAVAILABLE');
    assert.equal(failure.body.includes('private database'), false);
  } finally {
    await api.close();
  }
});
