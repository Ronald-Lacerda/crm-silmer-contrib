import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createOrderBillingDevelopmentWorkflow,
  createOrderBillingWorkflow,
  normalizeDevelopmentBillingInput,
} from '../ops/n8n/workflows/create-order-billing-workflow.mjs';

const CHARGE = '50c242cc-7a80-48a0-b2ce-750807589e17';
const COMMAND = { schema_version: '1.0', charge_id: CHARGE };
const CONFIG = {
  crmBaseUrl: 'http://billing-crm:3000',
  gatewayBaseUrl: 'http://billing-simulator:8080',
  webhookUrl: 'http://n8n:5678/webhook/silmer/order-billing-dev/paid',
  handle: 'synthetic-billing',
};

/** Executes generated code with the same limited globals as the current fixture.
 * @param {'command'|'payment'} mode @param {Record<string, any>} [options] */
function executeDevelopmentGraph(mode, options = {}) {
  const workflow = createOrderBillingDevelopmentWorkflow();
  /** @type {Record<string,any>} */
  const outputs = {};
  /** @type {Array<{url:string, body:any}>} */
  const calls = [];
  /** @type {any[]} */
  const acknowledgements = [];
  let current =
    mode === 'command'
      ? 'Receber emissão autorizada'
      : 'Receber aviso de pagamento';
  /** @type {any} */
  let value = {
    body:
      mode === 'command'
        ? COMMAND
        : {
            order_nsu: CHARGE,
            invoice_slug: 'synthetic-invoice',
            transaction_nsu: 'synthetic-payment',
            receipt_url:
              'https://receipt.infinitepay.io/synthetic-do-not-visit',
          },
  };
  const context = () => ({
    $json: value,
    $execution: { id: 'synthetic-dev-execution' },
    $: (/** @type {string} */ name) => ({
      first: () => ({ json: outputs[name] }),
    }),
  });
  const expression = (/** @type {string} */ code) =>
    runInNewContext(`(${code.slice(3, -2).trim()})`, context());
  let error;
  try {
    for (let count = 0; current && count < 30; count++) {
      const node = workflow.nodes.find((node) => node.name === current);
      assert.ok(node, 'all graph nodes must exist');
      let branch = 0;
      if (node.type === 'n8n-nodes-base.set') {
        value = { ...value, ...JSON.parse(node.parameters.jsonOutput) };
        if (options.tamper)
          value.billingConfig.gatewayBaseUrl =
            'https://api.checkout.infinitepay.io';
      }
      if (node.type === 'n8n-nodes-base.code')
        value = runInNewContext(
          `(function(){${node.parameters.jsCode}})()`,
          context(),
        ).json;
      if (node.type === 'n8n-nodes-base.if')
        branch = value.allowed === true ? 0 : 1;
      if (node.type === 'n8n-nodes-base.httpRequest') {
        const url = expression(node.parameters.url);
        const body = node.parameters.jsonBody
          ? expression(node.parameters.jsonBody)
          : null;
        calls.push({ url, body });
        if (url.endsWith('/reserve'))
          value = options.duplicate
            ? { allowed: false }
            : {
                allowed: true,
                chargeId: CHARGE,
                amountCents: 36000,
                description: 'Sinal sintético',
                validUntil: new Date(Date.now() + 86400000).toISOString(),
              };
        else if (url.endsWith('/links'))
          value = {
            url: 'https://checkout.infinitepay.io/synthetic-do-not-visit',
          };
        else if (url.endsWith('/created') || url.endsWith('/payment')) {
          if (options.callbackFailure)
            throw new Error('DEV_CALLBACK_UNAVAILABLE');
          value = { persisted: true };
        } else if (url.endsWith('/lookup')) {
          if (options.unknownCharge) throw new Error('DEV_CHARGE_UNKNOWN');
          value = { chargeId: CHARGE, amountCents: 36000 };
        } else if (url.endsWith('/payment_check'))
          value = {
            success: true,
            paid: true,
            amount: 36000,
            paid_amount: 36000,
            capture_method: 'pix',
            installments: 1,
            ...options.check,
          };
        else throw new Error('Unexpected DEV destination');
      }
      if (node.type === 'n8n-nodes-base.respondToWebhook')
        acknowledgements.push(expression(node.parameters.responseBody));
      outputs[node.name] = value;
      current = workflow.connections[node.name]?.main[branch]?.[0]?.node;
    }
  } catch (caught) {
    error = caught;
  }
  return { calls, acknowledgements, error };
}

test('BDEV-01 production default export stays byte-identical and DEV cannot enter through production config', () => {
  const workflow = createOrderBillingWorkflow();
  // Captured from the previously delivered, unchanged production export.
  assert.equal(
    createHash('sha256').update(JSON.stringify(workflow)).digest('hex'),
    'cbf8e5092e85bf741122ba67b613f685eeca1732f1fd2f28a481e38e6b75cce0',
  );
  assert.throws(
    () => createOrderBillingWorkflow(/** @type {any} */ (CONFIG)),
    /non-secret/,
  );
  assert.throws(
    () => createOrderBillingDevelopmentWorkflow(/** @type {any} */ (null)),
    /configuration/i,
  );
});

test('BDEV-01 DEV export is inactive, distinct, credential-separated and preserves the financial graph', () => {
  const prod = createOrderBillingWorkflow();
  const dev = createOrderBillingDevelopmentWorkflow();
  assert.equal(dev.active, false);
  assert.match(dev.name, /^DEV \|/);
  assert.deepEqual(dev.connections, prod.connections);
  assert.equal(dev.nodes.length, prod.nodes.length);
  for (const node of dev.nodes) {
    assert.equal(
      prod.nodes.some((candidate) => candidate.id === node.id),
      false,
    );
    for (const reference of Object.values(node.credentials ?? {}))
      assert.match(reference.name, / DEV$/);
    if (node.type === 'n8n-nodes-base.webhook') {
      assert.match(
        node.parameters.path,
        /^silmer\/order-billing-dev\/(create|paid)$/,
      );
      assert.equal(
        prod.nodes.some((candidate) => candidate.webhookId === node.webhookId),
        false,
      );
    }
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.equal(node.retryOnFail, false);
      assert.equal(
        node.parameters.options.redirect.redirect.followRedirects,
        false,
      );
    }
  }
  assert.equal(dev.settings.saveDataErrorExecution, 'none');
  assert.equal(dev.settings.saveDataSuccessExecution, 'none');
  assert.equal(dev.settings.saveManualExecutions, false);
});

test('BDEV-02 every DEV destination is local; remote accounts, expressions and confused hosts are refused', () => {
  for (const field of ['crmBaseUrl', 'gatewayBaseUrl', 'webhookUrl']) {
    for (const invalid of [
      'https://api.checkout.infinitepay.io',
      'https://production.example.test',
      'http://billing-crm:8080',
      'http://user:password@127.0.0.1:3000',
      'http://127.0.0.1.attacker.test:3000',
      'http://127.1:3000',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:3000?target=production',
      'http://127.0.0.1:3000#fragment',
      '={{ $env.REMOTE_URL }}',
    ])
      assert.throws(
        () =>
          createOrderBillingDevelopmentWorkflow({
            ...CONFIG,
            [field]: invalid,
          }),
        /configuration|non-secret/i,
      );
  }
  assert.throws(
    () => createOrderBillingDevelopmentWorkflow({ handle: 'real-merchant' }),
    /configuration/i,
  );
  assert.throws(
    () =>
      createOrderBillingDevelopmentWorkflow(
        /** @type {any} */ ({ apiKey: 'forbidden' }),
      ),
    /non-secret/i,
  );
  for (const hostname of ['127.0.0.1', 'localhost', 'host.docker.internal']) {
    const normalized = normalizeDevelopmentBillingInput(COMMAND, {
      ...CONFIG,
      crmBaseUrl: `http://${hostname}:23051`,
      gatewayBaseUrl: `http://${hostname}:23052`,
      webhookUrl: `http://${hostname}:25679/webhook/silmer/order-billing-dev/paid`,
    });
    assert.equal(normalized.crmBaseUrl, `http://${hostname}:23051`);
  }
  const tampered = executeDevelopmentGraph('command', { tamper: true });
  assert.match(String(tampered.error), /BILLING_DEV_CONFIGURATION_INVALID/);
  assert.equal(tampered.calls.length, 0);
  assert.equal(tampered.acknowledgements.length, 0);
});

test('BDEV-03 DEV issues once after CRM reservation and acknowledges only after durable callback', () => {
  const created = executeDevelopmentGraph('command');
  assert.equal(created.error, undefined);
  assert.deepEqual(
    created.calls.map((call) => call.url.split('/').at(-1)),
    ['reserve', 'links', 'created'],
  );
  assert.equal(created.calls[1].url, 'http://billing-simulator:8080/links');
  assert.equal(created.calls[1].body.items[0].price, 36000);
  assert.equal(created.calls[1].body.options.single_payment, true);
  assert.equal(created.calls[1].body.webhook_url, CONFIG.webhookUrl);
  assert.equal(created.acknowledgements[0].accepted, true);
  const duplicate = executeDevelopmentGraph('command', { duplicate: true });
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.calls.length, 1);
  assert.equal(duplicate.acknowledgements[0].duplicate, true);
  const failed = executeDevelopmentGraph('command', { callbackFailure: true });
  assert.equal(
    failed.calls.filter((call) => call.url.endsWith('/links')).length,
    1,
  );
  assert.equal(failed.acknowledgements.length, 0);
});

test('BDEV-03 DEV payment is checked against known charge and never trusts the public notice', () => {
  const paid = executeDevelopmentGraph('payment');
  assert.equal(paid.error, undefined);
  assert.deepEqual(
    paid.calls.map((call) => call.url.split('/').at(-1)),
    ['lookup', 'payment_check', 'payment'],
  );
  assert.equal(
    paid.calls[1].url,
    'http://billing-simulator:8080/payment_check',
  );
  assert.equal(paid.calls[2].body.amountCents, 36000);
  assert.equal(paid.acknowledgements[0].accepted, true);
  for (const invalid of [
    { paid: false },
    { amount: 100 },
    { paid_amount: 100 },
    { capture_method: 'cash' },
    { capture_method: 'pix', installments: 3 },
  ]) {
    const result = executeDevelopmentGraph('payment', { check: invalid });
    assert.ok(result.error);
    assert.equal(
      result.calls.some((call) => call.url.endsWith('/payment')),
      false,
    );
    assert.equal(result.acknowledgements.length, 0);
  }
  for (const options of [{ unknownCharge: true }, { callbackFailure: true }]) {
    const result = executeDevelopmentGraph('payment', options);
    assert.ok(result.error);
    assert.equal(result.acknowledgements.length, 0);
  }
});
