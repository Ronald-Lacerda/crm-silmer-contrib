import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { actionItems, mockPainel } from './support/painel-mock.js';

test('seller confirms deliveries by keyboard with the server day and moves focus to the next order', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockPainel(page, { manager: false });
  const rows = actionItems().filter((item) => item.targetType === 'order');
  rows[0].order.paidOn = '2026-10-13';
  mock.setActions(rows);
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await actions
    .getByRole('button', { name: 'Registrar entrega', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(actions).toContainText(
    'A entrega será registrada em 15/10/2026',
  );
  await expect(actions.locator('input[type=date]')).toHaveCount(0);
  await actions
    .getByRole('button', { name: 'Confirmar entrega de hoje', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    actions.getByRole('button', { name: 'Abrir Turma Sintética', exact: true }),
  ).toBeFocused();
  await expect(actions.getByRole('status')).toContainText(
    'Entrega do pedido 12-CRM registrada.',
  );
  expect(mock.writes[0].body).toEqual({ expectedVersion: 4 });
  expect(mock.writes[0].key).toBeTruthy();
  await actions
    .getByRole('button', { name: 'Abrir Turma Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Registrar entrega', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Confirmar entrega de hoje', exact: true })
    .click();
  await expect(
    actions.getByRole('heading', {
      name: 'O que precisa de você',
      exact: true,
    }),
  ).toBeFocused();
  await expect(actions).toContainText('Nenhuma providência nesta visão');
  expect(new Set(mock.writes.map((write) => write.key)).size).toBe(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a conflict does not simulate delivery or issue a second command before explicit refresh', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  let writes = 0;
  await page.route('**/api/v1/orders/*/delivery-confirmation', (route) => {
    writes += 1;
    return route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'VERSION_CONFLICT' }),
    });
  });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Turma Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Registrar entrega', exact: true })
    .click();
  const confirm = actions.getByRole('button', {
    name: 'Confirmar entrega de hoje',
    exact: true,
  });
  await confirm.click();
  await expect(actions.getByRole('alert')).toContainText(
    'A providência mudou.',
  );
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await confirm.focus();
  await page.keyboard.press('Enter');
  expect(writes).toBe(1);
  await expect(
    actions.getByRole('button', { name: 'Abrir Turma Sintética', exact: true }),
  ).toBeVisible();
  await expect(actions.getByText(/^Entrega do pedido/u)).toHaveCount(0);
});

test('events update the queue without stealing focus from an unchanged row', async ({
  page,
}) => {
  const mock = await mockPainel(page, { manager: false });
  let releaseEvent = () => {};
  const gate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  await page.route('**/api/v1/events?**', async (route) => {
    await gate;
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'retry: 60000\n\nevent: inbox.order.changed\nid: new-delivery\ndata: {"orderId":"manual-12"}\n\n',
    });
  });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  const remaining = actions.getByRole('button', {
    name: 'Abrir Turma Sintética',
    exact: true,
  });
  await remaining.focus();
  mock.setActions(
    actionItems().filter((item) => item.targetId !== 'manual-12'),
  );
  releaseEvent();
  await expect(
    actions.getByRole('button', {
      name: 'Abrir Equipe Sintética',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(remaining).toBeFocused();
  expect(mock.writes).toHaveLength(0);
});
