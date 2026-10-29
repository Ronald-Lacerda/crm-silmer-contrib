import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { ownConfirmedOrder } from './support/orders-mock.js';
import { mockPainel } from './support/painel-mock.js';

// T136 / PLA-10..12: synthetic manual orders, no real customer data.
const TASKS = [12, 13].map((number) => ({
  ...ownConfirmedOrder,
  conversationId: null,
  manualOwnerId: 'seller-1',
  origin: 'atendimento',
  id: `manual-${number}`,
  number: `${number}-CRM`,
}));

/**
 * @param {import('@playwright/test').Page} page
 * @param {{failLoad?: boolean, failConfirmation?: boolean}} [options]
 */
async function mockTasks(page, options = {}) {
  await mockPainel(page, { manager: false });
  let items = structuredClone(TASKS);
  let failLoad = options.failLoad ?? false;
  let failConfirmation = options.failConfirmation ?? false;
  /** @type {{orderId: string, body: any, key: string}[]} */
  const writes = [];
  let reads = 0;
  await page.route('**/api/v1/orders/delivery-tasks', (route) => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      status: failLoad ? 503 : 200,
      body: JSON.stringify(failLoad ? { code: 'UNAVAILABLE' } : { items }),
    });
  });
  await page.route(
    '**/api/v1/orders/*/delivery-confirmation',
    async (route) => {
      const request = route.request();
      const orderId = new URL(request.url()).pathname.split('/')[4];
      const body = request.postDataJSON();
      const key = request.headers()['idempotency-key'];
      expect(request.method()).toBe('POST');
      expect(key).toBeTruthy();
      writes.push({ body, key, orderId });
      if (failConfirmation) {
        await route.fulfill({
          contentType: 'application/problem+json',
          status: 409,
          body: JSON.stringify({ code: 'VERSION_CONFLICT' }),
        });
        return;
      }
      const current = items.find((item) => item.id === orderId);
      items = items.filter((item) => item.id !== orderId);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          order: { ...current, deliveredOn: '2026-10-21', version: 5 },
        }),
      });
    },
  );
  return {
    writes,
    reads: () => reads,
    removeFirst() {
      items = items.slice(1);
    },
    recover() {
      failLoad = false;
      failConfirmation = false;
    },
  };
}

/** @param {import('@playwright/test').Page} page */
function region(page) {
  return page.getByRole('region', { name: 'Meus afazeres de entrega' });
}

test('seller confirms manual delivery by keyboard with a server date and predictable focus (T136)', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const mock = await mockTasks(page);
  await page.goto('/dashboard');
  const tasks = region(page);
  const first = tasks.getByRole('checkbox', {
    name: 'O pedido 12-CRM já foi entregue?',
  });
  await expect(first).toBeVisible();
  await expect(tasks.locator('input[type="date"]')).toHaveCount(0);
  await expect(
    tasks.getByRole('link', { name: 'Ver pedido 12-CRM' }),
  ).toHaveAttribute('href', '/pedidos/manual-12');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toHaveCount(0);
  const next = tasks.getByRole('checkbox', {
    name: 'O pedido 13-CRM já foi entregue?',
  });
  await expect(next).toBeFocused();
  await expect(tasks.getByRole('status')).toHaveText(
    'Entrega do pedido 12-CRM confirmada.',
  );
  expect(mock.writes.map(({ body, orderId }) => ({ body, orderId }))).toEqual([
    { orderId: 'manual-12', body: { expectedVersion: 4 } },
  ]);
  await page.keyboard.press('Space');
  await expect(tasks.getByRole('checkbox')).toHaveCount(0);
  await expect(tasks.getByRole('heading')).toBeFocused();
  await expect(tasks).toContainText('Nenhuma entrega para confirmar.');
  expect(new Set(mock.writes.map(({ key }) => key)).size).toBe(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('stale confirmation keeps the task unchecked, asks to refresh, and then permits retry (T136)', async ({
  page,
}) => {
  const mock = await mockTasks(page, { failConfirmation: true });
  await page.goto('/dashboard');
  const tasks = region(page);
  const first = tasks.getByRole('checkbox', {
    name: 'O pedido 12-CRM já foi entregue?',
  });
  await first.focus();
  await page.keyboard.press('Space');
  await expect(tasks.getByRole('alert')).toContainText('O pedido mudou.');
  await expect(first).not.toBeChecked();
  await expect(first).toBeFocused();
  await page.keyboard.press('Space');
  expect(mock.writes).toHaveLength(1);
  mock.recover();
  await tasks.getByRole('button', { name: 'Atualizar afazeres' }).focus();
  await page.keyboard.press('Enter');
  await expect(tasks.getByRole('alert')).toHaveCount(0);
  await expect(tasks.getByRole('heading')).toBeFocused();
  await expect(first).not.toBeChecked();
  expect(mock.reads()).toBe(2);
  // The successful request removes this checkbox, so check() cannot reliably
  // verify its checked postcondition after triggering the change event.
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toHaveCount(0);
  await expect(tasks.getByRole('status')).toHaveText(
    'Entrega do pedido 12-CRM confirmada.',
  );
  expect(mock.writes.map(({ body, orderId }) => ({ body, orderId }))).toEqual([
    { orderId: 'manual-12', body: { expectedVersion: 4 } },
    { orderId: 'manual-12', body: { expectedVersion: 4 } },
  ]);
});

test('unavailable tasks never claim that there are no deliveries and recover by keyboard (T136)', async ({
  page,
}) => {
  const mock = await mockTasks(page, { failLoad: true });
  await page.goto('/dashboard');
  const tasks = region(page);
  await expect(tasks.getByRole('alert')).toContainText(
    'Não foi possível atualizar seus afazeres de entrega.',
  );
  await expect(tasks).not.toContainText('Nenhuma entrega para confirmar.');
  await expect(tasks.getByRole('checkbox')).toHaveCount(0);
  mock.recover();
  await tasks.getByRole('button', { name: 'Atualizar afazeres' }).focus();
  await page.keyboard.press('Enter');
  await expect(tasks.getByRole('checkbox')).toHaveCount(2);
  await expect(tasks.getByRole('heading')).toBeFocused();
  expect(mock.reads()).toBe(2);
});

test('order events refresh the seller delivery tasks without stealing focus (T136)', async ({
  page,
}) => {
  const mock = await mockTasks(page);
  /** @type {() => void} */
  let releaseEvent = () => {};
  const gate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  await page.route(
    (url) => url.pathname === '/api/v1/events',
    async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\nevent: inbox.order.changed\nid: delivery-event\ndata: {"orderId":"manual-12"}\n\n',
      });
    },
  );
  await page.goto('/dashboard');
  const tasks = region(page);
  await expect(tasks.getByRole('checkbox')).toHaveCount(2);
  const remaining = tasks.getByRole('checkbox', {
    name: 'O pedido 13-CRM já foi entregue?',
  });
  await remaining.focus();
  mock.removeFirst();
  releaseEvent();
  await expect(tasks.getByRole('checkbox')).toHaveCount(1);
  await expect(remaining).toBeFocused();
  expect(mock.reads()).toBeGreaterThan(1);
  expect(mock.writes).toHaveLength(0);
});
