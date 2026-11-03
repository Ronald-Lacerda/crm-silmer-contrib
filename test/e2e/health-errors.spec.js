import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel } from './support/painel-mock.js';

const designatedAdmin = {
  id: 'operator-synthetic',
  name: 'Operador Sintético',
  email: 'admin@crm-silmer.local',
  functionName: 'Vendedor',
  capabilities: ['COMMERCIAL_ADMIN'],
};
const occurrence = {
  id: 'incident-1234567890abcdef1234567890abcdef',
  source: 'n8n',
  code: 'N8N_OUTCOME_UNKNOWN',
  status: 'new',
  occurrences: 3,
  firstSeenAt: '2026-11-02T12:00:00.000Z',
  lastSeenAt: '2026-11-02T15:00:00.000Z',
  version: 1,
  requestId: '742351d6-a4b4-42e9-b3f8-8d84a8e002a8',
  history: [],
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{viewer?: Record<string,any>, empty?: boolean, unavailable?: boolean, conflict?: boolean, collectionPending?: boolean, delay?: Promise<unknown>, identityEvent?: Promise<unknown>}} [options]
 */
async function setup(page, options = {}) {
  await mockPainel(page);
  const viewer = { ...designatedAdmin, ...options.viewer };
  const item = structuredClone(occurrence);
  /** @type {string[]} */
  const reads = [];
  /** @type {Record<string,any>[]} */
  const writes = [];
  let unavailable = options.unavailable ?? false;
  let denied = 0;
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'synthetic-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/sessions/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: viewer }),
    }),
  );
  if (options.identityEvent) {
    await page.route('**/api/v1/events**', async (route) => {
      await options.identityEvent;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 60000\n\nevent: identity.user.changed\nid: evt-health\ndata: {"userId":"${viewer.id}"}\n\n`,
      });
    });
  }
  await page.route('**/api/v1/admin/health-errors**', async (route) => {
    const req = route.request();
    const status = new URL(req.url()).searchParams.get('status') ?? 'all';
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(body),
        status,
      });
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON();
      writes.push(body);
      expect(req.headers()['idempotency-key']).toBeTruthy();
      expect(req.headers()['x-csrf-token']).toBe('synthetic-csrf');
      expect(body.version).toBe(item.version);
      if (options.conflict) {
        item.version += 1;
        return json({ error: { code: 'INCIDENT_VERSION_CONFLICT' } }, 409);
      }
      item.status = body.status;
      item.version += 1;
      return json(item);
    }
    reads.push(status);
    await options.delay;
    if (denied) return json({ error: { code: 'FORBIDDEN' } }, denied);
    if (unavailable)
      return json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
    return json({
      items:
        options.empty || (status !== 'all' && status !== item.status)
          ? []
          : [item],
      summary: {
        new: !options.empty && item.status === 'new' ? 1 : 0,
        investigating: item.status === 'investigating' ? 1 : 0,
        resolved: item.status === 'resolved' ? 1 : 0,
      },
      checkedAt: '2026-11-02T15:05:00.000Z',
      collectionPending: options.collectionPending ?? false,
    });
  });
  return {
    reads,
    writes,
    viewer,
    recover() {
      unavailable = false;
    },
    deny(status = 403) {
      denied = status;
    },
  };
}

test('designated administrator opens Saúde e erros by keyboard and registers treatment', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/dashboard');
  const navigation = page.getByRole('navigation', {
    name: 'Navegação principal',
    exact: true,
  });
  const link = navigation.getByRole('link', {
    name: 'Saúde e erros',
    exact: true,
  });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/saude-erros');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Saúde e erros' }),
  ).toBeFocused();
  const card = page.getByRole('article', {
    name: 'Resultado do envio desconhecido',
  });
  await expect(card).toContainText('Automação n8n');
  await expect(card).toContainText('antes de qualquer nova tentativa');
  await expect(card).toContainText('02/11/2026, 12:00');
  const investigate = card.getByRole('button', {
    name: 'Em análise',
    exact: true,
  });
  await investigate.focus();
  await page.keyboard.press('Enter');
  await expect(card.locator('.health-error-status')).toHaveText('Em análise');
  await expect(
    page.getByRole('heading', { name: 'Ocorrências', exact: true }),
  ).toBeFocused();
  await card.getByRole('button', { name: 'Marcar resolvido' }).click();
  await expect(card.locator('.health-error-status')).toHaveText('Resolvido');
  await card.getByRole('button', { name: 'Reabrir' }).click();
  await expect(card.locator('.health-error-status')).toHaveText('Novo');
  expect(mock.writes.map((body) => body.status)).toEqual([
    'investigating',
    'resolved',
    'new',
  ]);
  const accessibility = await new AxeBuilder({ page })
    .include('#main-content')
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

for (const viewer of [
  { email: 'other@crm-silmer.local' },
  { capabilities: [] },
  { functionName: 'Financeiro', capabilities: [] },
  { kind: 'assistant' },
]) {
  test(`unapproved account cannot open the menu or fetch a deep link: ${JSON.stringify(viewer)}`, async ({
    page,
  }) => {
    const mock = await setup(page, { viewer });
    await page.goto('/saude-erros');
    await expect(page).toHaveURL(
      viewer.functionName === 'Financeiro' ? '/financeiro' : '/dashboard',
    );
    await expect(
      page.getByRole('link', { name: 'Saúde e erros', exact: true }),
    ).toHaveCount(0);
    expect(mock.reads).toEqual([]);
    expect(mock.writes).toEqual([]);
  });
}

test('mobile menu exposes the same restricted destination and fits the screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Mais', exact: true }).click();
  await page
    .getByRole('link', { name: 'Saúde e erros', exact: true })
    .last()
    .click();
  await expect(page).toHaveURL('/saude-erros');
  await expect(
    page.getByRole('article', { name: 'Resultado do envio desconhecido' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('failure does not become an empty list and a successful retry restores the occurrences', async ({
  page,
}) => {
  const mock = await setup(page, { unavailable: true });
  await page.goto('/saude-erros');
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível consultar',
  );
  await expect(page.getByText('Nenhuma ocorrência nesta consulta')).toHaveCount(
    0,
  );
  mock.recover();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'Resultado do envio desconhecido' }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Estado' }).selectOption('resolved');
  await expect(
    page.getByText('Nenhuma ocorrência nesta consulta'),
  ).toBeVisible();
  expect(mock.reads).toEqual(['all', 'all', 'resolved']);
});

test('authorization loss removes all previously read data', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/saude-erros');
  await expect(page.getByRole('article')).toBeVisible();
  mock.deny();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Acesso indisponível' }),
  ).toBeVisible();
  await expect(page.getByText('OUTCOME_UNKNOWN')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Marcar resolvido' }),
  ).toHaveCount(0);
});

test('conflict requires a fresh read before another treatment command', async ({
  page,
}) => {
  const mock = await setup(page, { conflict: true });
  await page.goto('/saude-erros');
  await page.getByRole('button', { name: 'Em análise', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Esta ocorrência mudou');
  await expect(page.getByRole('alert')).toBeFocused();
  const resolve = page.getByRole('button', { name: 'Marcar resolvido' });
  await expect(resolve).toHaveAttribute('aria-disabled', 'true');
  await resolve.click({ force: true });
  expect(mock.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(resolve).not.toHaveAttribute('aria-disabled', 'true');
});

test('loading is announced while the first consultation is pending', async ({
  page,
}) => {
  let release = () => {};
  const delay = new Promise(
    (/** @type {(value?: unknown)=>void} */ resolve) => {
      release = () => resolve();
    },
  );
  await setup(page, { delay });
  await page.goto('/saude-erros');
  await expect(
    page
      .getByRole('status', { name: '' })
      .filter({ hasText: 'Consultando ocorrências…' }),
  ).toBeVisible();
  release();
  await expect(page.getByRole('article')).toBeVisible();
});

test('partial collection is explicit and can continue with Atualizar', async ({
  page,
}) => {
  const mock = await setup(page, { collectionPending: true });
  await page.goto('/saude-erros');
  await expect(page.getByText(/Há mais registros para coletar/u)).toBeVisible();
  await expect(
    page.getByText(/as contagens ainda estão incompletas/u),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect.poll(() => mock.reads.length).toBe(2);
});

test('session change unmounts the console and removes the menu immediately', async ({
  page,
}) => {
  let change = () => {};
  const identityEvent = new Promise(
    (/** @type {(value?: unknown)=>void} */ resolve) => {
      change = () => resolve();
    },
  );
  const mock = await setup(page, { identityEvent });
  await page.goto('/saude-erros');
  await expect(page.getByRole('article')).toBeVisible();
  mock.viewer.email = 'other@crm-silmer.local';
  change();
  await expect(page).toHaveURL('/dashboard');
  await expect(
    page.getByRole('link', { name: 'Saúde e erros', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('OUTCOME_UNKNOWN')).toHaveCount(0);
  expect(mock.reads).toEqual(['all']);
});
