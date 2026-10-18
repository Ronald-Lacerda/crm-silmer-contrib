import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// LOJ-39..41 / T135: exceptional, audited quantity correction on a paid
// store order. All customer and payment data in this fixture are synthetic.
const initialOrder = {
  id: 'store-correction-fixture',
  number: '10-CRM',
  storeNumber: 'LJ-1234ABCD',
  origin: 'loja',
  status: 'confirmado',
  locked: true,
  version: 1,
  totalPieces: 1,
  finalAmountCents: 4500,
  paymentCondition: 'pix',
  orderDate: '2026-10-18',
  paidOn: '2026-10-18',
  seller: null,
  confirmedAt: '2026-10-18T13:47:00Z',
  confirmedBy: { id: 'system:loja-do-site', name: 'Loja do site' },
  createdAt: '2026-10-18T13:47:00Z',
  updatedAt: '2026-10-18T13:47:00Z',
  conversationId: null,
  missingFields: [],
  leadTimeBusinessDays: 1,
  isTest: false,
  fichaFirstPrintedAt: '2026-10-18T13:57:00Z',
  fichaFirstPrintedBy: { id: 'admin-test', name: 'Administrador Sintético' },
  gatewayPayment: {
    confirmedAt: '2026-10-18T13:47:00Z',
    invoiceSlug: 'invoice-synthetic',
    paidAmountCents: 9000,
    receiptUrl: 'https://recibo.infinitepay.io/synthetic',
    source: 'infinitepay',
    transactionNsu: 'nsu-synthetic',
  },
  ficha: {
    artwork: {
      feito_pela_silmer: false,
      feito_pelo_cliente: false,
      files: [],
      sem_estampa: true,
    },
    items: [
      {
        cor: 'Verde-bandeira/Amarelo',
        gola: 'Gola redonda',
        grade: [{ quantidade: 1, tamanho: 'M' }],
        malhas: ['Dry fit liso de poliéster'],
        publico: 'masculino',
        tipo: 'Camiseta',
      },
    ],
    loja: {
      produto: {
        nome: 'Camisa Bloquinho 22 Completa',
        slug: 'bloquinho-22-completa',
      },
      telefone: '5527900000001',
      comprovanteUrl: 'https://recibo.infinitepay.io/synthetic',
    },
    observations: [],
    serviceData: {},
    summary: { cliente: 'Cliente Sintético', nome: null },
  },
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{admin?: boolean, status?: number, failFirst?: boolean}} [options]
 */
async function mockCorrection(page, options = {}) {
  let order = structuredClone(initialOrder);
  /** @type {{body: any, key: string|undefined}[]} */
  const commands = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = {};
    if (path === '/api/v1/sessions/current') {
      data = {
        user: {
          id: 'admin-test',
          name: 'Administrador Sintético',
          email: 'admin@example.test',
          functionName: 'Vendedor',
          capabilities: options.admin === false ? [] : ['COMMERCIAL_ADMIN'],
        },
      };
    } else if (path === '/api/v1/events') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: ': connected\n\n',
      });
      return;
    } else if (path.endsWith('/store-correction')) {
      commands.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      if (options.failFirst && commands.length === 1) {
        await route.abort('failed');
        return;
      }
      if (options.status) {
        await route.fulfill({
          status: options.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'CORRECTION_REJECTED' } }),
        });
        return;
      }
      order = {
        ...order,
        version: 2,
        totalPieces: 2,
        finalAmountCents: 9000,
        ficha: {
          ...order.ficha,
          items: [
            {
              ...order.ficha.items[0],
              grade: [{ quantidade: 2, tamanho: 'M' }],
            },
          ],
        },
      };
      data = { order };
    } else if (path === `/api/v1/orders/${initialOrder.id}`) {
      data = { order };
    } else if (path === '/api/v1/orders/summary') {
      data = {
        storeNewCount: 0,
        totalPiecesSold: order.totalPieces,
        soldAmountCents: order.finalAmountCents,
      };
    } else if (path === '/api/v1/inbox/summary') {
      data = {
        mine: { count: 0, awaitingReplyCount: 0 },
        waitingHandoff: { count: 0, overdueCount: 0 },
        assistant: { activeCount: 0, failedDeliveryCount: 0, stalledCount: 0 },
      };
    } else if (path === '/api/v1/inbox/conversations') {
      data = { items: [], totalCount: 0 };
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });
  return commands;
}

/** @param {import('@playwright/test').Page} page */
async function openCorrection(page) {
  await page.goto(`/pedidos/${initialOrder.id}`);
  const summary = page.locator('.op-store-correction > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  const quantity = page.getByLabel('Quantidade confirmada pelo cliente');
  await expect(quantity).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(quantity).toBeFocused();
  return quantity;
}

test('LOJ-39..41: admin corrects two pieces by keyboard and sees the updated amount and PDF notice', async ({
  page,
}) => {
  const commands = await mockCorrection(page);
  const quantity = await openCorrection(page);
  await quantity.fill('2');
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', {
    name: 'Registrar correção de quantidade',
  });
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  const details = page.getByRole('region', { name: 'Pedido da loja do site' });
  await expect(details).toContainText('2 peças');
  await expect(
    page.getByRole('region', { name: 'Fechamento e pagamento' }),
  ).toContainText('R$ 90,00');
  await expect(page.locator('.op-store-correction [role="status"]')).toHaveText(
    'Quantidade corrigida. Gere novamente a ficha para usar os dados atualizados.',
  );
  await expect(submit).toBeFocused();
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toEqual({
    expectedVersion: 1,
    expectedQuantity: 1,
    expectedAmountCents: 4500,
    quantity: 2,
    reason: 'USER_CONFIRMED_QUANTITY',
  });
  expect(commands[0].key).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(
    details.getByRole('link', { name: /Comprovante InfinitePay/u }),
  ).toHaveAttribute('href', initialOrder.gatewayPayment.receiptUrl);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('LOJ-39: a seller without COMMERCIAL_ADMIN sees the order without the correction action', async ({
  page,
}) => {
  const commands = await mockCorrection(page, { admin: false });
  await page.goto(`/pedidos/${initialOrder.id}`);
  await expect(
    page.getByRole('heading', { name: 'Pedido 10-CRM' }),
  ).toBeVisible();
  await expect(page.locator('.op-store-correction')).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

for (const [status, message] of [
  [403, 'Somente um administrador pode corrigir a quantidade.'],
  [
    409,
    'O pedido mudou. Atualize a página e confira os dados antes de corrigir.',
  ],
  [422, 'A correção não é compatível com o catálogo ou com o valor já pago.'],
]) {
  test(`LOJ-39..41: HTTP ${status} preserves the order and announces why correction was refused`, async ({
    page,
  }) => {
    const commands = await mockCorrection(page, { status: Number(status) });
    const quantity = await openCorrection(page);
    await quantity.fill('2');
    await quantity.press('Enter');
    await expect(
      page.locator('.op-store-correction [role="alert"]'),
    ).toHaveText(String(message));
    await expect(
      page.getByRole('region', { name: 'Pedido da loja do site' }),
    ).toContainText('1 peça');
    await expect(
      page.getByRole('region', { name: 'Fechamento e pagamento' }),
    ).toContainText('R$ 45,00');
    await expect(
      page.getByRole('button', { name: 'Registrar correção de quantidade' }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Registrar correção de quantidade' }),
    ).toBeFocused();
    expect(commands).toHaveLength(1);
  });
}

test('LOJ-40: retry after a network failure reuses the complete command and idempotency key', async ({
  page,
}) => {
  const commands = await mockCorrection(page, { failFirst: true });
  const quantity = await openCorrection(page);
  await quantity.fill('2');
  await quantity.press('Enter');
  await expect(
    page.locator('.op-store-correction [role="alert"]'),
  ).toContainText('Tente novamente');
  await page
    .getByRole('button', { name: 'Registrar correção de quantidade' })
    .click();
  await expect(
    page.getByRole('region', { name: 'Pedido da loja do site' }),
  ).toContainText('2 peças');
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
});
