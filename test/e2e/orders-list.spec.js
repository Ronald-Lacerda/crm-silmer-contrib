import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  confirmedOrder,
  eventStreamBody,
  extraPending,
  mockOrders,
  pendingOrder,
} from './support/orders-mock.js';

test('groups orders by status with counts, columns and actions', async ({
  page,
}) => {
  await mockOrders(page);
  await page.goto('/pedidos');

  await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeFocused();

  const confirmed = page.getByRole('region', { name: /Confirmados/u });
  const pending = page.getByRole('region', { name: /Pendentes/u });
  await expect(confirmed.getByRole('heading', { level: 2 })).toContainText(
    'Confirmados',
  );
  await expect(confirmed.getByRole('heading', { level: 2 })).toContainText('1');
  await expect(pending.getByRole('heading', { level: 2 })).toContainText('1');

  await expect(confirmed.locator('thead th')).toHaveText([
    'Pedido',
    'Cliente',
    'Entrega',
    'Peças',
    'Valor',
    'Situação',
    'Ações',
  ]);
  // Pesquisa UX 2026-10-15, achado 3: what still needs a person comes first.
  await expect(page.locator('main section h2')).toHaveText([
    /^\s*Pendentes/u,
    /^\s*Confirmados/u,
  ]);

  const confirmedRow = confirmed.getByRole('row').nth(1);
  await expect(confirmedRow).toContainText('05-CRM');
  await expect(confirmedRow).toContainText('Buffet Casa Rosa');
  await expect(confirmedRow).toContainText('Aventais e camisetas');
  await expect(confirmedRow).toContainText('Ricardo Lima');
  await expect(confirmedRow).toContainText('60');
  await expect(confirmedRow).toContainText('R$ 1.180,00');
  await expect(confirmedRow).toContainText('24/10');
  await expect(confirmedRow).toContainText('Confirmado por Ricardo Lima');

  const pendingRow = pending.getByRole('row').nth(1);
  await expect(pendingRow).toContainText('07-CRM');
  await expect(pendingRow).toContainText('Colégio Ápice');
  await expect(pendingRow).toContainText('150');
  await expect(pendingRow).toContainText(
    'Falta valor final e forma de pagamento',
  );
  await expect(pendingRow).toContainText('Pedido sem movimentação há');

  // PLI-06: printing belongs to confirmed orders, continuing to pending ones.
  await expect(
    confirmedRow.getByRole('button', { name: 'Gerar PDF' }),
  ).toBeVisible();
  await expect(
    confirmedRow.getByRole('link', { name: 'Abrir pedido' }),
  ).toHaveAttribute('href', '/pedidos/order-confirmado');
  await expect(
    confirmedRow.getByRole('link', { name: 'Continuar pedido' }),
  ).toHaveCount(0);
  await expect(
    pendingRow.getByRole('button', { name: 'Gerar PDF' }),
  ).toHaveCount(0);
  await expect(
    pendingRow.getByRole('link', { name: 'Abrir pedido' }),
  ).toHaveAttribute('href', '/pedidos/order-pendente');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('keeps every desktop order cell on the same row line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await mockOrders(page);
  await page.goto('/pedidos');

  for (const group of ['Pedidos pendentes', 'Pedidos confirmados']) {
    const row = page.getByRole('region', { name: group }).locator('tbody tr');
    await expect(row).toBeVisible();
    const cells = await row.locator('td').evaluateAll((nodes) =>
      nodes.map((node) => ({
        bottom: node.getBoundingClientRect().bottom,
        display: globalThis.getComputedStyle(node).display,
      })),
    );
    expect(cells.every((cell) => cell.display === 'table-cell')).toBe(true);
    expect(
      Math.max(...cells.map((cell) => cell.bottom)) -
        Math.min(...cells.map((cell) => cell.bottom)),
    ).toBeLessThan(1);
  }
});

test('recovers the order list after an initial server failure without showing an empty wallet', async ({
  page,
}) => {
  await mockOrders(page, { failListOnce: true });
  await page.goto('/pedidos');

  await expect(
    page.getByRole('heading', { name: 'Pedidos indisponíveis' }),
  ).toBeVisible();
  await expect(page.getByText('Nenhum pedido por aqui')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('row', { name: /Colégio Ápice/u })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Pedidos', exact: true }),
  ).toBeFocused();
});

test('keeps loaded orders visible when a live refresh fails', async ({
  page,
}) => {
  await mockOrders(page);
  let reads = 0;
  await page.route(/\/api\/v1\/orders\?/u, async (route) => {
    reads += 1;
    if (reads !== 2) return route.fallback();
    return route.fulfill({
      body: JSON.stringify({ code: 'UNAVAILABLE' }),
      contentType: 'application/problem+json',
      status: 503,
    });
  });
  /** @type {() => void} */
  let sendEvent = () => {};
  const eventGate = new Promise((resolve) => {
    sendEvent = () => resolve(null);
  });
  await page.route(/\/api\/v1\/events\?/u, async (route) => {
    await eventGate;
    return route.fulfill({
      body: eventStreamBody({
        payload: { orderId: 'order-pendente' },
        type: 'inbox.order.changed',
      }),
      contentType: 'text/event-stream',
      status: 200,
    });
  });
  await page.goto('/pedidos');
  await expect(page.getByRole('row', { name: /Colégio Ápice/u })).toBeVisible();

  sendEvent();
  await expect(page.getByRole('alert')).toContainText(
    'Os dados exibidos podem estar desatualizados.',
  );
  await expect(page.getByRole('row', { name: /Colégio Ápice/u })).toBeVisible();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(reads).toBe(3);
});

test('filters by status and searches by number, customer or phone', async ({
  page,
}) => {
  /** @type {URLSearchParams[]} */
  const calls = [];
  await mockOrders(page, { onList: (params) => calls.push(params) });
  await page.goto('/pedidos');

  // PLI-10: the count of the result replaces the old summary.
  await expect(page.locator('.filter-summary')).toHaveText('2 pedidos');

  // PLI-09: "Pendentes" lives in the "Filtros" sheet.
  await page.getByRole('button', { name: 'Filtros' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await sheet.getByRole('radio', { name: 'Pendentes', exact: true }).check();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('region', { name: /Confirmados/u })).toHaveCount(
    0,
  );
  const pending = page.getByRole('region', { name: /Pendentes/u });
  await expect(pending).toBeVisible();
  await expect.poll(() => calls.at(-1)?.get('status')).toBe('pendente');
  await expect(page.locator('.filter-summary')).toHaveText('1 pedido');
  // PLI-03: the group keeps its own count while it is the one selected.
  await expect(pending.getByRole('heading', { level: 2 })).toContainText('1');

  await page.getByRole('button', { name: 'Todos' }).click();
  await expect.poll(() => calls.at(-1)?.get('status')).toBe(null);

  await page.getByLabel('Buscar número, cliente ou telefone').fill('07-CRM');
  await expect.poll(() => calls.at(-1)?.get('q')).toBe('07-CRM');
});

test('pages the list with "Ver mais"', async ({ page }) => {
  await mockOrders(page, { pages: [[pendingOrder], [extraPending]] });
  await page.goto('/pedidos');

  const pending = page.getByRole('region', { name: /Pendentes/u });
  await expect(pending.getByRole('row')).toHaveCount(2);

  await page.getByRole('button', { name: 'Ver mais' }).click();
  await expect(pending.getByRole('row')).toHaveCount(3);
  await expect(pending).toContainText('Loja Vitória Sports');
  await expect(page.getByRole('button', { name: 'Ver mais' })).toHaveCount(0);
});

test('keeps a long order list inside its own scrollable table', async ({
  page,
}) => {
  const manyPending = Array.from({ length: 40 }, (_, index) => ({
    ...pendingOrder,
    id: `order-pendente-${index + 1}`,
    number: `${index + 10}-CRM`,
    ficha: {
      ...pendingOrder.ficha,
      summary: {
        ...pendingOrder.ficha.summary,
        cliente: `Cliente de teste ${index + 1}`,
      },
    },
  }));
  await mockOrders(page, { orders: [confirmedOrder, ...manyPending] });
  await page.setViewportSize({ height: 720, width: 1280 });
  await page.goto('/pedidos');
  const table = page.getByRole('region', { name: 'Pedidos pendentes' });
  await expect(table.getByRole('row')).toHaveCount(41);

  const metrics = await table.evaluate((element) => ({
    clientHeight: element.clientHeight,
    pageHeight: globalThis.document.documentElement.scrollHeight,
    scrollHeight: element.scrollHeight,
    viewportHeight: globalThis.innerHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.clientHeight).toBeLessThan(metrics.viewportHeight);
  // The page no longer grows with the list it holds.
  expect(metrics.pageHeight).toBeLessThan(metrics.scrollHeight);

  const lastOrder = table.getByRole('row', { name: /Cliente de teste 40/u });
  await lastOrder.getByRole('link', { name: 'Abrir pedido' }).focus();
  await expect(lastOrder).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('refreshes the list when an order changes elsewhere (PLI-08)', async ({
  page,
}) => {
  let listCalls = 0;
  await mockOrders(page, {
    liveEvent: {
      payload: { conversationId: 'conversation-7', orderId: 'order-pendente' },
      type: 'inbox.order.changed',
    },
    onList: () => {
      listCalls += 1;
    },
  });
  await page.goto('/pedidos');

  await expect(page.getByRole('region', { name: /Pendentes/u })).toBeVisible();
  await expect.poll(() => listCalls).toBeGreaterThan(1);
});

test('shows an empty list and a failure apart from each other', async ({
  page,
}) => {
  await mockOrders(page, { orders: [] });
  await page.goto('/pedidos');

  await expect(page.getByText('Nenhum pedido por aqui')).toBeVisible();

  await page.route('**/api/v1/orders?**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }),
    });
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível carregar os pedidos.',
  );
});

// Pesquisa UX 2026-10-15, achados 3 e 4: the production view of Pedidos.
const TODAY = new Date('2026-10-15T12:00:00-03:00');

/** @param {string} id @param {Record<string, any>} [overrides] @param {Record<string, any>} [summary] */
function orderAt(id, overrides = {}, summary = {}) {
  const base = overrides.status === 'pendente' ? pendingOrder : confirmedOrder;
  return {
    ...base,
    ...overrides,
    ficha: {
      ...base.ficha,
      summary: { ...base.ficha.summary, ...summary },
    },
    id,
  };
}

const queueOrders = [
  orderAt(
    'order-soon',
    { number: '11-CRM' },
    { cliente: 'Academia Norte', data_entrega_confirmada: '2026-10-24' },
  ),
  orderAt(
    'order-done',
    { deliveredOn: '2026-10-10', number: '12-CRM' },
    { cliente: 'Clube Entregue', data_entrega_confirmada: '2026-10-11' },
  ),
  orderAt(
    'order-late',
    { number: '13-CRM' },
    { cliente: 'Escola Atrasada', data_entrega_confirmada: '2026-10-13' },
  ),
  orderAt(
    'order-test',
    { isTest: true, number: '14-CRM' },
    { cliente: 'Pedido de Teste', data_entrega_confirmada: '2026-10-16' },
  ),
  orderAt(
    'order-later',
    { number: '15-CRM' },
    { cliente: 'Time Sem Data', data_entrega_confirmada: null },
  ),
  orderAt(
    'order-pending-calm',
    {
      number: '16-CRM',
      status: 'pendente',
      updatedAt: '2026-10-15T14:00:00.000Z',
    },
    { cliente: 'Pendente Tranquilo', data_entrega_confirmada: '2026-10-30' },
  ),
  orderAt(
    'order-pending-stale',
    {
      number: '17-CRM',
      status: 'pendente',
      updatedAt: '2026-10-01T14:00:00.000Z',
    },
    { cliente: 'Pendente Parado', data_entrega_confirmada: '2026-11-20' },
  ),
];

/** @param {import('@playwright/test').Locator} region */
async function customerOrder(region) {
  return region.locator('tbody tr td:nth-child(2) strong').allTextContents();
}

test('puts pending orders and exceptions first, with the delivery deadline', async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await mockOrders(page, { orders: queueOrders });
  await page.goto('/pedidos');

  const pending = page.getByRole('region', { name: 'Pedidos pendentes' });
  const confirmed = page.getByRole('region', { name: 'Pedidos confirmados' });
  await expect(pending.getByRole('row')).toHaveCount(3);
  // A stalled pending order is an exception: it rides above a calm one even
  // with a later delivery.
  expect(await customerOrder(pending)).toEqual([
    'Pendente Parado',
    'Pendente Tranquilo',
  ]);
  await expect(
    pending.getByRole('row', { name: /Pendente Parado/u }),
  ).toContainText('Revisar pedido');
  // Late first, then the nearest delivery, no date after, delivered last.
  expect(await customerOrder(confirmed)).toEqual([
    'Escola Atrasada',
    'Pedido de Teste',
    'Academia Norte',
    'Time Sem Data',
    'Clube Entregue',
  ]);
  const late = confirmed.getByRole('row', { name: /Escola Atrasada/u });
  await expect(late.locator('td').nth(2)).toHaveText(
    /13\/10\s*Atrasada há 2 dias/u,
  );
  await expect(late).toHaveAttribute('data-exception', 'true');
  await expect(
    confirmed
      .getByRole('row', { name: /Pedido de Teste/u })
      .locator('td')
      .nth(2),
  ).toHaveText(/16\/10\s*Amanhã/u);
  await expect(
    confirmed
      .getByRole('row', { name: /Academia Norte/u })
      .locator('td')
      .nth(2),
  ).toHaveText(/24\/10\s*em 9 dias/u);
  await expect(
    confirmed
      .getByRole('row', { name: /Time Sem Data/u })
      .locator('td')
      .nth(2),
  ).toHaveText('Sem data');
  await expect(
    confirmed
      .getByRole('row', { name: /Clube Entregue/u })
      .locator('td')
      .nth(2),
  ).toHaveText(/Entregue em 10\/10/u);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('filters the orders ready for production, by the nearest delivery', async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  /** @type {URLSearchParams[]} */
  const calls = [];
  await mockOrders(page, {
    onList: (params) => calls.push(params),
    orders: queueOrders,
  });
  await page.goto('/pedidos');

  const chip = page.getByRole('button', { name: 'Prontos para produção' });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => calls.at(-1)?.get('status')).toBe('confirmado');
  await expect(page.getByRole('region', { name: /Pendentes/u })).toHaveCount(0);

  const queue = page.getByRole('region', { name: 'Fila de produção' });
  await expect(
    page.getByRole('heading', { level: 2, name: /Prontos para produção/u }),
  ).toContainText('3');
  // Neither the delivered order nor the test order is production work.
  expect(await customerOrder(queue)).toEqual([
    'Escola Atrasada',
    'Academia Norte',
    'Time Sem Data',
  ]);
  await expect(
    queue.getByRole('button', { name: 'Gerar PDF 13-CRM' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('says the production queue is empty when every order was delivered', async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await mockOrders(page, {
    orders: [queueOrders[1], queueOrders[5]],
  });
  await page.goto('/pedidos');
  await page.getByRole('button', { name: 'Prontos para produção' }).click();
  await expect(
    page.getByRole('heading', { name: 'Nenhum pedido na fila de produção' }),
  ).toBeVisible();
});

test('stacks the orders as cards on a phone, with no sideways scroll', async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.setViewportSize({ height: 844, width: 390 });
  await mockOrders(page, { orders: queueOrders });
  await page.goto('/pedidos');

  const confirmed = page.getByRole('region', { name: 'Pedidos confirmados' });
  const card = confirmed.getByRole('row', { name: /Academia Norte/u });
  await expect(card).toBeVisible();
  const layout = await page.evaluate(() => {
    const doc = globalThis.document.documentElement;
    const regions = [...globalThis.document.querySelectorAll('.order-list')];
    const row = globalThis.document.querySelector('.order-table tbody tr');
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      regionOverflow: regions.map((r) => r.scrollWidth - r.clientWidth),
      rowDisplay: row ? globalThis.getComputedStyle(row).display : '',
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.regionOverflow.every((value) => value <= 0)).toBe(true);
  expect(layout.rowDisplay).toBe('grid');
  // The column names travel with the values; the header row is not drawn.
  const header = await confirmed.locator('thead').boundingBox();
  expect(header?.height ?? 0).toBeLessThanOrEqual(1);
  await expect(card.locator('td').nth(2)).toHaveText(/24\/10\s*em 9 dias/u);
  const open = card.getByRole('link', { name: 'Abrir pedido 11-CRM' });
  await open.focus();
  await expect(open).toBeInViewport();
  const box = await open.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
  // Still a table for a screen reader: rows, cells and column headers.
  await expect(confirmed.getByRole('columnheader')).toHaveCount(7);
  // Mobile first: a card says its own status, which the section heading
  // says on a wide screen.
  await expect(card.locator('.order-card-status')).toHaveText('Confirmado');
  await expect(
    page
      .getByRole('region', { name: 'Pedidos pendentes' })
      .getByRole('row', { name: /Pendente Parado/u })
      .locator('.order-card-status'),
  ).toHaveText('Pendente');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(card.locator('.order-card-status')).toBeHidden();
  await expect(confirmed.locator('thead th').first()).toBeVisible();
});

// RFC 024 (PLI-09, PLI-10): three chips and a "Filtros" sheet.
test('PLI-09/PLI-10: the "Filtros" sheet works by keyboard and names the filter it applies', async ({
  page,
}) => {
  /** @type {URLSearchParams[]} */
  const calls = [];
  await page.setViewportSize({ height: 768, width: 1366 });
  await mockOrders(page, { onList: (params) => calls.push(params) });
  await page.goto('/pedidos');
  await expect(page.locator('.filter-summary')).toHaveText('2 pedidos');

  const group = page.getByRole('group', { name: 'Filtrar pedidos' });
  await expect(group.getByRole('button')).toHaveText([
    'Todos',
    'Meus pendentes',
    'Prontos para produção',
    'Filtros',
  ]);
  const all = group.getByRole('button', { name: 'Todos' });
  await expect(all).toHaveAttribute('aria-pressed', 'true');

  // The sheet opens on the filter in use; Esc leaves the list as it was.
  const filters = page.getByRole('button', { name: 'Filtros' });
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('legend')).toHaveText([
    'Situação',
    'Responsável',
    'Origem',
    'Entrega',
    'Produção',
  ]);
  await expect(sheet.getByRole('radio')).toHaveCount(8);
  await expect(sheet.getByRole('radio', { name: 'Todos' })).toBeFocused();
  await expect(sheet.getByRole('radio', { name: 'Todos' })).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('ArrowDown');
  await expect(
    sheet.getByRole('radio', { name: 'Pendentes', exact: true }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('region', { name: /Confirmados/u }),
  ).toBeVisible();
  await expect(page.locator('.filter-summary')).toHaveText('2 pedidos');

  // Arrows move between the options of every group; Tab reaches the footer.
  await page.keyboard.press('Enter');
  await expect(sheet.getByRole('radio', { name: 'Todos' })).toBeFocused();
  for (let step = 0; step < 5; step += 1)
    await page.keyboard.press('ArrowDown');
  const late = sheet.getByRole('radio', { name: 'Entrega atrasada' });
  await expect(late).toBeFocused();
  await expect(late).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(
    sheet.getByRole('button', { name: 'Limpar filtros' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    sheet.getByRole('button', { name: 'Ver resultados' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect
    .poll(() => calls.at(-1)?.get('delivery') ?? null)
    .toBe('overdue');

  // PLI-10: no chip says it, so the list names it, with a way out.
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  const active = page.locator('.orders-active-filter');
  await expect(active).toHaveText(
    /^\s*Filtro: Entrega atrasada\s*Limpar filtro\s*$/u,
  );
  await expect(page.locator('.filter-summary')).toHaveText('1 pedido');

  // "Limpar filtros" resets the draft; a click outside discards it.
  await filters.click();
  await expect(late).toBeChecked();
  await sheet.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(sheet.getByRole('radio', { name: 'Todos' })).toBeChecked();
  await expect(sheet).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(active).toContainText('Entrega atrasada');

  await page
    .getByRole('button', { name: 'Limpar filtro', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(active).toHaveCount(0);
  await expect(filters).toBeFocused();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => calls.at(-1)?.get('delivery') ?? null).toBe(null);
  await expect(page.locator('.filter-summary')).toHaveText('2 pedidos');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PLI-10: a Painel filter in the address is named, combines with the search and leaves the address when cleared', async ({
  page,
}) => {
  /** @type {URLSearchParams[]} */
  const calls = [];
  await mockOrders(page, { onList: (params) => calls.push(params) });
  await page.goto('/pedidos?origem=loja');
  const active = page.locator('.orders-active-filter');
  await expect(active).toContainText('Filtro: Loja do site');
  await expect.poll(() => calls.at(-1)?.get('origin') ?? null).toBe('loja');

  const search = page.getByRole('searchbox', {
    name: 'Buscar número, cliente ou telefone',
  });
  await search.fill('Casa Rosa');
  await expect.poll(() => calls.at(-1)?.get('q') ?? null).toBe('Casa Rosa');
  expect(calls.at(-1)?.get('origin')).toBe('loja');
  await expect(active).toContainText('Loja do site');

  // Clearing drops the filter from the address and keeps the search.
  await page
    .getByRole('button', { name: 'Limpar filtro', exact: true })
    .click();
  await expect(page).toHaveURL('/pedidos');
  await expect(active).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filtros' })).toBeFocused();
  await expect(search).toHaveValue('Casa Rosa');
  await expect.poll(() => calls.at(-1)?.get('origin') ?? null).toBe(null);
  expect(calls.at(-1)?.get('q')).toBe('Casa Rosa');

  // The delivery view is one short list the API does not search: a search
  // reads every order again, and the filter's name leaves with it.
  await page.goto('/pedidos?entrega=atrasada');
  await expect(active).toContainText('Filtro: Entrega atrasada');
  await expect
    .poll(() => calls.at(-1)?.get('delivery') ?? null)
    .toBe('overdue');
  await search.fill('05-CRM');
  await expect.poll(() => calls.at(-1)?.get('q') ?? null).toBe('05-CRM');
  expect(calls.at(-1)?.get('delivery')).toBeNull();
  await expect(active).toHaveCount(0);
});

test('PLI-09: on a phone the first order sits whole above the bottom bar, and "Filtros" is a bottom sheet', async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.setViewportSize({ height: 844, width: 390 });
  await mockOrders(page, { orders: queueOrders });
  await page.goto('/pedidos');

  const first = page.locator('.order-table tbody tr').first();
  await expect(first).toBeVisible();
  // One line of heading, then five controls: search, three chips, "Filtros".
  await expect(page.locator('.page-heading p')).toHaveCount(0);
  await expect(
    page.locator('.filter-bar').locator('button, input'),
  ).toHaveCount(5);
  const card = await first.boundingBox();
  const nav = await page
    .getByRole('navigation', { name: 'Navegação móvel' })
    .boundingBox();
  expect((card?.y ?? 0) + (card?.height ?? Infinity)).toBeLessThanOrEqual(
    nav?.y ?? 0,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Filtros' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  // 44 px targets, 8 px apart.
  /** @param {Element[]} elements */
  const rects = (elements) =>
    elements.map((element) => {
      const { bottom, height, top } = element.getBoundingClientRect();
      return { bottom, height, top };
    });
  const targets = await sheet
    .locator('.filter-sheet-option, button')
    .evaluateAll(rects);
  expect(targets).toHaveLength(11);
  expect(targets.every((rect) => rect.height >= 44)).toBe(true);
  const options = await sheet
    .locator('.filter-sheet-option')
    .evaluateAll(rects);
  for (let index = 1; index < options.length; index += 1) {
    expect(
      options[index].top - options[index - 1].bottom,
    ).toBeGreaterThanOrEqual(8);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PLI-09: on a notebook the "Filtros" sheet keeps 44 px targets, 8 px apart, without scroll', async ({
  page,
}) => {
  await page.setViewportSize({ height: 768, width: 1366 });
  await mockOrders(page);
  await page.goto('/pedidos');
  await page.getByRole('button', { name: 'Filtros' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();

  /** @param {Element[]} elements */
  const rects = (elements) =>
    elements.map((element) => {
      const { bottom, height, left, top } = element.getBoundingClientRect();
      return { bottom, height, left, top };
    });
  const targets = await sheet
    .locator('.filter-sheet-option, button')
    .evaluateAll(rects);
  expect(targets).toHaveLength(11);
  for (const rect of targets) expect(rect.height).toBeGreaterThanOrEqual(44);
  // Side by side in columns: 8 px between options stacked in one group.
  const options = await sheet
    .locator('.filter-sheet-option')
    .evaluateAll(rects);
  for (let index = 1; index < options.length; index += 1) {
    const [above, below] = [options[index - 1], options[index]];
    if (above.left !== below.left || below.top < above.bottom) continue;
    expect(below.top - above.bottom).toBeGreaterThanOrEqual(8);
  }
  const body = await sheet
    .locator('.filter-sheet-body')
    .evaluate(({ clientHeight, scrollHeight }) => ({
      clientHeight,
      scrollHeight,
    }));
  expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight);
});
