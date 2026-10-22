import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, ownConfirmedOrder } from './support/orders-mock.js';

/** @param {import('@playwright/test').Page} page */
async function legacyPayment(page) {
  const order = {
    ...structuredClone(ownConfirmedOrder),
    paymentReviewRequired: true,
  };
  /** @type {Array<Record<string, any>>} */
  const writes = [];
  await mockOrders(page, { orders: [order] });
  await page.route(
    '**/api/v1/orders/order-confirmado/milestones',
    async (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      Object.assign(order, {
        paidOn: body.paidOn,
        deliveredOn: body.deliveredOn,
        paymentReviewRequired:
          body.paymentReviewed === true ? false : order.paymentReviewRequired,
        version: order.version + 1,
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order }),
      });
    },
  );
  await page.clock.setFixedTime(new Date('2026-10-22T15:00:00.000Z'));
  await page.goto('/pedidos/order-confirmado');
  return writes;
}

test('saving delivery with an unchanged legacy payment does not declare full receipt', async ({
  page,
}) => {
  const writes = await legacyPayment(page);
  const dates = page.getByRole('region', { name: 'Datas do pedido' });
  await dates
    .getByRole('button', { name: 'Editar datas', exact: true })
    .click();
  const confirmation = dates.getByRole('checkbox', {
    name: 'Confirmo que o valor integral foi recebido',
  });
  await expect(confirmation).not.toBeChecked();
  await dates.getByLabel('Entregue em', { exact: true }).fill('2026-10-21');
  await dates
    .getByRole('button', { name: 'Salvar datas', exact: true })
    .click();
  await expect(
    dates.getByRole('button', { name: 'Editar datas', exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    { expectedVersion: 4, paidOn: '2026-09-10', deliveredOn: '2026-10-21' },
  ]);
  await expect(dates).toContainText('Confirme o recebimento integral');
  await dates
    .getByRole('button', { name: 'Editar datas', exact: true })
    .click();
  await expect(confirmation).not.toBeChecked();
});

test('explicit full receipt confirmation can preserve the original payment day', async ({
  page,
}) => {
  const writes = await legacyPayment(page);
  const dates = page.getByRole('region', { name: 'Datas do pedido' });
  await dates
    .getByRole('button', { name: 'Editar datas', exact: true })
    .click();
  await expect(dates.getByLabel('Pago em', { exact: true })).toHaveValue(
    '2026-09-10',
  );
  await dates
    .getByRole('checkbox', {
      name: 'Confirmo que o valor integral foi recebido',
    })
    .focus();
  await page.keyboard.press('Space');
  await dates
    .getByRole('button', { name: 'Salvar datas', exact: true })
    .click();
  await expect(
    dates.getByRole('button', { name: 'Editar datas', exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      expectedVersion: 4,
      paidOn: '2026-09-10',
      deliveredOn: null,
      paymentReviewed: true,
    },
  ]);
  await expect(dates).not.toContainText('Confirme o recebimento integral');
  await dates
    .getByRole('button', { name: 'Editar datas', exact: true })
    .click();
  await expect(
    dates.getByRole('checkbox', {
      name: 'Confirmo que o valor integral foi recebido',
    }),
  ).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
