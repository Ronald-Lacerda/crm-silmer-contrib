import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel } from './support/painel-mock.js';

const BASE = '/api/v1/shipping/melhor-envio';
const connected = {
  configured: true,
  connected: true,
  environment: 'sandbox',
  expiresAt: '2026-11-30T12:00:00.000Z',
  reconnectRequired: false,
};
const quote = {
  services: [
    {
      id: 1,
      name: 'PAC',
      company: 'Correios',
      priceCents: 2350,
      deliveryDays: 5,
    },
  ],
  unavailable: [
    {
      id: 2,
      name: 'SEDEX',
      message: 'Serviço indisponível para esta cotação.',
    },
  ],
};

/** @param {import('@playwright/test').Page} page @param {{manager?:boolean,status?:Record<string,any>,quoteError?:boolean}} [options] */
async function setup(page, options = {}) {
  await mockPainel(page, { manager: options.manager ?? true });
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 'test-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  /** @type {Array<{path:string,body:any,csrf:string|undefined}>} */
  const calls = [];
  let status = options.status ?? connected;
  await page.route('**/api/v1/shipping/melhor-envio/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    calls.push({ path, body, csrf: req.headers()['x-csrf-token'] });
    const json = (/** @type {unknown} */ value, code = 200) =>
      route.fulfill({
        status: code,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === `${BASE}/status`) return json(status);
    if (path === `${BASE}/complete`) {
      status = connected;
      return json(status);
    }
    if (path === `${BASE}/disconnect`) {
      status = { ...connected, connected: false, expiresAt: null };
      return json(status);
    }
    if (path === `${BASE}/quote`)
      return options.quoteError
        ? json({ code: 'MELHOR_ENVIO_UNAVAILABLE' }, 503)
        : json(quote);
    if (path === `${BASE}/authorize`)
      return json({
        authorizationUrl: 'https://unexpected.example.test/oauth/authorize',
      });
    return json({ code: 'UNKNOWN_ROUTE' }, 404);
  });
  return { calls };
}

/** @param {import('@playwright/test').Page} page */
async function fillQuote(page) {
  await page.getByLabel('CEP de origem', { exact: true }).fill('01001-000');
  await page.getByLabel('CEP de destino', { exact: true }).fill('20040-020');
  await page.getByLabel('Peso total (g)', { exact: true }).fill('1250');
  await page.getByLabel('Largura (cm)', { exact: true }).fill('20');
  await page.getByLabel('Altura (cm)', { exact: true }).fill('12');
  await page.getByLabel('Comprimento (cm)', { exact: true }).fill('30');
  await page.getByLabel('Valor segurado (R$)', { exact: true }).fill('150,25');
}

test('manager opens Melhor Envio by keyboard and quotes a measured package', async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.goto('/dashboard');
  const link = page
    .getByRole('navigation', { name: 'Navegação principal', exact: true })
    .getByRole('link', { name: 'Melhor Envio', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/melhor-envio');
  await expect(
    page.getByRole('heading', { name: 'Melhor Envio', level: 1 }),
  ).toBeFocused();
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Peso total (g)', { exact: true })).toHaveValue(
    '',
  );
  await fillQuote(page);
  // MEVC-05: fractional centimetres must fail before the API request.
  await page.getByLabel('Largura (cm)', { exact: true }).fill('15.5');
  await page
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  expect(calls.filter((call) => call.path === `${BASE}/quote`)).toHaveLength(0);
  await page.getByLabel('Largura (cm)', { exact: true }).fill('20');
  const submit = page.getByRole('button', {
    name: 'Consultar frete',
    exact: true,
  });
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Opções de frete' }),
  ).toBeFocused();
  await expect(page.getByRole('table')).toContainText('Correios · PAC');
  await expect(page.getByRole('table')).toContainText('R$ 23,50');
  await expect(page.getByRole('table')).toContainText('5 dias úteis');
  await page.screenshot({
    path: test.info().outputPath('melhor-envio-desktop.png'),
    fullPage: true,
  });
  await expect(
    page.getByText('SEDEX: Serviço indisponível para esta cotação.'),
  ).toBeVisible();
  const sent = calls.find((call) => call.path === `${BASE}/quote`);
  expect(sent?.csrf).toBe('test-csrf');
  expect(sent?.body).toEqual({
    fromPostalCode: '01001-000',
    toPostalCode: '20040-020',
    weightGrams: 1250,
    widthCm: 20,
    heightCm: 12,
    lengthCm: 30,
    insuranceValueCents: 15025,
  });
  await page.getByLabel('Peso total (g)', { exact: true }).fill('1500');
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(calls.filter((call) => call.path === `${BASE}/quote`)).toHaveLength(1);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('seller has no menu or administrative view and makes no shipping request', async ({
  page,
}) => {
  const { calls } = await setup(page, { manager: false });
  await page.goto('/melhor-envio');
  await expect(page).toHaveURL('/dashboard');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Melhor Envio', exact: true }),
  ).toHaveCount(0);
  expect(calls).toEqual([]);
});

test('OAuth callback removes secrets from URL and completes once with CSRF', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    status: { ...connected, connected: false, expiresAt: null },
  });
  await page.goto('/melhor-envio?code=synthetic-code&state=synthetic-state');
  await expect(page).toHaveURL('/melhor-envio');
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  const completed = calls.filter((call) => call.path === `${BASE}/complete`);
  expect(completed).toHaveLength(1);
  expect(completed[0].body).toEqual({
    code: 'synthetic-code',
    state: 'synthetic-state',
  });
  expect(completed[0].csrf).toBe('test-csrf');
  await expect(page.locator('main')).not.toContainText('synthetic-code');
  await page.reload();
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  expect(calls.filter((call) => call.path === `${BASE}/complete`)).toHaveLength(
    1,
  );
});

test('denied OAuth shows a recovery and never exchanges the authorization', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    status: { ...connected, connected: false, expiresAt: null },
  });
  await page.goto('/melhor-envio?error=access_denied&state=synthetic-state');
  await expect(page).toHaveURL('/melhor-envio');
  await expect(page.getByRole('alert')).toContainText(
    'A autorização não foi concluída',
  );
  expect(calls.filter((call) => call.path === `${BASE}/complete`)).toHaveLength(
    0,
  );
});

test('unconfigured connection gives its reason without a quote form', async ({
  page,
}) => {
  await setup(page, {
    status: { ...connected, configured: false, connected: false },
  });
  await page.goto('/melhor-envio');
  await expect(
    page.getByText('Conexão ainda não configurada', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Conectar conta', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('CEP de origem', { exact: true })).toHaveCount(
    0,
  );
});

test('failed quote stays recoverable and does not show zero prices', async ({
  page,
}) => {
  await setup(page, { quoteError: true });
  await page.goto('/melhor-envio');
  await fillQuote(page);
  await page
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'O Melhor Envio está indisponível',
  );
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByLabel('Peso total (g)', { exact: true })).toHaveValue(
    '1250',
  );
});

test('an unexpected authorization destination is rejected before navigation', async ({
  page,
}) => {
  await setup(page, {
    status: { ...connected, connected: false, expiresAt: null },
  });
  await page.goto('/melhor-envio');
  await page
    .getByRole('button', { name: 'Conectar conta', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'O Melhor Envio está indisponível',
  );
  await expect(page).toHaveURL('/melhor-envio');
});

test('mobile quote reflows without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await setup(page);
  await page.goto('/melhor-envio');
  await fillQuote(page);
  await page
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath('melhor-envio-mobile.png'),
    fullPage: true,
  });
});
