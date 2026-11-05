import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const base = '/api/v1/integrations/olist';
const settings = {
  sellerId: null,
  operationNatureId: null,
  warehouseId: null,
  paymentMethodId: null,
  priceListId: null,
  originId: null,
  paymentTerms: null,
  purchaseOrder: null,
};
const connected = {
  configured: true,
  accountConfigured: true,
  connected: true,
  reconnectRequired: false,
  creationEnabled: false,
  version: 3,
  generation: 2,
  settingsVersion: 4,
  settings,
  environment: 'production',
  expiresAt: null,
};

/** @param {import('@playwright/test').Page} page @param {{profile?:string,enabled?:boolean,conflict?:boolean}} [options] */
async function setup(page, options = {}) {
  const viewer = {
    id: 'viewer',
    name: 'Operador de exemplo',
    email: 'operador@example.test',
    functionName: options.profile === 'finance' ? 'Financeiro' : 'Vendedor',
    capabilities: options.profile === 'admin' ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: options.enabled ?? true,
    olistAuthorizationVersion: 2,
  };
  const target = {
    id: 'target',
    name: 'Pessoa financeira de exemplo',
    email: 'financeiro@example.test',
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: false,
    olistAuthorizationVersion: 7,
    disabledAt: null,
  };
  /** @type {Array<{path:string,body:any,url:string}>} */
  const calls = [];
  let current = { ...connected, settings: { ...settings } };
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'olist-test-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = ['POST', 'PATCH'].includes(req.method())
      ? req.postDataJSON()
      : null;
    calls.push({ path, body, url: page.url() });
    const json = (/** @type {unknown} */ value, code = 200) =>
      route.fulfill({
        contentType: 'application/json',
        status: code,
        body: JSON.stringify(value),
      });
    if (path === '/api/v1/sessions/current') return json({ user: viewer });
    if (path === '/api/v1/events') {
      await eventGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `retry: 60000\n\nevent: identity.user.changed\nid: olist-revoke\ndata: {"userId":"viewer"}\n\n`,
      });
    }
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });
    if (path === `${base}/status`) return json(current);
    if (path.startsWith(`${base}/`) && req.method() === 'POST') {
      expect(req.headers()['x-csrf-token']).toBe('olist-test-csrf');
      if (path !== `${base}/complete`)
        expect(req.headers()['idempotency-key']).toBeTruthy();
      if (path === `${base}/order-lookup`)
        return json({
          orderId: 'acbf1c1b-c57f-4c5c-8076-7f439f95cfb0',
          number: '41-CRM',
          status: 'pendente',
          pendingFields: [
            { code: 'CUSTOMER_FISCAL', label: 'Cadastro fiscal incompleto' },
          ],
          operation: null,
          creationEnabled: false,
        });
      if (path === `${base}/complete`) return json(current);
      if (path === `${base}/settings`) {
        current = {
          ...current,
          settings: body.settings,
          settingsVersion: current.settingsVersion + 1,
        };
        return json(current);
      }
      if (path === `${base}/disconnect`) {
        current = { ...current, connected: false };
        return json(current);
      }
      if (path === `${base}/authorize`)
        return json({
          authorizationUrl: 'https://unexpected.example.test/oauth',
        });
    }
    if (path === '/api/v1/users' && req.method() === 'GET')
      return json({ users: [viewer, target] });
    if (path === '/api/v1/users/target' && req.method() === 'PATCH') {
      expect(req.headers()['idempotency-key']).toBeTruthy();
      if (options.conflict) return json({ code: 'VERSION_CONFLICT' }, 409);
      target.olistEnabled = body.olistEnabled;
      target.olistAuthorizationVersion++;
      return json({ user: target });
    }
    if (path === '/api/v1/finance/orders')
      return json({
        items: [],
        counts: { waiting: 0, completed: 0 },
        nextCursor: null,
      });
    return json({
      columns: [],
      items: [],
      eventCursor: 'olist-before',
      period: {},
      totals: {},
      mine: {},
      team: [],
    });
  });
  return {
    calls,
    revoke() {
      viewer.olistEnabled = false;
      viewer.olistAuthorizationVersion++;
      releaseEvent();
    },
  };
}

test('enabled Financeiro searches exactly by keyboard with a minimum projection and no commercial access', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'finance' });
  await page.goto('/olist');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Olist' }),
  ).toBeFocused();
  await expect(
    page.getByRole('link', { name: 'Caixa de Entrada', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Conexão da empresa' }),
  ).toHaveCount(0);
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Pedido 41-CRM' }),
  ).toBeFocused();
  await expect(page.getByText('Cadastro fiscal incompleto')).toBeVisible();
  await expect(page.getByRole('link', { name: /Pedido 41/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Gerar/u })).toHaveCount(0);
  expect(
    calls.find((call) => call.path === `${base}/order-lookup`)?.body,
  ).toEqual({ query: '41-CRM' });
  expect(
    calls.filter(
      (call) =>
        call.path === `${base}/status` ||
        call.path === '/api/v1/orders' ||
        call.path === '/api/v1/contacts',
    ),
  ).toHaveLength(0);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: 'var/olist-finance-desktop.png',
    fullPage: true,
  });
  await page.goto('/inbox');
  await expect(page).toHaveURL('/financeiro');
});

test('lookup refuses incomplete numbers and remains usable on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await setup(page, { profile: 'finance' });
  await page.goto('/olist');
  await page.getByLabel('Número ou identificador do pedido').fill('41');
  await page
    .getByRole('button', { name: 'Localizar pedido', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(
    calls.filter((call) => call.path === `${base}/order-lookup`),
  ).toHaveLength(0);
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page
    .getByRole('button', { name: 'Localizar pedido', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Pedido 41-CRM' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const mobileNav = await page
    .getByRole('navigation', { name: 'Navegação móvel' })
    .boundingBox();
  expect(mobileNav?.height).toBeLessThanOrEqual(80);
  await page.screenshot({
    path: 'var/olist-finance-mobile.png',
    fullPage: true,
  });
});

test('disabled Admin manages the connection without order lookup or self-enablement', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Localizar pedido' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Conectar Olist', exact: false })
    .first()
    .click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page).toHaveURL('/olist');
  expect(
    calls.filter((call) => call.path === `${base}/order-lookup`),
  ).toHaveLength(0);
  await page.goto('/usuarios');
  await expect(
    page.getByLabel('Habilitado Olist', { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('Mais ações para Operador de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByLabel('Habilitado Olist'),
  ).toBeDisabled();
});

test('administrator enables an unrelated Financeiro with its current authorization version', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/usuarios');
  await page.getByLabel('Mais ações para Pessoa financeira de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const checkbox = page.getByRole('dialog').getByLabel('Habilitado Olist');
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    calls.find((call) => call.path === '/api/v1/users/target')?.body,
  ).toMatchObject({ olistEnabled: true, expectedOlistAuthorizationVersion: 7 });
});

test('stale Olist checkbox keeps editing open and explains the conflict', async ({
  page,
}) => {
  await setup(page, { profile: 'admin', enabled: false, conflict: true });
  await page.goto('/usuarios');
  await page.getByLabel('Mais ações para Pessoa financeira de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Habilitado Olist').check();
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByText(/habilitação Olist mudou em outra sessão/u),
  ).toBeVisible();
});

test('revoked checkbox removes the Olist route and menu after the session event', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/olist');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Olist' }),
  ).toBeVisible();
  mock.revoke();
  await expect(page).toHaveURL('/dashboard');
  await expect(
    page.getByRole('link', { name: 'Olist', exact: true }),
  ).toHaveCount(0);
});

test('OAuth query is removed before the first request and callback is consumed once', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist?code=synthetic-code&state=synthetic-state');
  await expect(page).toHaveURL('/olist');
  await expect(
    page
      .getByRole('region', { name: 'Conexão da empresa' })
      .getByText('Conta Olist conectada.', { exact: true }),
  ).toBeVisible();
  expect(
    calls.every(
      (call) =>
        !call.url.includes('synthetic-code') &&
        !call.url.includes('synthetic-state'),
    ),
  ).toBe(true);
  expect(calls.filter((call) => call.path === `${base}/complete`)).toHaveLength(
    1,
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        ...globalThis.localStorage,
        ...globalThis.sessionStorage,
      }),
    ),
  ).not.toContain('synthetic-code');
  expect(
    await page.evaluate(() => JSON.stringify(globalThis.history.state)),
  ).not.toContain('synthetic-code');
  await page.reload();
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  expect(calls.filter((call) => call.path === `${base}/complete`)).toHaveLength(
    1,
  );
});

test('central parameters use the settings version and preserve omitted values as null', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toBeFocused();
  await page.getByLabel('Vendedor no Olist (ID)', { exact: true }).fill('23');
  await page.getByLabel('Prazo de pagamento', { exact: true }).fill('30 dias');
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Conexão da empresa' })
      .getByText('Parâmetros comerciais salvos.'),
  ).toBeVisible();
  expect(
    calls.find((call) => call.path === `${base}/settings`)?.body,
  ).toMatchObject({
    expectedVersion: 4,
    settings: { ...settings, sellerId: 23, paymentTerms: '30 dias' },
  });
});
