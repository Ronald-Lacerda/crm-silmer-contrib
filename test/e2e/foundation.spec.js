import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('renders the semantic foundation without critical accessibility violations', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page).toHaveTitle('CRM Silmer');
  await expect(
    page.getByRole('heading', { level: 1, name: 'CRM Silmer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entrar com segurança' }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('keeps the status announcement and document language available', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(page.getByRole('status')).toHaveText('Entre para continuar.');
});

test('uses the light theme by default, even when the system is dark', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  // RFC 022: the canvas derives from the brand ink (5% over white), so the
  // light page paints that near-white tint even under a dark system
  // preference. Chromium serializes the mix as `color(srgb …)`.
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    /^color\(srgb 0\.95\d* 0\.95\d* 0\.95\d*\)$/u,
  );
});

test('applies a saved dark theme before the application bundle loads', async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('silmer-theme', 'dark');
  });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});

test('ignores the retired system preference and defaults to light', async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('silmer-theme', 'system');
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('shows a seller account without exposing capabilities', async ({
  page,
}) => {
  await page.route('**/api/v1/sessions/current', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          capabilities: [],
          email: 'vendedora@example.test',
          functionName: 'Vendedor',
          id: 'seller-1',
          name: 'Vendedora Silmer',
        },
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Conta' }).click();

  await expect(
    page.getByRole('heading', { name: 'Conta e segurança' }),
  ).toBeFocused();
  await expect(page.getByRole('definition')).toHaveText([
    'Vendedora Silmer',
    'vendedora@example.test',
    'Vendedor',
  ]);
  await expect(page.locator('.account-facts dt')).toHaveText([
    'Nome',
    'E-mail',
    'Função',
  ]);
  await expect(page.locator('.sidebar-account')).toContainText(
    'Vendedora Silmer',
  );
  await expect(page.locator('.sidebar-account')).toContainText(
    'vendedora@example.test',
  );
});

test('offers only the login form, with no invitation path', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Boas-vindas de volta',
  );
  await expect(page.getByLabel('E-mail')).toBeVisible();
  await expect(page.getByLabel('Senha')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entrar com segurança' }),
  ).toBeVisible();

  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByText(/convite/iu)).toHaveCount(0);
  // No minimum-length rule is advertised or enforced by the markup.
  await expect(page.getByLabel('Senha')).not.toHaveAttribute('minlength', /./u);
});

test('distinguishes session service failure from a signed-out session', async ({
  page,
}) => {
  let available = false;
  let signedOutStatus = 400;
  await page.route('**/api/v1/sessions/current', async (route) => {
    await route.fulfill({
      contentType: 'application/problem+json',
      status: available ? signedOutStatus : 503,
      body: JSON.stringify({
        code: available ? 'INVALID_CRM_SESSION' : 'UNAVAILABLE',
      }),
    });
  });

  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: 'Não foi possível verificar sua sessão',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entrar com segurança' }),
  ).toHaveCount(0);

  available = true;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(
    page.getByRole('button', { name: 'Entrar com segurança' }),
  ).toBeVisible();

  signedOutStatus = 403;
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Entrar com segurança' }),
  ).toBeVisible();
});

test('returns a real 404 for a missing compiled asset', async ({ request }) => {
  const response = await request.get('/assets/inexistente.js');
  expect(response.status()).toBe(404);
});

test('submits login, restores and closes a session by keyboard without browser storage', async ({
  page,
}) => {
  let authenticated = false;
  let loginAttempts = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/api/v1/sessions/current' && method === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        status: authenticated ? 200 : 401,
        body: authenticated
          ? JSON.stringify({
              user: {
                capabilities: ['COMMERCIAL_ADMIN'],
                functionName: 'Vendedor',
                name: 'Admin Comercial',
                email: 'admin@example.test',
                id: 'admin-1',
              },
            })
          : JSON.stringify({ error: { code: 'INVALID_CREDENTIALS' } }),
      });
      return;
    }

    if (path === '/api/v1/sessions' && method === 'POST') {
      loginAttempts += 1;
      if (loginAttempts === 1) {
        await route.fulfill({
          contentType: 'application/json',
          status: 401,
          body: JSON.stringify({
            error: { code: 'INVALID_CREDENTIALS' },
          }),
        });
        return;
      }
      authenticated = true;
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({
          user: {
            capabilities: ['COMMERCIAL_ADMIN'],
            functionName: 'Vendedor',
            name: 'Admin Comercial',
            email: 'admin@example.test',
            id: 'admin-1',
          },
        }),
      });
      return;
    }

    if (path === '/api/v1/sessions/current' && method === 'DELETE') {
      authenticated = false;
      await route.fulfill({ status: 204 });
      return;
    }

    if (path === '/api/v1/kanban' && method === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ eventCursor: 'evt-1', columns: [] }),
      });
      return;
    }

    if (path === '/api/v1/inbox/conversations' && method === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null, totalCount: 0 }),
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
    if (path === '/api/v1/inbox/summary' && method === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
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
      });
      return;
    }

    if (path === '/api/v1/orders/summary' && method === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          confirmedCount: 0,
          soldAmountCents: 0,
          averageTicketCents: 0,
          pendingCount: 0,
          totalPiecesSold: 0,
        }),
      });
      return;
    }

    if (path === '/api/v1/events' && method === 'GET') {
      await route.fulfill({ status: 204 });
      return;
    }

    await route.abort();
  });

  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Entre para continuar.');

  const loginPanel = page.getByRole('region', {
    name: 'Boas-vindas de volta',
  });
  await loginPanel.getByLabel('E-mail').fill('admin@example.test');
  await loginPanel.getByLabel('Senha').fill('wrong password value');
  await loginPanel.getByLabel('Senha').press('Enter');
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(
    'Não foi possível entrar com os dados informados.',
  );
  await expect(alert).toBeFocused();

  await loginPanel.getByLabel('Senha').fill('correct horse battery staple');
  await loginPanel.getByLabel('Senha').press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();
  // The Dashboard may still show its own "Carregando indicadores…" status
  // while the shell announces the session.
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Sessão iniciada com segurança.' }),
  ).toHaveCount(1);

  await page.getByRole('link', { name: 'Conta' }).click();
  await expect(
    page.getByRole('heading', { name: 'Conta e segurança' }),
  ).toBeFocused();
  await expect(page.getByRole('definition')).toHaveText([
    'Admin Comercial',
    'admin@example.test',
    'Administrador',
  ]);
  await expect(page.locator('.account-facts dt')).toHaveText([
    'Nome',
    'E-mail',
    'Função',
  ]);

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Claro' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Escuro' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Escuro' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Sistema' })).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sessão restaurada.' }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Sair' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Sessão encerrada.');
  await expect(
    page.getByRole('heading', { name: 'Boas-vindas de volta' }),
  ).toBeFocused();
  await page.evaluate(() => globalThis.localStorage.removeItem('silmer-theme'));
  await expect(
    page.evaluate(() => ({
      local: globalThis.localStorage.length,
      session: globalThis.sessionStorage.length,
    })),
  ).resolves.toEqual({ local: 0, session: 0 });
});

test('keeps Pedidos in the menu after Caixa de Entrada, active across its pages', async ({
  page,
}) => {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/sessions/current') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            capabilities: ['COMMERCIAL_ADMIN'],
            email: 'admin@example.test',
            functionName: 'Vendedor',
            id: 'admin-1',
            name: 'Admin Comercial',
          },
        }),
      });
      return;
    }
    if (path === '/api/v1/events') {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        counts: { confirmado: 0, pendente: 0 },
        items: [],
        nextCursor: null,
        order: null,
      }),
    });
  });

  await page.goto('/pedidos');

  const sidebar = page.getByRole('navigation', { name: 'Navegação principal' });
  await expect(sidebar.getByRole('link')).toHaveText([
    'Dashboard',
    'Caixa de Entrada',
    'Pedidos',
    'Clientes',
    'Financeiro',
    'Melhor Envio',
    'Usuários',
    'Conta',
  ]);
  await expect(sidebar.getByRole('link', { name: 'Pedidos' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.topbar-title')).toHaveText('Pedidos');

  await page.setViewportSize({ height: 800, width: 480 });
  // Mobile-first: the four daily places live in a bottom bar under the
  // thumb, and "Mais" opens the rest, admin and exit included.
  const mobile = page.getByRole('navigation', { name: 'Navegação móvel' });
  for (const name of ['Início', 'Caixa de Entrada', 'Pedidos', 'Clientes']) {
    await expect(mobile.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(
    mobile.getByRole('link', { name: 'Pedidos', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const more = mobile.getByRole('button', { name: 'Mais' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  const sheet = page.getByRole('region', { name: 'Mais opções' });
  await expect(sheet.getByRole('link')).toHaveText([
    'Financeiro',
    'Melhor Envio',
    'Usuários',
    'Conta',
  ]);
  await expect(sheet.getByRole('button', { name: 'Sair' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Escuro' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await page.setViewportSize({ height: 900, width: 1280 });
  // PGE-01: the order page belongs to Pedidos, so the menu item stays lit on
  // a route the link does not match exactly.
  await page.goto('/pedidos/order-1');
  await expect(sidebar.getByRole('link', { name: 'Pedidos' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    sidebar.getByRole('link', { name: 'Clientes' }),
  ).not.toHaveAttribute('aria-current', /./u);
});
