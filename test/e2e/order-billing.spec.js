import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, ownConfirmedOrder } from './support/orders-mock.js';

/** @param {import('@playwright/test').Page} page @param {any} [options] */
async function setup(page, options = {}) {
  const order = {
    ...ownConfirmedOrder,
    paidOn: null,
    origin: 'atendimento',
    finalAmountCents: options.amount ?? 180000,
    status: options.orderStatus ?? ownConfirmedOrder.status,
  };
  await mockOrders(page, { orders: [order] });
  await page.route('**/api/v1/orders/order-confirmado', (route) =>
    route.fulfill({ json: { order } }),
  );
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'synthetic-billing-csrf',
      url: `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`,
    },
  ]);
  const billing = {
    version: 0,
    orderVersion: order.version,
    percent: null,
    totalAmountCents: order.finalAmountCents,
    receivedAmountCents: 0,
    balanceAmountCents: order.finalAmountCents,
    canManage: true,
    managed: false,
    blockedReason: null,
    charges: [],
    enabled: true,
    ...options.billing,
  };
  /** @type {any[]} */
  const writes = [];
  const committed = new Map();
  let responseLost = false;
  let failRead = options.failRead ?? false;
  await page.route('**/api/v1/orders/*/billing**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (/** @type {number} */ status, /** @type {any} */ body) =>
      route.fulfill({ status, json: body });
    if (options.disabled) return json(404, { code: 'NOT_FOUND' });
    if (request.method() === 'GET') {
      if (failRead) {
        failRead = false;
        return json(503, { code: 'SERVICE_UNAVAILABLE' });
      }
      return json(200, { billing });
    }
    expect(request.headers()['idempotency-key']).toBeTruthy();
    const body = request.postDataJSON();
    const key = request.headers()['idempotency-key'];
    writes.push({ path, body, key });
    if (committed.has(key)) return json(200, committed.get(key));
    if (options.writeFailure)
      return json(options.writeFailure.status, {
        code: options.writeFailure.code,
      });
    if (path.endsWith('/plan')) {
      billing.percent = body.percent;
      billing.managed = true;
      billing.version++;
    } else if (path.endsWith('/charges')) {
      billing.percent = body.percent;
      billing.managed = true;
      billing.version++;
      const signal =
        !billing.charges.length && body.percent > 0 && body.percent < 100;
      billing.charges.push({
        id: `billing-${billing.charges.length + 1}`,
        kind: signal ? 'signal' : billing.charges.length ? 'balance' : 'full',
        amountCents: signal
          ? Math.round((billing.totalAmountCents * body.percent) / 100)
          : billing.balanceAmountCents,
        status: options.createStatus ?? 'waiting',
        checkoutUrl: 'https://checkout.infinitepay.io/synthetic-checkout',
        receiptUrl: null,
        method: null,
        installments: null,
        refundableAmountCents: 0,
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      });
    } else if (path.endsWith('/refund')) {
      const charge = billing.charges[0];
      charge.refundedAmountCents =
        (charge.refundedAmountCents ?? 0) + body.amountCents;
      charge.refundableAmountCents -= body.amountCents;
      billing.receivedAmountCents = Math.max(
        0,
        billing.receivedAmountCents - body.amountCents,
      );
      billing.balanceAmountCents =
        billing.totalAmountCents - billing.receivedAmountCents;
      billing.version++;
      billing.orderVersion = ++order.version;
    } else if (path.endsWith('/reconcile')) {
      billing.blockedReason = null;
      billing.version++;
      billing.orderVersion = ++order.version;
      billing.charges.forEach((/** @type {any} */ charge) => {
        charge.status = body.decision === 'close_unpaid' ? 'closed' : 'paid';
      });
    }
    const result = { billing: JSON.parse(JSON.stringify(billing)) };
    committed.set(key, result);
    if (
      options.loseResponse &&
      path.endsWith(`/${options.loseResponse}`) &&
      !responseLost
    ) {
      responseLost = true;
      return route.abort('failed');
    }
    return json(200, result);
  });
  await page.goto(`/pedidos/${order.id}#cobrancas`);
  const section = page.getByRole('region', { name: 'Cobranças', exact: true });
  await expect(section).toBeVisible();
  if (!options.failRead && !options.disabled)
    await expect(section.getByRole('definition').first()).toBeVisible();
  return {
    section,
    billing,
    writes,
    failNextRead() {
      failRead = true;
    },
    pay(method = 'pix', installments = 1) {
      const charge = billing.charges.at(-1);
      charge.status = 'paid';
      charge.method = method;
      charge.installments = installments;
      charge.paidAt = '2026-11-05T15:00:00.000Z';
      charge.receiptUrl = 'https://infinitepay.io/synthetic-receipt';
      charge.refundableAmountCents = charge.amountCents;
      billing.receivedAmountCents += charge.amountCents;
      billing.balanceAmountCents -= charge.amountCents;
      billing.version++;
      billing.orderVersion = ++order.version;
    },
  };
}

/** @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} section */
async function issue(page, section) {
  await section
    .getByRole('button', { name: /Revisar cobrança|Cobrar saldo|Cobrar R\$/u })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Gerar link de pagamento', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

test('0% saves no checkout, then lets the owner explicitly charge the total', async ({
  page,
}, testInfo) => {
  const { section, writes } = await setup(page);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('billing-desktop.png'),
    fullPage: true,
  });
  await section.getByRole('radio', { name: '0% Sem entrada' }).check();
  await section.getByRole('button', { name: 'Salvar sem entrada' }).click();
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toMatch(/\/plan$/u);
  expect(writes[0].body.percent).toBe(0);
  await expect(section).toContainText('Nenhum link de entrada foi gerado');
  await expect(
    section.getByRole('link', { name: 'Abrir cobrança' }),
  ).toHaveCount(0);
  await issue(page, section);
  expect(writes).toHaveLength(2);
  expect(writes[1].body.percent).toBe(0);
  await expect(
    section.getByRole('link', { name: 'Abrir cobrança' }),
  ).toBeVisible();
  await expect(section.locator('.billing-totals')).toContainText('R$ 0,00');
});

test('a signal paid in card installments leaves the balance; Pix settles only after server confirmation', async ({
  page,
}, testInfo) => {
  const { section, writes, pay } = await setup(page);
  await section.getByLabel('Percentual de entrada', { exact: true }).fill('30');
  await issue(page, section);
  expect(writes[0].body.percent).toBe(30);
  await expect(section.locator('.billing-history')).toContainText('R$ 540,00');
  await expect(section.locator('.billing-totals')).toContainText('R$ 0,00');
  await expect(
    section.getByRole('button', { name: 'Revisar cobrança' }),
  ).toHaveCount(0);
  const checkoutLink = section.getByRole('link', { name: 'Abrir cobrança' });
  expect(
    (await checkoutLink.boundingBox())?.height ?? 0,
  ).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('billing-link-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkoutLink.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('billing-link-390.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  pay('credit_card', 3);
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section).toContainText('Pago parcialmente');
  await expect(section.locator('.billing-live')).toContainText('540,00');
  const announcement =
    (await section.locator('.billing-live').textContent()) ?? '';
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section.locator('.billing-live')).toHaveText(announcement);
  expect(
    (
      await section
        .getByRole('link', { name: 'Comprovante InfinitePay' })
        .boundingBox()
    )?.height ?? 0,
  ).toBeGreaterThanOrEqual(44);
  await expect(section.locator('.billing-history')).toContainText(
    'Cartão em 3x',
  );
  await expect(
    section.getByRole('button', { name: /Cobrar saldo de R\$/u }),
  ).toContainText('1.260,00');
  await issue(page, section);
  expect(writes[1].body.percent).toBe(30);
  pay();
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section).toContainText('Pedido integralmente pago');
  await expect(section.locator('.billing-totals dd').nth(1)).toHaveText(
    'R$ 1.800,00',
  );
  await expect(section.locator('.billing-totals dd').nth(2)).toHaveText(
    'R$ 0,00',
  );
});

test('100% card payment in 6x settles the entire order without collecting card details in CRM', async ({
  page,
}) => {
  const { section, writes, pay } = await setup(page);
  await section.getByRole('radio', { name: '100% Pagamento integral' }).check();
  await section.getByRole('button', { name: 'Revisar cobrança' }).click();
  await expect(page.getByRole('dialog')).toContainText('R$ 1.800,00');
  await expect(page.getByLabel(/cartão|parcelas/iu)).toHaveCount(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Gerar link de pagamento', exact: true })
    .click();
  expect(writes[0].body.percent).toBe(100);
  pay('credit_card', 6);
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section).toContainText('Quitado');
  await expect(section).toContainText('Cartão em 6x');
});

test('rounds the signal by cents, rejects invalid percentages and keeps keyboard focus', async ({
  page,
}) => {
  const { section, writes } = await setup(page, { amount: 10001 });
  await section.getByLabel('Percentual de entrada', { exact: true }).fill('30');
  await expect(section.locator('.billing-preview')).toContainText('R$ 30,00');
  await expect(section.locator('.billing-preview')).toContainText('R$ 70,01');
  await section
    .getByLabel('Percentual de entrada', { exact: true })
    .fill('101');
  await section.getByRole('button', { name: 'Revisar cobrança' }).click();
  await expect(section.getByRole('alert')).toContainText('1% a 99%');
  await expect(
    section.getByLabel('Percentual de entrada', { exact: true }),
  ).toBeFocused();
  expect(writes).toHaveLength(0);
  await section.getByLabel('Percentual de entrada', { exact: true }).fill('30');
  const trigger = section.getByRole('button', { name: 'Revisar cobrança' });
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('an uncertain charge cannot be emitted again and exposes explicit provider review', async ({
  page,
}) => {
  const { section } = await setup(page, { createStatus: 'unknown' });
  await issue(page, section);
  await expect(section).toContainText(
    'Precisamos conferir se o link foi criado',
  );
  await expect(
    section.getByRole('button', { name: 'Revisar cobrança' }),
  ).toHaveCount(0);
  await section.getByText('Conferência e devoluções', { exact: true }).click();
  await section
    .getByRole('button', { name: 'Conferir cobrança', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Registrar conferência' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Confira a cobrança na InfinitePay',
  );
});

for (const scenario of [
  { name: 'agreement review', status: 'review', review: true, expired: false },
  { name: 'expired link', status: 'waiting', review: false, expired: true },
  {
    name: 'uncertain result',
    status: 'unknown',
    review: false,
    expired: false,
  },
  {
    name: 'reopened order',
    status: 'waiting',
    review: false,
    expired: false,
    reopened: true,
  },
]) {
  test(`does not offer to send a financial link after ${scenario.name}`, async ({
    page,
  }) => {
    const { section } = await setup(page, {
      orderStatus: scenario.reopened ? 'pendente' : 'confirmado',
      billing: {
        managed: true,
        percent: 30,
        reviewRequired: scenario.review,
        blockedReason: scenario.review
          ? 'BILLING_REVIEW_REQUIRED'
          : 'BILLING_ACTIVE_CHARGE',
        charges: [
          {
            id: 'previous-agreement-charge',
            kind: 'signal',
            amountCents: 54000,
            status: scenario.status,
            checkoutUrl:
              'https://checkout.infinitepay.io/synthetic-previous-agreement',
            validUntil: new Date(
              Date.now() + (scenario.expired ? -86_400_000 : 86_400_000),
            ).toISOString(),
          },
        ],
      },
    });
    await expect(
      section.getByRole('button', { name: 'Copiar link', exact: true }),
    ).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Preparar mensagem', exact: true }),
    ).toHaveCount(0);
    await expect(
      section.getByRole('link', { name: 'Abrir cobrança', exact: true }),
    ).toHaveCount(0);
    if (scenario.expired) await expect(section).toContainText('Link vencido');
    await section
      .getByText('Conferência e devoluções', { exact: true })
      .click();
    await expect(
      section.getByRole('link', {
        name: 'Abrir cobrança anterior para conferência',
        exact: true,
      }),
    ).toBeVisible();
    if (!scenario.reopened)
      await expect(
        section.getByRole('button', { name: 'Conferir cobrança', exact: true }),
      ).toBeVisible();
  });
}

test('billing-managed dates cannot be marked manually, while delivery stays editable', async ({
  page,
}) => {
  await setup(page, { billing: { managed: true, percent: 0 } });
  const dates = page.getByRole('region', {
    name: 'Datas do pedido',
    exact: true,
  });
  await expect(dates).toContainText(
    'receber um sinal não registra quitação integral',
  );
  const toggle = dates.getByRole('button', { name: /Datas do pedido/u });
  if (await toggle.count()) await toggle.click();
  await dates
    .getByRole('button', { name: 'Editar datas', exact: true })
    .click();
  await expect(dates.getByLabel('Pago em', { exact: true })).toBeDisabled();
  await expect(dates.getByLabel('Entregue em', { exact: true })).toBeEnabled();
});

test('read-only users see amounts without a checkout link or financial commands', async ({
  page,
}) => {
  const { section, writes } = await setup(page, {
    billing: {
      canManage: false,
      managed: true,
      percent: 100,
      charges: [
        {
          id: 'read-only-charge',
          kind: 'full',
          amountCents: 180000,
          status: 'waiting',
          checkoutUrl: 'https://checkout.infinitepay.io/private-link',
        },
      ],
    },
  });
  await expect(section).toContainText('Somente o responsável pelo pedido');
  await expect(section.getByRole('link')).toHaveCount(0);
  await expect(section.getByRole('radio')).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test('a failed refresh preserves amounts but blocks sharing the previous link until recovery', async ({
  page,
}) => {
  const mock = await setup(page);
  await issue(page, mock.section);
  const open = mock.section.getByRole('link', {
    name: 'Abrir cobrança',
    exact: true,
  });
  await expect(open).toBeVisible();
  mock.failNextRead();
  await mock.section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(mock.section.getByRole('alert')).toContainText(
    'Os valores anteriores foram preservados',
  );
  await expect(mock.section.locator('.billing-totals')).toContainText(
    '1.800,00',
  );
  await expect(open).toHaveCount(0);
  await expect(
    mock.section.getByRole('link', {
      name: 'Abrir cobrança anterior para conferência',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    mock.section.getByRole('button', { name: 'Copiar link', exact: true }),
  ).toHaveCount(0);
  await mock.section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(open).toBeVisible();
});

test('read failure recovers without showing a false zero', async ({ page }) => {
  const { section } = await setup(page, { failRead: true });
  await expect(section.getByRole('alert')).toContainText(
    'Não foi possível consultar',
  );
  await expect(section.locator('.billing-totals')).toHaveCount(0);
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section.locator('.billing-totals')).toContainText('R$ 1.800,00');
});

test('multiple receipts in review permit refunding the full remaining received amount', async ({
  page,
}) => {
  const { section, writes, billing } = await setup(page, {
    amount: 10000,
    billing: {
      version: 1,
      percent: 100,
      managed: true,
      reviewRequired: true,
      blockedReason: 'BILLING_REVIEW_REQUIRED',
      receivedAmountCents: 10000,
      balanceAmountCents: 0,
      charges: [
        {
          id: 'multiple-receipts-charge',
          kind: 'full',
          amountCents: 10000,
          status: 'review',
          paidAt: '2026-11-05T15:00:00Z',
          method: 'pix',
          installments: 1,
          refundedAmountCents: 0,
          // Two distinct R$100 receipts; the second requires review.
          refundableAmountCents: 20000,
        },
      ],
    },
  });
  await section.getByText('Conferência e devoluções', { exact: true }).click();
  const refund = section.getByRole('button', {
    name: 'Registrar devolução do pagamento integral',
  });
  await refund.click();
  const dialog = page.getByRole('dialog');
  const amount = dialog.getByLabel('Valor já devolvido', { exact: true });
  const submit = dialog.getByRole('button', { name: 'Registrar conferência' });
  await amount.fill('200,01');
  await dialog.getByRole('checkbox').check();
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Informe o valor já devolvido',
  );
  expect(writes).toHaveLength(0);

  await amount.fill('150,00');
  await submit.click();
  await expect(dialog).not.toBeVisible();
  expect(writes[0].body.amountCents).toBe(15000);
  expect(billing.charges[0].refundableAmountCents).toBe(5000);
  await expect(refund).toBeVisible();
  await expect(refund).toBeFocused();

  await refund.press('Enter');
  await amount.fill('50,00');
  await dialog.getByRole('checkbox').check();
  await submit.click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1].body.amountCents).toBe(5000);
  expect(billing.charges[0].refundedAmountCents).toBe(20000);
  expect(billing.charges[0].refundableAmountCents).toBe(0);
  await expect(refund).toHaveCount(0);
});

test('refund retry keeps its original intent after commit, response loss and a newer read', async ({
  page,
}) => {
  const { section, writes, billing } = await setup(page, {
    loseResponse: 'refund',
    billing: {
      version: 1,
      percent: 100,
      managed: true,
      receivedAmountCents: 180000,
      balanceAmountCents: 0,
      charges: [
        {
          id: 'paid-charge',
          kind: 'full',
          amountCents: 180000,
          status: 'paid',
          paidAt: '2026-11-05T15:00:00Z',
          method: 'pix',
          installments: 1,
          refundedAmountCents: 0,
          refundableAmountCents: 180000,
        },
      ],
    },
  });
  await section.getByText('Conferência e devoluções', { exact: true }).click();
  await section
    .getByRole('button', { name: 'Registrar devolução do pagamento integral' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Valor já devolvido', { exact: true }).fill('100,00');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Registrar conferência' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Não foi possível confirmar a resposta',
  );
  await expect(
    dialog.getByLabel('Valor já devolvido', { exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Voltar', exact: true }).click();
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  await expect(section.locator('.billing-totals dd').nth(1)).toHaveText(
    'R$ 1.700,00',
  );
  await section
    .getByRole('button', { name: 'Conferir registro pendente' })
    .click();
  await dialog.getByRole('button', { name: 'Registrar conferência' }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1].key).toBe(writes[0].key);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(billing.charges[0].refundedAmountCents).toBe(10000);
  await expect(
    section.getByText('Há um registro com resultado incerto.', {
      exact: false,
    }),
  ).toHaveCount(0);
});

test('reconciliation retry replays the same operation after a newer billing and order version', async ({
  page,
}) => {
  const { section, writes, billing } = await setup(page, {
    loseResponse: 'reconcile',
    billing: {
      version: 1,
      percent: 100,
      managed: true,
      blockedReason: 'BILLING_REVIEW_REQUIRED',
      charges: [
        {
          id: 'review-charge',
          kind: 'full',
          amountCents: 180000,
          status: 'review',
          paidAt: '2026-11-05T15:00:00Z',
          method: 'pix',
          installments: 1,
        },
      ],
    },
  });
  await section.getByText('Conferência e devoluções', { exact: true }).click();
  await section
    .getByRole('button', { name: 'Conferir cobrança', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Registrar conferência' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Não foi possível confirmar a resposta',
  );
  await expect(dialog.getByRole('radio').first()).toBeDisabled();
  await dialog.getByRole('button', { name: 'Voltar', exact: true }).click();
  await section
    .getByRole('button', { name: 'Atualizar cobranças', exact: true })
    .click();
  expect(billing.version).toBe(2);
  expect(billing.orderVersion).toBeGreaterThan(writes[0].body.expectedVersion);
  await section
    .getByRole('button', { name: 'Conferir registro pendente' })
    .click();
  await dialog.getByRole('button', { name: 'Registrar conferência' }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1].key).toBe(writes[0].key);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(billing.version).toBe(2);
});

test('mobile light and dark preserve layout, labels, keyboard and accessible dialogs', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { section } = await setup(page);
  await expect(
    section.getByRole('button', { name: /Cobranças/u }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(
    (await new AxeBuilder({ page }).include('.billing-section').analyze())
      .violations,
  ).toEqual([]);
  await section.screenshot({ path: info.outputPath('billing-390-light.png') });
  await page.setViewportSize({ width: 320, height: 844 });
  const overflow = await section.evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(overflow).toBe(false);
  const touchGap = await section
    .locator('.billing-choices label')
    .evaluateAll((labels) => {
      const first = labels[0].getBoundingClientRect();
      const second = labels[1].getBoundingClientRect();
      return second.top - first.bottom;
    });
  expect(touchGap).toBeGreaterThanOrEqual(7.5);
  await section.screenshot({ path: info.outputPath('billing-320-light.png') });
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'dark';
  });
  await section.screenshot({ path: info.outputPath('billing-320-dark.png') });
  await section
    .getByRole('button', { name: 'Revisar cobrança', exact: true })
    .click();
  expect(
    (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
  ).toEqual([]);
});
