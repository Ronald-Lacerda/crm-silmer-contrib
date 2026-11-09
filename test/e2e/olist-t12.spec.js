import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, pendingOrder } from './support/orders-mock.js';

const orderId = 'acbf1c1b-c57f-4c5c-8076-7f439f95cfb0';
const groupId = '83a15e8e-1690-4c7b-ad7a-0cec51bbc155';
const lineId = '2e8120c9-de5a-438e-8a9b-06e176c5f8fa';
const integration = '/api/v1/integrations/olist';
const operation = `/api/v1/orders/${orderId}/olist`;
const privateCanary = 'provider-private-detail-canary';

/** All data is synthetic. No provider endpoint is contacted by these tests.
 * @param {Record<string, any>} [overrides] */
function previewFixture(overrides = {}) {
  return {
    orderId,
    number: '41-CRM',
    status: 'pendente',
    eligible: true,
    creationEnabled: false,
    issues: [],
    commercial: {
      groups: [
        {
          groupId,
          attributes: {
            garment: 'CAMISETA',
            color: 'AZUL',
            fabric: '["ALGODÃO"]',
            application: 'SILK',
            collar: 'GOLA REDONDA',
            audience: 'ADULTO',
          },
          lines: [
            {
              groupId,
              lineId,
              size: 'M',
              quantity: 3,
              subtotalCents: 300,
              unitCents: 100,
              unitLexeme: '1.00',
            },
          ],
        },
      ],
      totalCents: 300,
      orderDate: '2026-11-08',
      deliveryOn: '2026-11-30',
      paymentCondition: 'pix',
    },
    customer: { name: 'Comprador sintético', documentSuffix: '0091' },
    registrations: {
      customer: { action: 'reuse', remoteId: '100' },
      groups: [
        {
          groupId,
          action: 'create',
          remoteId: null,
          lines: [{ lineId, action: 'create', remoteId: null }],
        },
      ],
      issues: [],
    },
    versions: {
      order: 4,
      source: 0,
      buyer: 2,
      settings: 3,
      connection: 5,
      authorization: 2,
    },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    previewToken: 'synthetic-session-bound-preview',
    ...overrides,
  };
}

/** @param {import('@playwright/test').Page} page
 * @param {{enabled?:boolean, profile?:string, projection?:any, preview?:any, previewFailure?:{code:string,status:number}, checkFailure?:{code:string,status:number}, delayPreview?:boolean}} [options] */
async function setup(page, options = {}) {
  const viewer = {
    id: 'financial-synthetic',
    name: 'Operador sintético',
    email: 'operador@example.test',
    functionName: options.profile ?? 'Financeiro',
    capabilities:
      options.profile === 'Administrador' ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: options.enabled ?? true,
    olistAuthorizationVersion: 2,
  };
  const projection = {
    orderId,
    number: '41-CRM',
    status: 'pendente',
    creationEnabled: false,
    pendingFields: [
      {
        code: 'OLIST_CREATION_DISABLED',
        label: 'Geração Olist ainda indisponível.',
      },
    ],
    operation: null,
    ...options.projection,
  };
  /** @type {Array<{path:string,method:string,body:any}>} */
  const calls = [];
  /** @type {() => void} */
  let releasePreview = () => {};
  const previewGate = new Promise((resolve) => {
    releasePreview = () => resolve(null);
  });
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 't12-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = ['POST', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    calls.push({ path, method, body });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/api/v1/sessions/current') return json({ user: viewer });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n',
      });
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });
    if (path === '/api/v1/finance/orders')
      return json({
        items: [],
        counts: { waiting: 0, completed: 0 },
        nextCursor: null,
      });
    if (path === `${integration}/order-lookup`) {
      expect(method).toBe('POST');
      expect(Object.keys(body)).toEqual(['query']);
      expect(req.headers()['x-csrf-token']).toBe('t12-csrf');
      expect(req.headers()['idempotency-key']).toBeTruthy();
      return json(projection);
    }
    if (path === operation && method === 'GET') return json(projection);
    if (path === `${operation}/preview`) {
      expect(method).toBe('POST');
      expect(body).toEqual({
        ...(projection.paymentDuePolicy === 'per_order'
          ? { paymentDueOn: '2026-12-10' }
          : {}),
        ...(projection.productFiscalRequired
          ? { productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' } }
          : {}),
      });
      expect(req.headers()['x-csrf-token']).toBe('t12-csrf');
      if (options.delayPreview) await previewGate;
      if (options.previewFailure)
        return json(
          { ...options.previewFailure, detail: privateCanary },
          options.previewFailure.status,
        );
      return json(options.preview ?? previewFixture());
    }
    if (path === `${operation}/preview/check`) {
      expect(method).toBe('POST');
      expect(body).toEqual({ previewToken: 'synthetic-session-bound-preview' });
      expect(req.headers()['x-csrf-token']).toBe('t12-csrf');
      if (options.checkFailure)
        return json(
          { ...options.checkFailure, detail: privateCanary },
          options.checkFailure.status,
        );
      return json({
        valid: true,
        creationEnabled: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === `${integration}/status`)
      return json({
        configured: false,
        accountConfigured: false,
        connected: false,
        creationEnabled: false,
      });
    // A forbidden accidental export or broader commercial read is recorded and
    // fails the assertions instead of ever reaching a real API.
    return json({ code: 'FORBIDDEN' }, 403);
  });
  return { calls, releasePreview };
}

/** @param {{calls:Array<{path:string,method:string,body:any}>}} state */
function expectNoEffectsOrGeneralRead(state) {
  expect(state.calls.filter(({ path }) => path.endsWith('/export'))).toEqual(
    [],
  );
  expect(
    state.calls.filter(
      ({ path }) =>
        path === `/api/v1/orders/${orderId}` ||
        path === '/api/v1/orders' ||
        path.startsWith('/api/v1/contacts') ||
        path.startsWith('/api/v1/conversations'),
    ),
  ).toEqual([]);
  expect(
    state.calls.filter(
      ({ path, method }) =>
        method !== 'GET' &&
        ![
          `${integration}/order-lookup`,
          `${operation}/preview`,
          `${operation}/preview/check`,
        ].includes(path),
    ),
  ).toEqual([]);
}

/** @param {import('@playwright/test').Page} page */
async function openAndPreview(page) {
  await page.goto(`/olist?pedido=${orderId}`);
  await page
    .getByRole('button', { name: 'Conferir prévia Olist', exact: true })
    .click();
}

test('T12 Financeiro searches another owner and opens a restricted deep link by keyboard', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/olist');
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page.keyboard.press('Enter');
  const link = page.getByRole('link', {
    name: 'Conferir pedido no Olist',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', `/olist?pedido=${orderId}`);
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/olist?pedido=${orderId}`);
  await expect(
    page.getByRole('button', { name: 'Conferir prévia Olist', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Caixa de Entrada', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Editar|Reabrir|Cancelar pedido/u }),
  ).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 eligible exact-cent preview remains read only with generation disabled', async ({
  page,
}) => {
  const state = await setup(page);
  await openAndPreview(page);
  await expect(
    page.getByText(/Comprador sintético · documento final/iu),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: /Subtotal|Valor final|Preço unitário/u }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Validar prévia', exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/preview/check`)
          .length,
    )
    .toBe(1);
  expectNoEffectsOrGeneralRead(state);
});

test('T17 per-order due date is required, reviewed, and changing it discards the prior preview', async ({
  page,
}) => {
  const state = await setup(page, {
    projection: { paymentDuePolicy: 'per_order', creationEnabled: true },
    preview: previewFixture({
      commercial: {
        ...previewFixture().commercial,
        paymentDueOn: '2026-12-10',
      },
    }),
  });
  await page.goto(`/olist?pedido=${orderId}`);
  const date = page.getByLabel('Vencimento deste pedido', { exact: true });
  await expect(
    page.getByText('Confira os dados e a prévia antes de gerar a venda.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Gerar venda no Olist', exact: true }),
  ).toHaveCount(0);
  const confer = page.getByRole('button', {
    name: 'Conferir prévia Olist',
    exact: true,
  });
  await confer.click();
  await expect(date).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Informe o vencimento');
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview`),
  ).toHaveLength(0);
  await date.fill('2026-12-10');
  await confer.click();
  await expect(page.getByText('10/12/2026', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Gerar venda no Olist', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await date.fill('2026-12-11');
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('10/12/2026', { exact: true })).toHaveCount(0);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview`),
  ).toHaveLength(1);
  expectNoEffectsOrGeneralRead(state);
});

test('T17 fiscal data is entered explicitly, frozen for review and changing it discards the preview', async ({
  page,
}) => {
  const productFiscal = { ncm: '61091000', origin: 0, unit: 'UN' };
  const state = await setup(page, {
    projection: { productFiscalRequired: true },
    preview: previewFixture({ productFiscal }),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/olist?pedido=${orderId}`);
  const confer = page.getByRole('button', {
    name: 'Conferir prévia Olist',
    exact: true,
  });
  const ncm = page.getByLabel('NCM (8 dígitos)', { exact: true });
  const origin = page.getByLabel('Origem fiscal (código de 0 a 8)', {
    exact: true,
  });
  const unit = page.getByLabel('Unidade dos produtos', { exact: true });
  await expect(ncm).toHaveValue('');
  await expect(origin).toHaveValue('');
  await expect(unit).toHaveValue('');
  await confer.click();
  await expect(ncm).toBeFocused();
  await ncm.fill(productFiscal.ncm);
  await confer.click();
  await expect(origin).toBeFocused();
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview`),
  ).toHaveLength(0);
  await origin.fill('0');
  await unit.fill(productFiscal.unit);
  await confer.click();
  await expect(
    page.getByText('NCM 61091000 · Origem 0 · UN', { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await unit.fill('PC');
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

for (const [label, status, issue] of [
  [
    'pending incomplete',
    'pendente',
    { code: 'OLIST_ORDER_REQUIRED', field: 'items[0].gola' },
  ],
  [
    'confirmed legacy',
    'confirmado',
    { code: 'LEGACY_PRICE_BREAKDOWN_REQUIRED', field: 'priceBreakdown' },
  ],
  [
    'store with missing fiscal registration',
    'confirmado',
    { code: 'STORE_BUYER_REQUIRED', field: 'buyer.registration.document' },
  ],
]) {
  test(`T12 ${label} reports blockers without inventing prices or granting editing`, async ({
    page,
  }) => {
    const state = await setup(page, {
      projection: { status },
      preview: previewFixture({
        status,
        eligible: false,
        issues: [issue],
        previewToken: null,
        expiresAt: null,
        registrations: null,
        commercial: { groups: [], totalCents: null },
      }),
    });
    await openAndPreview(page);
    await expect(
      page.getByRole('button', { name: 'Validar prévia', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Editar|Reabrir|Cancelar pedido/u }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('textbox', { name: /Subtotal|Valor final/u }),
    ).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
  });
}

test('T12 fractional cents block the entire preview and never offer an export retry', async ({
  page,
}) => {
  const state = await setup(page, {
    preview: previewFixture({
      eligible: false,
      issues: [
        {
          code: 'OLIST_FRACTIONAL_CENT_UNIT',
          field: `sizePricing.${groupId}.${lineId}`,
        },
      ],
      previewToken: null,
      expiresAt: null,
      registrations: null,
      commercial: { groups: [], totalCents: 100 },
    }),
  });
  await openAndPreview(page);
  await expect(
    page.getByText(/fração|fracion|centavo/iu).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

for (const code of ['OLIST_PREVIEW_STALE', 'OLIST_PREVIEW_EXPIRED']) {
  test(`T12 ${code} invalidates the receipt and requires a new review`, async ({
    page,
  }) => {
    const state = await setup(page, { checkFailure: { code, status: 409 } });
    await openAndPreview(page);
    await page
      .getByRole('button', { name: 'Validar prévia', exact: true })
      .click();
    await expect(page.getByRole('alert').last()).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Validar prévia', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(privateCanary)).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
  });
}

for (const failure of [
  { code: 'FORBIDDEN', status: 403 },
  { code: 'OLIST_RATE_LIMITED', status: 429 },
  { code: 'SERVICE_UNAVAILABLE', status: 503 },
]) {
  test(`T12 ${failure.status} uses safe errors and no stale preview token`, async ({
    page,
  }) => {
    const state = await setup(page, { previewFailure: failure });
    await openAndPreview(page);
    await expect(page.getByRole('alert').last()).toBeVisible();
    await expect(page.getByText(privateCanary)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Validar prévia', exact: true }),
    ).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
  });
}

test('T12 reload restores projection without persisting the session-bound preview', async ({
  page,
}) => {
  const state = await setup(page);
  await openAndPreview(page);
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Conferir prévia Olist', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toHaveCount(0);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview`),
  ).toHaveLength(1);
  expect(
    state.calls.filter(({ path }) => path === operation).length,
  ).toBeGreaterThanOrEqual(2);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 repeated activation during preview creates only one read-only request', async ({
  page,
}) => {
  const state = await setup(page, { delayPreview: true });
  await page.goto(`/olist?pedido=${orderId}`);
  const button = page.getByRole('button', {
    name: 'Conferir prévia Olist',
    exact: true,
  });
  await button.click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/preview`)
          .length,
    )
    .toBe(1);
  await button.dispatchEvent('click');
  state.releasePreview();
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview`),
  ).toHaveLength(1);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 leaving the restricted order ignores a late preview response', async ({
  page,
}) => {
  const state = await setup(page, { delayPreview: true });
  await page.goto(`/olist?pedido=${orderId}`);
  await page
    .getByRole('button', { name: 'Conferir prévia Olist', exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/preview`)
          .length,
    )
    .toBe(1);
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('link', { name: 'Minha conta', exact: true })
    .click();
  state.releasePreview();
  await expect(page).toHaveURL('/conta');
  await expect(page.getByText('Comprador sintético')).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 mobile preview is keyboard operable, accessible and does not overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const state = await setup(page);
  await page.goto(`/olist?pedido=${orderId}`);
  const button = page.getByRole('button', {
    name: 'Conferir prévia Olist',
    exact: true,
  });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Validar prévia', exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'var/olist-t12-restricted-mobile.png',
    fullPage: true,
  });
  expectNoEffectsOrGeneralRead(state);
});

/** @returns {any} */
function managedOrder() {
  return {
    ...structuredClone(pendingOrder),
    id: orderId,
    number: '41-CRM',
    finalAmountCents: 300,
    pricing: {
      complete: true,
      totalCents: 300,
      groups: [{ id: groupId, subtotalCents: 300 }],
      issues: [],
    },
    ficha: {
      ...structuredClone(pendingOrder.ficha),
      sizePricing: [
        {
          id: groupId,
          lines: [
            {
              id: lineId,
              size: 'M',
              quantity: 100,
              subtotalCents: 200,
              subtotalReviewed: true,
            },
            {
              id: '775594a9-2bff-490b-9284-995906676b97',
              size: 'G',
              quantity: 50,
              subtotalCents: 100,
              subtotalReviewed: true,
            },
          ],
        },
      ],
    },
    missingFields: ['paymentCondition'],
  };
}

test('T12 managed confirmation shows the backend total read only and preserves its value', async ({
  page,
}) => {
  const order = managedOrder();
  /** @type {any[]} */
  const writes = [];
  await mockOrders(page, { orders: [order] });
  await page.route(`**/api/v1/orders/${orderId}/confirm`, async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(body.expectedVersion).toBe(order.version);
    expect(body.paymentCondition).toBe('pix');
    if (body.amountText !== undefined) expect(body.amountText).toBe('3,00');
    expect(body.finalAmountCents).toBeUndefined();
    return route.fulfill({
      json: {
        order: {
          ...order,
          status: 'confirmado',
          confirmedAt: '2026-11-08T15:00:00Z',
          version: order.version + 1,
          missingFields: [],
          paymentCondition: 'pix',
        },
      },
    });
  });
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Gerar pedido', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('textbox', { name: 'Valor final', exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toContainText('3,00');
  await dialog.getByLabel('Pix', { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Confirmar e gerar ficha', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test('T12 managed confirmation with a stale version keeps the review and never silently resubmits', async ({
  page,
}) => {
  const order = managedOrder();
  /** @type {any[]} */
  const writes = [];
  await mockOrders(page, { orders: [order] });
  await page.route(`**/api/v1/orders/${orderId}/confirm`, async (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { code: 'VERSION_CONFLICT' } });
  });
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Gerar pedido', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Pix', { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Confirmar e gerar ficha', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog).toContainText(/mudou|versão|atual/iu);
  expect(writes).toHaveLength(1);
  expect(writes[0].expectedVersion).toBe(order.version);
  await expect(
    dialog.getByRole('textbox', { name: 'Valor final', exact: true }),
  ).toHaveCount(0);
});

/** @param {import('@playwright/test').Page} page
 * @param {{conflict?:boolean, secondGroup?:boolean, empty?:boolean, sharedState?:any}} [options] */
async function setupManaged(page, options = {}) {
  const state = options.sharedState ?? {
    order: managedOrder(),
    writes: /** @type {any[]} */ ([]),
    conflict: Boolean(options.conflict),
  };
  if (options.secondGroup) {
    const second = structuredClone(state.order.ficha.sizePricing[0]);
    second.id = 'da80970e-348e-4b8d-8515-0a3b64cec97f';
    second.lines[0].id = '227c951c-a04b-41a6-9cae-0bc32d31064d';
    second.lines[1].id = '32be5380-0d7e-43fc-83ca-18c8cc5dffb7';
    state.order.ficha.sizePricing.push(second);
    state.order.ficha.items.push(structuredClone(state.order.ficha.items[0]));
    state.order.pricing.groups.push({ id: second.id, subtotalCents: 300 });
    state.order.pricing.totalCents = 600;
    state.order.finalAmountCents = 600;
  }
  if (options.empty) {
    state.order.ficha.items = [];
    state.order.ficha.sizePricing = [];
    state.order.pricing = {
      complete: false,
      totalCents: null,
      groups: [],
      issues: [{ code: 'SIZE_PRICING_EMPTY', groupId: null, lineId: null }],
    };
    state.order.finalAmountCents = null;
    state.order.missingFields = ['items', 'sizePricing', 'paymentCondition'];
  }
  await mockOrders(page, { orders: [state.order] });
  await page.route(`**/api/v1/orders/${orderId}`, (route) =>
    route.fulfill({ json: { order: state.order } }),
  );
  await page.route(
    `**/api/v1/orders/${orderId}/sections/size-pricing`,
    async (route) => {
      const body = route.request().postDataJSON();
      state.writes.push(body);
      expect(route.request().method()).toBe('PATCH');
      expect(Number.isInteger(body.expectedVersion)).toBe(true);
      if (body.expectedVersion !== state.order.version) {
        return route.fulfill({
          status: 409,
          json: { code: 'VERSION_CONFLICT' },
        });
      }
      expect(Object.keys(body).sort()).toEqual(['expectedVersion', 'value']);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      if (state.conflict) {
        state.conflict = false;
        state.order.version++;
        return route.fulfill({
          status: 409,
          json: { code: 'VERSION_CONFLICT' },
        });
      }
      const command = body.value;
      const group = state.order.ficha.sizePricing.find(
        (/** @type {any} */ entry) => entry.id === command.groupId,
      );
      const line = group?.lines.find(
        (/** @type {any} */ entry) => entry.id === command.lineId,
      );
      if (command.action === 'change_quantity') {
        line.quantity = command.quantity;
        line.subtotalReviewed = false;
        const groupIndex = state.order.ficha.sizePricing.indexOf(group);
        const lineIndex = group.lines.indexOf(line);
        state.order.ficha.items[groupIndex].grade[lineIndex].quantidade =
          command.quantity;
      } else if (command.action === 'review_subtotal') {
        line.subtotalCents = command.subtotalCents;
        line.subtotalReviewed = command.subtotalCents !== null;
      } else throw new Error('Unexpected T12 mock command');
      const groups = state.order.ficha.sizePricing.map(
        (/** @type {any} */ item) => ({
          id: item.id,
          subtotalCents: item.lines.every(
            (/** @type {any} */ entry) =>
              entry.subtotalReviewed && entry.subtotalCents !== null,
          )
            ? item.lines.reduce(
                (/** @type {number} */ sum, /** @type {any} */ entry) =>
                  sum + entry.subtotalCents,
                0,
              )
            : null,
        }),
      );
      const issues = state.order.ficha.sizePricing.flatMap(
        (/** @type {any} */ item) =>
          item.lines
            .filter(
              (/** @type {any} */ entry) =>
                !entry.subtotalReviewed || entry.subtotalCents === null,
            )
            .map((/** @type {any} */ entry) => ({
              groupId: item.id,
              lineId: entry.id,
              code:
                entry.subtotalCents === null
                  ? 'SIZE_SUBTOTAL_REQUIRED'
                  : 'SIZE_SUBTOTAL_REVIEW_REQUIRED',
            })),
      );
      const totalCents = issues.length
        ? null
        : groups.reduce(
            (/** @type {number} */ sum, /** @type {any} */ item) =>
              sum + item.subtotalCents,
            0,
          );
      state.order.pricing = {
        complete: issues.length === 0,
        totalCents,
        groups,
        issues,
      };
      state.order.finalAmountCents = totalCents;
      state.order.missingFields = [
        ...issues.map(
          (/** @type {any} */ issue) =>
            `sizePricing.${issue.groupId}.${issue.lineId}`,
        ),
        'paymentCondition',
      ];
      state.order.version++;
      return route.fulfill({ json: { order: state.order } });
    },
  );
  return state;
}

test('T12 changing quantity preserves IDs and old subtotal but requires a separate human review', async ({
  page,
}) => {
  const state = await setupManaged(page);
  await page.goto(`/pedidos/${orderId}`);
  const trigger = page.getByRole('button', {
    name: 'Alterar quantidade do item 1, tamanho M',
    exact: true,
  });
  await trigger.click();
  const input = page.getByLabel('Quantidade do item 1, tamanho M', {
    exact: true,
  });
  await expect(input).toBeFocused();
  await input.fill('101');
  await page
    .getByRole('button', { name: 'Salvar alteração', exact: true })
    .click();
  expect(state.writes[0].value).toEqual({
    action: 'change_quantity',
    groupId,
    lineId,
    quantity: 101,
  });
  const row = page.locator(`[data-line-id="${lineId}"]`).first();
  await expect(row).toContainText('101');
  await expect(row).toContainText('2,00');
  await expect(row).toContainText('Revisar subtotal');
  await expect(trigger).toBeFocused();
  await page
    .getByRole('button', {
      name: 'Revisar subtotal do item 1, tamanho M',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('2,02');
  await page
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  expect(state.writes[1].value).toEqual({
    action: 'review_subtotal',
    groupId,
    lineId,
    subtotalCents: 202,
  });
  await expect(row).not.toContainText('Revisar subtotal');
  expect(state.order.pricing.totalCents).toBe(302);
});

test('T12 a blank subtotal saves an incomplete draft instead of a partial authoritative total', async ({
  page,
}) => {
  const state = await setupManaged(page);
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', {
      name: 'Revisar subtotal do item 1, tamanho M',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('');
  await page
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  expect(state.writes[0].value).toEqual({
    action: 'review_subtotal',
    groupId,
    lineId,
    subtotalCents: null,
  });
  await expect(
    page.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('Falta subtotal');
  expect(state.order.pricing.totalCents).toBeNull();
  await page.reload();
  await expect(
    page.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('Falta subtotal');
});

for (const value of ['0', '-1,00', 'abc', '90.071.992.547.409,92']) {
  test(`T12 rejects invalid managed subtotal ${value} before issuing a command`, async ({
    page,
  }) => {
    const state = await setupManaged(page);
    await page.goto(`/pedidos/${orderId}`);
    await page
      .getByRole('button', {
        name: 'Revisar subtotal do item 1, tamanho M',
        exact: true,
      })
      .click();
    const input = page.getByLabel('Subtotal do item 1, tamanho M', {
      exact: true,
    });
    await input.fill(value);
    await page
      .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
      .click();
    const form = page.getByRole('form', {
      name: 'Revisar subtotal',
      exact: true,
    });
    await expect(form.getByRole('alert')).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(state.writes).toHaveLength(0);
  });
}

test('T12 the same size in two groups updates only the selected server identities', async ({
  page,
}) => {
  const state = await setupManaged(page, { secondGroup: true });
  const selected = state.order.ficha.sizePricing[1];
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', {
      name: 'Revisar subtotal do item 2, tamanho M',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Subtotal do item 2, tamanho M', { exact: true })
    .fill('5,00');
  await page
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  expect(state.writes[0].value).toEqual({
    action: 'review_subtotal',
    groupId: selected.id,
    lineId: selected.lines[0].id,
    subtotalCents: 500,
  });
  expect(state.order.ficha.sizePricing[0].lines[0].subtotalCents).toBe(200);
});

test('T12 version conflict keeps the draft, disables resubmission and refreshes only after cancellation', async ({
  page,
}) => {
  const state = await setupManaged(page, { conflict: true });
  await page.goto(`/pedidos/${orderId}`);
  const trigger = page.getByRole('button', {
    name: 'Revisar subtotal do item 1, tamanho M',
    exact: true,
  });
  await trigger.click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('7,00');
  const save = page.getByRole('button', {
    name: 'Salvar subtotal revisado',
    exact: true,
  });
  await save.click();
  await expect(
    page
      .getByRole('form', { name: 'Revisar subtotal', exact: true })
      .getByRole('alert'),
  ).toBeFocused();
  await expect(save).toBeDisabled();
  await expect(
    page.getByLabel('Subtotal do item 1, tamanho M', { exact: true }),
  ).toHaveValue('7,00');
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await trigger.click();
  await expect(
    page.getByLabel('Subtotal do item 1, tamanho M', { exact: true }),
  ).toHaveValue('2,00');
});

test('T12 Escape cancels monetary editing and returns focus without a write', async ({
  page,
}) => {
  const state = await setupManaged(page);
  await page.goto(`/pedidos/${orderId}`);
  const trigger = page.getByRole('button', {
    name: 'Revisar subtotal do item 1, tamanho M',
    exact: true,
  });
  await trigger.click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('9,00');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(
    page.getByLabel('Subtotal do item 1, tamanho M', { exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('T12 empty managed composition remains an editable incomplete draft', async ({
  page,
}) => {
  const state = await setupManaged(page, { empty: true });
  await page.goto(`/pedidos/${orderId}`);
  await expect(
    page.getByText(
      'Informe o subtotal negociado para todas as peças de cada tamanho. O total é calculado pelo servidor.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Adicionar item', exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

/** @param {import('@playwright/test').Page} page
 * @param {{failure?:{code:string,status:number},store?:boolean}} [options] */
async function setupSupplement(page, options = {}) {
  const order = managedOrder();
  delete order.ficha.sizePricing;
  delete order.pricing;
  order.status = 'confirmado';
  order.confirmedAt = '2026-11-07T15:00:00Z';
  order.missingFields = [];
  order.paymentCondition = 'pix';
  if (options.store) {
    order.origin = 'loja';
    order.locked = true;
  }
  const source = {
    mode: options.store ? 'store' : 'legacy',
    orderId,
    orderVersion: order.version,
    revision: 1,
    sourceValid: true,
    groups: structuredClone(managedOrder().ficha.sizePricing),
    pricing: managedOrder().pricing,
    issues: [],
    updatedBy: 'seller-marina',
    updatedAt: '2026-11-07T16:00:00Z',
    ...(options.store
      ? {
          details: {
            deliveryOn: null,
            applications: [{ groupId, application: null }],
            registration: null,
          },
        }
      : {}),
  };
  /** @type {any[]} */
  const writes = [];
  await mockOrders(page, { orders: [order] });
  if (options.store)
    await page.route('**/api/v1/sessions/current', (route) =>
      route.fulfill({
        json: {
          user: {
            id: 'seller-marina',
            name: 'Admin sintético',
            functionName: 'Administrador',
            capabilities: ['COMMERCIAL_ADMIN'],
            olistEnabled: false,
          },
        },
      }),
    );
  await page.route(`**/api/v1/orders/${orderId}/olist`, (route) =>
    route.fulfill({
      json: {
        orderId,
        number: '41-CRM',
        status: 'confirmado',
        operation: null,
        creationEnabled: false,
        pendingFields: [],
      },
    }),
  );
  await page.route(`**/api/v1/orders/${orderId}/price-breakdown`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: source });
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(body.expectedVersion).toBe(source.orderVersion);
    if (options.failure)
      return route.fulfill({
        status: options.failure.status,
        json: { code: options.failure.code },
      });
    return route.fulfill({
      json: { ...source, revision: 2, orderVersion: order.version + 1 },
    });
  });
  return { order, source, writes };
}

test('T12 legacy composition sends all line identities without modifying the historical total', async ({
  page,
}) => {
  const state = await setupSupplement(page);
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Editar complemento', exact: true })
    .click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('2,00');
  await page
    .getByLabel('Subtotal do item 1, tamanho G', { exact: true })
    .fill('1,00');
  await page
    .getByRole('button', { name: 'Salvar complemento', exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].value).toEqual({
    action: 'set_subtotals',
    lines: state.source.groups.flatMap((/** @type {any} */ group) =>
      group.lines.map((/** @type {any} */ line) => ({
        groupId: group.id,
        lineId: line.id,
        subtotalCents: line.subtotalCents,
      })),
    ),
  });
  expect(state.order.finalAmountCents).toBe(300);
});

test('T12 legacy sum mismatch explains the unchanged historical amount and keeps the draft', async ({
  page,
}) => {
  const state = await setupSupplement(page, {
    failure: { code: 'SIZE_PRICING_AMOUNT_MISMATCH', status: 409 },
  });
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Editar complemento', exact: true })
    .click();
  await page
    .getByLabel('Subtotal do item 1, tamanho M', { exact: true })
    .fill('8,00');
  await page
    .getByRole('button', { name: 'Salvar complemento', exact: true })
    .click();
  const alert = page
    .getByRole('region', { name: 'Complemento para o Olist', exact: true })
    .getByRole('alert');
  await expect(alert).toBeFocused();
  await expect(alert).toContainText(/soma|histórico/iu);
  await expect(
    page.getByLabel('Subtotal do item 1, tamanho M', { exact: true }),
  ).toHaveValue('8,00');
  expect(state.order.finalAmountCents).toBe(300);
  expect(state.writes).toHaveLength(1);
});

test('T12 legacy conflict requires cancellation before saving against a refreshed version', async ({
  page,
}) => {
  const state = await setupSupplement(page, {
    failure: { code: 'VERSION_CONFLICT', status: 409 },
  });
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Editar complemento', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Salvar complemento', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Salvar complemento', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Cancelar complemento', exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(1);
});

test('T12 store complement has read-only prices and sends no amount or checkout mutation', async ({
  page,
}) => {
  const state = await setupSupplement(page, { store: true });
  await page.goto(`/pedidos/${orderId}`);
  await page
    .getByRole('button', { name: 'Editar complemento', exact: true })
    .click();
  const section = page.getByRole('region', {
    name: 'Complemento para o Olist',
    exact: true,
  });
  await expect(
    section.getByRole('textbox', { name: /Subtotal|Valor final/u }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Salvar complemento', exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(Object.keys(state.writes[0].value).sort()).toEqual([
    'action',
    'applications',
    'deliveryOn',
    'registration',
  ]);
  expect(state.writes[0].value.action).toBe('set_store_details');
  expect(state.order.finalAmountCents).toBe(300);
});

for (const stateName of ['confirmed', 'linked', 'outcome_unknown']) {
  test(`T12 backend ${stateName} lock protects an owner without the Olist checkbox`, async ({
    page,
  }) => {
    const order = managedOrder();
    order.status = 'confirmado';
    order.confirmedAt = '2026-11-07T15:00:00Z';
    order.missingFields = [];
    order.olistLocked = true;
    order.olistConfirmationAllowed = stateName !== 'outcome_unknown';
    await mockOrders(page, { orders: [order] });
    await page.goto(`/pedidos/${orderId}`);
    await expect(page.getByRole('button', { name: /Reabrir/u })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^Revisar subtotal do item/u }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^Alterar quantidade do item/u }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^Editar atributos do item/u }),
    ).toHaveCount(0);
  });
}

test('T12 an already linked pending order may confirm unchanged without gaining editing', async ({
  page,
}) => {
  const order = managedOrder();
  order.olistLocked = true;
  order.olistConfirmationAllowed = true;
  await mockOrders(page, { orders: [order] });
  await page.goto(`/pedidos/${orderId}`);
  await expect(
    page.getByRole('button', { name: /^Revisar subtotal do item/u }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Gerar pedido', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('textbox', { name: 'Valor final', exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toContainText('3,00');
});

test('T12 a confirmed sale in the current account does not override a cross-account confirmation lock', async ({
  page,
}) => {
  const order = managedOrder();
  order.olistLocked = true;
  order.olistConfirmationAllowed = false;
  await mockOrders(page, { orders: [order] });
  await page.route('**/api/v1/sessions/current', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'seller-marina',
          name: 'Vendedor sintético',
          functionName: 'Vendedor',
          capabilities: [],
          olistEnabled: true,
          olistAuthorizationVersion: 2,
        },
      },
    }),
  );
  await page.route(`**/api/v1/orders/${orderId}/olist`, (route) =>
    route.fulfill({
      json: {
        orderId,
        number: '41-CRM',
        status: 'pendente',
        operation: { state: 'confirmed', stage: 'complete', number: '500' },
        creationEnabled: false,
        pendingFields: [],
      },
    }),
  );
  await page.goto(`/pedidos/${orderId}`);
  await expect(page.getByText(/Venda Olist conferida/u)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Gerar pedido', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Revisar subtotal do item/u }),
  ).toHaveCount(0);
});

test('T12 two real tabs share versions while a stale monetary draft stays isolated until cancellation', async ({
  page,
}) => {
  const state = await setupManaged(page);
  const otherPage = await page.context().newPage();
  await setupManaged(otherPage, { sharedState: state });
  await Promise.all([
    page.goto(`/pedidos/${orderId}`),
    otherPage.goto(`/pedidos/${orderId}`),
  ]);
  const triggerName = 'Revisar subtotal do item 1, tamanho M';
  await page.getByRole('button', { name: triggerName, exact: true }).click();
  await otherPage
    .getByRole('button', { name: triggerName, exact: true })
    .click();
  const inputName = 'Subtotal do item 1, tamanho M';
  await expect(page.getByLabel(inputName, { exact: true })).toHaveValue('2,00');
  await expect(otherPage.getByLabel(inputName, { exact: true })).toHaveValue(
    '2,00',
  );
  const originalVersion = state.order.version;
  await page.getByLabel(inputName, { exact: true }).fill('4,00');
  await page
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  await expect(
    page.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('4,00');
  expect(state.order.version).toBe(originalVersion + 1);
  await otherPage.getByLabel(inputName, { exact: true }).fill('8,00');
  await otherPage
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  const form = otherPage.getByRole('form', {
    name: 'Revisar subtotal',
    exact: true,
  });
  await expect(form.getByRole('alert')).toBeFocused();
  await expect(otherPage.getByLabel(inputName, { exact: true })).toHaveValue(
    '8,00',
  );
  await expect(
    otherPage.getByRole('button', {
      name: 'Salvar subtotal revisado',
      exact: true,
    }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(2);
  expect(
    state.writes.map((/** @type {any} */ write) => write.expectedVersion),
  ).toEqual([originalVersion, originalVersion]);
  expect(state.order.ficha.sizePricing[0].id).toBe(groupId);
  expect(state.order.ficha.sizePricing[0].lines[0].id).toBe(lineId);
  expect(state.order.ficha.sizePricing[0].lines[0].subtotalCents).toBe(400);
  await otherPage
    .getByRole('button', { name: 'Cancelar', exact: true })
    .click();
  await expect(
    otherPage.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('4,00');
  await otherPage
    .getByRole('button', { name: triggerName, exact: true })
    .click();
  await expect(otherPage.getByLabel(inputName, { exact: true })).toHaveValue(
    '4,00',
  );
  await otherPage.getByLabel(inputName, { exact: true }).fill('9,00');
  await otherPage
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  await expect(
    otherPage.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('9,00');
  expect(state.writes).toHaveLength(3);
  expect(state.writes[2].expectedVersion).toBe(originalVersion + 1);
  expect(state.order.ficha.sizePricing[0].id).toBe(groupId);
  expect(state.order.ficha.sizePricing[0].lines[0].id).toBe(lineId);
  await otherPage.close();
});

for (const visual of [
  { width: 320, height: 844, theme: 'dark', name: 'dark320' },
  { width: 390, height: 844, theme: 'light', name: 'light390' },
  { width: 1366, height: 900, theme: 'light', name: 'desktop1366' },
]) {
  test(`T12 managed editor keyboard, axe and visual evidence ${visual.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: visual.width, height: visual.height });
    await page.addInitScript((theme) => {
      globalThis.localStorage.setItem('silmer-theme', theme);
    }, visual.theme);
    const state = await setupManaged(page);
    await page.goto(`/pedidos/${orderId}#itens`);
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      visual.theme,
    );
    const trigger = page.getByRole('button', {
      name: 'Revisar subtotal do item 1, tamanho M',
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const input = page.getByLabel('Subtotal do item 1, tamanho M', {
      exact: true,
    });
    await expect(input).toBeFocused();
    await input.fill('0');
    await page
      .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
      .click();
    await expect(
      page
        .getByRole('form', { name: 'Revisar subtotal', exact: true })
        .getByRole('alert'),
    ).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    const box = await input.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(visual.width);
    await page.screenshot({
      path: `var/olist-t12-managed-${visual.name}.png`,
      fullPage: true,
    });
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    expect(state.writes).toHaveLength(0);
  });
}

test('T12 an SSE event for another order preserves the open monetary draft and its original version', async ({
  page,
}) => {
  const state = await setupManaged(page);
  await page.route('**/api/v1/sessions/current', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'seller-marina',
          name: 'Vendedor sintético',
          functionName: 'Vendedor',
          capabilities: [],
          olistEnabled: true,
          olistAuthorizationVersion: 2,
        },
      },
    }),
  );
  await page.route(`**/api/v1/orders/${orderId}/olist`, (route) =>
    route.fulfill({
      json: {
        orderId,
        number: '41-CRM',
        status: 'pendente',
        creationEnabled: false,
        pendingFields: [],
        operation: null,
      },
    }),
  );
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  await page.route('**/api/v1/events**', async (route) => {
    await eventGate;
    const event = {
      type: 'inbox.order.changed',
      orderId: '8c7ba95a-8b94-4dcb-a71d-3b73a663a778',
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `retry: 60000\n\nevent: inbox.order.changed\nid: t12-unrelated-order\ndata: ${JSON.stringify(event)}\n\n`,
    });
  });
  await page.goto(`/pedidos/${orderId}`);
  const trigger = page.getByRole('button', {
    name: 'Revisar subtotal do item 1, tamanho M',
    exact: true,
  });
  await trigger.click();
  const originalVersion = state.order.version;
  const input = page.getByLabel('Subtotal do item 1, tamanho M', {
    exact: true,
  });
  await input.fill('6,00');
  releaseEvent();
  await expect(
    page.getByText(/Atualize a preparação e confira uma nova prévia/iu),
  ).toBeVisible();
  await expect(input).toHaveValue('6,00');
  await expect(
    page.getByRole('form', { name: 'Revisar subtotal', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Salvar subtotal revisado', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText(/Pedido protegido por uma operação Olist/u),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Salvar subtotal revisado', exact: true })
    .click();
  await expect(
    page.locator(`[data-line-id="${lineId}"]`).first(),
  ).toContainText('6,00');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({
    expectedVersion: originalVersion,
    value: { action: 'review_subtotal', groupId, lineId, subtotalCents: 600 },
  });
});

/** All /export traffic in these tests is intercepted. Synthetic flags do not
 * alter runtime configuration, accounts or any provider state.
 * @param {import('@playwright/test').Page} page
 * @param {{projectionEnabled?:boolean,previewEnabled?:boolean,checkedEnabled?:boolean,checkedValid?:boolean,checkFailure?:{code:string,status:number},delayCheck?:boolean,delayExport?:boolean,exportAbort?:boolean,exportFailure?:{code:string,status:number},eligible?:boolean,exportResponse?:any}} [options] */
async function setupHumanExport(page, options = {}) {
  const fixture = previewFixture({
    eligible: options.eligible ?? true,
    creationEnabled: options.previewEnabled ?? true,
  });
  const state = await setup(page, {
    profile: 'Vendedor',
    projection: { creationEnabled: options.projectionEnabled ?? true },
    preview: fixture,
  });
  const viewer = {
    id: 'financial-synthetic',
    name: 'Operador sintético',
    email: 'operador@example.test',
    functionName: 'Vendedor',
    capabilities: [],
    olistEnabled: true,
    olistAuthorizationVersion: 2,
  };
  /** @type {any} */
  let ledger = null;
  /** @type {string[]} */
  const exportKeys = [];
  /** @type {() => void} */
  let releaseCheck = () => {};
  /** @type {() => void} */
  let releaseExport = () => {};
  /** @type {() => void} */
  let releaseRevocation = () => {};
  const checkGate = new Promise((resolve) => {
    releaseCheck = () => resolve(null);
  });
  const exportGate = new Promise((resolve) => {
    releaseExport = () => resolve(null);
  });
  const eventGate = new Promise((resolve) => {
    releaseRevocation = () => resolve(null);
  });
  let nextEvent = {
    type: 'identity.user.changed',
    userId: 'financial-synthetic',
    orderId: '',
  };
  await page.route('**/api/v1/sessions/current', (route) =>
    route.fulfill({ json: { user: viewer } }),
  );
  await page.route('**/api/v1/events**', async (route) => {
    await eventGate;
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 60000\n\nevent: ${nextEvent.type}\nid: t12-export-change\ndata: ${JSON.stringify(nextEvent)}\n\n`,
    });
  });
  await page.route(`**/api/v1/orders/${orderId}/olist`, (route) => {
    state.calls.push({ path: operation, method: 'GET', body: null });
    return route.fulfill({
      json: {
        orderId,
        number: '41-CRM',
        status: 'pendente',
        pendingFields: [],
        creationEnabled: options.projectionEnabled ?? true,
        operation: ledger,
      },
    });
  });
  await page.route(`**${operation}/preview/check`, async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    state.calls.push({
      path: `${operation}/preview/check`,
      method: req.method(),
      body,
    });
    expect(req.method()).toBe('POST');
    expect(body).toEqual({ previewToken: fixture.previewToken });
    expect(req.headers()['x-csrf-token']).toBe('t12-csrf');
    if (options.delayCheck) await checkGate;
    if (options.checkFailure)
      return route.fulfill({
        status: options.checkFailure.status,
        json: { code: options.checkFailure.code, detail: privateCanary },
      });
    return route.fulfill({
      json: {
        valid: options.checkedValid ?? true,
        creationEnabled: options.checkedEnabled ?? true,
        expiresAt: fixture.expiresAt,
      },
    });
  });
  await page.route(`**${operation}/export`, async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    state.calls.push({
      path: `${operation}/export`,
      method: req.method(),
      body,
    });
    expect(req.method()).toBe('POST');
    expect(body).toEqual({ previewToken: fixture.previewToken });
    expect(req.headers()['x-csrf-token']).toBe('t12-csrf');
    const key = req.headers()['idempotency-key'];
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    exportKeys.push(key);
    if (options.delayExport) await exportGate;
    if (options.exportAbort) return route.abort('timedout');
    if (options.exportFailure)
      return route.fulfill({
        status: options.exportFailure.status,
        json: { code: options.exportFailure.code, detail: privateCanary },
      });
    ledger = { state: 'queued', stage: 'customer', number: null };
    return route.fulfill({
      status: 202,
      json: options.exportResponse ?? {
        operationId: 'synthetic-export-id',
        orderId,
        number: '41-CRM',
        state: ledger.state,
        stage: ledger.stage,
        creationEnabled: false,
      },
    });
  });
  return {
    ...state,
    exportKeys,
    releaseCheck,
    releaseExport,
    orderChanged() {
      nextEvent = { type: 'inbox.order.changed', userId: '', orderId };
      releaseRevocation();
    },
    revoke() {
      viewer.olistEnabled = false;
      viewer.olistAuthorizationVersion++;
      releaseRevocation();
    },
  };
}

/** @param {import('@playwright/test').Page} page */
function humanGenerate(page) {
  return page.getByRole('button', {
    name: 'Gerar venda no Olist',
    exact: true,
  });
}
/** @param {import('@playwright/test').Page} page */
function humanDialog(page) {
  return page.getByRole('dialog', {
    name: 'Gerar venda no Olist?',
    exact: true,
  });
}

for (const gates of [
  { projection: false, preview: true },
  { projection: true, preview: false },
  { projection: false, preview: false },
]) {
  test(`T12 human export requires both flags: projection=${gates.projection} preview=${gates.preview}`, async ({
    page,
  }) => {
    const state = await setupHumanExport(page, {
      projectionEnabled: gates.projection,
      previewEnabled: gates.preview,
    });
    await openAndPreview(page);
    await expect(humanGenerate(page)).toHaveAttribute('aria-disabled', 'true');
    await humanGenerate(page).dispatchEvent('click');
    await expect(humanDialog(page)).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
    expect(
      state.calls.filter(({ path }) => path === `${operation}/preview/check`),
    ).toHaveLength(0);
  });
}

for (const check of [
  { checkedEnabled: false, checkedValid: true },
  { checkedEnabled: true, checkedValid: false },
]) {
  test(`T12 fresh check valid=${check.checkedValid} enabled=${check.checkedEnabled} cannot authorize export`, async ({
    page,
  }) => {
    const state = await setupHumanExport(page, check);
    await openAndPreview(page);
    await humanGenerate(page).click();
    await expect
      .poll(
        () =>
          state.calls.filter(
            ({ path }) => path === `${operation}/preview/check`,
          ).length,
      )
      .toBe(1);
    await expect(humanDialog(page)).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
  });
}

for (const code of [
  'OLIST_PREVIEW_STALE',
  'OLIST_PREVIEW_EXPIRED',
  'FORBIDDEN',
]) {
  test(`T12 human export stops when fresh check returns ${code}`, async ({
    page,
  }) => {
    const state = await setupHumanExport(page, {
      checkFailure: { code, status: code === 'FORBIDDEN' ? 403 : 409 },
    });
    await openAndPreview(page);
    await humanGenerate(page).click();
    await expect(page.getByRole('alert').last()).toBeVisible();
    await expect(humanDialog(page)).toHaveCount(0);
    await expect(page.getByText(privateCanary)).toHaveCount(0);
    expectNoEffectsOrGeneralRead(state);
  });
}

test('T12 human export requires explicit confirmation after a fresh check and sends one exact idempotent command', async ({
  page,
}) => {
  const state = await setupHumanExport(page, { delayExport: true });
  await openAndPreview(page);
  await humanGenerate(page).click();
  const dialog = humanDialog(page);
  await expect(dialog).toBeVisible();
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview/check`),
  ).toHaveLength(1);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/export`),
  ).toHaveLength(0);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  const confirm = dialog.getByRole('button', {
    name: 'Gerar venda conferida',
    exact: true,
  });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/export`).length,
    )
    .toBe(1);
  await dialog.locator('button.primary').dispatchEvent('click');
  await page.keyboard.press('Enter');
  state.releaseExport();
  await expect(dialog).toHaveCount(0);
  expect(state.exportKeys).toHaveLength(1);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/export`),
  ).toHaveLength(1);
  expect(
    state.calls.findIndex(({ path }) => path === `${operation}/preview/check`),
  ).toBeLessThan(
    state.calls.findIndex(({ path }) => path === `${operation}/export`),
  );
  await page.reload();
  await expect(
    page.getByText('Operação Olist em acompanhamento', { exact: true }),
  ).toBeVisible();
  await expect(humanGenerate(page)).toHaveCount(0);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/export`),
  ).toHaveLength(1);
});

test('T12 cancelling the human export dialog restores focus and sends no export', async ({
  page,
}) => {
  const state = await setupHumanExport(page);
  await openAndPreview(page);
  await humanGenerate(page).click();
  await expect(humanDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(humanDialog(page)).toHaveCount(0);
  await expect(humanGenerate(page)).toBeFocused();
  expectNoEffectsOrGeneralRead(state);
});

test('T12 a second generate activation during the fresh check cannot open duplicate dialogs', async ({
  page,
}) => {
  const state = await setupHumanExport(page, { delayCheck: true });
  await openAndPreview(page);
  await humanGenerate(page).click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/preview/check`)
          .length,
    )
    .toBe(1);
  await humanGenerate(page).dispatchEvent('click');
  state.releaseCheck();
  await expect(humanDialog(page)).toHaveCount(1);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/preview/check`),
  ).toHaveLength(1);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 a locally expired preview closes the human confirmation before any export', async ({
  page,
}) => {
  await page.clock.install();
  const state = await setupHumanExport(page);
  await openAndPreview(page);
  await humanGenerate(page).click();
  await expect(humanDialog(page)).toBeVisible();
  await page.clock.fastForward(601_000);
  await expect(humanDialog(page)).toHaveCount(0);
  await expect(page.getByText(/prévia expirou/iu).last()).toBeVisible();
  expectNoEffectsOrGeneralRead(state);
});

test('T12 revoking the checkbox closes the human confirmation and clears its receipt', async ({
  page,
}) => {
  const state = await setupHumanExport(page);
  await openAndPreview(page);
  await humanGenerate(page).click();
  await expect(humanDialog(page)).toBeVisible();
  state.revoke();
  await expect(humanDialog(page)).toHaveCount(0);
  await expect(humanGenerate(page)).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

test('T12 changing the selected order while a check is pending ignores its late success', async ({
  page,
}) => {
  const state = await setupHumanExport(page, { delayCheck: true });
  await openAndPreview(page);
  await humanGenerate(page).click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/preview/check`)
          .length,
    )
    .toBe(1);
  await page.goto('/olist?pedido=8c7ba95a-8b94-4dcb-a71d-3b73a663a778');
  state.releaseCheck();
  await expect(humanDialog(page)).toHaveCount(0);
  expectNoEffectsOrGeneralRead(state);
});

for (const outcome of [
  { exportAbort: true, name: 'timeout' },
  {
    exportFailure: { code: 'OLIST_UPSTREAM_REJECTED', status: 422 },
    name: 'rejection',
  },
]) {
  test(`T12 human export ${outcome.name} never offers blind retry or leaks provider errors`, async ({
    page,
  }) => {
    const state = await setupHumanExport(page, outcome);
    await openAndPreview(page);
    await humanGenerate(page).click();
    await humanDialog(page)
      .getByRole('button', { name: 'Gerar venda conferida', exact: true })
      .click();
    await expect(
      page.getByText(/incerto|não repita|conferência administrativa/iu).last(),
    ).toBeVisible();
    await expect(humanDialog(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Gerar venda conferida', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Tentar novamente|Repetir geração/u }),
    ).toHaveCount(0);
    await expect(page.getByText(privateCanary)).toHaveCount(0);
    expect(
      state.calls.filter(({ path }) => path === `${operation}/export`),
    ).toHaveLength(1);
    await page
      .getByRole('button', { name: 'Atualizar preparação', exact: true })
      .click();
    expect(
      state.calls.filter(({ path }) => path === `${operation}/export`),
    ).toHaveLength(1);
  });
}

test('T12 an SSE invalidation during the export POST preserves uncertainty and ignores a late accepted response', async ({
  page,
}) => {
  const state = await setupHumanExport(page, { delayExport: true });
  await openAndPreview(page);
  await humanGenerate(page).click();
  await humanDialog(page)
    .getByRole('button', { name: 'Gerar venda conferida', exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.calls.filter(({ path }) => path === `${operation}/export`).length,
    )
    .toBe(1);
  state.orderChanged();
  await expect(humanDialog(page)).toHaveCount(0);
  await expect(
    page.getByText(
      /resultado da solicitação precisa de conferência administrativa/iu,
    ),
  ).toBeVisible();
  state.releaseExport();
  await expect(humanGenerate(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Conferir prévia Olist', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Atualizar preparação', exact: true })
    .click();
  await expect(humanGenerate(page)).toHaveCount(0);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/export`),
  ).toHaveLength(1);
  expect(state.exportKeys).toHaveLength(1);
});

test('T12 a malformed accepted response cannot be reported as an ERP sale or permit a second command', async ({
  page,
}) => {
  const state = await setupHumanExport(page, {
    exportResponse: {
      operationId: 'synthetic-export-id',
      orderId,
      number: 'ERP-UNTRUSTED-900',
      state: 'queued',
      stage: 'customer',
      creationEnabled: false,
    },
  });
  await openAndPreview(page);
  await humanGenerate(page).click();
  await humanDialog(page)
    .getByRole('button', { name: 'Gerar venda conferida', exact: true })
    .click();
  await expect(
    page.getByText(
      /resultado da solicitação precisa de conferência administrativa/iu,
    ),
  ).toBeVisible();
  await expect(page.getByText('ERP-UNTRUSTED-900')).toHaveCount(0);
  await expect(humanGenerate(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Conferir prévia Olist', exact: true }),
  ).toHaveCount(0);
  expect(
    state.calls.filter(({ path }) => path === `${operation}/export`),
  ).toHaveLength(1);
});

for (const viewport of [
  { width: 390, height: 844, name: 'mobile390' },
  { width: 1366, height: 900, name: 'desktop1366' },
]) {
  test(`T12 human export review dialog has axe, keyboard and visual evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setupHumanExport(page);
    await openAndPreview(page);
    const generate = humanGenerate(page);
    await generate.focus();
    await page.keyboard.press('Enter');
    const dialog = humanDialog(page);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Voltar à prévia', exact: true }),
    ).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const box = await dialog.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({
      path: `var/olist-t12-export-dialog-${viewport.name}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(generate).toBeFocused();
    expectNoEffectsOrGeneralRead(state);
  });
}
