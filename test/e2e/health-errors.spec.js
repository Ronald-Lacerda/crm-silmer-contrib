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
  activeCount: 1,
  activeFirstSeenAt: '2026-11-02T12:00:00.000Z',
  activeLastSeenAt: '2026-11-02T15:00:00.000Z',
  firstSeenAt: '2026-11-02T12:00:00.000Z',
  lastSeenAt: '2026-11-02T15:00:00.000Z',
  version: 1,
  requestId: '742351d6-a4b4-42e9-b3f8-8d84a8e002a8',
  history: [],
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{viewer?: Record<string,any>, empty?: boolean, unavailable?: boolean, conflict?: boolean, collectionPending?: boolean, delay?: Promise<unknown>, identityEvent?: Promise<unknown>, legacy?: boolean, archiveConflict?: boolean, archiveRefreshFailure?: boolean, operational?:{status:number,body:any}, operationalDelay?:Promise<unknown>}} [options]
 */
async function setup(page, options = {}) {
  await mockPainel(page);
  const viewer = { ...designatedAdmin, ...options.viewer };
  const item = structuredClone(occurrence);
  if (options.legacy)
    Object.assign(item, {
      status: 'investigating',
      occurrences: 13,
      activeCount: 13,
    });
  const worker = {
    ...structuredClone(occurrence),
    id: 'incident-worker-synthetic',
    source: 'worker',
    code: 'WORKER_OUTCOME_UNKNOWN',
    occurrences: 14,
    activeCount: 12,
    status: 'investigating',
    activeFirstSeenAt: /** @type {string|null} */ (
      occurrence.activeFirstSeenAt
    ),
    activeLastSeenAt: /** @type {string|null} */ (occurrence.activeLastSeenAt),
  };
  /** @type {string[]} */
  const reads = [];
  /** @type {Record<string,any>[]} */
  const writes = [];
  /** @type {Record<string,any>[]} */
  const archives = [];
  /** @type {string[]} */
  const views = [];
  let legacyCount = options.legacy ? 12 : 0;
  let unavailable = options.unavailable ?? false;
  let denied = 0;
  let healthResponse = options.operational;
  /** @type {string[]} */
  const operationalReads = [];
  await page.route('**/api/health/operations', async (route) => {
    operationalReads.push('read');
    await options.operationalDelay;
    return route.fulfill({
      status: healthResponse?.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(
        healthResponse?.body ?? {
          status: 'ok',
          checkedAt: new Date().toISOString(),
          checks: { worker: 'ok', queue: 'ok', commands: 'ok' },
        },
      ),
    });
  });
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
    const view = new URL(req.url()).searchParams.get('view') ?? 'active';
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(body),
        status,
      });
    if (req.method() === 'POST') {
      expect(new URL(req.url()).pathname).toBe(
        '/api/v1/admin/health-errors/legacy/archive',
      );
      expect(req.headers()['idempotency-key']).toBeTruthy();
      expect(req.headers()['x-csrf-token']).toBe('synthetic-csrf');
      const body = req.postDataJSON();
      archives.push(body);
      if (options.archiveConflict)
        return json({ error: { code: 'VERSION_CONFLICT' } }, 409);
      expect(body).toEqual({
        count: 12,
        fingerprint: 'legacy-synthetic-fingerprint',
      });
      legacyCount = 0;
      // The worker job and n8n command represent the same remaining Evolution operation.
      worker.activeCount = 1;
      item.activeCount = 1;
      if (options.archiveRefreshFailure) unavailable = true;
      return json({
        archivedCount: 12,
        archivedAt: '2026-11-03T15:00:00.000Z',
      });
    }
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
    views.push(view);
    await options.delay;
    if (denied) return json({ error: { code: 'FORBIDDEN' } }, denied);
    if (unavailable)
      return json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
    const allItems = options.empty
      ? []
      : options.legacy
        ? [worker, item]
        : [item];
    const currentItems = allItems.filter(
      (candidate) => candidate.activeCount > 0,
    );
    const countStatuses = (/** @type {typeof allItems} */ candidates) =>
      Object.fromEntries(
        ['new', 'investigating', 'resolved'].map((state) => [
          state,
          candidates.filter((candidate) => candidate.status === state).length,
        ]),
      );
    return json({
      items: (view === 'active' ? currentItems : allItems).filter(
        (candidate) => status === 'all' || candidate.status === status,
      ),
      activeSummary: countStatuses(currentItems),
      legacyArchive: {
        count: legacyCount,
        fingerprint: legacyCount ? 'legacy-synthetic-fingerprint' : null,
      },
      summary: {
        new: !options.empty && item.status === 'new' ? 1 : 0,
        investigating: item.status === 'investigating' ? allItems.length : 0,
        resolved: item.status === 'resolved' ? 1 : 0,
      },
      checkedAt: '2026-11-02T15:05:00.000Z',
      collectionPending: options.collectionPending ?? false,
    });
  });
  return {
    operationalReads,
    setOperational(/** @type {{status:number,body:any}} */ response) {
      healthResponse = response;
    },
    reads,
    writes,
    archives,
    views,
    viewer,
    recover() {
      unavailable = false;
    },
    fail() {
      unavailable = true;
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
      viewer.functionName === 'Financeiro' ? '/conta' : '/dashboard',
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

test('OPS-INBOX-ACK-04: review and archive only the 12 WAHA pendencies by keyboard, preserving uncertain history', async ({
  page,
}) => {
  const mock = await setup(page, { legacy: true });
  await page.goto('/saude-erros');
  await expect(
    page.getByRole('combobox', { name: 'Consulta', exact: true }),
  ).toHaveValue('active');
  const archive = page.getByRole('button', {
    name: 'Arquivar pendências do WAHA (12)',
    exact: true,
  });
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'Revisar arquivamento de 12 pendências',
    }),
  ).toBeFocused();
  await expect(
    page.getByText(/Isso não marca envios como resolvidos/u),
  ).toBeVisible();
  expect(mock.archives).toEqual([]);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(archive).toBeFocused();
  await page.keyboard.press('Enter');
  const accessibility = await new AxeBuilder({ page })
    .include('#main-content')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', {
      name: 'Confirmar arquivamento (12)',
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Ocorrências', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('article')).toHaveCount(2);
  const evolution = page.getByRole('article', {
    name: 'Resultado do envio desconhecido',
  });
  await expect(evolution.locator('.health-error-status')).toHaveText(
    'Em análise',
  );
  await expect(evolution.locator('.health-error-facts')).toContainText(
    'Pendências atuais1',
  );
  await expect(
    page
      .getByRole('article', { name: 'Resultado de tarefa desconhecido' })
      .locator('.health-error-facts'),
  ).toContainText('Pendências atuais1');
  await expect(
    page.getByText(
      /A mesma operação pode aparecer em Processamento e Automação n8n/u,
    ),
  ).toBeHidden();
  await page
    .getByText('Como interpretar as ocorrências', { exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(
      /A mesma operação pode aparecer em Processamento e Automação n8n/u,
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '12 pendências do WAHA arquivadas' }),
  ).toContainText('resultado incerto foram preservados');
  expect(mock.archives).toHaveLength(1);
  expect(mock.writes).toEqual([]);
  await page
    .getByRole('combobox', { name: 'Consulta', exact: true })
    .selectOption('history');
  await expect(page.getByRole('article')).toHaveCount(2);
  const workerCard = page.getByRole('article', {
    name: 'Resultado de tarefa desconhecido',
  });
  await expect(workerCard.locator('.health-error-facts')).toContainText(
    'Ocorrências históricas (14 dias)14',
  );
  await expect(workerCard.locator('.health-error-facts')).toContainText(
    'Pendências atuais1',
  );
  await expect(evolution.locator('.health-error-facts')).toContainText(
    'Ocorrências históricas (14 dias)13',
  );
  await expect(
    page.locator('.health-error-status').filter({ hasText: 'Resolvido' }),
  ).toHaveCount(0);
  expect(mock.views).toEqual(['active', 'active', 'history']);
});

test('archive conflict preserves the current list and requires a fresh review', async ({
  page,
}) => {
  const mock = await setup(page, { legacy: true, archiveConflict: true });
  await page.goto('/saude-erros');
  const archive = page.getByRole('button', {
    name: 'Arquivar pendências do WAHA (12)',
    exact: true,
  });
  await archive.click();
  await page
    .getByRole('button', { name: 'Confirmar arquivamento (12)', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'As pendências do WAHA mudaram',
  );
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(archive).toHaveAttribute('aria-disabled', 'true');
  await archive.click({ force: true });
  expect(mock.archives).toHaveLength(1);
  expect(mock.writes).toEqual([]);
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(archive).not.toHaveAttribute('aria-disabled', 'true');
  await expect(
    page.getByRole('button', {
      name: 'Confirmar arquivamento (12)',
      exact: true,
    }),
  ).toHaveCount(0);
});

test('a failed read after archive keeps the last snapshot and prevents a duplicate archive', async ({
  page,
}) => {
  const mock = await setup(page, { legacy: true, archiveRefreshFailure: true });
  await page.goto('/saude-erros');
  const archive = page.getByRole('button', {
    name: 'Arquivar pendências do WAHA (12)',
    exact: true,
  });
  await archive.click();
  await page
    .getByRole('button', { name: 'Confirmar arquivamento (12)', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'última consulta bem-sucedida',
  );
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(archive).toHaveAttribute('aria-disabled', 'true');
  await archive.click({ force: true });
  expect(mock.archives).toHaveLength(1);
  expect(mock.writes).toEqual([]);
  mock.recover();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(archive).toHaveCount(0);
});

test('a failed history query preserves the active view label and counts', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/saude-erros');
  await expect(page.getByRole('article')).toHaveCount(1);
  mock.fail();
  await page
    .getByRole('combobox', { name: 'Consulta', exact: true })
    .selectOption('history');
  await expect(page.getByRole('alert')).toContainText(
    'última consulta bem-sucedida',
  );
  await expect(
    page.getByRole('heading', { name: 'Grupos com pendências ativas' }),
  ).toBeVisible();
  await expect(page.locator('.health-error-facts')).toContainText(
    'Pendências atuais1',
  );
  expect(mock.views).toEqual(['active', 'history']);
});

test('OPSUI-01: summary reads only on entry and Atualizar, never on filters, treatment or elapsed time', async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  const mock = await setup(page);
  await page.goto('/saude-erros');
  const summary = page.getByRole('region', {
    name: 'Resumo operacional',
    exact: true,
  });
  await expect(summary).toContainText('Operação saudável');
  await expect(summary).toContainText('Atualização manual');
  await expect(summary).toContainText('Sem atraso');
  expect(mock.operationalReads).toHaveLength(1);
  await page
    .getByRole('combobox', { name: 'Estado', exact: true })
    .selectOption('new');
  await expect.poll(() => mock.reads.length).toBe(2);
  await page.getByRole('button', { name: 'Em análise', exact: true }).click();
  await expect.poll(() => mock.writes.length).toBe(1);
  await expect.poll(() => mock.reads.length).toBe(3);
  await page.clock.fastForward(180_000);
  expect(mock.operationalReads).toHaveLength(1);
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect.poll(() => mock.operationalReads.length).toBe(2);
});

test('OPSUI-02/03: degraded 503 is useful, network failure never preserves green and incidents remain available', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/saude-erros');
  const summary = page.getByRole('region', {
    name: 'Resumo operacional',
    exact: true,
  });
  await expect(summary).toContainText('Operação saudável');
  mock.setOperational({
    status: 503,
    body: {
      status: 'degraded',
      checkedAt: new Date().toISOString(),
      checks: { worker: 'ok', queue: 'degraded', commands: 'ok' },
    },
  });
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(summary).toContainText('Operação precisa de atenção');
  await expect(summary).toContainText('Atrasada');
  await expect(summary).toContainText('mais de 5 minutos');
  await expect(summary).toContainText('Ativo');
  await page.screenshot({
    path: 'var/health-summary-degraded.png',
    fullPage: true,
  });
  await page.route('**/api/health/operations', (route) =>
    route.abort('failed'),
  );
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(summary).toContainText('Saúde operacional indisponível');
  await expect(summary).not.toContainText('Operação saudável');
  await expect(page.getByRole('article')).toBeVisible();
  await page.getByRole('button', { name: 'Em análise', exact: true }).click();
  await expect(page.locator('.health-error-status')).toHaveText('Em análise');
  mock.deny();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(summary).toHaveCount(0);
});

test('OPSUI-03: leaving the page cancels the pending health read', async ({
  page,
}) => {
  await setup(page);
  let release = () => {};
  const pending = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route('**/api/health/operations', async (route) => {
    await pending;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          checkedAt: new Date().toISOString(),
          checks: { worker: 'ok', queue: 'ok', commands: 'ok' },
        }),
      })
      .catch(() => {});
  });
  const failed = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith('/api/health/operations'),
  );
  await page.goto('/saude-erros');
  await expect(page.getByRole('article')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Resumo operacional' }),
  ).toHaveAttribute('aria-busy', 'true');
  await page
    .getByRole('link', { name: 'Dashboard', exact: true })
    .first()
    .click();
  await failed;
  release();
  await expect(
    page.getByRole('region', { name: 'Resumo operacional' }),
  ).toHaveCount(0);
});

test('OPSUI-04: compact prototype fits mobile and desktop and preserves keyboard disclosure and axe', async ({
  page,
}) => {
  await setup(page, { empty: true });
  await page.goto('/saude-erros');
  await expect(
    page.getByRole('region', { name: 'Resumo operacional' }),
  ).toContainText('Operação saudável');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: 'var/health-summary-desktop.png',
    fullPage: true,
  });
  const disclosure = page.getByText('Sobre estes dados', { exact: true });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(/Pendências ativas e histórico dos últimos 14 dias/u),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'var/health-summary-mobile.png',
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .include('#main-content')
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
