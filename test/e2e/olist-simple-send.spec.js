import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// All records and endpoints are synthetic. Unknown requests are refused.
const orderId = '99999999-9999-4999-8999-999999999991';
const base = `/api/v1/orders/${orderId}/olist`;
const token = 'synthetic-reviewed-ficha';
const buyer = 'Comprador de teste';
const canary = 'PRIVATE_PROVIDER_BODY';

/** @param {import('@playwright/test').Page} page @param {{checkValid?:boolean,creationEnabled?:boolean,delayCheck?:boolean,exportTimeout?:boolean}} [options] */
async function setup(page, options = {}) {
  /** @type {Array<{path:string,method:string,body:any,headers:Record<string,string>}>} */ const calls =
    [];
  const user = {
    id: 'seller-test',
    name: 'Vendedora de teste',
    functionName: 'Vendedor',
    capabilities: [],
    olistEnabled: true,
    olistAuthorizationVersion: 2,
  };
  /** @type {any} */ let operation = null;
  let releaseCheck = () => {},
    releaseEvent = () => {};
  const checkGate = new Promise((resolve) => {
    releaseCheck = () => resolve(null);
  });
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  const commercial = {
    orderDate: '2026-11-09',
    deliveryOn: '2026-12-15',
    paymentCondition: 'pix',
    paymentDueOn: null,
    totalCents: 4500,
    groups: [
      {
        groupId: 'group-test',
        attributes: {
          garment: 'CAMISETA',
          color: 'BRANCA',
          fabric: '["PV"]',
          application: 'SILK',
          collar: 'VIÉS',
          audience: 'ADULTO',
        },
        lines: [
          { lineId: 'line-m', size: 'M', quantity: 2, subtotalCents: 3000 },
          { lineId: 'line-g', size: 'G', quantity: 1, subtotalCents: 1500 },
        ],
      },
    ],
  };
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'simple-send-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.context().route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = method === 'POST' ? request.postDataJSON() : null;
    calls.push({ path, method, body, headers: request.headers() });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({ status, json: value });
    if (path === '/api/v1/sessions/current') return json({ user });
    if (path === '/api/v1/events') {
      await eventGate;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `event: identity.user.changed\ndata: {"type":"identity.user.changed","userId":"seller-test"}\n\n`,
      });
    }
    if (path === '/api/v1/integrations/olist/status')
      return json({
        configured: false,
        connected: false,
        creationEnabled: false,
      });
    if (path === base)
      return json({
        orderId,
        number: '73-CRM',
        status: 'pendente',
        creationEnabled: options.creationEnabled ?? true,
        paymentDuePolicy: 'erp',
        productFiscalDeferred: true,
        operation,
        pendingFields: [],
      });
    if (path === `${base}/preview`) {
      expect(body).toEqual({});
      return json({
        orderId,
        eligible: true,
        creationEnabled: options.creationEnabled ?? true,
        previewToken: token,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        customer: { name: buyer, documentSuffix: '0042' },
        commercial,
        productFiscal: null,
        productFiscalDeferred: true,
        issues: [],
      });
    }
    if (path === `${base}/preview/check`) {
      expect(body).toEqual({ previewToken: token });
      if (options.delayCheck) await checkGate;
      return json({
        valid: options.checkValid ?? true,
        creationEnabled: options.creationEnabled ?? true,
      });
    }
    if (path === `${base}/export`) {
      expect(body).toEqual({ previewToken: token });
      if (options.exportTimeout) return route.abort('timedout');
      operation = { state: 'queued', stage: 'customer', number: null };
      return json(
        {
          orderId,
          number: '73-CRM',
          operationId: 'export-test',
          state: 'queued',
          stage: 'customer',
        },
        202,
      );
    }
    return json({ code: 'FORBIDDEN', detail: canary }, 403);
  });
  await page.goto(`/olist?pedido=${orderId}`);
  return {
    calls,
    releaseCheck,
    revoke() {
      user.olistEnabled = false;
      user.olistAuthorizationVersion++;
      releaseEvent();
    },
  };
}

/** @param {import('@playwright/test').Page} page */
const review = (page) =>
  page.getByRole('button', { name: 'Revisar envio', exact: true });
/** @param {import('@playwright/test').Page} page */
const dialog = (page) =>
  page.getByRole('dialog', { name: 'Enviar para Olist?', exact: true });
/** @param {{calls:Array<{path:string}>}} state @param {string} suffix */
const count = (state, suffix) =>
  state.calls.filter((call) => call.path === `${base}${suffix}`).length;

test('Olist sending takes two gestures and reviews the entire commercial ficha before any export', async ({
  page,
}) => {
  const state = await setup(page);
  await expect(review(page)).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Validar prévia|Gerar venda|Atualizar preparação/u,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel(
      /NCM|Origem fiscal|Unidade dos produtos|Vencimento deste pedido/u,
    ),
  ).toHaveCount(0);
  await review(page).click();
  const sheet = dialog(page);
  await expect(sheet).toBeVisible();
  expect(count(state, '/preview')).toBe(1);
  expect(count(state, '/preview/check')).toBe(1);
  expect(count(state, '/export')).toBe(0);
  for (const value of [
    buyer,
    '73-CRM',
    '09/11/2026',
    '15/12/2026',
    'Pix',
    'Definido no Olist',
    'CAMISETA',
    'BRANCA',
    'Tecido: PV',
    'Aplicação: SILK',
    'Gola: VIÉS',
    'Público: ADULTO',
    'R$ 30,00',
    'R$ 15,00',
    'R$ 45,00',
  ])
    await expect(sheet).toContainText(value);
  await expect(
    sheet.getByRole('rowheader', { name: 'M', exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole('rowheader', { name: 'G', exact: true }),
  ).toBeVisible();
  await expect(sheet.getByRole('textbox')).toHaveCount(0);
  await sheet
    .getByRole('button', { name: 'Enviar para Olist', exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  expect(count(state, '/export')).toBe(1);
  const command = state.calls.find((call) => call.path === `${base}/export`);
  expect(command?.body).toEqual({ previewToken: token });
  expect(command?.headers['x-csrf-token']).toBe('simple-send-csrf');
  expect(command?.headers['idempotency-key']).toBeTruthy();
  await expect(review(page)).toHaveCount(0);
});

test('Olist repeated review during the fresh read performs one check and sends nothing', async ({
  page,
}) => {
  const state = await setup(page, { delayCheck: true });
  await review(page).click();
  await expect.poll(() => count(state, '/preview/check')).toBe(1);
  await review(page).dispatchEvent('click');
  state.releaseCheck();
  await expect(dialog(page)).toBeVisible();
  expect(count(state, '/preview')).toBe(1);
  expect(count(state, '/preview/check')).toBe(1);
  expect(count(state, '/export')).toBe(0);
});

test('Olist returning from review restores focus and a new gesture refreshes the receipt', async ({
  page,
}) => {
  const state = await setup(page);
  await review(page).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(review(page)).toBeFocused();
  expect(count(state, '/export')).toBe(0);
  await review(page).click();
  await expect(dialog(page)).toBeVisible();
  expect(count(state, '/preview')).toBe(2);
  expect(count(state, '/preview/check')).toBe(2);
  expect(count(state, '/export')).toBe(0);
});

test('Olist stale fresh check cannot open a send confirmation', async ({
  page,
}) => {
  const state = await setup(page, { checkValid: false });
  await review(page).click();
  await expect(page.getByRole('alert')).toContainText(/mudou|expirou/u);
  await expect(dialog(page)).toHaveCount(0);
  expect(count(state, '/export')).toBe(0);
  await expect(page.getByText(canary)).toHaveCount(0);
});

test('Olist an expired review closes without an export', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  await review(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.clock.fastForward(601000);
  await expect(dialog(page)).toHaveCount(0);
  expect(count(state, '/export')).toBe(0);
});

test('Olist revocation closes the review and removes the send action', async ({
  page,
}) => {
  const state = await setup(page);
  await review(page).click();
  await expect(dialog(page)).toBeVisible();
  state.revoke();
  await expect(dialog(page)).toHaveCount(0);
  await expect(review(page)).toHaveCount(0);
  expect(count(state, '/export')).toBe(0);
});

test('Olist uncertainty offers progress reading without a second send', async ({
  page,
}) => {
  const state = await setup(page, { exportTimeout: true });
  await review(page).click();
  await dialog(page)
    .getByRole('button', { name: 'Enviar para Olist', exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Não repita');
  await page
    .getByRole('button', { name: 'Atualizar progresso', exact: true })
    .click();
  expect(count(state, '/export')).toBe(1);
  await expect(review(page)).toHaveCount(0);
});

test('Olist creation disabled still has a fresh read-only review without a send action', async ({
  page,
}) => {
  const state = await setup(page, { creationEnabled: false });
  await review(page).click();
  await expect(
    page.getByRole('heading', { name: 'Prévia pronta para conferência' }),
  ).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(count(state, '/preview/check')).toBe(1);
  expect(count(state, '/export')).toBe(0);
});

for (const viewport of [
  { width: 320, height: 780, name: 'mobile320' },
  { width: 1366, height: 900, name: 'desktop1366' },
]) {
  test(`Olist commercial review has keyboard, axe and reflow evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setup(page);
    await review(page).focus();
    await page.keyboard.press('Enter');
    const sheet = dialog(page);
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: 'Voltar', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      sheet.getByRole('region', { name: 'Ficha comercial para revisão' }),
    ).toBeFocused();
    await page.keyboard.press('PageDown');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await sheet
      .getByRole('rowheader', { name: 'M', exact: true })
      .scrollIntoViewIfNeeded();
    const row = await sheet
      .getByRole('rowheader', { name: 'M', exact: true })
      .boundingBox();
    const actions = await sheet.locator('.olist-review-actions').boundingBox();
    expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual(
      actions?.y ?? 0,
    );
    await page.screenshot({
      path: `var/qa-olist-phase6/simple-send-${viewport.name}.png`,
    });
    expect(count(state, '/export')).toBe(0);
  });
}
