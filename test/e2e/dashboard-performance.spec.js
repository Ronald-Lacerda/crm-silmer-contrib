import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel, performanceSummary } from './support/painel-mock.js';

// ACT-T04: "Seu resultado" is text without controls (7 days); the period
// choice and its race protection live on "Desempenho da equipe".

test('own performance failure is unknown, never zero, and leaves actions usable', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  let failing = true;
  await page.route('**/api/v1/dashboard/performance?days=7', (route) =>
    failing
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        })
      : route.fallback(),
  );
  await page.goto('/dashboard');
  const performance = page.getByRole('region', { name: 'Seu resultado' });
  await expect(performance.getByRole('alert')).toContainText(
    'Não foi possível consultar suas vendas agora.',
  );
  await expect(performance.locator('dd').first()).toHaveText('—');
  await expect(performance).not.toContainText('R$ 0,00');
  await expect(performance).toContainText('5 min');
  await expect(performance.getByRole('combobox')).toHaveCount(0);
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Cliente Sintético', exact: true })
    .click();
  await expect(
    actions.getByRole('link', { name: 'Abrir conversa para responder' }),
  ).toBeVisible();
  failing = false;
  await performance
    .getByRole('button', { name: 'Atualizar resultado', exact: true })
    .click();
  await expect(performance).toContainText('R$ 8.400,00');
  await expect(performance.getByRole('alert')).toHaveCount(0);
  await expect(
    performance.getByRole('heading', { name: 'Seu resultado' }),
  ).toBeFocused();
});

test('an older team response cannot replace a newer selected period', async ({
  page,
}) => {
  await mockPainel(page);
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
          ...performanceSummary(true, 30),
          totals: { soldAmountCents: 9900000, confirmedCount: 90 },
        }),
      })
      .catch(() => {});
  });
  await page.goto('/dashboard/equipe');
  const totals = page.getByRole('region', { name: 'Totais da equipe' });
  await expect(totals).toContainText('R$ 16.400,00');
  const period = page.getByRole('group', { name: 'Período' });
  await period.getByRole('button', { name: '30 dias' }).click();
  await pending;
  const newest = page.waitForResponse((response) =>
    response.url().endsWith('/dashboard/performance?days=7'),
  );
  await period.getByRole('button', { name: '7 dias' }).click();
  await newest;
  release();
  await expect(period.getByRole('button', { name: '7 dias' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(totals).toContainText('R$ 16.400,00');
  await expect(page.getByText('99.000')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a failed read on the team page stays in its region with retry and a dash', async ({
  page,
}) => {
  await mockPainel(page);
  let failing = true;
  await page.route('**/api/v1/dashboard/metrics/losses?days=7', (route) =>
    failing
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE' }),
        })
      : route.fallback(),
  );
  await page.goto('/dashboard/equipe');
  const reasons = page.getByRole('region', { name: 'Por que perdemos' });
  await expect(reasons.getByRole('alert')).toContainText(
    'Não foi possível consultar as perdas agora.',
  );
  const totals = page.getByRole('region', { name: 'Totais da equipe' });
  await expect(totals).toContainText('Leads perdidos — Indisponível agora');
  // The sales view did not fail: its table stays readable.
  const table = page.getByRole('region', { name: 'Por vendedor' });
  await expect(table.getByRole('alert')).toHaveCount(0);
  await expect(table).toContainText('R$ 8.400,00');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  failing = false;
  await reasons
    .getByRole('button', { name: 'Atualizar perdas', exact: true })
    .click();
  await expect(reasons).toContainText('5 leads marcados como perdidos');
  await expect(reasons).toContainText('Preço');
  await expect(
    reasons.getByRole('heading', { name: 'Por que perdemos' }),
  ).toBeFocused();
});
