import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createOrderBillingCheckWorkflow,
  normalizeBillingCheckInput,
} from '../ops/n8n/workflows/create-order-billing-check-workflow.mjs';

const ID = '50c242cc-7a80-48a0-b2ce-750807589e17';
const config = {
  crmBaseUrl: 'http://billing-crm:3000',
  gatewayBaseUrl: 'http://billing-simulator:8080',
  webhookUrl: 'http://n8n:5678/webhook/silmer/order-billing-dev/paid',
  handle: 'synthetic-billing',
};

function run(/** @type {any} */ options = {}) {
  const workflow = createOrderBillingCheckWorkflow({}, { development: true });
  /** @type {Record<string,any>} */ const outputs = {};
  /** @type {string[]} */ const calls = [];
  let name = 'Receber conferência autorizada';
  /** @type {any} */ let value = {
    body: { schema_version: '1.0', check_id: ID },
  };
  let ack = false;
  let failure;
  const context = () => ({
    $json: value,
    $execution: { id: 'synthetic-check-execution' },
    $: (/** @type {string} */ n) => ({ first: () => ({ json: outputs[n] }) }),
  });
  const expression = (/** @type {string} */ code) =>
    runInNewContext(`(${code.slice(3, -2).trim()})`, context());
  try {
    for (let i = 0; name && i < 25; i++) {
      const node = workflow.nodes.find((node) => node.name === name);
      assert.ok(node);
      let branch = 0;
      if (node.type === 'n8n-nodes-base.set')
        value = { ...value, ...JSON.parse(node.parameters.jsonOutput) };
      if (node.type === 'n8n-nodes-base.code')
        value = runInNewContext(
          `(function(){${node.parameters.jsCode}})()`,
          context(),
        ).json;
      if (node.type === 'n8n-nodes-base.if')
        branch = expression(node.parameters.conditions.conditions[0].leftValue)
          ? 0
          : 1;
      if (node.type === 'n8n-nodes-base.httpRequest') {
        const url = node.parameters.url.startsWith('={{')
          ? expression(node.parameters.url)
          : node.parameters.url;
        calls.push(url);
        if (url.endsWith('/payment-checks/' + ID))
          value = {
            checkId: ID,
            chargeId: ID,
            invoiceSlug: 'synthetic-invoice',
            transactionNsu: 'synthetic-transaction',
            receiptUrl: null,
            state: 'queued',
            amountCents: 3000,
          };
        else if (url.endsWith('/payment_check'))
          value = {
            success: true,
            paid: options.unpaid !== true,
            amount: options.underpaid ? 2999 : 3000,
            paid_amount: 3000,
            capture_method: 'pix',
            installments: 1,
          };
        else if (url.endsWith('/payment')) {
          if (options.paymentFailure)
            throw new Error('SYNTHETIC_PERSISTENCE_FAILED');
          value = { recorded: true };
        } else if (url.endsWith('/result')) {
          if (options.resultFailure) throw new Error('SYNTHETIC_RESULT_FAILED');
          value = { recorded: true };
        } else throw new Error('unexpected local request');
      }
      if (node.type === 'n8n-nodes-base.respondToWebhook') ack = true;
      outputs[name] = value;
      name = workflow.connections[name]?.main?.[branch]?.[0]?.node;
    }
  } catch (error) {
    failure = error;
  }
  return { calls, ack, failure };
}

test('BFIN-06 recovery input is a strict CRM check identity and refuses external DEV destinations', () => {
  assert.equal(
    normalizeBillingCheckInput(
      { schema_version: '1.0', check_id: ID },
      config,
      true,
    ).checkId,
    ID,
  );
  for (const body of [
    { schema_version: '1.0', check_id: ID, paid: true },
    { schema_version: '1.0', check_id: ID, amount: 3000 },
    { schema_version: '1.0', check_id: 'invalid' },
  ])
    assert.throws(() => normalizeBillingCheckInput(body, config, true));
  assert.throws(() =>
    createOrderBillingCheckWorkflow(
      { ...config, crmBaseUrl: 'https://crm.example.test' },
      { development: true },
    ),
  );
  const production = createOrderBillingCheckWorkflow();
  assert.equal(production.active, false);
  assert.equal(
    production.nodes.find((node) => node.type === 'n8n-nodes-base.webhook')
      .parameters.path,
    'silmer/order-billing/check',
  );
  assert.equal(
    production.nodes.some(
      (node) =>
        node.parameters.url ===
        'https://api.checkout.infinitepay.io/payment_check',
    ),
    true,
  );
  assert.equal(
    production.nodes.some((node) =>
      String(node.parameters.url).endsWith('/links'),
    ),
    false,
  );
});

test('BFIN-06 verified recovery persists payment before durable result and ACK; unpaid records no payment', () => {
  const paid = run();
  assert.equal(paid.failure, undefined);
  assert.equal(paid.ack, true);
  assert.deepEqual(
    paid.calls.map((url) => url.split('/').at(-1)),
    [ID, 'payment_check', 'payment', 'result'],
  );
  const unpaid = run({ unpaid: true });
  assert.equal(unpaid.failure, undefined);
  assert.equal(unpaid.ack, true);
  assert.deepEqual(
    unpaid.calls.map((url) => url.split('/').at(-1)),
    [ID, 'payment_check', 'result'],
  );
});

test('BFIN-06/07 underpayment or failed durable callbacks never acknowledge successful reconciliation', () => {
  for (const fault of [
    { underpaid: true },
    { paymentFailure: true },
    { resultFailure: true },
  ]) {
    const result = run(fault);
    assert.ok(result.failure);
    assert.equal(result.ack, false);
    assert.equal(
      result.calls.some((url) => url.endsWith('/links')),
      false,
    );
  }
});
