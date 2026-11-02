import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  mockConversationShipping,
  shippingInput,
  shippingQuote,
} from './support/conversation-shipping-mock.js';

/** @param {import('@playwright/test').Page} page */
async function openQuote(page) {
  await page.goto('/inbox/shipping-conversation-1');
  const trigger = page.getByRole('button', {
    name: 'Cotar frete',
    exact: true,
  });
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Cotar frete para o pedido',
  });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

/** @param {import('@playwright/test').Locator} dialog @param {string} [subjectId] */
async function fillQuote(dialog, subjectId = 'shipping-subject-1') {
  await dialog.getByLabel('Pedido deste atendimento').selectOption(subjectId);
  await dialog
    .getByLabel('CEP de origem', { exact: true })
    .fill(shippingInput.fromPostalCode);
  await dialog
    .getByLabel('CEP de destino', { exact: true })
    .fill(shippingInput.toPostalCode);
  await dialog.getByLabel('Peso total (g)', { exact: true }).fill('1250');
  await dialog.getByLabel('Largura (cm)', { exact: true }).fill('20');
  await dialog.getByLabel('Altura (cm)', { exact: true }).fill('12');
  await dialog.getByLabel('Comprimento (cm)', { exact: true }).fill('30');
  await dialog
    .getByLabel('Valor segurado (R$)', { exact: true })
    .fill('150,25');
}

test('T139: seller quotes an explicit order by keyboard, saves an estimate and drafts without sending', async ({
  page,
}) => {
  const { calls, orders } = await mockConversationShipping(page);
  const before = JSON.stringify(orders);
  const { dialog, trigger } = await openQuote(page);
  await expect(dialog.getByLabel('Pedido deste atendimento')).toHaveValue('');
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('heading', { name: 'Opções de frete' }),
  ).toBeFocused();
  await expect(dialog).toContainText('Correios · PAC');
  await expect(dialog).toContainText('R$ 23,50');
  await expect(dialog).toContainText('5 dias úteis previstos');
  const calculated = calls[0];
  expect(calculated.path).toBe(
    '/api/v1/conversations/shipping-conversation-1/shipping-quotes',
  );
  expect(calculated.csrf).toBe('shipping-csrf');
  expect(calculated.key).toBeTruthy();
  expect(calculated.body).toEqual({
    ...shippingInput,
    subjectId: 'shipping-subject-1',
    orderId: 'shipping-order-1',
    orderVersion: 2,
  });
  await dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }).click();
  await expect(dialog).toContainText('Frete estimado vinculado ao pedido');
  expect(calls[1].body).toEqual({
    subjectId: 'shipping-subject-1',
    orderId: 'shipping-order-1',
    orderVersion: 2,
    serviceId: 1,
  });
  expect(calls[1].key).toBeTruthy();
  expect(calls[1].csrf).toBe('shipping-csrf');
  await dialog
    .getByRole('button', { name: 'Escrever resposta com o frete' })
    .click();
  await expect(dialog).toBeHidden();
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue(
    /Frete estimado para 150 peças: Correios PAC, R\$ 23,50/u,
  );
  await expect(reply).toHaveValue(/sujeita a nova consulta/u);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(orders)).toBe(before);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('T139: choosing another order keeps its explicit subject and preserves a reply draft', async ({
  page,
}) => {
  const { calls } = await mockConversationShipping(page, { multiple: true });
  await page.goto('/inbox/shipping-conversation-1');
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Já confirmei as cores.');
  await page.getByRole('button', { name: 'Cotar frete', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Cotar frete para o pedido',
  });
  await fillQuote(dialog, 'shipping-subject-other');
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }).click();
  await dialog
    .getByRole('button', { name: 'Acrescentar resposta com o frete' })
    .click();
  await expect(reply).toHaveValue(
    /^Já confirmei as cores\.\n\nFrete estimado/u,
  );
  expect(calls[0].body.orderId).toBe('shipping-order-2');
  expect(calls[0].body.subjectId).toBe('shipping-subject-other');
  expect(calls).toHaveLength(2);
});

test('T139: changed measurements invalidate displayed options before selection', async ({
  page,
}) => {
  const { calls } = await mockConversationShipping(page);
  const { dialog } = await openQuote(page);
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }),
  ).toBeVisible();
  await dialog.getByLabel('Peso total (g)', { exact: true }).fill('1800');
  await expect(
    dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Escrever resposta com o frete' }),
  ).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('T139: a customer CEP opens the quote with destination filled and still requires an explicit order', async ({
  page,
}) => {
  const { calls } = await mockConversationShipping(page);
  await page.goto('/inbox/shipping-conversation-1');
  // Subjects load independently from messages. This scenario opens a quote
  // after its order exists, so wait for the hidden dialog's target control.
  await page.locator('#shipping-target').waitFor({ state: 'attached' });
  const trigger = page.getByRole('button', {
    name: 'Cotar para CEP 20040-020',
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Cotar frete para o pedido',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Pedido deste atendimento')).toBeFocused();
  await expect(dialog.getByLabel('Pedido deste atendimento')).toHaveValue('');
  await expect(
    dialog.getByLabel('CEP de destino', { exact: true }),
  ).toHaveValue('20040-020');
  expect(calls).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('T139: CEP action ignores documents and phone numbers and normalizes punctuated CEP', async ({
  page,
}) => {
  await mockConversationShipping(page, {
    message:
      'CEP 01.001-000. Documento sintético 000.000.000-00; telefone +55 (00) 00000-0000 e inválido 00000000.',
  });
  await page.goto('/inbox/shipping-conversation-1');
  await expect(
    page.getByRole('heading', { name: 'Cliente sintético 1', level: 2 }),
  ).toBeVisible();
  const actions = page.getByRole('button', { name: /^Cotar para CEP/u });
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveText('Cotar para CEP 01001-000');
});

test('T139: a late response after changing destination never restores old options', async ({
  page,
}) => {
  /** @type {()=>void} */ let release = () => {};
  const delay = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const { calls } = await mockConversationShipping(page, { delay });
  const { dialog } = await openQuote(page);
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect.poll(() => calls.length).toBe(1);
  await dialog.getByLabel('CEP de destino', { exact: true }).fill('30140-071');
  release();
  await expect(
    dialog.getByRole('button', { name: 'Consultar frete', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('heading', { name: 'Opções de frete' }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }),
  ).toHaveCount(0);
});

test('T139: provider failure stays recoverable with measurements kept and no fabricated price', async ({
  page,
}) => {
  const { calls } = await mockConversationShipping(page, { quoteError: true });
  const { dialog } = await openQuote(page);
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Não foi possível consultar o Melhor Envio',
  );
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(
    dialog.getByLabel('Peso total (g)', { exact: true }),
  ).toHaveValue('1250');
  await expect(
    dialog.getByRole('button', { name: 'Vincular PAC ao pedido' }),
  ).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('T139: no available service leaves no selection or response action', async ({
  page,
}) => {
  await mockConversationShipping(page, { empty: true });
  const { dialog } = await openQuote(page);
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(dialog).toContainText('Nenhum serviço disponível');
  await expect(
    dialog.getByRole('button', { name: /Vincular .* ao pedido/u }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Escrever resposta com o frete' }),
  ).toHaveCount(0);
});

for (const scenario of [
  { name: 'another seller owns the conversation', owner: 'other-seller' },
  { name: 'the assistant still has the conversation', assistant: true },
  { name: 'no seller owns the conversation', owner: null },
]) {
  test(`T139: cannot quote while ${scenario.name}`, async ({ page }) => {
    const { calls } = await mockConversationShipping(page, scenario);
    await page.goto('/inbox/shipping-conversation-1');
    await expect(
      page.getByRole('heading', { name: 'Cliente sintético 1', level: 2 }),
    ).toBeVisible();
    const trigger = page.getByRole('button', {
      name: 'Cotar frete',
      exact: true,
    });
    if (await trigger.count()) await expect(trigger).toBeDisabled();
    await expect(
      page.getByRole('button', { name: /^Cotar para CEP/u }),
    ).toHaveCount(0);
    expect(calls).toEqual([]);
  });
}

test('T139: narrow screen quote dialog is accessible and fits the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await mockConversationShipping(page);
  const { dialog } = await openQuote(page);
  await fillQuote(dialog);
  await dialog
    .getByRole('button', { name: 'Consultar frete', exact: true })
    .click();
  await expect(
    dialog.getByRole('heading', { name: 'Opções de frete' }),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('.conversation-shipping-dialog')
    .analyze();
  expect(axe.violations).toEqual([]);
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(320);
  expect(box?.x).toBeGreaterThanOrEqual(0);
  await page.screenshot({
    path: test.info().outputPath('conversation-shipping-mobile.png'),
    fullPage: true,
  });
});

test('T139: order page reads the saved estimate and labels stale results without changing the total', async ({
  page,
}) => {
  await mockConversationShipping(page, {
    saved: { ...shippingQuote, selectedServiceId: 1, stale: true },
  });
  await page.goto('/pedidos/shipping-order-1');
  await expect(
    page.getByRole('heading', { name: 'Pedido 01-CRM' }),
  ).toBeVisible();
  const estimate = page.getByRole('region', { name: 'Frete estimado' });
  await expect(estimate).toContainText('Correios');
  await expect(estimate).toContainText('R$ 23,50');
  await expect(estimate).toContainText(/desatualizada/iu);
  await expect(estimate).toContainText('Vendedora sintética');
});
