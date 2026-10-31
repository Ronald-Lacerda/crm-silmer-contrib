import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { QUEUE, mockPainel, ordersSummary } from './support/painel-mock.js';

// RFC 024, proposta D (PNL-01 a PNL-03): o Painel diz o próximo passo do
// papel, o período declara que vale para Vendido e a falha da fila aparece
// com "—" e "Tentar novamente", sem esconder a seção. Dados sintéticos.

/** @param {import('@playwright/test').Page} page */
function nextStepRegion(page) {
  return page.getByRole('region', { name: 'Próximo passo' });
}

/** @param {import('@playwright/test').Page} page */
function sectionTitles(page) {
  return page.locator('#main-content').getByRole('heading', { level: 2 });
}

/** @param {import('@playwright/test').Page} page */
async function expectNoAxeViolations(page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** @param {import('@playwright/test').Page} page */
function visibleControls(page) {
  return page.locator('#main-content').locator('a:visible, button:visible');
}

/**
 * The queue answers 500 until `recover()` is called. Registered after
 * `mockPainel`, so it wins over the mock's own answer.
 *
 * @param {import('@playwright/test').Page} page
 */
async function failQueue(page) {
  let failing = true;
  let reads = 0;
  await page.route(
    (url) => url.pathname === '/api/v1/inbox/summary',
    (route) => {
      reads += 1;
      return route.fulfill({
        body: JSON.stringify(failing ? { error: { code: 'INTERNAL' } } : QUEUE),
        contentType: 'application/json',
        status: failing ? 500 : 200,
      });
    },
  );
  return {
    reads: () => reads,
    recover() {
      failing = false;
    },
  };
}

test('the seller sees one next step on the phone and opens it by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const mock = await mockPainel(page, { manager: false });
  await page.goto('/dashboard');

  const region = nextStepRegion(page);
  await expect(region.getByRole('link')).toHaveCount(1);
  const step = region.getByRole('link', { name: 'Responder 2 conversas' });
  await expect(step).toHaveAttribute('href', '/inbox?fila=minhas');
  // No heading of its own: the outline stays the two sections.
  await expect(region.getByRole('heading')).toHaveCount(0);
  await expect(sectionTitles(page)).toHaveText([
    'Minha fila',
    'Entregas',
    'Meus afazeres de entrega',
  ]);
  // One link more than the five indicators of the seller.
  await expect(visibleControls(page)).toHaveCount(6);
  expect((await step.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(
    () =>
      globalThis.document.documentElement.scrollWidth -
      globalThis.document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page);

  await step.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/inbox?fila=minhas');
  await expect
    .poll(() => mock.inboxLists.at(-1)?.get('assignedUserId') ?? null)
    .toBe('seller-1');
});

test('the manager starts from the SLA and the period says it is for Vendido', async ({
  page,
}) => {
  await page.setViewportSize({ height: 768, width: 1366 });
  await mockPainel(page);
  await page.goto('/dashboard');

  const region = nextStepRegion(page);
  await expect(region.getByRole('link')).toHaveCount(1);
  const step = region.getByRole('link', {
    name: 'Atender 1 conversa fora do prazo',
  });
  await expect(step).toHaveAttribute('href', '/inbox?situacao=aguardando');
  expect((await step.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(sectionTitles(page)).toHaveText([
    'Vendas e entregas',
    'Atendimento',
    'Meus afazeres de entrega',
  ]);
  // Three period buttons and seven indicators, plus the next step and the
  // way into the agent's performance (AGENTE-OBS-01).
  await expect(visibleControls(page)).toHaveCount(12);

  const periodGroup = page.getByRole('group', { name: 'Período das vendas' });
  await expect(periodGroup).toHaveAccessibleDescription('Vale para Vendido');
  await expect(page.getByText('Vale para Vendido')).toBeVisible();
  await expectNoAxeViolations(page);

  await step.click();
  await expect(page).toHaveURL('/inbox?situacao=aguardando');
});

test('with nothing pending the next step is calm text, without a link', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  await page.route(
    (url) => url.pathname === '/api/v1/inbox/summary',
    (route) =>
      route.fulfill({
        body: JSON.stringify({
          ...QUEUE,
          mine: { awaitingReplyCount: 0, count: 1, pendingOrderCount: 0 },
          waitingHandoff: { count: 0, oldestSince: null, overdueCount: 0 },
        }),
        contentType: 'application/json',
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/v1/orders/summary',
    (route) => {
      const summary = ordersSummary('hoje');
      return route.fulfill({
        body: JSON.stringify({
          ...summary,
          deliveries: { ...summary.deliveries, overdueCount: 0 },
        }),
        contentType: 'application/json',
      });
    },
  );
  await page.goto('/dashboard');

  const region = nextStepRegion(page);
  await expect(region).toContainText('Nada urgente agora.');
  await expect(region.getByRole('link')).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('a failing queue keeps Atendimento with dashes and retries by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockPainel(page);
  const queue = await failQueue(page);
  await page.goto('/dashboard');

  const attendance = page.getByRole('region', { name: 'Atendimento' });
  await expect(attendance).toBeVisible();
  await expect(attendance.getByRole('alert')).toContainText(
    'Não foi possível consultar a fila agora.',
  );
  const cards = attendance.locator('.metric-card');
  await expect(cards).toHaveCount(3);
  for (const value of await cards.locator('.metric-value').allTextContents()) {
    expect(value.trim()).toBe('—');
  }
  await expect(
    page.getByRole('link', { name: /^Esperando vendedor —/u }),
  ).toBeVisible();
  // The step skips the queue rules: the next one comes from the deliveries.
  await expect(
    nextStepRegion(page).getByRole('link', {
      name: 'Conferir 2 entregas atrasadas',
    }),
  ).toBeVisible();
  const retry = attendance.getByRole('button', { name: 'Tentar novamente' });
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectNoAxeViolations(page);

  // A second failure keeps the dashes and the focus on the retry.
  const readsBefore = queue.reads();
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => queue.reads()).toBeGreaterThan(readsBefore);
  await expect(retry).toBeFocused();
  await expect(cards.first().locator('.metric-value')).toHaveText('—');

  queue.recover();
  await page.keyboard.press('Enter');
  await expect(attendance.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /^Esperando vendedor 3/u }),
  ).toContainText('1 fora do prazo');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Atendimento' }),
  ).toBeFocused();
  await expect(
    nextStepRegion(page).getByRole('link', {
      name: 'Atender 1 conversa fora do prazo',
    }),
  ).toBeVisible();
});

test('the seller queue failure says the step could not be read', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  await failQueue(page);
  await page.route(
    (url) => url.pathname === '/api/v1/orders/summary',
    (route) => {
      const summary = ordersSummary('hoje');
      return route.fulfill({
        body: JSON.stringify({
          ...summary,
          deliveries: { ...summary.deliveries, overdueCount: 0 },
        }),
        contentType: 'application/json',
      });
    },
  );
  await page.goto('/dashboard');

  await expect(sectionTitles(page)).toHaveText([
    'Minha fila',
    'Entregas',
    'Meus afazeres de entrega',
  ]);
  const region = nextStepRegion(page);
  await expect(region).toContainText(
    'A fila não respondeu; tente de novo mais abaixo.',
  );
  await expect(region).not.toContainText('Nada urgente');
  await expect(region.getByRole('link')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /^Responder agora —/u }),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});
