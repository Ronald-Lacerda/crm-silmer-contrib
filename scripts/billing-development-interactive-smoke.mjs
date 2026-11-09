import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.env.RUN_BILLING_INTERACTIVE_SMOKE !== 'yes')
  throw new Error('Explicit local interactive smoke required');
const base = 'http://127.0.0.1:4180';
const health = await globalThis.fetch(base + '/__billing-development/health');
assert.equal(health.status, 200);
assert.equal((await health.json()).synthetic, true);
const login = await globalThis.fetch(base + '/api/v1/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({
    email: 'vendedor@crm-silmer.local',
    password: 'Desenvolvimento!2026',
  }),
});
assert.equal(login.status, 200);
const cookies = login.headers
  .getSetCookie()
  .map((value) => value.split(';')[0]);
const cookie = cookies.join('; ');
const csrf = cookies
  .find((value) => value.startsWith('crm_csrf='))
  ?.slice('crm_csrf='.length);
assert.ok(csrf);
const headers = {
  cookie,
  origin: base,
  'x-csrf-token': csrf,
  'content-type': 'application/json',
};
async function get(/** @type {string} */ path) {
  const r = await globalThis.fetch(base + path, {
    headers: { cookie, origin: base },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function post(
  /** @type {string} */ path,
  /** @type {any} */ body,
  expected = 200,
) {
  const r = await globalThis.fetch(base + path, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  assert.equal(r.status, expected, await r.clone().text());
  return r.json();
}
async function wait(/** @type {()=>Promise<boolean>} */ condition) {
  for (let n = 0; n < 90; n++) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('BILLING_INTERACTIVE_SMOKE_TIMEOUT');
}
const seeded = await post('/__billing-development/seed', {});
const prefix = `/api/v1/orders/${seeded.orderId}/billing`;
const before = (await get(prefix)).billing;
const conversation = await get(
  `/api/v1/inbox/conversations/${seeded.conversationId}`,
);
const target = conversation.conversation ?? conversation;
const intent = await post(
  prefix + '/send-intents',
  {
    action: 'issue',
    conversationId: seeded.conversationId,
    expectedVersion: before.orderVersion,
    expectedBillingVersion: before.version,
    expectedConversationVersion: target.version,
    percent: 30,
  },
  202,
);
await wait(
  async () =>
    (await get(prefix + '/send-intents/' + intent.id)).state === 'delivered',
);
const silent = await post('/__billing-development/confirm', {
  chargeId: intent.chargeId,
  notify: false,
});
assert.equal(silent.notified, false);
assert.equal((await get(prefix)).billing.receivedAmountCents, 0);
const current = (await get(prefix)).billing;
assert.equal(current.paymentCheckEnabled, true);
await post(
  prefix + `/charges/${intent.chargeId}/check-payment`,
  {
    expectedVersion: current.orderVersion,
    expectedBillingVersion: current.version,
    invoiceSlug: silent.candidate.invoice_slug,
    transactionNsu: silent.candidate.transaction_nsu,
  },
  202,
);
await wait(
  async () => (await get(prefix)).billing.receivedAmountCents === 3000,
);
let paid = (await get(prefix)).billing;
assert.equal(paid.balanceAmountCents, 7000);
assert.equal(paid.paymentChecks[0].state, 'paid');
const receivedOn = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
}).format(new Date());
await post(prefix + '/external-receipts', {
  expectedVersion: paid.orderVersion,
  expectedBillingVersion: paid.version,
  amountCents: 7000,
  receivedOn,
  method: 'cash',
  note: 'Recebimento sintético presencial',
});
paid = (await get(prefix)).billing;
assert.equal(paid.receivedAmountCents, 10000);
assert.equal(paid.balanceAmountCents, 0);
assert.equal(paid.externalReceipts[0].method, 'cash');
await post(
  prefix + `/external-receipts/${paid.externalReceipts[0].id}/reverse`,
  {
    expectedVersion: paid.orderVersion,
    expectedBillingVersion: paid.version,
    reason: 'Correção sintética do registro externo',
  },
);
paid = (await get(prefix)).billing;
assert.equal(paid.receivedAmountCents, 3000);
assert.equal(paid.balanceAmountCents, 7000);
const history = await get(prefix + '/history');
assert.ok(
  history.items.some(
    (/** @type {any} */ item) => item.kind === 'external_receipt',
  ),
);
assert.ok(
  history.items.some(
    (/** @type {any} */ item) => item.kind === 'external_reversal',
  ),
);
const state = await get('/__billing-development/state');
assert.equal(
  state.effects[(await get(prefix + '/send-intents/' + intent.id)).commandId],
  1,
);
await mkdir('var', { recursive: true });
await writeFile(
  'var/billing-interactive-smoke-result.json',
  JSON.stringify(
    {
      verdict: 'PASS',
      synthetic: true,
      login: 'real session and CSRF',
      transport:
        'real n8n reservation/preflight/delivery with simulated provider',
      missedWebhook: 'recovered by authenticated payment check',
      receivedAmountCents: 3000,
      balanceAmountCents: 7000,
      externalReceipt: '7000 recorded and reversed with history',
      orderId: seeded.orderId,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  'PASS billing interactive: real login/CSRF, delivery, missed webhook recovery, external receipt and reversal.\n',
);
