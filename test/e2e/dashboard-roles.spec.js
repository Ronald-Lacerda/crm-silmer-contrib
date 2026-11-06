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
  // PNL-05: the week by day is one described figure, same week any period.
  const daily = page.getByRole('region', { name: 'Vendido por dia' });
  await expect(daily).toContainText(
    /Últimos 7 dias · R\$\s28\.170,00 em 67 pedidos/u,
  );
  await expect(daily.getByRole('img')).toHaveAccessibleName(
    /^Vendido por dia: sexta R\$\s4\.120,00, sábado R\$\s2\.000,00, .*, hoje R\$\s1\.800,00$/u,
  );
  await expect(daily.locator('.sales-chart-day')).toHaveText([
    'Sex',
    'Sáb',
    'Dom',
    'Seg',
    'Ter',
    'Qua',
    'Hoje',
  ]);
  // PNL-06: three whole-row links into the filtered Inbox.
  const attendance = page.getByRole('region', { name: 'Atendimento agora' });
  const rows = attendance.locator('.attendance-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute(
    'href',
    '/inbox?situacao=aguardando',
  );
  await expect(rows.nth(0)).toContainText('3Esperando vendedor');
  await expect(rows.nth(0)).toContainText('O primeiro espera há 6 h');
  await expect(rows.nth(1)).toHaveAttribute('href', '/inbox?situacao=agente');
  await expect(rows.nth(1)).toContainText(
    '1 sem resposta há 10 min ou mais; 1 com envio falho em 24 h',
  );
  await expect(rows.nth(2)).toHaveAttribute('href', '/inbox?situacao=vendedor');
  await expect(rows.nth(2)).toContainText('Sem resposta há mais de 15 min');
  await expect(rows.nth(2)).toContainText(
    '3 de Vendedor S. · 1 de Atendente S.',
  );
  for (const row of await rows.all()) {
    expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    attendance.getByRole('link', { name: 'Ver desempenho do agente' }),
  ).toHaveAttribute('href', '/dashboard/agente');
  // PNL-06: the partners' checkpoint and the manager's own actions left.
  await expect(page.getByText('Checkpoint dos sócios')).toHaveCount(0);
  await expect(page.getByText('Minhas providências')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'O que precisa de você' }),
  ).toHaveCount(0);
  // The team reads after the day and the week.
  const chartNode = await daily.elementHandle();
  const teamNode = await team.elementHandle();
  expect(
    await page.evaluate(
      ([chart, people]) =>
        Boolean(
          chart &&
          people &&
          chart.compareDocumentPosition(people) &
            globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      [chartNode, teamNode],
    ),
  ).toBe(true);
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
  // The two cards stack on the phone without horizontal scrolling.
  const chartBox = await daily.boundingBox();
  const attendanceBox = await attendance.boundingBox();
  expect(attendanceBox?.y).toBeGreaterThan(
    (chartBox?.y ?? 0) + (chartBox?.height ?? 0) - 1,
  );
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth -
        globalThis.document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
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

test('PNL-05: manager chart labels fit phone, narrow desktop with expanded menu and notebook', async ({
  page,
}) => {
  await mockPainel(page);
  await page.goto('/dashboard');
  const chart = page.getByRole('region', { name: 'Vendido por dia' });
  await expect(chart.getByRole('img')).toBeVisible();
  await page.evaluate(() => globalThis.document.fonts.ready);
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width === 1024)
      await page
        .getByRole('button', { name: 'Expandir menu', exact: true })
        .click();
    await page.screenshot({
      path: test.info().outputPath('manager-' + width + '.png'),
      fullPage: true,
    });
    const labels = await chart
      .locator('.sales-chart-value')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const range = globalThis.document.createRange();
          range.selectNodeContents(node);
          return {
            label: node.textContent,
            textWidth: range.getBoundingClientRect().width,
            columnWidth: node.parentElement?.getBoundingClientRect().width ?? 0,
          };
        }),
      );
    for (const label of labels)
      expect(label.textWidth, width + 'px: ' + label.label).toBeLessThanOrEqual(
        label.columnWidth + 0.5,
      );
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth -
          globalThis.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
});
