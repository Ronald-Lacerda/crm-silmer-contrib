import { expect, test } from '@playwright/test';
import { mockPainel, performanceSummary } from './support/painel-mock.js';

test('performance failure preserves the last valid period and leaves actions usable', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  await page.route('**/api/v1/dashboard/performance?days=30', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'UNAVAILABLE' }),
    }),
  );
  await page.goto('/dashboard');
  const performance = page.getByRole('region', { name: 'Seu resultado' });
  await expect(performance).toContainText('R$ 8.400,00');
  await performance
    .getByRole('combobox', { name: 'Período do desempenho' })
    .selectOption('30');
  await expect(performance.getByRole('alert')).toContainText(
    'Os dados exibidos podem estar desatualizados.',
  );
  await expect(performance).toContainText('Última consulta válida: 7 dias.');
  await expect(performance).toContainText('R$ 8.400,00');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Cliente Sintético', exact: true })
    .click();
  await expect(
    actions.getByRole('link', { name: 'Abrir conversa para responder' }),
  ).toBeVisible();
});

test('an older performance response cannot replace a newer selected period', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  let release = () => {};
  let arrived = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(null);
  });
  const pending = new Promise((resolve) => {
    arrived = () => resolve(null);
  });
  await page.route('**/api/v1/dashboard/performance?days=30', async (route) => {
    arrived();
    await gate;
    await route
      .fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...performanceSummary(false, 30),
          rows: [
            {
              ...performanceSummary(false, 30).rows[0],
              soldAmountCents: 9900000,
            },
          ],
        }),
      })
      .catch(() => {});
  });
  await page.goto('/dashboard');
  const performance = page.getByRole('region', { name: 'Seu resultado' });
  await expect(performance).toContainText('R$ 8.400,00');
  const period = performance.getByRole('combobox', {
    name: 'Período do desempenho',
  });
  await period.selectOption('30');
  await pending;
  const newest = page.waitForResponse((response) =>
    response.url().endsWith('/dashboard/performance?days=7'),
  );
  await period.selectOption('7');
  await newest;
  release();
  await expect(period).toHaveValue('7');
  await expect(performance).toContainText('R$ 8.400,00');
  await expect(performance).not.toContainText('99.000');
  await expect(performance.getByRole('alert')).toHaveCount(0);
});
