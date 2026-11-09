import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// RFC050 T16: all endpoints are mocked. Unknown requests fail closed; these
// scenarios never reach an ERP or the production application.
const orderId = '11111111-1111-4111-8111-111111111111';
const base = `/api/v1/orders/${orderId}/olist`;
const groups = [
  {
    groupId: 'group-a',
    attributes: {
      garment: 'Camiseta',
      color: 'Branca',
      fabric: '["PV"]',
      application: 'Sem estampa',
      collar: 'Viés',
      audience: '',
    },
    lines: [
      { lineId: 'line-m', size: 'M', quantity: 2, subtotalCents: 3000 },
      { lineId: 'line-g', size: 'G', quantity: 1, subtotalCents: 1500 },
    ],
  },
];

/** @param {import('@playwright/test').Page} page @param {{noContext?:boolean,previewFailure?:string,expired?:boolean,linkFailure?:string,noHistoricalMetadata?:boolean,productFiscalRequired?:boolean,buyerReview?:Record<string,unknown>}} [options] */
async function setup(page, options = {}) {
  /** @type {Array<{path:string,body:any,method:string,headers:Record<string,string>}>} */
  const calls = [];
  let linked = false;
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'legacy-synthetic-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.context().route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    calls.push({ path, body, method: req.method(), headers: req.headers() });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/api/v1/sessions/current')
      return json({
        user: {
          id: 'admin-synthetic',
          name: 'Admin sintético',
          functionName: 'Administrador',
          capabilities: ['COMMERCIAL_ADMIN'],
          olistEnabled: true,
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n',
      });
    if (path === '/api/v1/integrations/olist/status')
      return json({
        configured: false,
        connected: false,
        creationEnabled: false,
      });
    if (path === base)
      return json({
        orderId,
        number: '41-CRM',
        status: 'pendente',
        creationEnabled: false,
        pendingFields: [],
        operation: linked
          ? { state: 'linked', stage: 'complete', number: '98' }
          : null,
      });
    if (path === `${base}/administration`)
      return json({
        operation: linked
          ? {
              id: 'export-synthetic',
              state: 'linked',
              stage: 'complete',
              number: '98',
              version: 1,
            }
          : null,
        resources: [],
        attempts: [],
        requests: [],
        legacyLinkContext:
          linked || options.noContext
            ? null
            : {
                groups,
                paymentDuePolicy: 'fixed_date',
                historicalDueReadOnly: true,
              },
        paymentDuePolicy: 'per_order',
        productFiscalRequired: options.productFiscalRequired ?? false,
      });
    if (
      path === `${base}/existing/legacy/previews` ||
      path === `${base}/existing/previews`
    ) {
      if (options.previewFailure)
        return json(
          { code: options.previewFailure, detail: 'PRIVATE_PROVIDER_BODY' },
          409,
        );
      return json({
        orderId,
        eligible: true,
        mode: 'legacy-sale-only-v1',
        sale: { id: body.saleId, number: '98' },
        mapping: body.mapping,
        versions: { order: 1, settings: 1 },
        expiresAt: new Date(
          Date.now() + (options.expired ? -1000 : 600000),
        ).toISOString(),
        previewToken: 'legacy-synthetic-receipt',
        commercial: { paymentDueOn: body.paymentDueOn ?? '2026-11-04' },
        productFiscal: body.productFiscal ?? null,
        buyerReview: options.buyerReview,
        historicalMetadata: options.noHistoricalMetadata
          ? undefined
          : {
              originId: 0,
              priceListId: null,
              purchaseOrder: 'SYNTHETIC-PO-41',
              paymentDueOn: '2026-11-04',
              orderDate: '2026-11-04',
              deliveryOn: '2026-11-10',
              productFiscalMissing: true,
              fiscalVerified: false,
              reusable: false,
              products: [
                {
                  parentProductId: '200',
                  ncm: null,
                  unit: null,
                  origin: null,
                  fiscalMissing: true,
                },
              ],
            },
      });
    }
    if (path === `${base}/existing/legacy/links`) {
      if (options.linkFailure)
        return json(
          { code: options.linkFailure, detail: 'PRIVATE_PROVIDER_BODY' },
          409,
        );
      linked = true;
      return json({
        operationId: 'export-synthetic',
        state: 'linked',
        number: '98',
        creationEnabled: false,
      });
    }
    return json({ code: 'FORBIDDEN' }, 403);
  });
  await page.goto(`/olist?pedido=${orderId}`);
  return calls;
}

/** @param {import('@playwright/test').Page} page */
async function fillMapping(page) {
  await page
    .getByRole('button', {
      name: 'Vincular venda histórica por linha',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist', { exact: true }).fill('901');
  await dialog.getByLabel('ID do produto pai no Olist — grupo 1').fill('200');
  await dialog.getByLabel('ID da variação no Olist — grupo 1, M').fill('201');
  await dialog
    .getByLabel('Posição do item na venda Olist — grupo 1, M')
    .fill('0');
  await dialog.getByLabel('ID da variação no Olist — grupo 1, G').fill('202');
  await dialog
    .getByLabel('Posição do item na venda Olist — grupo 1, G')
    .fill('1');
  return dialog;
}

test('T16 legacy link has explicit line correspondence, human attestation, keyboard focus and no creator', async ({
  page,
}) => {
  const calls = await setup(page);
  const dialog = await fillMapping(page);
  await expect(dialog.getByLabel('Vencimento desta venda')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  await expect(
    dialog.getByRole('region', { name: 'Correspondência conferida' }),
  ).toContainText('variação 201 · posição 0');
  await expect(dialog).toContainText('04/11/2026');
  const historical = dialog.getByRole('region', {
    name: 'Dados históricos da venda',
  });
  await expect(historical).toContainText('SYNTHETIC-PO-41');
  await expect(historical).toContainText(
    'Cadastro fiscal legado ausente; esses dados não serão reutilizados em novas vendas.',
  );
  await expect(historical.locator('input,select,textarea')).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  const confirmation = dialog.getByRole('checkbox');
  await expect(confirmation).toBeFocused();
  expect(calls.filter((x) => x.path.endsWith('/legacy/links'))).toHaveLength(0);
  await confirmation.check();
  await dialog
    .getByLabel('Motivo do vínculo (obrigatório)')
    .fill('Conferência sintética do histórico');
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'Nenhuma venda foi criada',
  );
  const preview = calls.find((x) => x.path.endsWith('/legacy/previews'));
  if (!preview) throw new Error('Missing legacy preview');
  expect(preview.body).toEqual({
    saleId: '901',
    mapping: {
      groups: [
        {
          groupId: 'group-a',
          parentProductId: '200',
          lines: [
            { lineId: 'line-m', childProductId: '201', itemIndex: 0 },
            { lineId: 'line-g', childProductId: '202', itemIndex: 1 },
          ],
        },
      ],
    },
  });
  const commit = calls.find((x) => x.path.endsWith('/legacy/links'));
  if (!commit) throw new Error('Missing legacy commit');
  expect(commit.body).toEqual({
    previewToken: 'legacy-synthetic-receipt',
    confirmed: true,
    reason: 'Conferência sintética do histórico',
  });
  expect(commit.headers['x-csrf-token']).toBe('legacy-synthetic-csrf');
  expect(commit.headers['idempotency-key']).toBeTruthy();
  expect(
    calls.filter(
      (x) =>
        x.method === 'POST' &&
        !/\/existing\/legacy\/(previews|links)$/u.test(x.path),
    ),
  ).toEqual([]);
});

test('T16 duplicate positions are refused before any read or link and Escape restores focus', async ({
  page,
}) => {
  const calls = await setup(page);
  const dialog = await fillMapping(page);
  await dialog
    .getByLabel('Posição do item na venda Olist — grupo 1, G')
    .fill('0');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText('Não repita');
  expect(calls.filter((x) => x.method === 'POST')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Vincular venda histórica por linha',
      exact: true,
    }),
  ).toBeFocused();
});

for (const code of ['OLIST_PREVIEW_STALE', 'OLIST_PRODUCT_DIVERGENT']) {
  test(`T16 ${code} preserves the form without leaking provider text or canonical fallback`, async ({
    page,
  }) => {
    const calls = await setup(page, { previewFailure: code });
    const dialog = await fillMapping(page);
    await dialog
      .getByRole('button', { name: 'Conferir venda', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(page.getByText('PRIVATE_PROVIDER_BODY')).toHaveCount(0);
    await expect(
      dialog.getByLabel('ID da variação no Olist — grupo 1, M'),
    ).toHaveValue('201');
    expect(calls.filter((x) => x.method === 'POST').map((x) => x.path)).toEqual(
      [`${base}/existing/legacy/previews`],
    );
  });
}

test('T16 an expired review cannot commit and context absence hides historical link', async ({
  page,
}) => {
  const calls = await setup(page, { expired: true });
  const dialog = await fillMapping(page);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await dialog.getByRole('checkbox').check();
  await dialog
    .getByLabel('Motivo do vínculo (obrigatório)')
    .fill('Conferência sintética');
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  expect(calls.filter((x) => x.path.endsWith('/legacy/links'))).toHaveLength(0);
  await page.keyboard.press('Escape');
});

test('T16 no context never offers the historical link', async ({ page }) => {
  await setup(page, { noContext: true });
  await expect(
    page.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Vincular venda histórica por linha',
      exact: true,
    }),
  ).toHaveCount(0);
});

test('T16 missing historical evidence cannot reach the human confirmation or commit', async ({
  page,
}) => {
  const calls = await setup(page, { noHistoricalMetadata: true });
  const dialog = await fillMapping(page);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  expect(
    calls.filter((call) => call.path.endsWith('/legacy/links')),
  ).toHaveLength(0);
});

test('T16 canonical existing link still requires the per-order due date', async ({
  page,
}) => {
  const calls = await setup(page);
  await page
    .getByRole('button', { name: 'Vincular venda existente', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist', { exact: true }).fill('901');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog.getByLabel('Vencimento desta venda')).toBeFocused();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await dialog.getByLabel('Vencimento desta venda').fill('2026-11-10');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  expect(
    calls.find((call) => call.path.endsWith('/existing/previews'))?.body,
  ).toEqual({ saleId: '901', paymentDueOn: '2026-11-10' });
});

test('T16 historical correspondence and attestation reflow at 320px with axe evidence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await setup(page);
  const dialog = await fillMapping(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('R$ 30,00');
  await expect(dialog).not.toContainText('["PV"]');
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'var/qa-olist-phase6/legacy-form-mobile.png' });
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
  await dialog
    .getByRole('region', { name: 'Dados históricos da venda' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'var/qa-olist-phase6/legacy-review-mobile.png',
  });
});

test('T16 canonical link validates explicit fiscal fields and rechecks after a fiscal change', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const calls = await setup(page, { productFiscalRequired: true });
  await page
    .getByRole('button', { name: 'Vincular venda existente', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist', { exact: true }).fill('901');
  await dialog.getByLabel('Vencimento desta venda').fill('2026-11-10');
  const ncm = dialog.getByLabel('NCM do produto', { exact: true }),
    origin = dialog.getByLabel('Origem fiscal do produto', { exact: true }),
    unit = dialog.getByLabel('Unidade fiscal do produto', { exact: true });
  await expect(ncm).toHaveValue('');
  await expect(origin).toHaveValue('');
  await expect(unit).toHaveValue('');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(ncm).toBeFocused();
  await expect(ncm).toHaveAttribute('aria-invalid', 'true');
  await ncm.fill('61091000');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(origin).toBeFocused();
  await origin.fill('9');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(origin).toBeFocused();
  await origin.fill('0');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(unit).toBeFocused();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await unit.fill('un');
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
  await dialog
    .getByRole('group', { name: 'Cadastro fiscal para esta conferência' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'var/qa-olist-phase6/legacy-canonical-fiscal-mobile.png',
  });
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  await expect(dialog).toContainText('NCM 61091000 · origem 0 · UN');
  await dialog.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Vincular venda ao pedido' }),
  ).toHaveCount(0);
  await unit.fill('PC');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog).toContainText('NCM 61091000 · origem 0 · PC');
  expect(
    calls
      .filter((call) => call.path.endsWith('/existing/previews'))
      .map((call) => call.body.productFiscal),
  ).toEqual([
    { ncm: '61091000', origin: 0, unit: 'UN' },
    { ncm: '61091000', origin: 0, unit: 'PC' },
  ]);
  expect(calls.filter((call) => call.path.endsWith('/links'))).toHaveLength(0);
});

test('T16 historical link never asks for creation fiscal defaults', async ({
  page,
}) => {
  const calls = await setup(page, { productFiscalRequired: true });
  const dialog = await fillMapping(page);
  await expect(
    dialog.getByLabel('NCM do produto', { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  expect(
    calls.find((call) => call.path.endsWith('/legacy/previews'))?.body
      .productFiscal,
  ).toBeUndefined();
});

test('T16 a historical buyer phone mismatch is reviewed within the existing confirmation and never copied', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const privatePhone = 'SYNTHETIC_PRIVATE_PHONE';
  const calls = await setup(page, {
    buyerReview: {
      mode: 'legacy-sale-buyer-review-v1',
      phoneMismatch: true,
      reusable: false,
      code: 'OLIST_LEGACY_BUYER_PHONE_MISMATCH',
      crmPhone: privatePhone,
      erpPhone: privatePhone,
    },
  });
  const dialog = await fillMapping(page);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText(
    'os telefones no CRM e no Olist são diferentes',
  );
  await expect(dialog.getByRole('alert')).toContainText(
    'não corrige o cadastro nem libera novos envios',
  );
  await dialog.getByRole('alert').scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('alert')).toBeInViewport();
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: 'var/qa-olist-phase6/legacy-buyer-phone-mobile.png',
  });
  await expect(dialog.getByText(privatePhone)).toHaveCount(0);
  await expect(
    dialog.getByText(/O Olist confirmou comprador, itens/u),
  ).toHaveCount(0);
  const confirmation = dialog.getByRole('checkbox', {
    name: /telefone diferente.*vínculo exclusivo desta venda histórica/u,
  });
  await expect(confirmation).toHaveCount(1);
  expect(
    calls.filter((call) => call.path.endsWith('/legacy/links')),
  ).toHaveLength(0);
  await confirmation.check();
  await dialog
    .getByLabel('Motivo do vínculo (obrigatório)')
    .fill('Conferência sintética exclusiva da venda selecionada');
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    calls.find((call) => call.path.endsWith('/legacy/links'))?.body,
  ).toEqual({
    previewToken: 'legacy-synthetic-receipt',
    confirmed: true,
    reason: 'Conferência sintética exclusiva da venda selecionada',
  });
  expect(
    calls.filter((call) => call.method === 'POST').map((call) => call.path),
  ).toEqual([
    `${base}/existing/legacy/previews`,
    `${base}/existing/legacy/links`,
  ]);
});

test('T16 an unknown historical buyer review policy cannot reach the confirmation', async ({
  page,
}) => {
  const calls = await setup(page, {
    buyerReview: {
      mode: 'unknown-policy',
      phoneMismatch: true,
      reusable: false,
      code: 'OLIST_LEGACY_BUYER_PHONE_MISMATCH',
    },
  });
  const dialog = await fillMapping(page);
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  expect(
    calls.filter((call) => call.path.endsWith('/legacy/links')),
  ).toHaveLength(0);
});
