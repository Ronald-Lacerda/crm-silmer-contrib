import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { mockPainel } from './support/painel-mock.js';

// Pesquisa de UX de 15/10/2026, achado 2: o Painel responde por papel e cada
// indicador abre a lista já filtrada. Dados sintéticos.

/** @param {import('@playwright/test').Page} page */
function sectionTitles(page) {
  return page.locator('#main-content').getByRole('heading', { level: 2 });
}

test('the manager reads the day first, with the period on the server', async ({
  page,
}) => {
  const mock = await mockPainel(page);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();
  await expect(
    page.getByText(
      'Quinta-feira, 15 de outubro: vendas, entregas e quem espera atendimento.',
    ),
  ).toBeVisible();
  await expect(sectionTitles(page)).toHaveText([
    'Vendas e entregas',
    'Atendimento',
    'Meus afazeres de entrega',
  ]);
  // No technical copy from the old Dashboard.
  await expect(page.getByText(/100 conversas|Conteúdo mínimo/u)).toHaveCount(0);

  const sold = page.getByRole('link', { name: /^Vendido hoje/u });
  await expect(sold).toContainText('R$ 1.800,00');
  await expect(
    page.getByRole('link', { name: /^Entregas atrasadas 2/u }),
  ).toContainText('A mais antiga era para 09/10');
  await expect(
    page.getByRole('link', { name: /^Esperando vendedor 3/u }),
  ).toContainText('1 fora do prazo');
  await expect(
    page.getByRole('link', { name: /^Assistente Pede atenção/u }),
  ).toContainText('1 sem resposta há 10 min ou mais');

  const periodGroup = page.getByRole('group', { name: 'Período das vendas' });
  await expect(
    periodGroup.getByRole('button', { name: 'Hoje' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await periodGroup.getByRole('button', { name: '7 dias' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('link', { name: /^Vendido em 7 dias/u }),
  ).toContainText('R$ 12.300,00');
  await expect(
    periodGroup.getByRole('button', { name: '7 dias' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#main-content').getByRole('status')).toHaveText(
    'Vendido em 7 dias atualizado.',
  );
  expect(mock.periods).toEqual(['hoje', '7dias']);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Each indicator opens its list already filtered, by keyboard.
  await page.getByRole('link', { name: /^Entregas atrasadas/u }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/pedidos?entrega=atrasada');
  // PLI-10: the filter lives in the "Filtros" sheet, so the list names it.
  await expect(page.locator('.orders-active-filter')).toContainText(
    'Filtro: Entrega atrasada',
  );
  await expect
    .poll(() => mock.orderLists.at(-1)?.get('delivery') ?? null)
    .toBe('overdue');

  await page.goBack();
  await page.getByRole('link', { name: /^Esperando vendedor/u }).click();
  await expect(page).toHaveURL('/inbox?situacao=aguardando');
  await expect
    .poll(() => mock.inboxLists.at(-1)?.get('pendingHandoff') ?? null)
    .toBe('true');
});

test('the seller home is their queue: answer now, stalled, their orders', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const mock = await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  await expect(sectionTitles(page)).toHaveText([
    'Minha fila',
    'Entregas',
    'Meus afazeres de entrega',
  ]);
  const mine = page.getByRole('link', { name: /^Responder agora 2/u });
  await expect(mine).toContainText('O primeiro cliente escreveu há 25 min');
  await expect(
    page.getByRole('link', { name: /^Esperando vendedor 3/u }),
  ).toContainText('A mais antiga está parada há 6 h');
  const myOrders = page.getByRole('link', {
    name: /^Meus pedidos pendentes 2/u,
  });
  await expect(myOrders).toHaveAttribute(
    'href',
    '/pedidos?status=pendente&vendedor=eu',
  );
  // The assistant's health is the manager's question.
  await expect(page.getByRole('link', { name: /^Assistente/u })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await myOrders.click();
  await expect(page).toHaveURL('/pedidos?status=pendente&vendedor=eu');
  await expect(
    page.getByRole('button', { name: 'Meus pendentes' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => mock.orderLists.at(-1)?.get('owner') ?? null)
    .toBe('me');
  expect(mock.orderLists.at(-1)?.get('status')).toBe('pendente');

  await page.goBack();
  await mine.click();
  await expect(page).toHaveURL('/inbox?fila=minhas');
  await expect
    .poll(() => mock.inboxLists.at(-1)?.get('assignedUserId') ?? null)
    .toBe('seller-1');
});

test('on a 390 px phone the indicators sit two by two, tappable, without sideways scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await mockPainel(page);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('link', { name: /^Vendido hoje/u }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      globalThis.document.documentElement.scrollWidth -
      globalThis.document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const boxes = await page
    .locator('#dashboard-orders-title')
    .locator('xpath=../..')
    .locator('.metric-card')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const box = card.getBoundingClientRect();
        return { height: box.height, left: Math.round(box.left) };
      }),
    );
  // Four sales and delivery indicators in a 2×2 grid, each a 44 px target.
  expect(boxes).toHaveLength(4);
  expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44);

  // Scrolled to the end, the last indicator clears the fixed bottom bar.
  await page.locator('.metric-card').last().scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000);
  const nav = await page
    .getByRole('navigation', { name: 'Navegação móvel' })
    .boundingBox();
  const last = await page.locator('.metric-card').last().boundingBox();
  expect(nav).not.toBeNull();
  expect(last).not.toBeNull();
  expect(
    /** @type {{y: number, height: number}} */ (last).y +
      /** @type {{y: number, height: number}} */ (last).height,
  ).toBeLessThanOrEqual(/** @type {{y: number}} */ (nav).y);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
