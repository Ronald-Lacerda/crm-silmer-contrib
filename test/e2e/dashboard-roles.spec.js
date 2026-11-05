import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel } from './support/painel-mock.js';

test('the manager reads reconciled human performance and keeps operational destinations', async ({
  page,
}) => {
  const mock = await mockPainel(page);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();
  const team = page.getByRole('region', { name: 'Desempenho da equipe' });
  await expect(team).toContainText('R$ 16.400,00');
  await expect(
    team.getByRole('row', { name: /Atendente Sintética/u }),
  ).toContainText('R$ 8.400,00');
  await expect(
    team.getByRole('row', { name: /Vendedor Sintético/u }),
  ).toContainText('Inativo');
  await expect(team).toContainText('Loja do site: R$ 1.800,00');
  await expect(team).toContainText('Sem atribuição histórica: R$ 0,00');
  await expect(
    page.getByRole('link', { name: /^Vendido hoje/u }),
  ).toContainText('R$ 1.800,00');
  const period = page.getByRole('group', { name: 'Período das vendas' });
  await expect(period).toHaveAccessibleDescription('Vale para Vendido');
  await period.getByRole('button', { name: '7 dias' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('link', { name: /^Vendido em 7 dias/u }),
  ).toContainText('R$ 12.300,00');
  expect(mock.periods).toEqual(['hoje', '7dias']);
  await expect(
    page.getByRole('link', { name: /^Esperando vendedor 3/u }),
  ).toContainText('1 fora do prazo');
  await expect(
    page.getByRole('link', { name: /^Assistente Pede atenção/u }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(team.getByRole('columnheader')).toHaveCount(6);
  await expect(team.getByRole('rowheader')).toHaveCount(2);
  await expect(team.getByRole('cell').first()).toHaveAttribute(
    'headers',
    'team-person-0 team-sold',
  );
  await page.screenshot({
    path: test.info().outputPath('team-mobile-390.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: /^Entregas atrasadas/u }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/pedidos?entrega=atrasada');
  await expect
    .poll(() => mock.orderLists.at(-1)?.get('delivery'))
    .toBe('overdue');
});

test('the seller works from their own queue and navigates to the real Inbox by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await expect(
    actions.getByRole('button', { name: 'Tudo 5', exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Pedidos 2', exact: true }),
  ).toBeVisible();
  const row = actions.getByRole('button', {
    name: 'Abrir Cliente Sintético',
    exact: true,
  });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(
    actions.getByRole('heading', { name: 'Cliente Sintético', exact: true }),
  ).toBeFocused();
  const reply = actions.getByRole('link', {
    name: 'Abrir conversa para responder',
  });
  await expect(reply).toHaveAttribute('href', '/inbox/reply-1');
  await expect(actions.locator('textarea')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Desempenho da equipe' }),
  ).toHaveCount(0);
  await actions.getByRole('button', { name: 'Voltar às providências' }).click();
  await expect(row).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await row.click();
  await reply.click();
  await expect(page).toHaveURL('/inbox/reply-1');
});

test('the queue and detail fit phone, tablet and notebook without horizontal scrolling', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await expect(
    actions.getByRole('button', { name: 'Tudo 5', exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    const box = await actions
      .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
      .boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: test.info().outputPath(`actions-${width}.png`),
      fullPage: true,
    });
    await actions
      .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
      .click();
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: test.info().outputPath(`detail-${width}.png`),
      fullPage: true,
    });
    const back = actions.getByRole('button', {
      name: 'Voltar às providências',
      exact: true,
    });
    if (await back.isVisible()) await back.click();
    else
      await actions
        .getByRole('button', { name: 'Tudo 5', exact: true })
        .click();
  }
  await page.getByRole('button', { name: 'Escuro', exact: true }).click();
  await page.screenshot({
    path: test.info().outputPath('actions-dark-1440.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
