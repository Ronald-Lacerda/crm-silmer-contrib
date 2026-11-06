import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  billingCheckoutPayload,
  billingCreatedResult,
  createOrderBillingWorkflow,
  normalizeBillingInput,
  verifiedBillingPayment,
} from '../ops/n8n/workflows/create-order-billing-workflow.mjs';

const CHARGE = '50c242cc-7a80-48a0-b2ce-750807589e17';
const CONFIG = {
  crmBaseUrl: 'https://crm.example.test',
  handle: 'synthetic-merchant',
  webhookUrl:
    'https://automation.example.test/webhook/silmer/order-billing/paid',
};
const COMMAND = { schema_version: '1.0', charge_id: CHARGE };
const CANDIDATE = {
  order_nsu: CHARGE,
  invoice_slug: 'fixture-invoice',
  transaction_nsu: 'fixture-transaction',
  receipt_url: 'https://receipt.infinitepay.io/fixture',
};
const CHECK = {
  success: true,
  paid: true,
  amount: 54000,
  paid_amount: 55000,
  capture_method: 'credit_card',
  installments: 3,
};
const RESERVATION = {
  allowed: true,
  chargeId: CHARGE,
  amountCents: 54000,
  description: 'Sinal do pedido sintético',
  validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

/** Runs the actual exported node code/expressions over local HTTP fixtures.
 * @param {'command'|'payment'} mode @param {Record<string,any>} [options] */
function runFixture(mode, options = {}) {
  const workflow = createOrderBillingWorkflow(options.configuration ?? CONFIG);
  const outputs = /** @type {Record<string,any>} */ ({});
  const calls = /** @type {string[]} */ ([]);
  const responses = /** @type {any[]} */ ([]);
  let current =
    mode === 'command'
      ? 'Receber emissão autorizada'
      : 'Receber aviso de pagamento';
  /** @type {any} */
  let value = { body: mode === 'command' ? COMMAND : CANDIDATE };
  const context = () => ({
    $json: value,
    $execution: { id: 'synthetic-execution' },
    $: (/** @type {string} */ name) => ({
      first: () => ({ json: outputs[name] }),
    }),
  });
  const expression = (/** @type {string} */ source) =>
    runInNewContext(`(${source.slice(3, -2).trim()})`, context());
  let error;
  try {
    for (let step = 0; current && step < 30; step++) {
      const node = workflow.nodes.find((node) => node.name === current);
      if (!node) throw new Error('fixture node missing');
      let branch = 0;
      if (node.type === 'n8n-nodes-base.set') {
        assert.equal(node.parameters.includeOtherFields, true);
        value = { ...value, ...JSON.parse(node.parameters.jsonOutput) };
      }
      if (node.type === 'n8n-nodes-base.code')
        value = runInNewContext(
          `(function(){${node.parameters.jsCode}})()`,
          context(),
        ).json;
      if (node.type === 'n8n-nodes-base.if')
        branch = value.allowed === true ? 0 : 1;
      if (node.type === 'n8n-nodes-base.httpRequest') {
        const url = node.parameters.url.startsWith('={{')
          ? expression(node.parameters.url)
          : node.parameters.url;
        calls.push(url);
        const body = node.parameters.jsonBody
          ? expression(node.parameters.jsonBody)
          : null;
        if (url.endsWith('/reserve'))
          value = options.allowed === false ? { allowed: false } : RESERVATION;
        else if (url.endsWith('/links')) {
          assert.equal(body.order_nsu, CHARGE);
          value = { url: 'https://checkout.infinitepay.io/fixture' };
        } else if (url.endsWith('/created')) {
          if (options.callbackFailure)
            throw new Error('BILLING_CALLBACK_UNAVAILABLE');
          value = { persisted: true };
        } else if (url.endsWith('/lookup')) {
          if (options.unknownCharge) throw new Error('BILLING_CHARGE_UNKNOWN');
          value = { chargeId: CHARGE, amountCents: 54000 };
        } else if (url.endsWith('/payment_check')) {
          assert.equal(body.handle, CONFIG.handle);
          assert.equal(body.slug, CANDIDATE.invoice_slug);
          value = options.check ?? CHECK;
        } else if (url.endsWith('/payment')) {
          if (options.callbackFailure)
            throw new Error('BILLING_CALLBACK_UNAVAILABLE');
          assert.equal(body.amountCents, 54000);
          value = { persisted: true };
        } else throw new Error('unexpected fixture HTTP');
      }
      if (node.type === 'n8n-nodes-base.respondToWebhook')
        responses.push(expression(node.parameters.responseBody));
      outputs[node.name] = value;
      current = workflow.connections[node.name]?.main[branch]?.[0]?.node;
    }
  } catch (caught) {
    error = caught;
  }
  return { calls, responses, error };
}

test('inactive workflow separates authenticated issuance from public payment candidates', () => {
  const workflow = createOrderBillingWorkflow();
  assert.equal(workflow.active, false);
  const triggers = workflow.nodes.filter(
    (node) => node.type === 'n8n-nodes-base.webhook',
  );
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0].parameters.authentication, 'basicAuth');
  assert.equal(triggers[1].parameters.authentication, undefined);
  assert.ok(
    triggers.every((node) => node.parameters.responseMode === 'responseNode'),
  );
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.doesNotMatch(JSON.stringify(workflow), /\$vars|\$env/u);
  const configurationNodes = workflow.nodes.filter(
    (node) => node.type === 'n8n-nodes-base.set',
  );
  assert.equal(configurationNodes.length, 2);
  for (const node of configurationNodes) {
    assert.equal(node.typeVersion, 3.4);
    assert.deepEqual(JSON.parse(node.parameters.jsonOutput).billingConfig, {
      crmBaseUrl: '',
      handle: '',
      webhookUrl: '',
    });
  }
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /inchk_|5527|cliente@example|CRM_AUTOMATION_CLIENT_SECRET/,
  );
  for (const node of workflow.nodes.filter(
    (node) => node.type === 'n8n-nodes-base.httpRequest',
  )) {
    assert.equal(node.retryOnFail, false);
    assert.equal(
      node.parameters.options.redirect.redirect.followRedirects,
      false,
    );
  }
});

test('actual workflow runs reserve -> link -> callback before acknowledgement', () => {
  const result = runFixture('command');
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.calls.map((url) => url.split('/').at(-1)),
    ['reserve', 'links', 'created'],
  );
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].accepted, true);
});

test('Community execution needs no custom variables and fails before network I/O when unconfigured', () => {
  const result = runFixture('command', { configuration: {} });
  assert.match(String(result.error), /BILLING_CONFIGURATION_INVALID/);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.responses, []);
  assert.throws(
    () => createOrderBillingWorkflow({ handle: 'inchk_forbidden_secret' }),
    /non-secret/,
  );
  assert.throws(
    () =>
      createOrderBillingWorkflow(
        /** @type {any} */ ({ apiKey: 'must-not-export' }),
      ),
    /non-secret/,
  );
});

test('consumed financial reserve never calls the gateway again', () => {
  const result = runFixture('command', { allowed: false });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.equal(result.responses[0].duplicate, true);
});

test('creation callback failure does not acknowledge or repeat link creation', () => {
  const result = runFixture('command', { callbackFailure: true });
  assert.equal(result.responses.length, 0);
  assert.equal(result.calls.filter((url) => url.endsWith('/links')).length, 1);
  assert.match(String(result.error), /BILLING_CALLBACK_UNAVAILABLE/);
});

test('payment acknowledgement follows known charge lookup, payment_check and durable callback', () => {
  const result = runFixture('payment');
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.calls.map((url) => url.split('/').at(-1)),
    ['lookup', 'payment_check', 'payment'],
  );
  assert.equal(result.responses.length, 1);
  const failed = runFixture('payment', { callbackFailure: true });
  assert.equal(failed.responses.length, 0);
});

test('unconfirmed or undersized payment and unknown charge never reach payment recording', () => {
  for (const check of [
    { ...CHECK, paid: false },
    { ...CHECK, success: false },
    { ...CHECK, amount: 100 },
    { ...CHECK, paid_amount: 100 },
  ]) {
    const result = runFixture('payment', { check });
    assert.equal(result.responses.length, 0);
    assert.equal(
      result.calls.some((url) => url.endsWith('/payment')),
      false,
    );
  }
  const unknown = runFixture('payment', { unknownCharge: true });
  assert.equal(unknown.calls.length, 1);
  assert.equal(unknown.responses.length, 0);
});

test('only verified gateway amounts are recorded; card fees are kept separate', () => {
  const candidate = normalizeBillingInput(CANDIDATE, CONFIG, 'payment');
  const payment = verifiedBillingPayment(CHECK, candidate, {
    chargeId: CHARGE,
    amountCents: 54000,
  });
  assert.deepEqual(payment, {
    transactionNsu: CANDIDATE.transaction_nsu,
    invoiceSlug: CANDIDATE.invoice_slug,
    amountCents: 54000,
    paidAmountCents: 55000,
    method: 'credit_card',
    installments: 3,
    receiptUrl: CANDIDATE.receipt_url,
  });
  assert.throws(
    () =>
      verifiedBillingPayment({ ...CHECK, capture_method: 'cash' }, candidate, {
        chargeId: CHARGE,
        amountCents: 54000,
      }),
    /BILLING_PAYMENT_METHOD_INVALID/,
  );
  assert.throws(
    () =>
      verifiedBillingPayment(
        { ...CHECK, capture_method: 'pix', installments: 3 },
        candidate,
        { chargeId: CHARGE, amountCents: 54000 },
      ),
    /BILLING_PAYMENT_METHOD_INVALID/,
  );
});

test('checkout requires an unconsumed reservation and selects one payment plus explicit validity', () => {
  const config = normalizeBillingInput(COMMAND, CONFIG);
  const payload = billingCheckoutPayload(RESERVATION, config);
  assert.equal(payload.options.single_payment, true);
  assert.deepEqual(payload.options.payment_methods_enabled, [
    'pix',
    'credit_card',
  ]);
  assert.equal(payload.items[0].price, 54000);
  assert.equal(payload.items[0].quantity, 1);
  assert.throws(
    () => billingCheckoutPayload({ ...RESERVATION, allowed: false }, config),
    /BILLING_RESERVATION_INVALID/,
  );
  assert.throws(
    () =>
      billingCheckoutPayload(
        { ...RESERVATION, validUntil: '2000-01-01T00:00:00Z' },
        config,
      ),
    /BILLING_RESERVATION_INVALID/,
  );
});

test('malformed candidates and non-provider URLs are rejected before network I/O', () => {
  assert.throws(
    () =>
      normalizeBillingInput(
        { ...CANDIDATE, items: ['あ'.repeat(6000)] },
        CONFIG,
        'payment',
      ),
    /BILLING_INPUT_INVALID/,
  );
  assert.throws(
    () => normalizeBillingInput({ ...COMMAND, amount: 1 }, CONFIG),
    /BILLING_COMMAND_INVALID/,
  );
  assert.throws(
    () =>
      normalizeBillingInput(
        { ...CANDIDATE, receipt_url: 'https://infinitepay.io.attacker.test/x' },
        CONFIG,
        'payment',
      ),
    /BILLING_RECEIPT_URL_INVALID/,
  );
  assert.throws(
    () =>
      normalizeBillingInput(
        { ...CANDIDATE, transaction_nsu: 'unsafe\nvalue' },
        CONFIG,
        'payment',
      ),
    /BILLING_PAYMENT_ID_INVALID/,
  );
  assert.throws(
    () =>
      normalizeBillingInput(COMMAND, {
        ...CONFIG,
        crmBaseUrl: 'https://secret@crm.example.test',
      }),
    /BILLING_CONFIGURATION_INVALID/,
  );
  assert.throws(
    () => billingCreatedResult({ url: 'https://attacker.test/private' }),
    /BILLING_CHECKOUT_URL_INVALID/,
  );
  assert.throws(
    () =>
      billingCreatedResult({
        url: 'https://checkout.infinitepay.io:8443/private',
      }),
    /BILLING_CHECKOUT_URL_INVALID/,
  );
  assert.deepEqual(
    billingCreatedResult({ url: 'https://checkout.infinitepay.io/fixture' }),
    { checkoutUrl: 'https://checkout.infinitepay.io/fixture' },
  );
});
