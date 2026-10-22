import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/** @param {import('@playwright/test').Page} page @param {{access?: string, conflict?: boolean, listError?: boolean, financeOnEvent?: boolean}} [options] */
async function mockFinance(page, options = {}) {
  const access = options.access ?? 'finance';
  const viewer = {
    id: 'finance-viewer',
    name: 'Pessoa financeira',
    email: 'finance@example.test',
    functionName: access === 'finance' ? 'Financeiro' : 'Vendedor',
    capabilities: access === 'admin' ? ['COMMERCIAL_ADMIN'] : [],
  };
  /** @type {Array<Record<string, any>>} */
  const rows = [
    {
      id: 'order-a',
      number: '41-CRM',
      clientName: 'Equipe Aurora',
      origin: 'atendimento',
      ownerName: 'Vendedora A',
      totalPieces: 12,
      finalAmountCents: 120000,
      paidOn: '2026-10-18',
      deliveryOn: '2026-10-29',
      version: 3,
      financeVersion: 0,
      completedAt: null,
      completedByName: null,
    },
    {
      id: 'order-b',
      number: '42-CRM',
      clientName: 'Projeto Horizonte',
      origin: 'loja',
      ownerName: null,
      totalPieces: 24,
      finalAmountCents: 240000,
      paidOn: '2026-10-19',
      deliveryOn: '2026-10-30',
      version: 1,
      financeVersion: 0,
      completedAt: null,
      completedByName: null,
    },
  ];
  /** @type {Map<string, Array<Record<string, any>>>} */
  const history = new Map(rows.map((row) => [row.id, []]));
  /** @type {string[]} */
  const calls = [];
  /** @type {Array<{path:string,body:any}>} */
  const writes = [];
  let conflict = Boolean(options.conflict);
  let listError = Boolean(options.listError);
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 'test-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  const detail = (/** @type {Record<string, any>} */ row) => ({
    ...row,
    items: [
      {
        tipo: 'Camiseta',
        cor: 'Azul',
        grade: [{ tamanho: 'M', quantidade: row.totalPieces }],
        malhas: ['Algodão'],
        tipo_servico: 'Serigrafia',
      },
    ],
    history: history.get(row.id),
    canManage:
      viewer.functionName === 'Financeiro' && !viewer.capabilities.length,
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(url.pathname);
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/v1/sessions/current')
      return json({ user: viewer });
    if (url.pathname === '/api/v1/events' && options.financeOnEvent) {
      viewer.functionName = 'Financeiro';
      viewer.capabilities = [];
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `retry: 60000\n\nevent: identity.user.changed\nid: evt-finance\ndata: {"userId":"${viewer.id}"}\n\n`,
      });
    }
    if (url.pathname === '/api/v1/events')
      return route.fulfill({ status: 204 });
    if (url.pathname === '/api/v1/orders/summary')
      return json({ storeNewCount: 0 });
    if (url.pathname === '/api/v1/finance/orders') {
      if (listError) return json({ code: 'UNAVAILABLE' }, 503);
      const completed = url.searchParams.get('status') === 'completed';
      return json({
        items: rows.filter((row) => Boolean(row.completedAt) === completed),
        counts: {
          waiting: rows.filter((row) => !row.completedAt).length,
          completed: rows.filter((row) => row.completedAt).length,
        },
        nextCursor: null,
      });
    }
    const target = rows.find(
      (row) =>
        url.pathname === `/api/v1/finance/orders/${row.id}` ||
        url.pathname.startsWith(`/api/v1/finance/orders/${row.id}/`),
    );
    if (target && req.method() === 'GET')
      return json({ order: detail(target) });
    if (target && req.method() === 'POST') {
      const body = req.postDataJSON();
      writes.push({ path: url.pathname, body });
      expect(req.headers()['idempotency-key']).toBeTruthy();
      expect(req.headers()['x-csrf-token']).toBe('test-csrf');
      if (conflict) {
        conflict = false;
        target.version += 1;
        return json({ code: 'ORDER_VERSION_CONFLICT' }, 409);
      }
      expect(body).toMatchObject({
        expectedVersion: target.version,
        expectedFinanceVersion: target.financeVersion,
      });
      target.financeVersion += 1;
      const complete = url.pathname.endsWith('/complete');
      target.completedAt = complete ? '2026-10-22T12:30:00.000Z' : null;
      target.completedByName = complete ? viewer.name : null;
      history.get(target.id)?.push({
        id: `event-${target.financeVersion}`,
        action: complete ? 'completed' : 'reopened',
        actorName: viewer.name,
        occurredAt: '2026-10-22T12:30:00.000Z',
      });
      return json({ order: detail(target) });
    }
    return json({}, 404);
  });
  return {
    calls,
    writes,
    rows,
    recoverList() {
      listError = false;
    },
    setAdministrator() {
      viewer.functionName = 'Vendedor';
      viewer.capabilities = ['COMMERCIAL_ADMIN'];
    },
  };
}

test('Financeiro opens its own panel, checks and undoes without commercial requests', async ({
  page,
}) => {
  const mock = await mockFinance(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/financeiro$/u);
  await expect(
    page.getByRole('heading', { name: 'Financeiro', exact: true }),
  ).toBeFocused();
  const nav = page.getByRole('navigation', {
    name: 'Navegação principal',
    exact: true,
  });
  await expect(nav.getByRole('link')).toHaveCount(2);
  await expect(nav.getByRole('link', { name: 'Minha conta' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Aguardando 2', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Atualizar', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Aguardando 2', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Concluídos 0', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Equipe Aurora', exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath('finance-desktop.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Marcar nota criada', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Aguardando 1', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Conferir 42-CRM, Projeto Horizonte' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Desfazer', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Aguardando 2', exact: true }),
  ).toBeVisible();
  expect(mock.writes.map((write) => write.path)).toEqual([
    '/api/v1/finance/orders/order-a/complete',
    '/api/v1/finance/orders/order-a/reopen',
  ]);
  expect(
    mock.calls.some(
      (path) =>
        path === '/api/v1/events' ||
        path.startsWith('/api/v1/orders') ||
        path.startsWith('/api/v1/conversations'),
    ),
  ).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('administrator retains full navigation and only consults Financeiro', async ({
  page,
}) => {
  const mock = await mockFinance(page, { access: 'admin' });
  await page.goto('/financeiro');
  await expect(
    page.getByRole('heading', { name: 'Financeiro', exact: true }),
  ).toBeVisible();
  const nav = page.getByRole('navigation', {
    name: 'Navegação principal',
    exact: true,
  });
  for (const name of [
    'Dashboard',
    'Caixa de Entrada',
    'Pedidos',
    'Clientes',
    'Financeiro',
    'Usuários',
    'Conta',
  ])
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' })
    .click();
  await expect(
    page.getByText('Consulta do administrador', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Voltar para aguardando', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('finance-admin-desktop.png'),
    fullPage: true,
  });
  expect(mock.writes).toHaveLength(0);
});

test('Financeiro cannot open commercial or user management routes', async ({
  page,
}) => {
  const mock = await mockFinance(page);
  for (const path of [
    '/usuarios',
    '/inbox',
    '/pedidos',
    '/clientes',
    '/dashboard',
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/financeiro$/u);
    await expect(
      page.getByRole('button', { name: 'Aguardando 2', exact: true }),
    ).toBeVisible();
  }
  expect(
    mock.calls.some(
      (path) =>
        path === '/api/v1/users' ||
        path === '/api/v1/events' ||
        path.startsWith('/api/v1/orders') ||
        path.startsWith('/api/v1/conversations'),
    ),
  ).toBe(false);
});

test('seller has no Financeiro navigation or direct access', async ({
  page,
}) => {
  const mock = await mockFinance(page, { access: 'seller' });
  await page.goto('/financeiro');
  await expect(page).toHaveURL(/\/dashboard$/u);
  const nav = page.getByRole('navigation', {
    name: 'Navegação principal',
    exact: true,
  });
  await expect(
    nav.getByRole('link', { name: 'Financeiro', exact: true }),
  ).toHaveCount(0);
  expect(mock.calls.some((path) => path.startsWith('/api/v1/finance/'))).toBe(
    false,
  );
});

test('Financeiro session refresh applies administrator consultation and full menu', async ({
  page,
}) => {
  await page.clock.install();
  const mock = await mockFinance(page);
  await page.goto('/financeiro');
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toBeVisible();
  mock.setAdministrator();
  await page.clock.fastForward(30_000);
  await expect(
    page.getByText('Consulta do administrador', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Navegação principal', exact: true })
      .getByRole('link', { name: 'Usuários', exact: true }),
  ).toBeVisible();
});

test('switching a commercial session to Financeiro closes the Inbox event stream', async ({
  page,
}) => {
  await page.clock.install();
  const mock = await mockFinance(page, {
    access: 'admin',
    financeOnEvent: true,
  });
  await page.goto('/financeiro');
  await expect(
    page
      .getByRole('navigation', { name: 'Navegação principal', exact: true })
      .getByRole('link'),
  ).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(65_000);
  expect(mock.calls.filter((path) => path === '/api/v1/events')).toHaveLength(
    1,
  );
});

test('conflict blocks another command until the queue is refreshed', async ({
  page,
}) => {
  const mock = await mockFinance(page, { conflict: true });
  await page.goto('/financeiro');
  await page
    .getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' })
    .click();
  await page
    .getByRole('button', { name: 'Marcar nota criada', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('O pedido mudou');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Atualizar fila', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Marcar nota criada', exact: true })
    .click();
  expect(mock.writes).toHaveLength(2);
  expect(mock.writes[1].body.expectedVersion).toBe(4);
});

test('a failed list is not represented by zero and can recover', async ({
  page,
}) => {
  const mock = await mockFinance(page, { listError: true });
  await page.goto('/financeiro');
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível carregar a fila',
  );
  await expect(
    page.getByRole('button', { name: 'Aguardando —', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Nenhum pedido aguardando', { exact: true }),
  ).toHaveCount(0);
  mock.recoverList();
  await page
    .getByRole('button', { name: 'Tentar novamente', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Aguardando 2', exact: true }),
  ).toBeVisible();
});

test('mobile Financeiro preserves the CRM shell, detail navigation and themes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFinance(page);
  await page.goto('/financeiro');
  await expect(
    page.getByRole('button', { name: 'Aguardando 2', exact: true }),
  ).toBeVisible();
  const mobile = page.getByRole('navigation', {
    name: 'Navegação móvel',
    exact: true,
  });
  await expect(mobile.getByRole('link')).toHaveCount(2);
  await expect(
    mobile.getByRole('button', { name: 'Mais', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Equipe Aurora', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Marcar nota criada', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath('finance-mobile-light.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Equipe Aurora', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Voltar à fila', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' }),
  ).toBeFocused();
  await page.evaluate(() => {
    globalThis.localStorage.setItem('silmer-theme', 'dark');
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Conferir 41-CRM, Equipe Aurora' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('heading', { name: 'Equipe Aurora', exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath('finance-mobile-dark.png'),
    fullPage: true,
  });
});
