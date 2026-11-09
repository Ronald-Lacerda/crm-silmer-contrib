import { expect, test } from '@playwright/test';
import { mockOrders, pendingOrder } from './support/orders-mock.js';

// A real EventSource stream.reset races the first, delayed scoped CRM read.
// No provider endpoint is used; every API request is intercepted.
const orderId = '77777777-7777-4777-8777-777777777771';
const base = `/api/v1/orders/${orderId}/olist`;
const token = 'synthetic-initial-sync-review';

/** @param {import('@playwright/test').Page} page @param {{admin?:boolean,initialForbidden?:boolean}} [options] */
async function setup(page, options = {}) {
  const user = {
    id: 'sync-user',
    name: 'Usuário sintético',
    functionName: options.admin ? 'Administrador' : 'Vendedor',
    capabilities: options.admin ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: !options.admin,
    olistAuthorizationVersion: 2,
  };
  const order = { ...pendingOrder, id: orderId, number: '73-CRM' };
  await mockOrders(page, { orders: [order], user });
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'sync-test-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  /** @type {Array<{path:string,method:string,body:any}>} */ const calls = [];
  let reads = 0,
    sessionReads = 0;
  let releaseInitial = () => {},
    reset = () => {};
  const firstReadGate = new Promise((resolve) => {
    releaseInitial = () => resolve(null);
  });
  const resetGate = new Promise((resolve) => {
    reset = () => resolve(null);
  });
  const groups = [
    {
      groupId: 'sync-group',
      attributes: {
        garment: 'CAMISETA',
        color: 'AZUL',
        fabric: '["PV"]',
        application: 'SILK',
        collar: 'VIÉS',
        audience: '',
      },
      lines: [
        { lineId: 'sync-line', size: 'M', quantity: 2, subtotalCents: 3000 },
      ],
    },
  ];
  const projection = {
    orderId,
    number: '73-CRM',
    status: 'pendente',
    creationEnabled: true,
    paymentDuePolicy: 'erp',
    productFiscalDeferred: true,
    operation: null,
    pendingFields: [],
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    const body = method === 'POST' ? req.postDataJSON() : null;
    calls.push({ path, method, body });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({ status, json: value });
    if (path === '/api/v1/sessions/current') {
      sessionReads++;
      return json({ user });
    }
    if (path === '/api/v1/events') {
      await resetGate;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\nevent: stream.reset\nid: 1\ndata: {"type":"stream.reset","cursor":"1"}\n\n',
      });
    }
    if (path === base && method === 'GET') {
      reads++;
      if (reads === 1) {
        await firstReadGate;
        if (options.initialForbidden)
          return json({ code: 'FORBIDDEN', status: 403 }, 403);
      }
      return json(projection);
    }
    if (path === `${base}/administration`)
      return json({
        operation: null,
        resources: [],
        requests: [],
        attempts: [],
        paymentDuePolicy: 'erp',
        legacyLinkContext: {
          paymentDuePolicy: 'fixed_date',
          historicalDueReadOnly: true,
          groups,
        },
      });
    if (path === '/api/v1/integrations/olist/status')
      return json({
        configured: false,
        connected: false,
        creationEnabled: false,
      });
    if (path === `${base}/preview`) {
      expect(body).toEqual({});
      return json({
        orderId,
        eligible: true,
        creationEnabled: true,
        previewToken: token,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        customer: { name: 'Comprador sintético' },
        commercial: {
          groups,
          orderDate: '2026-11-09',
          deliveryOn: '2026-12-15',
          paymentCondition: 'pix',
          paymentDueOn: null,
          totalCents: 3000,
        },
        issues: [],
      });
    }
    if (path === `${base}/preview/check`) {
      expect(body).toEqual({ previewToken: token });
      return json({ valid: true, creationEnabled: true });
    }
    if (path === `${base}/export`) {
      expect(body).toEqual({ previewToken: token });
      return json(
        {
          orderId,
          number: '73-CRM',
          operationId: 'sync-operation',
          state: 'queued',
          stage: 'customer',
        },
        202,
      );
    }
    if (path.startsWith(base)) return json({ code: 'FORBIDDEN' }, 403);
    return route.fallback();
  });
  await page.goto(
    options.admin ? `/pedidos/${orderId}` : `/olist?pedido=${orderId}`,
  );
  return {
    calls,
    reset,
    releaseInitial,
    get reads() {
      return reads;
    },
    get sessionReads() {
      return sessionReads;
    },
  };
}

/** @param {{calls:Array<{path:string,method:string}>}} state */
function expectNoCommands(state) {
  expect(state.calls.filter((call) => call.method === 'POST')).toEqual([]);
}

test('Olist initial stream reset restores administration without granting the Olist checkbox', async ({
  page,
}) => {
  const state = await setup(page, { admin: true });
  await expect.poll(() => state.reads).toBe(1);
  state.reset();
  await expect.poll(() => state.sessionReads).toBeGreaterThan(1);
  state.releaseInitial();
  await expect(
    page.getByRole('button', {
      name: 'Vincular venda histórica por linha',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revisar envio', exact: true }),
  ).toHaveCount(0);
  expect(state.reads).toBe(2);
  expectNoCommands(state);
});

test('Olist initial stream reset recovers the operator projection and keeps two explicit sending gestures', async ({
  page,
}) => {
  const state = await setup(page);
  await expect.poll(() => state.reads).toBe(1);
  state.reset();
  await expect.poll(() => state.sessionReads).toBeGreaterThan(1);
  state.releaseInitial();
  await expect(page.locator('.olist-preparation .op-sheet-head')).toContainText(
    'Pedido 73-CRM',
  );
  expect(state.reads).toBe(2);
  expectNoCommands(state);
  await page
    .getByRole('button', { name: 'Revisar envio', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Enviar para Olist?',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(
    state.calls.filter((call) => call.path === `${base}/export`),
  ).toHaveLength(0);
  await dialog
    .getByRole('button', { name: 'Enviar para Olist', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    state.calls.filter((call) => call.path === `${base}/export`),
  ).toHaveLength(1);
});

test('Olist stream reset does not retry a denied scoped read or expose administrative controls', async ({
  page,
}) => {
  const state = await setup(page, { admin: true, initialForbidden: true });
  await expect.poll(() => state.reads).toBe(1);
  state.releaseInitial();
  await expect(
    page.locator('.olist-preparation').getByRole('alert'),
  ).toContainText('Seu acesso mudou');
  state.reset();
  await expect.poll(() => state.sessionReads).toBeGreaterThan(1);
  await expect(
    page.locator('.olist-preparation').getByRole('alert'),
  ).toContainText('Seu acesso mudou');
  await expect(
    page.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Revisar envio', exact: true }),
  ).toHaveCount(0);
  expect(state.reads).toBe(1);
  expectNoCommands(state);
});
