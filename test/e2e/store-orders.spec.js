import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// ADRs 027 and 028 (LOJ-08, LOJ-10, LOJ-14, LOJ-22..24): a site shop order
// paid through InfinitePay, in the list and on its page — the "Loja · LJ-…"
// badge, "Pago — confirmado pela InfinitePay em …", the lead time, the NSU,
// the receipt link, the lock and "Baixar ficha" — all by keyboard; and the
// order link the seller opens without a session comes back after the login.
// The customer and the gateway identifiers are synthetic.

const session = {
  user: {
    capabilities: ['COMMERCIAL_ADMIN'],
    email: 'rose@example.test',
    functionName: 'Vendedor',
    id: 'admin-rose',
    name: 'Rose Sintética',
  },
};

const RECEIPT_URL = 'https://recibo.infinitepay.io/sintetico-5b0c77ed';

const storeOrder = {
  confirmedAt: '2026-10-08T02:16:03.000Z',
  confirmedBy: { id: 'system:loja-do-site', name: 'Loja do site' },
  conversationId: null,
  createdAt: '2026-10-08T02:16:03.000Z',
  deliveredOn: null,
  fabCode: '01',
  ficha: {
    artwork: {
      feito_pela_silmer: false,
      feito_pelo_cliente: false,
      files: [],
      sem_estampa: true,
    },
    items: [
      {
        cor: 'Preto',
        gola: 'Gola redonda',
        grade: [{ quantidade: 10, tamanho: 'M' }],
        malhas: ['Dry fit liso de poliéster'],
        publico: 'masculino',
        tipo: 'Camiseta',
      },
    ],
    loja: {
      comprovanteUrl: RECEIPT_URL,
      produto: {
        nome: 'Camisa Masculina Lisa Dry Fit',
        slug: 'camisa-masculina-lisa',
      },
      telefone: '5527900000001',
    },
    observations: [],
    serviceData: {},
    summary: {
      cliente: 'Cliente Sintetico da Loja',
      data_entrega_confirmada: null,
      nome: null,
    },
  },
  finalAmountCents: 18000,
  firstContactAt: '2026-10-08T02:15:55.000Z',
  gatewayPayment: {
    confirmedAt: '2026-10-08T02:15:55.000Z',
    invoiceSlug: 'fatura-sintetica-1',
    paidAmountCents: 18000,
    receiptUrl: RECEIPT_URL,
    source: 'infinitepay',
    transactionNsu: 'nsu-sintetico-0001',
  },
  id: 'order-loja',
  isTest: true,
  lastMessage: null,
  leadTimeBusinessDays: 10,
  locked: true,
  missingFields: [],
  number: '12-CRM',
  orderDate: '2026-10-07',
  origin: 'loja',
  paidOn: '2026-10-07',
  paymentCondition: 'pix',
  reopenedAt: null,
  reopenedBy: null,
  seller: null,
  status: 'confirmado',
  storeNumber: 'LJ-5B0C77ED',
  totalPieces: 10,
  updatedAt: '2026-10-08T02:16:03.000Z',
  version: 1,
};

/**
 * ADR 031: a paid site order that is not a test and whose ficha nobody
 * printed yet — a "pedido novo do site".
 */
const newStoreOrder = {
  ...storeOrder,
  fichaFirstPrintedAt: null,
  fichaFirstPrintedBy: null,
  id: 'order-loja-nova',
  isTest: false,
  number: '13-CRM',
  storeNumber: 'LJ-0001ABCD',
};

/** The same order after Rose printed its ficha. */
const printedStoreOrder = {
  ...newStoreOrder,
  fichaFirstPrintedAt: '2026-10-08T12:12:00.000Z',
  fichaFirstPrintedBy: { id: 'admin-rose', name: 'Rose Sintética' },
  id: 'order-loja-impressa',
  number: '14-CRM',
  storeNumber: 'LJ-0002ABCD',
  version: 2,
};

/**
 * @param {number} storeNewCount
 * @param {string|null} [storeNewOldestPaidAt]
 */
function summaryWith(storeNewCount, storeNewOldestPaidAt = null) {
  return {
    averageTicketCents: 0,
    confirmedCount: 0,
    pendingCount: 0,
    soldAmountCents: 0,
    storeNewCount,
    storeNewOldestPaidAt,
    totalPiecesSold: 0,
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   onList?: (params: URLSearchParams) => void,
 *   signedOut?: boolean,
 *   orders?: any[],
 *   summary?: (read: number) => any,
 *   liveEvent?: Promise<string>,
 * }} [options]
 */
async function mockStore(page, options = {}) {
  let authenticated = options.signedOut !== true;
  let summaryReads = 0;
  const orders = options.orders ?? [storeOrder];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (/^\/api\/v1\/orders\/[^/]+\/pdf$/u.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: '%PDF-1.4\n% synthetic store ficha\n',
      });
      return;
    }
    if (path === '/api/v1/sessions/current' && request.method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify(
          authenticated ? session : { error: { code: 'UNAUTHENTICATED' } },
        ),
        contentType: 'application/json',
        status: authenticated ? 200 : 401,
      });
      return;
    }
    if (path === '/api/v1/sessions' && request.method() === 'POST') {
      authenticated = true;
      await route.fulfill({
        body: JSON.stringify(session),
        contentType: 'application/json',
      });
      return;
    }
    if (path === '/api/v1/events') {
      // ADR 031: a live event, when the test hands one, arrives once.
      const event = options.liveEvent ? await options.liveEvent : '';
      await route.fulfill({
        body: `retry: 60000\n\n: connected\n\n${event}`,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        status: 200,
      });
      return;
    }
    if (path === '/api/v1/orders/delivery-tasks') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    if (path === '/api/v1/orders/summary' && request.method() === 'GET') {
      summaryReads += 1;
      await route.fulfill({
        body: JSON.stringify(
          options.summary?.(summaryReads) ?? summaryWith(0, null),
        ),
        contentType: 'application/json',
      });
      return;
    }
    if (path === '/api/v1/inbox/conversations' && request.method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({ items: [], totalCount: 0 }),
        contentType: 'application/json',
      });
      return;
    }
    if (path === '/api/v1/inbox/summary' && request.method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({
          assistant: {
            activeCount: 3,
            failedDeliveryCount: 0,
            lastReplyAt: '2026-10-15T14:58:00.000Z',
            stallMinutes: 10,
            stalledCount: 0,
          },
          generatedAt: '2026-10-15T15:00:00.000Z',
          mine: { awaitingReplyCount: 0, count: 0, oldestAwaitingSince: null },
          waitingHandoff: { count: 0, oldestSince: null, overdueCount: 0 },
        }),
        contentType: 'application/json',
      });
      return;
    }
    if (path === '/api/v1/orders' && request.method() === 'GET') {
      options.onList?.(url.searchParams);
      await route.fulfill({
        body: JSON.stringify({
          counts: { confirmado: orders.length, pendente: 0 },
          items: orders,
          nextCursor: null,
        }),
        contentType: 'application/json',
      });
      return;
    }
    const opened = orders.find(
      (order) => path === `/api/v1/orders/${order.id}`,
    );
    if (opened && request.method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify({ order: opened }),
        contentType: 'application/json',
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'ORDER_NOT_FOUND' } }),
      contentType: 'application/json',
      status: 404,
    });
  });
}

/** @param {import('@playwright/test').Page} page */
async function signIn(page) {
  const loginPanel = page.getByRole('region', {
    name: 'Boas-vindas de volta',
  });
  await loginPanel.getByLabel('E-mail').fill('rose@example.test');
  await loginPanel.getByLabel('Senha').fill('senha sintetica de teste');
  await loginPanel.getByLabel('Senha').press('Enter');
}

test('the list filters "Loja do site" by keyboard and labels the store order', async ({
  page,
}) => {
  /** @type {URLSearchParams[]} */
  const lists = [];
  await mockStore(page, { onList: (params) => lists.push(params) });
  await page.goto('/pedidos');
  await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeFocused();

  // PLI-09: "Loja do site" lives in the "Filtros" sheet, by keyboard too.
  const filters = page.getByRole('button', { name: 'Filtros' });
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  const storeFilter = sheet.getByRole('radio', { name: 'Loja do site' });
  await storeFilter.focus();
  await page.keyboard.press('Space');
  await expect(storeFilter).toBeChecked();
  await sheet.getByRole('button', { name: 'Ver resultados' }).focus();
  await page.keyboard.press('Enter');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  // PLI-10: no chip says it, so the list names it.
  await expect(page.locator('.orders-active-filter')).toContainText(
    'Filtro: Loja do site',
  );
  await expect.poll(() => lists.at(-1)?.get('origin') ?? null).toBe('loja');
  expect(lists.at(-1)?.get('status')).toBeNull();

  // LOJ-23: the search sends the shop's number as typed; the API finds it.
  await page
    .getByLabel('Buscar número, cliente ou telefone')
    .fill('LJ-5B0C77ED');
  await expect.poll(() => lists.at(-1)?.get('q') ?? null).toBe('LJ-5B0C77ED');

  const confirmed = page.getByRole('region', { name: /Confirmados/u });
  const row = confirmed.getByRole('row').nth(1);
  await expect(row).toContainText('12-CRM');
  await expect(
    row.getByText('Loja · LJ-5B0C77ED', { exact: true }),
  ).toBeVisible();
  await expect(row.getByText('Teste', { exact: true })).toBeVisible();
  await expect(row).toContainText('Cliente Sintetico da Loja');
  await expect(row).toContainText('Loja do site · Camisa dry fit');
  await expect(row).toContainText('R$ 180,00');
  // LOJ-33: confirmed like any order, by the site; a test is never "new".
  await expect(row).toContainText(
    'Confirmado pela loja do site · 07/10/2026, 23:15',
  );
  await expect(row).not.toContainText('Ficha ainda sem PDF');
  await expect(row).not.toContainText('Pago — confirmado pela InfinitePay');
  await expect(row).not.toContainText('sem vendedor');
  await expect(row).not.toContainText('informado pelo cliente');
  await expect(row.getByRole('button', { name: 'Gerar PDF' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Abrir pedido' })).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('LOJ-33: a new site order says "Ficha ainda sem PDF"; a printed one says who printed it', async ({
  page,
}) => {
  await mockStore(page, { orders: [newStoreOrder, printedStoreOrder] });
  await page.goto('/pedidos');
  const confirmed = page.getByRole('region', { name: /Confirmados/u });
  const fresh = confirmed.getByRole('row').filter({ hasText: '13-CRM' });
  await expect(
    fresh.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toBeVisible();
  await expect(fresh).toContainText(
    'Confirmado pela loja do site · 07/10/2026, 23:15',
  );
  await expect(fresh).not.toContainText('PDF gerado por');

  const printed = confirmed.getByRole('row').filter({ hasText: '14-CRM' });
  await expect(printed).not.toContainText('Ficha ainda sem PDF');
  await expect(printed).toContainText(
    'PDF gerado por Rose Sintética · 08/10/2026, 09:12',
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('LOJ-31/LOJ-32: the Dashboard notice is one link to the site orders, and the menu counts them', async ({
  page,
}) => {
  /** @type {URLSearchParams[]} */
  const lists = [];
  await mockStore(page, {
    onList: (params) => lists.push(params),
    orders: [newStoreOrder],
    summary: () => summaryWith(2, '2026-10-08T02:15:55.000Z'),
  });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeFocused();

  const notice = page
    .locator('#main-content')
    .getByRole('link', { name: /pedidos novos do site/u });
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveAttribute('href', '/pedidos?origem=loja');
  await expect(notice).toContainText('2 pedidos novos do site');
  await expect(notice).toContainText(
    'Confirmados e pagos por Pix, o mais antigo em 07/10, 23:15. Gere os PDFs das fichas para começar a produção.',
  );
  await expect(notice).toContainText('Ver pedidos');
  // The notice sits in a polite live region, before the indicators.
  await expect(page.locator('.store-notice-region')).toHaveAttribute(
    'aria-live',
    'polite',
  );

  // LOJ-32: the menu shows the same number, with words for screen readers.
  const menu = page.getByRole('navigation', { name: 'Navegação principal' });
  const ordersItem = menu.getByRole('link', { name: /^Pedidos/u });
  await expect(ordersItem).toHaveAccessibleName(
    'Pedidos 2 pedidos novos do site',
  );

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Keyboard: Enter on the notice opens the list already on "Loja do site".
  await notice.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/pedidos?origem=loja');
  // PLI-10: the filter lives in the sheet, so the list names it.
  await expect(page.locator('.orders-active-filter')).toContainText(
    'Filtro: Loja do site',
  );
  await expect.poll(() => lists.at(-1)?.get('origin') ?? null).toBe('loja');
});

test('LOJ-31: one new site order reads in the singular; none hides the notice', async ({
  page,
}) => {
  await mockStore(page, {
    summary: () => summaryWith(1, '2026-10-08T02:15:55.000Z'),
  });
  await page.goto('/dashboard');
  const notice = page
    .locator('#main-content')
    .getByRole('link', { name: /pedido novo do site/u });
  await expect(notice).toContainText('1 pedido novo do site');
  await expect(notice).toContainText(
    'Confirmado e pago por Pix em 07/10, 23:15. Gere o PDF da ficha para começar a produção.',
  );

  const empty = await page.context().newPage();
  await mockStore(empty, { summary: () => summaryWith(0, null) });
  await empty.goto('/dashboard');
  await expect(empty.getByText('Vendido hoje', { exact: true })).toBeVisible();
  await expect(empty.locator('.store-notice')).toHaveCount(0);
  await expect(
    empty
      .getByRole('navigation', { name: 'Navegação principal' })
      .locator('.nav-count'),
  ).toHaveCount(0);
});

test('LOJ-31: the notice leaves when the first print arrives as a live event', async ({
  page,
}) => {
  /** @type {(event: string) => void} */
  let sendEvent = () => {};
  const liveEvent = new Promise((resolve) => {
    sendEvent = resolve;
  });
  let printed = false;
  await mockStore(page, {
    liveEvent: /** @type {Promise<string>} */ (liveEvent),
    summary: () =>
      printed ? summaryWith(0, null) : summaryWith(1, '2026-10-08T02:15:55Z'),
  });
  await page.goto('/dashboard');
  await expect(
    page
      .locator('#main-content')
      .getByRole('link', { name: /1 pedido novo do site/u }),
  ).toBeVisible();

  printed = true;
  sendEvent(
    'event: inbox.order.changed\nid: 2\ndata: {"conversationId":"","orderId":"order-loja-nova"}\n\n',
  );
  await expect(page.locator('.store-notice')).toHaveCount(0);
  await expect(page.locator('.store-notice-region')).toBeAttached();
});

test('the store order page reads like a confirmed order, is locked and downloads its ficha', async ({
  page,
}) => {
  await mockStore(page);
  await page.goto('/pedidos/order-loja');

  const heading = page.getByRole('heading', { name: 'Pedido 12-CRM' });
  await expect(heading).toBeFocused();
  // LOJ-34: "Confirmado", like any order generated in the CRM.
  await expect(page.locator('.op-head .op-status')).toHaveText('Confirmado');
  await expect(
    page.getByText('Pago — confirmado pela InfinitePay', { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Loja · LJ-5B0C77ED', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Teste', { exact: true })).toBeVisible();
  // A test order is never a new site order.
  await expect(
    page.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'Cliente Sintetico da Loja — Loja do site · Camisa dry fit',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Pedido da loja do site: travado, sem edição.'),
  ).toBeVisible();

  // LOJ-35: only what production and the contact use.
  const details = page.getByRole('region', { name: 'Pedido da loja do site' });
  const labels = await details.locator('dl > div > dt').allTextContents();
  expect(labels.map((label) => label.trim())).toEqual([
    'Produto',
    'Cor',
    'Tamanho',
    'Quantidade',
    'Prazo da cor',
    'Cliente',
    'WhatsApp',
    'Comprovante',
  ]);
  for (const [label, value] of [
    ['Produto', 'Camisa dry fit'],
    ['Cor', 'Preto'],
    ['Tamanho', 'M'],
    ['Quantidade', '10 peças'],
    ['Prazo da cor', '10 dias úteis'],
    ['Cliente', 'Cliente Sintetico da Loja'],
    ['WhatsApp', '+55 (27) 90000-0001'],
  ]) {
    await expect(
      details
        .locator('dl > div')
        .filter({ has: page.getByText(label, { exact: true }) }),
    ).toContainText(value);
  }
  await expect(details).toContainText(
    'Retirada na loja é o padrão; se o cliente quiser receber, a equipe combina o frete pelo WhatsApp abaixo.',
  );
  for (const gone of ['nsu-sintetico', 'Camiseta', 'Gola redonda', 'Sicredi']) {
    await expect(details).not.toContainText(gone);
  }

  // LOJ-34: the closing panel, confirmed, beside the sheet.
  const closing = page.getByRole('region', { name: 'Fechamento e pagamento' });
  await expect(closing).toContainText('pedido confirmado');
  for (const [label, value] of [
    ['Valor final', 'R$ 180,00'],
    ['Forma de pagamento', 'Pix'],
    ['Confirmação', 'Confirmado pela loja do site · 07/10/2026, 23:15'],
  ]) {
    await expect(
      closing
        .locator('.op-deal > div')
        .filter({ has: page.getByText(label, { exact: true }) }),
    ).toContainText(value);
  }
  await expect(closing).toContainText('Ficha 12-CRM');
  await expect(closing).toContainText('1 página · pedido da loja');
  await expect(closing.locator('.op-ficha-status')).toHaveText(
    'PDF ainda não gerado.',
  );
  await expect(
    closing.getByRole('button', { name: 'Baixar ficha em PDF' }),
  ).toBeVisible();
  await expect(closing).toContainText(
    'Pedido da loja não é reaberto: valor e itens vieram do pagamento.',
  );

  // LOJ-22: the receipt opens in a new tab, and says so.
  const receipt = details.getByRole('link', {
    name: 'Comprovante InfinitePay (abre em nova aba)',
  });
  await expect(receipt).toHaveAttribute('href', RECEIPT_URL);
  await expect(receipt).toHaveAttribute('target', '_blank');
  await expect(receipt).toHaveAttribute('rel', 'noopener noreferrer');

  // Nothing to edit, generate, reopen or attach on a locked order.
  for (const name of [
    /Editar/u,
    /Gerar pedido/u,
    /Reabrir/u,
    /Enviar arquivo/u,
    /Salvar/u,
  ]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }

  // Keyboard reaches the PDF action for the simplified store ficha.
  const download = page.getByRole('button', { name: 'Baixar ficha em PDF' });
  await heading.focus();
  let reached = false;
  for (let step = 0; step < 40 && !reached; step += 1) {
    await page.keyboard.press('Tab');
    reached = await download.evaluate(
      (element) => element === element.ownerDocument.activeElement,
    );
  }
  expect(reached).toBe(true);
  await expect(
    page.locator('.op-head-actions').getByRole('button', { name: 'Gerar PDF' }),
  ).toBeEnabled();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('LOJ-24: the order link opened without a session comes back to the order after the login', async ({
  page,
}) => {
  await mockStore(page, { signedOut: true });
  await page.goto('/pedidos/order-loja');
  await expect(page.getByRole('status')).toHaveText('Entre para continuar.');
  await expect(page).toHaveURL('/?voltar=/pedidos/order-loja');

  await signIn(page);
  await expect(page).toHaveURL('/pedidos/order-loja');
  await expect(
    page.getByRole('heading', { name: 'Pedido 12-CRM' }),
  ).toBeFocused();
});

test('LOJ-24: a return address outside the app is ignored', async ({
  page,
}) => {
  await mockStore(page, { signedOut: true });
  await page.goto('/?voltar=%2F%2Fevil.example%2Fpedidos');
  await expect(page.getByRole('status')).toHaveText('Entre para continuar.');
  await signIn(page);
  await expect(page).toHaveURL('/dashboard');
});

test('LOJ-34: the page of a new site order says its ficha waits; printed, it names who printed it', async ({
  page,
}) => {
  await mockStore(page, { orders: [newStoreOrder, printedStoreOrder] });
  await page.goto('/pedidos/order-loja-nova');
  await expect(
    page.getByRole('heading', { name: 'Pedido 13-CRM' }),
  ).toBeFocused();
  await expect(
    page.locator('.op-head').getByText('Ficha ainda sem PDF', { exact: true }),
  ).toBeVisible();
  const closing = page.getByRole('region', { name: 'Fechamento e pagamento' });
  await expect(closing.locator('.op-ficha-status')).toHaveText(
    'PDF ainda não gerado. Ao gerar, o pedido sai do aviso do Dashboard.',
  );
  await expect(closing.locator('.op-ficha-status')).toHaveAttribute(
    'data-tone',
    'warning',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto('/pedidos/order-loja-impressa');
  await expect(
    page.getByRole('heading', { name: 'Pedido 14-CRM' }),
  ).toBeFocused();
  await expect(
    page.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toHaveCount(0);
  const printedClosing = page.getByRole('region', {
    name: 'Fechamento e pagamento',
  });
  await expect(printedClosing.locator('.op-ficha-status')).toHaveText(
    'PDF gerado por Rose Sintética · 08/10/2026, 09:12',
  );
  await expect(printedClosing.locator('.op-ficha-status')).toHaveAttribute(
    'data-tone',
    'success',
  );
});

test('ADR 031: after "Gerar PDF" one re-read clears the badge without a live event', async ({
  page,
}) => {
  /** @type {any[]} */
  const orders = [{ ...newStoreOrder }];
  await mockStore(page, { orders });
  await page.goto('/pedidos');
  const confirmed = page.getByRole('region', { name: /Confirmados/u });
  const row = confirmed.getByRole('row').filter({ hasText: '13-CRM' });
  await expect(
    row.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toBeVisible();

  // The API records the first print while the tab opens; no event arrives.
  orders[0] = {
    ...newStoreOrder,
    fichaFirstPrintedAt: '2026-10-08T12:12:00.000Z',
    fichaFirstPrintedBy: { id: 'admin-rose', name: 'Rose Sintética' },
    version: 2,
  };
  await row.getByRole('button', { name: 'Gerar PDF' }).click();
  await expect(
    row.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toHaveCount(0, { timeout: 8000 });
  await expect(row).toContainText('PDF gerado por Rose Sintética');
});

test('ADR 037: on the order page, the first PDF re-reads the order and clears the badge', async ({
  page,
}) => {
  /** @type {any[]} */
  const orders = [{ ...newStoreOrder }];
  await mockStore(page, { orders });
  await page.goto('/pedidos/order-loja-nova');
  const head = page.locator('.op-head');
  await expect(
    head.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toBeVisible();

  orders[0] = {
    ...newStoreOrder,
    fichaFirstPrintedAt: '2026-10-08T12:12:00.000Z',
    fichaFirstPrintedBy: { id: 'admin-rose', name: 'Rose Sintética' },
    version: 2,
  };
  await page
    .getByRole('region', { name: 'Fechamento e pagamento' })
    .getByRole('button', { name: 'Baixar ficha em PDF' })
    .click();
  await expect(
    head.getByText('Ficha ainda sem PDF', { exact: true }),
  ).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.op-ficha-status')).toHaveText(
    'PDF gerado por Rose Sintética · 08/10/2026, 09:12',
  );
});
